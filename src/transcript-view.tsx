/** @jsxImportSource @stencil-hq/tern */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { DiffHunk, JSX, NodeJson, Tone } from '@stencil-hq/tern';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import { contentText, type ToolStep, type TranscriptEntry } from './model';
import type { DirectoryPreview } from './files';
import type { PluginEntry } from './extensions';
import type { DiffMode, UserPrefs } from './prefs';
import {
  extractMarkdownFollowUpQuestions,
  extractToolFollowUpQuestions,
  type QuestionField,
} from './follow-up';
import {
  buildTaskDetailText,
  buildUnifiedDiffHunks,
  clipDiffHunks,
  clipInlinePreview,
  extractActionableUrls,
  extractMarkdownImagePaths,
  extractPluginCards,
  extractToolImagePaths,
  extractToolInlineImages,
  extractToolOutputText,
  formatPathLabel,
  splitMarkdownSegments,
  stripPluginCardTags,
  summarizeThoughtTopic,
  summarizeToolCall,
} from './ui-format';

const PATH_EXISTS_TTL_MS = 4_000;
const MAX_PATH_EXISTS_CACHE = 512;
const pathExistsCache = new Map<string, { exists: boolean; at: number }>();

/** Bounded TTL cache for synchronous path-existence checks during transcript render. */
export function cachedPathExists(targetPath: string): boolean {
  const now = Date.now();
  const cached = pathExistsCache.get(targetPath);
  if (cached && now - cached.at <= PATH_EXISTS_TTL_MS) return cached.exists;
  let exists = false;
  try {
    exists = existsSync(targetPath);
  } catch {
    exists = false;
  }
  if (pathExistsCache.size >= MAX_PATH_EXISTS_CACHE) {
    const oldest = pathExistsCache.keys().next().value;
    if (oldest !== undefined) pathExistsCache.delete(oldest);
  }
  pathExistsCache.set(targetPath, { exists, at: now });
  return exists;
}

const CLIPBOARD_TIMEOUT_MS = 2_000;

export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: ReadonlyArray<readonly [string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ];
  for (const [cmd, args] of candidates) {
    const bin = Bun.which(cmd);
    if (!bin) continue;
    const ok = await new Promise<boolean>(resolve => {
      let settled = false;
      const done = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore if process already exited.
        }
        done(false);
      }, CLIPBOARD_TIMEOUT_MS);
      child.once('error', () => done(false));
      child.once('close', code => done(code === 0));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  // Fall back to OSC 52 when attached to an interactive terminal without local clipboard binaries.
  if (process.stdout.isTTY && text.length > 0 && text.length <= 100_000) {
    try {
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      process.stdout.write(`\x1b]52;c;${encoded}\x07`);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function clockTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

export function hoverKv(items: ReadonlyArray<{ k: string; v: string }>): NodeJson {
  return { k: 'kv', p: { items: items.map(({ k, v }) => ({ k, v })) } };
}

export type InspectTarget =
  | { type: 'image-path'; path: string }
  | { type: 'image-blob'; blob: string; mimeType: string; name?: string }
  | { type: 'diff'; path: string; hunks: DiffHunk[]; newFileText?: string }
  | { type: 'file'; path: string; content: string; truncated?: boolean }
  | { type: 'dir'; preview: DirectoryPreview };

function InlineMediaPreview({
  caption,
  blob,
  mimeType,
  path,
  onOpen,
}: {
  caption: string;
  blob?: string;
  mimeType?: string;
  path?: string;
  onOpen?: () => void;
}): JSX.Element {
  return <col align="start" gap="xs" title={onOpen ? 'Click image to open modal preview' : undefined} onClick={onOpen}>
    {blob
      ? <image blob={blob} alt={mimeType ?? caption} title="Click image to open modal preview" onClick={onOpen} />
      : path
        ? <media path={path} title="Click image to open modal preview" onClick={onOpen} />
        : null}
    <row gap="xs" align="center" wrap>
      <text><span s="muted">{caption}</span></text>
      {onOpen && <button size="sm" variant="quiet" icon="expand" onClick={onOpen}>
        Open modal
      </button>}
    </row>
  </col>;
}

export function ToolOutput({ rawOutput }: { rawOutput: unknown }): JSX.Element {
  if (typeof rawOutput === 'string') {
    const clipped = clipInlinePreview(rawOutput);
    return <col gap="xs">
      <code wrap>{clipped.text}</code>
      {clipped.truncated && <text><span s="muted">Output truncated in card · click Copy output for full text</span></text>}
    </col>;
  }
  if (typeof rawOutput === 'object' && rawOutput !== null && !Array.isArray(rawOutput)) {
    const record = rawOutput as Record<string, unknown>;
    const stdout = typeof record.stdout === 'string' ? record.stdout : undefined;
    const stderr = typeof record.stderr === 'string' ? record.stderr : undefined;
    if (stdout !== undefined || stderr !== undefined) {
      const outClip = stdout ? clipInlinePreview(stdout) : undefined;
      const errClip = stderr ? clipInlinePreview(stderr) : undefined;
      return <col gap="xs">
        {outClip && <code wrap>{outClip.text}</code>}
        {errClip && <code wrap>{errClip.text}</code>}
        {(outClip?.truncated || errClip?.truncated) && <text><span s="muted">Output truncated in card · click Copy output for full text</span></text>}
      </col>;
    }
  }
  const jsonClip = clipInlinePreview(JSON.stringify(rawOutput, null, 2));
  return <col gap="xs">
    <code wrap>{jsonClip.text}</code>
    {jsonClip.truncated && <text><span s="muted">Output truncated in card · click Copy output for full text</span></text>}
  </col>;
}

interface ParsedTargetPath {
  path: string;
  absPath: string;
  line?: number;
}

function parseToolTargetPath(target: string | undefined, cwd: string): ParsedTargetPath | undefined {
  if (!target) return undefined;
  const match = /^(.*):(\d+)$/.exec(target);
  const path = match ? match[1]! : target;
  if (!path) return undefined;
  return {
    path,
    absPath: isAbsolute(path) ? path : resolve(cwd, path),
    line: match ? Number(match[2]) : undefined,
  };
}

function firstToolDiffInspectTarget(
  call: ToolCallUpdate,
  cwd: string,
): { title: string; target: InspectTarget; subtitle: string } | undefined {
  for (const item of call.content ?? []) {
    if (item.type !== 'diff') continue;
    const label = formatPathLabel(item.path, cwd);
    if (item.oldText == null) {
      return { title: basename(label), target: { type: 'file', path: label, content: item.newText }, subtitle: label };
    }
    const diff = buildUnifiedDiffHunks(item.oldText, item.newText);
    if (diff.hunks.length > 0) {
      return { title: basename(label), target: { type: 'diff', path: label, hunks: diff.hunks }, subtitle: label };
    }
  }
  return undefined;
}

function buildToolHeaderActions(opts: {
  kind?: ToolCallUpdate['kind'];
  hasDiff: boolean;
  hasCopyableOutput: boolean;
  hasFollowUp: boolean;
  collapsed: boolean;
  targetExists: boolean;
  canInspectFile: boolean;
  canSplit: boolean;
}): Array<{ id: string; label: string }> {
  const actions: Array<{ id: string; label: string }> = [];
  if (opts.hasFollowUp) {
    actions.push({ id: 'answer-followup', label: 'Answer' });
  }
  if (opts.kind === 'read' && opts.targetExists && opts.canInspectFile) {
    actions.push({ id: 'view-file', label: 'Open file' });
    if (opts.canSplit) actions.push({ id: 'split', label: 'Split' });
    actions.push({ id: 'toggle', label: opts.collapsed ? 'Details' : 'Collapse' });
    return actions;
  }
  if (opts.hasDiff || opts.kind === 'edit') {
    actions.push({ id: 'inspect-diff', label: opts.hasDiff ? 'Inspect diff' : 'Inspect' });
    if (opts.targetExists && opts.canInspectFile) actions.push({ id: 'view-file', label: 'Open file' });
    if (opts.targetExists && opts.canSplit) actions.push({ id: 'split', label: 'Split' });
    return actions;
  }
  if (opts.targetExists && opts.canInspectFile) {
    actions.push({ id: 'view-file', label: 'Open file' });
  }
  actions.push({ id: 'inspect', label: 'Inspect' });
  if (opts.hasCopyableOutput) {
    actions.push({ id: 'copy-output', label: 'Copy' });
  }
  return actions;
}

export function ToolBody({ call, step, cwd, showRawInput, fullCommand, runnableCommand, diffMode, targetInfo, targetExists, summaryTitle, summaryTarget, pathExists, getBlob, onInspect, onInspectFile, onOpenSplit, onRunCommand, onAttachPath, onCopy }: {
  call: ToolCallUpdate;
  step?: ToolStep;
  cwd: string;
  showRawInput: boolean;
  fullCommand?: string;
  runnableCommand?: string;
  diffMode: DiffMode;
  targetInfo?: ParsedTargetPath;
  targetExists?: boolean;
  summaryTitle?: string;
  summaryTarget?: string;
  pathExists?(targetPath: string): boolean;
  getBlob?(key: string, data: string, mimeType: string): string | undefined;
  onInspect?(title: string, target: InspectTarget, subtitle?: string): void;
  onInspectFile?(filePath: string, line?: number): void;
  onOpenSplit?(path: string, line?: number): void;
  onRunCommand?(command: string): void;
  onAttachPath?(path: string): void;
  onCopy?(text: string): void;
}): JSX.Element {
  const checkPathExists = pathExists ?? cachedPathExists;
  const imagePaths = extractToolImagePaths(call, cwd).filter(checkPathExists);
  const copyableOutput = extractToolOutputText(call.rawOutput);
  const commandClip = !showRawInput && fullCommand ? clipInlinePreview(fullCommand, 6, 450) : undefined;
  const splitCmd = fullCommand || runnableCommand;
  const rawInputClip = showRawInput && call.rawInput !== undefined
    ? clipInlinePreview(typeof call.rawInput === 'string' ? call.rawInput : JSON.stringify(call.rawInput, null, 2), 8, 600)
    : undefined;
  const extraLocations = (call.locations ?? []).filter(loc => !!loc.path);
  const showLocations = extraLocations.length > 1 || (extraLocations.length === 1 && !targetInfo);
  const resolvedTargetExists = targetExists ?? (!!targetInfo && checkPathExists(targetInfo.absPath));
  const detailTitle = summaryTitle ?? call.title ?? call.toolCallId;
  const hasInlineSplitForTarget = Boolean(
    resolvedTargetExists && targetInfo && call.content?.some(c =>
      c.type === 'diff' && (isAbsolute(c.path) ? c.path : resolve(cwd, c.path)) === targetInfo.absPath),
  );
  return <col gap="sm">
    {showLocations && <row key="locations" gap="xs" align="center" wrap>
      <text><span s="muted">Locations</span></text>
      {extraLocations.slice(0, 6).map((loc, index) => {
        const label = `${formatPathLabel(loc.path, cwd)}${loc.line ? `:${loc.line}` : ''}`;
        const absLoc = isAbsolute(loc.path) ? loc.path : resolve(cwd, loc.path);
        const locExists = checkPathExists(absLoc);
        const canInspectLoc = !!onInspectFile && locExists;
        const canSplitLoc = !!onOpenSplit && locExists;
        return <button key={`loc-${index}`} size="sm" variant="quiet" icon={canInspectLoc ? 'file' : canSplitLoc ? 'split' : 'copy'}
          onClick={() => {
            if (canInspectLoc) onInspectFile(absLoc, loc.line ?? undefined);
            else if (canSplitLoc) onOpenSplit(absLoc, loc.line ?? undefined);
            else onCopy?.(absLoc);
          }}>
          {label}
        </button>;
      })}
      {extraLocations.length > 6 && <text><span s="muted">{`+${extraLocations.length - 6} more`}</span></text>}
    </row>}
    {rawInputClip && <col key="input" gap="xs">
      <text><span s="muted">Input</span></text>
      <code wrap>{rawInputClip.text}</code>
      {rawInputClip.truncated && <text><span s="muted">Input preview truncated</span></text>}
    </col>}
    {commandClip && <col key="command" gap="xs">
      <code lang="sh" wrap>{commandClip.text}</code>
      {(commandClip.truncated || onCopy || onInspect || onRunCommand) && <row gap="xs" align="center" wrap>
        {onCopy && fullCommand && <button size="sm" variant="quiet" icon="copy" onClick={() => onCopy(fullCommand)}>
          Copy command
        </button>}
        {onInspect && fullCommand && <button size="sm" variant="quiet" icon="expand"
          onClick={() => onInspect('Command', { type: 'file', path: 'command.sh', content: fullCommand })}>
          Fullscreen command
        </button>}
        {onRunCommand && fullCommand && <button size="sm" variant="quiet" icon="split"
          onClick={() => onRunCommand(fullCommand)}>
          Run in split
        </button>}
      </row>}
    </col>}
    {call.content?.map((content, index) => {
      if (content.type === 'content') {
        if (content.content.type === 'image') {
          const imageMime = content.content.mimeType;
          const blob = getBlob?.(`tool:${call.toolCallId}:${index}`, content.content.data, imageMime);
          if (blob) {
            return <InlineMediaPreview key={`img-${index}`} caption={imageMime} blob={blob} mimeType={imageMime}
              onOpen={onInspect ? () => onInspect('Live image preview', { type: 'image-blob', blob, mimeType: imageMime }, imageMime) : undefined} />;
          }
        }
        if (content.content.type === 'resource_link') {
          const link = content.content;
          const linkLabel = link.title || link.name || link.uri;
          const rawPath = link.uri.startsWith('file://') ? link.uri.slice(7) : link.uri;
          const absLinkPath = rawPath && !rawPath.includes('://')
            ? (isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath))
            : undefined;
          const linkExists = !!absLinkPath && checkPathExists(absLinkPath);
          const canSplitLink = linkExists && !!onOpenSplit;
          const canInspectLink = linkExists && !!onInspectFile;
          return <row key={`content-${index}`} gap="xs" align="center" wrap>
            <text><span s="muted">{linkLabel}</span></text>
            {canInspectLink && <button size="sm" variant="quiet" icon="file" onClick={() => onInspectFile(absLinkPath!)}>
              Open file
            </button>}
            {canSplitLink && <button size="sm" variant="quiet" icon="split" onClick={() => onOpenSplit(absLinkPath!)}>
              Tern split
            </button>}
            {onCopy && <button size="sm" variant="quiet" icon="copy" onClick={() => onCopy(link.uri)}>
              Copy URI
            </button>}
          </row>;
        }
        return <md key={`content-${index}`}>{contentText(content.content)}</md>;
      }
      if (content.type === 'terminal') return <text key={`content-${index}`} wrap="char">
        Terminal reference: {content.terminalId} (terminal embedding is not enabled)
      </text>;
      const pathLabel = formatPathLabel(content.path, cwd);
      const absPath = isAbsolute(content.path) ? content.path : resolve(cwd, content.path);
      const canSplit = !!onOpenSplit && checkPathExists(absPath);
      if (content.oldText == null) {
        const clippedFile = clipInlinePreview(content.newText, 24, 3_000);
        return <col key={`content-${index}`} gap="xs">
          <code numbers path={pathLabel}>{clippedFile.text}</code>
          {clippedFile.truncated && <text><span s="muted">Preview truncated · open Fullscreen for full file</span></text>}
          {(onInspect || onCopy || canSplit) && <row gap="xs">
            {onInspect && <button size="sm" variant="quiet" icon="expand"
              onClick={() => onInspect(basename(pathLabel), { type: 'file', path: pathLabel, content: content.newText }, pathLabel)}>
              Fullscreen
            </button>}
            {onCopy && <button size="sm" variant="quiet" icon="copy"
              onClick={() => onCopy(content.newText)}>
              Copy
            </button>}
            {canSplit && <button size="sm" variant="quiet" icon="split"
              onClick={() => onOpenSplit(absPath)}>
              Tern split
            </button>}
          </row>}
        </col>;
      }
      const diff = buildUnifiedDiffHunks(content.oldText, content.newText);
      if (!diff.hunks.length) {
        return <text key={`content-${index}`} wrap="char"><span s="muted">No line changes in {pathLabel}</span></text>;
      }
      const firstChangedLine = diff.hunks[0]?.newStart;
      const diffCopyText = diff.hunks.flatMap(h => h.lines).join('\n');
      const clippedDiff = clipDiffHunks(diff.hunks, 32);
      return <col key={`content-${index}`} gap="xs">
        <diff path={pathLabel} hunks={clippedDiff.hunks} mode={diffMode} />
        {clippedDiff.truncated && <text><span s="muted">Diff preview truncated · open Fullscreen diff for all hunks</span></text>}
        {(onInspect || onCopy || canSplit) && <row gap="xs">
          {onInspect && <button size="sm" variant="quiet" icon="expand"
            onClick={() => onInspect(basename(pathLabel), { type: 'diff', path: pathLabel, hunks: diff.hunks }, pathLabel)}>
            Fullscreen diff
          </button>}
          {onCopy && diffCopyText && <button size="sm" variant="quiet" icon="copy"
            onClick={() => onCopy(diffCopyText)}>
            Copy diff
          </button>}
          {canSplit && <button size="sm" variant="quiet" icon="split"
            onClick={() => onOpenSplit(absPath, firstChangedLine)}>
            Tern split
          </button>}
        </row>}
      </col>;
    })}
    {imagePaths.map((imgPath, index) => {
      const label = formatPathLabel(imgPath, cwd);
      return <InlineMediaPreview key={`media-${index}`} caption={label} path={imgPath}
        onOpen={onInspect ? () => onInspect(basename(label), { type: 'image-path', path: imgPath }, label) : undefined} />;
    })}
    {call.rawOutput !== undefined && call.rawOutput !== null && call.rawOutput !== '' && <col key="output" gap="xs">
      <ToolOutput rawOutput={call.rawOutput} />
      {(onCopy || onInspect) && copyableOutput && <row gap="xs" wrap>
        {onInspect && <button size="sm" variant="quiet" icon="expand"
          onClick={() => onInspect(detailTitle, { type: 'file', path: 'task.log', content: copyableOutput }, summaryTarget)}>
          Inspect output
        </button>}
        {onCopy && <button size="sm" variant="quiet" icon="copy" onClick={() => onCopy(copyableOutput)}>
          Copy output
        </button>}
      </row>}
    </col>}
    {((resolvedTargetExists && targetInfo && (onInspectFile || onOpenSplit || onAttachPath)) || (step && onInspect) || (!commandClip && splitCmd && onRunCommand)) && (
      <row key="task-actions" gap="xs" wrap>
        {resolvedTargetExists && targetInfo && onInspectFile && <button size="sm" variant="quiet" icon="file"
          onClick={() => onInspectFile(targetInfo.absPath, targetInfo.line)}>
          Open file
        </button>}
        {!commandClip && splitCmd && onRunCommand && <button size="sm" variant="quiet" icon="split"
          onClick={() => onRunCommand(splitCmd)}>
          Run in split
        </button>}
        {step && onInspect && <button size="sm" variant="quiet" icon="expand"
          onClick={() => onInspect(detailTitle, { type: 'file', path: 'task.log', content: buildTaskDetailText(step, cwd) }, summaryTarget)}>
          Inspect details
        </button>}
        {resolvedTargetExists && targetInfo && onOpenSplit && !hasInlineSplitForTarget && <button size="sm" variant="quiet" icon="split"
          onClick={() => onOpenSplit(targetInfo.absPath, targetInfo.line)}>
          Tern split
        </button>}
        {resolvedTargetExists && targetInfo && onAttachPath && <button size="sm" variant="quiet" icon="plus"
          onClick={() => onAttachPath(targetInfo.path)}>
          Attach
        </button>}
      </row>
    )}
  </col>;
}

export interface EntryCallbacks {
  cwd: string;
  working: boolean;
  now: number;
  agentStatus: Tone;
  agentAvatarBlob?: string;
  prefs: UserPrefs;
  proseMaxW?: `${number}ch`;
  thoughtFoldOverrides: Map<string, boolean>;
  toolFoldOverrides: Map<string, boolean>;
  canRetry: boolean;
  canReconnect: boolean;
  canSwitchAccount: boolean;
  pathExists?(targetPath: string): boolean;
  getBlob(key: string, data: string, mimeType: string): string | undefined;
  onInspect(title: string, target: InspectTarget, subtitle?: string): void;
  onInspectFile?(filePath: string, line?: number): void;
  onToggleThought(id: string, open: boolean): void;
  onToggleTool(id: string, collapsed: boolean): void;
  onRetry(): void;
  onReconnect(): void;
  onSwitchModel(): void;
  onSwitchAccount(): void;
  onOpenAccount(): void;
  onOpenChanges(): void;
  onOpenSplit?(path: string, line?: number): void;
  onRunCommand?(command: string): void;
  onAttachPath(path: string): void;
  onExport(): void;
  onCopy(text: string): void;
  onResend(text: string): void;
  onLoadDeeperHistory?(): void;
  onOpenFollowUp?(title: string, message: string, fields: readonly QuestionField[]): void;
  pinnedTurnIds?: ReadonlySet<string>;
  onTogglePin?(entryId: string): void;
  pluginsList?: readonly PluginEntry[];
  onOpenPluginCard?(catalogId: string): void;
  onInstallPluginCard?(catalogId: string): void;
  onHandoffOfficialAgy?(reason: string, returnPanel?: 'plugins' | 'mcp'): void;
  onOpenExternalUrl?(url: string): void;
}

export function Entry({ entry, continued, streaming, recent, turnNumber, callbacks }: {
  entry: TranscriptEntry;
  continued?: boolean;
  streaming?: boolean;
  recent?: boolean;
  turnNumber?: number;
  callbacks: EntryCallbacks;
}): JSX.Element {
  const showAvatar = callbacks.prefs.transcriptDensity !== 'compact';
  const checkPathExists = callbacks.pathExists ?? cachedPathExists;
  switch (entry.type) {
    case 'message': {
      const withDivider = entry.role === 'user' && !!turnNumber && turnNumber > 1 && showAvatar;
      const pluginCards = entry.role === 'agent' && entry.text ? extractPluginCards(entry.text) : [];
      const displayText = pluginCards.length ? stripPluginCardTags(entry.text) : entry.text;
      const segments = entry.role === 'agent' && displayText ? splitMarkdownSegments(displayText) : undefined;
      const hasCodeBlocks = !!segments?.some(seg => seg.kind === 'code');
      const mdImagePaths = entry.role === 'agent' && !streaming && displayText
        ? extractMarkdownImagePaths(displayText, callbacks.cwd, checkPathExists)
        : [];
      const actionableUrls = entry.role === 'agent' && !streaming && entry.text
        ? extractActionableUrls(entry.text)
        : [];
      const mdFollowUpQuestions = entry.role === 'agent' && !streaming && displayText && callbacks.onOpenFollowUp
        ? extractMarkdownFollowUpQuestions(displayText)
        : [];
      const isPinned = entry.role === 'user' && (callbacks.pinnedTurnIds?.has(entry.id) ?? false);
      const msgNode = <message key={withDivider ? 'msg' : entry.id} variant="auto"
        side={entry.role === 'user' ? 'end' : 'start'} author={entry.role === 'user' ? 'You' : 'Antigravity'}
        continued={continued}
        time={callbacks.prefs.showTimestamps ? entry.time : undefined}
        pending={streaming || undefined}
        status={streaming ? 'Streaming' : (isPinned ? 'Pinned' : undefined)}
        reveal="hover"
        avatar={showAvatar ? (entry.role === 'user'
          ? <avatar variant="circle" icon="user" text="You" seed="local-user" size="sm" />
          : <avatar variant="square" blob={callbacks.agentAvatarBlob} icon={callbacks.agentAvatarBlob ? undefined : 'tern'} text="AG" seed="antigravity" size="sm" status={callbacks.agentStatus} />) : undefined}
        actions={entry.role === 'user'
          ? [
            { act: 'copy', icon: 'copy', title: 'Copy message' },
            { act: 'resend', icon: 'repeat', title: 'Load into composer' },
            ...(callbacks.onTogglePin ? [{ act: 'pin', icon: 'compass', title: isPinned ? 'Unpin turn' : 'Pin turn' }] : []),
          ]
          : [{ act: 'copy', icon: 'copy', title: 'Copy response' }]}
        onMenu={{
          Copy: () => callbacks.onCopy(entry.text),
          ...(entry.role === 'user' ? {
            'Load into composer': () => callbacks.onResend(entry.text),
            ...(callbacks.onTogglePin ? { [isPinned ? 'Unpin turn' : 'Pin turn']: () => callbacks.onTogglePin?.(entry.id) } : {}),
          } : {}),
          'Export transcript': callbacks.onExport,
        }}
        onAction={{
          copy: () => callbacks.onCopy(entry.text),
          resend: () => callbacks.onResend(entry.text),
          pin: () => callbacks.onTogglePin?.(entry.id),
        }}>
        {entry.images?.map((img, idx) => {
          const blob = callbacks.getBlob(`${entry.id}:img:${idx}`, img.data, img.mimeType);
          return blob
            ? <InlineMediaPreview key={`img-${idx}`} caption={img.mimeType} blob={blob} mimeType={img.mimeType}
              onOpen={() => callbacks.onInspect('Message image', { type: 'image-blob', blob, mimeType: img.mimeType }, img.mimeType)} />
            : <text key={`img-${idx}`}><span s="muted">{`[Image: ${img.mimeType}]`}</span></text>;
        })}
        {displayText && (entry.role === 'user'
          ? <text wrap="char">{displayText}</text>
          : hasCodeBlocks && segments
            ? <col gap="xs">
              {segments.map((seg, idx) => seg.kind === 'prose'
                ? <md key={`prose-${idx}`} max={{ w: callbacks.proseMaxW ?? '80ch' }}>{seg.text}</md>
                : <col key={`code-${idx}`} gap="xs">
                  <code lang={seg.lang} wrap>{seg.text}</code>
                  <row gap="xs" align="center" wrap>
                    {seg.lang && <text><span s="muted">{seg.lang}</span></text>}
                    <button size="sm" variant="quiet" icon="copy" onClick={() => callbacks.onCopy(seg.text)}>
                      Copy
                    </button>
                    <button size="sm" variant="quiet" icon="expand"
                      onClick={() => callbacks.onInspect(seg.lang ? `Snippet (${seg.lang})` : 'Code snippet',
                        { type: 'file', path: seg.lang ? `snippet.${seg.lang}` : 'snippet.txt', content: seg.text })}>
                      Fullscreen
                    </button>
                    {!streaming && seg.closed !== false && seg.runnable && callbacks.onRunCommand && <button size="sm" variant="quiet" icon="terminal"
                      onClick={() => callbacks.onRunCommand?.(seg.text)}>
                      Run in split
                    </button>}
                  </row>
                </col>)}
            </col>
            : <md stream={streaming} max={{ w: callbacks.proseMaxW ?? '80ch' }}>{displayText}</md>)}
        {pluginCards.length > 0 && <col key="plugin-cards" gap="xs">
          {pluginCards.map(card => {
            const installed = callbacks.pluginsList?.find(p => p.name.toLowerCase() === card.catalogId.toLowerCase());
            const heading = installed?.displayName ? `${installed.displayName} (${card.catalogId})` : card.catalogId;
            const statusText = installed
              ? (installed.enabled ? 'Installed · Enabled' : 'Installed · Disabled')
              : 'Antigravity plugin';
            return <card key={`pcard-${card.catalogId}`} head={heading} meta={statusText} icon="compass">
              <col gap="xs">
                {installed?.description && <text wrap="word"><span s="muted">{installed.description}</span></text>}
                <row gap="xs" wrap>
                  {callbacks.onOpenPluginCard && <button size="sm" variant="default" onClick={() => callbacks.onOpenPluginCard?.(card.catalogId)}>
                    Open /plugin
                  </button>}
                  {!installed && callbacks.onInstallPluginCard && <button size="sm" variant="primary" onClick={() => callbacks.onInstallPluginCard?.(card.catalogId)}>
                    Install
                  </button>}
                  {(installed?.hasAuth || !installed) && callbacks.onHandoffOfficialAgy && <button size="sm" variant="quiet"
                    onClick={() => callbacks.onHandoffOfficialAgy?.(`Sign in to ${card.catalogId} in official /plugin`, 'plugins')}>
                    Sign in (official agy)
                  </button>}
                </row>
              </col>
            </card>;
          })}
        </col>}
        {actionableUrls.length > 0 && <row key="oauth-links" gap="xs" wrap>
          {actionableUrls.map((link, idx) => <row key={`url-${idx}`} gap="xs" align="center">
            {callbacks.onOpenExternalUrl && <button size="sm" variant="default" icon="link"
              onClick={() => callbacks.onOpenExternalUrl?.(link.url)}>
              {`Open ${link.label}`}
            </button>}
            <button size="sm" variant="quiet" icon="copy" onClick={() => callbacks.onCopy(link.url)}>
              Copy URL
            </button>
          </row>)}
        </row>}
        {mdImagePaths.map((imgPath, idx) => {
          const label = formatPathLabel(imgPath, callbacks.cwd);
          return <InlineMediaPreview key={`md-img-${idx}`} caption={label} path={imgPath}
            onOpen={() => callbacks.onInspect(basename(label), { type: 'image-path', path: imgPath }, label)} />;
        })}
        {mdFollowUpQuestions.length > 0 && callbacks.onOpenFollowUp && <row key="follow-up-bar" gap="xs">
          <button size="sm" variant="default" icon="chat"
            onClick={() => callbacks.onOpenFollowUp?.(
              'Follow-up questions',
              'Answer the follow-up questions below and send your reply to Antigravity.',
              mdFollowUpQuestions,
            )}>
            Answer follow-up ({mdFollowUpQuestions.length})
          </button>
        </row>}
      </message>;
      if (withDivider) {
        const pinTag = isPinned ? ' [Pinned]' : '';
        const turnLabel = callbacks.prefs.showTimestamps && entry.time ? `Turn ${turnNumber}${pinTag} · ${entry.time}` : `Turn ${turnNumber}${pinTag}`;
        return <col key={entry.id} gap="sm">
          <rule variant="note" label={turnLabel} />
          {msgNode}
        </col>;
      }
      return msgNode;
    }
    case 'thought': {
      const running = entry.endedAt === undefined && callbacks.working;
      const open = callbacks.thoughtFoldOverrides.get(entry.id) ?? (running || callbacks.prefs.thoughtExpanded);
      const elapsed = entry.endedAt !== undefined
        ? Math.max(0, entry.endedAt - entry.startedAt)
        : Math.max(0, callbacks.now - entry.startedAt);
      const topic = summarizeThoughtTopic(entry.text, 56);
      const title = running
        ? (topic
          ? [{ t: 'Thinking', fx: 'shimmer' as const }, { t: `: ${topic}`, s: 'muted' as const }]
          : [{ t: 'Thinking', fx: 'shimmer' as const }])
        : (topic
          ? [{ t: 'Thought', s: 'strong' as const }, { t: `: ${topic}`, s: 'muted' as const }]
          : 'Thought');
      return <trace key={entry.id} variant="card" role="agy.thought" icon="thinking"
        title={title}
        summary={running ? (topic ? `Thinking: ${topic}` : 'Thinking') : (topic ? `Thought: ${topic}` : 'Thought')}
        status={running ? 'running' : 'done'}
        age={running ? elapsed : undefined}
        took={running ? undefined : elapsed}
        open={open}
        onToggle={event => callbacks.onToggleThought(entry.id, event.open ?? !open)}>
        <md key="reasoning" stream={running || undefined} max={{ w: callbacks.proseMaxW ?? '80ch' }}>{entry.text}</md>
      </trace>;
    }
    case 'tool': {
      const summary = summarizeToolCall(entry.call, callbacks.cwd);
      const hasMedia = extractToolInlineImages(entry.call).length > 0 ||
        extractToolImagePaths(entry.call, callbacks.cwd).some(checkPathExists);
      const running = entry.call.status === 'in_progress' || entry.call.status === 'pending';
      const defaultCollapsed = callbacks.prefs.toolDisplay === 'expanded'
        ? !recent && !running && entry.call.status !== 'failed'
        : !((recent && (summary.hasDiff || hasMedia)) || running || entry.call.status === 'failed');
      const collapsed = callbacks.toolFoldOverrides.get(entry.id) ?? defaultCollapsed;
      const took = entry.startedAt !== undefined && entry.endedAt !== undefined
        ? Math.max(0, entry.endedAt - entry.startedAt)
        : undefined;
      const age = entry.startedAt !== undefined && entry.endedAt === undefined && running
        ? Math.max(0, callbacks.now - entry.startedAt)
        : undefined;
      const targetInfo = summary.targetKind === 'path' ? parseToolTargetPath(summary.target, callbacks.cwd) : undefined;
      const targetExists = !!targetInfo && checkPathExists(targetInfo.absPath);
      const copyableOutput = extractToolOutputText(entry.call.rawOutput);
      const toolFollowUp = callbacks.onOpenFollowUp ? extractToolFollowUpQuestions(entry.call) : undefined;
      const isPlainFileRead = entry.call.kind === 'read' && !!targetInfo && targetExists && !summary.hasDiff &&
        !hasMedia && !(entry.call.content?.length) && entry.call.rawOutput === undefined && entry.call.status !== 'failed';
      const headerActions = buildToolHeaderActions({
        kind: entry.call.kind,
        hasDiff: summary.hasDiff,
        hasCopyableOutput: !!copyableOutput,
        hasFollowUp: !!toolFollowUp,
        collapsed,
        targetExists,
        canInspectFile: !!callbacks.onInspectFile,
        canSplit: !!callbacks.onOpenSplit,
      });
      const openDetailsModal = (): void => {
        callbacks.onInspect(
          summary.title,
          { type: 'file', path: 'task.log', content: buildTaskDetailText(entry, callbacks.cwd) },
          summary.target,
        );
      };
      return <tool key={entry.id} name={summary.name}
        title={summary.title} target={summary.target} targetKind={summary.targetKind}
        frame={hasMedia ? 'card' : summary.frame} badges={summary.badges.length ? summary.badges : undefined}
        exit={summary.exit} age={age} took={took} approved={entry.approved}
        status={entry.call.status === 'in_progress' ? 'running' : entry.call.status === 'completed' ? 'done' :
          entry.call.status === 'failed' ? 'error' : 'pending'}
        collapsible collapsed={collapsed} preview={{ lines: 4 }}
        tools={headerActions}
        onAction={{
          ...(toolFollowUp && callbacks.onOpenFollowUp ? {
            'answer-followup': () => callbacks.onOpenFollowUp?.(summary.title, toolFollowUp.message, toolFollowUp.fields),
          } : {}),
          ...(targetInfo && callbacks.onInspectFile ? {
            'view-file': () => callbacks.onInspectFile?.(targetInfo.absPath, targetInfo.line),
          } : {}),
          'inspect-diff': () => {
            const diffInspect = firstToolDiffInspectTarget(entry.call, callbacks.cwd);
            if (diffInspect) callbacks.onInspect(diffInspect.title, diffInspect.target, diffInspect.subtitle);
            else openDetailsModal();
          },
          inspect: openDetailsModal,
          ...(copyableOutput ? {
            'copy-output': () => callbacks.onCopy(copyableOutput),
          } : {}),
          ...(targetInfo && callbacks.onOpenSplit ? {
            split: () => callbacks.onOpenSplit?.(targetInfo.absPath, targetInfo.line),
          } : {}),
          toggle: () => callbacks.onToggleTool(entry.id, !collapsed),
        }}
        onMenu={{
          ...(targetInfo && targetExists && callbacks.onInspectFile ? {
            'Open file in modal': () => callbacks.onInspectFile?.(targetInfo.absPath, targetInfo.line),
          } : {}),
          'Inspect task details': openDetailsModal,
          'Toggle details': () => callbacks.onToggleTool(entry.id, !collapsed),
          ...(targetInfo ? {
            'Attach path': () => callbacks.onAttachPath(targetInfo.path),
            ...(callbacks.onOpenSplit && targetExists ? {
              'Open in Tern split': () => callbacks.onOpenSplit?.(targetInfo.absPath, targetInfo.line),
            } : {}),
          } : {}),
          ...(summary.hasDiff ? { 'Review in /changes': callbacks.onOpenChanges } : {}),
        }}
        onToggle={event => {
          if (collapsed && isPlainFileRead && targetInfo && callbacks.onInspectFile) {
            callbacks.onInspectFile(targetInfo.absPath, targetInfo.line);
            return;
          }
          callbacks.onToggleTool(entry.id, event.collapsed ?? !collapsed);
        }}>
        {!collapsed ? <ToolBody call={entry.call} step={entry} cwd={callbacks.cwd} showRawInput={summary.showRawInput}
          fullCommand={summary.fullCommand} runnableCommand={summary.targetKind === 'command' ? summary.target : undefined}
          diffMode={callbacks.prefs.diffMode}
          targetInfo={targetInfo} targetExists={targetExists} summaryTitle={summary.title} summaryTarget={summary.target}
          pathExists={checkPathExists} getBlob={callbacks.getBlob} onInspect={callbacks.onInspect}
          onInspectFile={callbacks.onInspectFile} onOpenSplit={callbacks.onOpenSplit}
          onRunCommand={callbacks.onRunCommand} onAttachPath={callbacks.onAttachPath} onCopy={callbacks.onCopy} />
          : <spacer key="lazy" size="none" />}
      </tool>;
    }
    case 'plan': return <checklist key={entry.id} phases={[{ title: 'Plan', items: entry.entries.map((item, index) => ({
      id: String(index), text: item.content,
      status: item.status === 'in_progress' ? 'active' : item.status === 'completed' ? 'done' : 'pending',
    })) }]} />;
    case 'notice':
      if (entry.error) {
        return <card key={entry.id} tone="error" icon="x-circle" head="Request failed">
          <text wrap="word">{entry.text}</text>
          <buttons variant="toolbar" label="Recovery actions">
            {callbacks.canReconnect && <button size="sm" icon="repeat" onClick={callbacks.onReconnect}>Reconnect ACP</button>}
            {entry.retryable && callbacks.canRetry && <button size="sm" icon="repeat" onClick={callbacks.onRetry}>Retry</button>}
            <button variant="quiet" size="sm" icon="model" onClick={callbacks.onSwitchModel}>Switch model</button>
            {callbacks.canSwitchAccount && <button variant="quiet" size="sm" icon="user" onClick={callbacks.onSwitchAccount}>Switch account</button>}
            <button variant="quiet" size="sm" icon="info" onClick={callbacks.onOpenAccount}>Account</button>
          </buttons>
        </card>;
      }
      if (entry.action === 'load_deeper_history' && callbacks.onLoadDeeperHistory) {
        return <row key={entry.id} justify="between" align="center" gap="sm" wrap>
          <rule variant="note" icon="info" label={entry.text} />
          <button size="sm" variant="quiet" icon="history" onClick={callbacks.onLoadDeeperHistory}>
            Load older brain log
          </button>
        </row>;
      }
      return <rule key={entry.id} variant="note" icon="info" label={entry.text} />;
    case 'compaction': {
      const status = entry.status === 'failed' || entry.status === 'cancelled'
        ? 'error'
        : entry.status === 'completed' ? 'done' : 'running';
      return <trace key={entry.id} variant="summary" icon="context" title="Context compacted"
        summary={entry.status === 'completed' ? 'Context compacted' : entry.status === 'in_progress' ? 'Compacting context' : `Compaction ${entry.status}`}
        status={status}
        open={callbacks.thoughtFoldOverrides.get(entry.id) ?? (status === 'error')}
        lines={[{ id: 'body', title: 'Summary', status }]}
        onToggle={event => callbacks.onToggleThought(entry.id, event.open ?? false)}>
        <md key="body">{entry.error ? `${entry.text ? `${entry.text}\n\n` : ''}${entry.error}` : (entry.text || 'Compacting conversation history...')}</md>
      </trace>;
    }
  }
}
