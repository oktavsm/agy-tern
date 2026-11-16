/** @jsxImportSource @stencil-hq/tern */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { DiffHunk, JSX, NodeJson, Tone } from '@stencil-hq/tern';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import { contentText, type TranscriptEntry } from './model';
import type { DiffMode, UserPrefs } from './prefs';
import {
  buildUnifiedDiffHunks,
  clipDiffHunks,
  clipInlinePreview,
  extractToolImagePaths,
  extractToolInlineImages,
  extractToolOutputText,
  formatPathLabel,
  splitMarkdownSegments,
  summarizeToolCall,
} from './ui-format';

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
      const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => resolve(false));
      child.once('close', code => resolve(code === 0));
      child.stdin.end(text);
    });
    if (ok) return true;
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
  | { type: 'file'; path: string; content: string; truncated?: boolean };

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

export function ToolBody({ call, cwd, showRawInput, diffMode, getBlob, onInspect, onOpenSplit, onCopy }: {
  call: ToolCallUpdate;
  cwd: string;
  showRawInput: boolean;
  diffMode: DiffMode;
  getBlob?(key: string, data: string, mimeType: string): string | undefined;
  onInspect?(title: string, target: InspectTarget, subtitle?: string): void;
  onOpenSplit?(path: string, line?: number): void;
  onCopy?(text: string): void;
}): JSX.Element {
  const imagePaths = extractToolImagePaths(call, cwd).filter(path => existsSync(path));
  const copyableOutput = extractToolOutputText(call.rawOutput);
  return <col gap="sm">
    {showRawInput && call.rawInput !== undefined && <col key="input" gap="xs">
      <text><span s="muted">Input</span></text>
      <code wrap>{typeof call.rawInput === 'string' ? call.rawInput : JSON.stringify(call.rawInput, null, 2)}</code>
    </col>}
    {call.content?.map((content, index) => {
      if (content.type === 'content') {
        if (content.content.type === 'image') {
          const imageMime = content.content.mimeType;
          const blob = getBlob?.(`tool:${call.toolCallId}:${index}`, content.content.data, imageMime);
          if (blob) {
            return <col key={`img-${index}`} align="center" gap="xs">
              <image blob={blob} alt={imageMime} />
              {onInspect && <button size="sm" variant="quiet" icon="expand"
                onClick={() => onInspect('Live image preview', { type: 'image-blob', blob, mimeType: imageMime }, imageMime)}>
                Center preview
              </button>}
            </col>;
          }
        }
        return <md key={`content-${index}`}>{contentText(content.content)}</md>;
      }
      if (content.type === 'terminal') return <text key={`content-${index}`} wrap="char">
        Terminal reference: {content.terminalId} (terminal embedding is not enabled)
      </text>;
      const pathLabel = formatPathLabel(content.path, cwd);
      const absPath = isAbsolute(content.path) ? content.path : resolve(cwd, content.path);
      const canSplit = !!onOpenSplit && existsSync(absPath);
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
      return <col key={`media-${index}`} align="center" gap="xs">
        <media path={imgPath} />
        {onInspect && <button size="sm" variant="quiet" icon="expand"
          onClick={() => onInspect(basename(label), { type: 'image-path', path: imgPath }, label)}>
          Center preview
        </button>}
      </col>;
    })}
    {call.rawOutput !== undefined && call.rawOutput !== null && call.rawOutput !== '' && <col key="output" gap="xs">
      <ToolOutput rawOutput={call.rawOutput} />
      {onCopy && copyableOutput && <row gap="xs">
        <button size="sm" variant="quiet" icon="copy" onClick={() => onCopy(copyableOutput)}>
          Copy output
        </button>
      </row>}
    </col>}
  </col>;
}

export interface EntryCallbacks {
  cwd: string;
  working: boolean;
  now: number;
  agentStatus: Tone;
  prefs: UserPrefs;
  thoughtFoldOverrides: Map<string, boolean>;
  toolFoldOverrides: Map<string, boolean>;
  canRetry: boolean;
  canReconnect: boolean;
  canSwitchAccount: boolean;
  getBlob(key: string, data: string, mimeType: string): string | undefined;
  onInspect(title: string, target: InspectTarget, subtitle?: string): void;
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
  switch (entry.type) {
    case 'message': {
      const withDivider = entry.role === 'user' && !!turnNumber && turnNumber > 1 && showAvatar;
      const segments = entry.role === 'agent' && entry.text ? splitMarkdownSegments(entry.text) : undefined;
      const hasCodeBlocks = !!segments?.some(seg => seg.kind === 'code');
      const msgNode = <message key={withDivider ? 'msg' : entry.id} variant="auto"
        side={entry.role === 'user' ? 'end' : 'start'} author={entry.role === 'user' ? 'You' : 'Antigravity'}
        continued={continued}
        time={callbacks.prefs.showTimestamps ? entry.time : undefined}
        pending={streaming || undefined}
        status={streaming ? 'Streaming' : undefined}
        reveal="hover"
        avatar={showAvatar ? (entry.role === 'user'
          ? <avatar variant="circle" icon="user" text="You" seed="local-user" size="sm" />
          : <avatar variant="square" icon="tern" text="AG" seed="antigravity" size="sm" status={callbacks.agentStatus} />) : undefined}
        actions={entry.role === 'user'
          ? [{ act: 'copy', icon: 'copy', title: 'Copy message' }, { act: 'resend', icon: 'repeat', title: 'Load into composer' }]
          : [{ act: 'copy', icon: 'copy', title: 'Copy response' }]}
        onMenu={{
          Copy: () => callbacks.onCopy(entry.text),
          ...(entry.role === 'user' ? { 'Load into composer': () => callbacks.onResend(entry.text) } : {}),
          'Export transcript': callbacks.onExport,
        }}
        onAction={{
          copy: () => callbacks.onCopy(entry.text),
          resend: () => callbacks.onResend(entry.text),
        }}>
        {entry.images?.map((img, idx) => {
          const blob = callbacks.getBlob(`${entry.id}:img:${idx}`, img.data, img.mimeType);
          return blob ? <col key={`img-${idx}`} align="center" gap="xs">
            <image blob={blob} alt={img.mimeType} />
            <button size="sm" variant="quiet" icon="expand"
              onClick={() => callbacks.onInspect('Message image', { type: 'image-blob', blob, mimeType: img.mimeType }, img.mimeType)}>
              Center preview
            </button>
          </col> : <text key={`img-${idx}`}><span s="muted">{`[Image: ${img.mimeType}]`}</span></text>;
        })}
        {entry.text && (entry.role === 'user'
          ? <text wrap="char">{entry.text}</text>
          : hasCodeBlocks && segments
            ? <col gap="xs">
              {segments.map((seg, idx) => seg.kind === 'prose'
                ? <md key={`prose-${idx}`} max={{ w: '80ch' }}>{seg.text}</md>
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
            : <md stream={streaming} max={{ w: '80ch' }}>{entry.text}</md>)}
      </message>;
      if (withDivider) {
        const turnLabel = callbacks.prefs.showTimestamps && entry.time ? `Turn ${turnNumber} · ${entry.time}` : `Turn ${turnNumber}`;
        return <col key={entry.id} gap="sm">
          <rule variant="note" label={turnLabel} />
          {msgNode}
        </col>;
      }
      return msgNode;
    }
    case 'thought': {
      const open = callbacks.thoughtFoldOverrides.get(entry.id) ?? callbacks.prefs.thoughtExpanded;
      const running = entry.endedAt === undefined && callbacks.working;
      const elapsed = entry.endedAt !== undefined
        ? Math.max(0, entry.endedAt - entry.startedAt)
        : Math.max(0, callbacks.now - entry.startedAt);
      return <trace key={entry.id} variant="summary" icon="thinking" title="Thought"
        summary={running ? 'Thinking' : 'Thought'}
        status={running ? 'running' : 'done'}
        age={running ? elapsed : undefined}
        took={running ? undefined : elapsed}
        open={open}
        lines={[{ id: 'body', title: 'Reasoning', status: running ? 'running' : 'done' }]}
        onToggle={event => callbacks.onToggleThought(entry.id, event.open ?? !open)}>
        {open ? <md key="body">{entry.text}</md> : <spacer key="body" size="none" />}
      </trace>;
    }
    case 'tool': {
      const summary = summarizeToolCall(entry.call, callbacks.cwd);
      const hasMedia = extractToolInlineImages(entry.call).length > 0 ||
        extractToolImagePaths(entry.call, callbacks.cwd).some(path => existsSync(path));
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
      return <tool key={entry.id} name={summary.name}
        title={summary.title} target={summary.target} targetKind={summary.targetKind}
        frame={hasMedia ? 'card' : summary.frame} badges={summary.badges.length ? summary.badges : undefined}
        exit={summary.exit} age={age} took={took} approved={entry.approved}
        status={entry.call.status === 'in_progress' ? 'running' : entry.call.status === 'completed' ? 'done' :
          entry.call.status === 'failed' ? 'error' : 'pending'}
        collapsible collapsed={collapsed} preview={{ lines: 4 }}
        onMenu={{
          'Toggle details': () => callbacks.onToggleTool(entry.id, !collapsed),
          ...(summary.targetKind === 'path' && summary.target ? {
            'Attach path': () => callbacks.onAttachPath(summary.target!.replace(/:\d+$/, '')),
            ...(callbacks.onOpenSplit ? {
              'Open in Tern split': () => {
                const match = /^(.*):(\d+)$/.exec(summary.target!);
                const filePath = match ? match[1]! : summary.target!;
                const line = match ? Number(match[2]) : undefined;
                callbacks.onOpenSplit?.(filePath, line);
              },
            } : {}),
          } : {}),
          ...(summary.hasDiff ? { 'Review in /changes': callbacks.onOpenChanges } : {}),
        }}
        onToggle={event => callbacks.onToggleTool(entry.id, event.collapsed ?? !collapsed)}>
        {!collapsed ? <ToolBody call={entry.call} cwd={callbacks.cwd} showRawInput={summary.showRawInput} diffMode={callbacks.prefs.diffMode}
          getBlob={callbacks.getBlob} onInspect={callbacks.onInspect} onOpenSplit={callbacks.onOpenSplit} onCopy={callbacks.onCopy} />
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
