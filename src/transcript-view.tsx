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
  extractToolImagePaths,
  extractToolInlineImages,
  formatPathLabel,
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
    return <code wrap>{rawOutput}</code>;
  }
  if (typeof rawOutput === 'object' && rawOutput !== null && !Array.isArray(rawOutput)) {
    const record = rawOutput as Record<string, unknown>;
    const stdout = typeof record.stdout === 'string' ? record.stdout : undefined;
    const stderr = typeof record.stderr === 'string' ? record.stderr : undefined;
    if (stdout !== undefined || stderr !== undefined) {
      return <col gap="xs">
        {stdout && <code wrap>{stdout}</code>}
        {stderr && <code wrap>{stderr}</code>}
      </col>;
    }
  }
  return <code wrap>{JSON.stringify(rawOutput, null, 2)}</code>;
}

export function ToolBody({ call, cwd, showRawInput, diffMode, getBlob, onInspect, onOpenSplit }: {
  call: ToolCallUpdate;
  cwd: string;
  showRawInput: boolean;
  diffMode: DiffMode;
  getBlob?(key: string, data: string, mimeType: string): string | undefined;
  onInspect?(title: string, target: InspectTarget, subtitle?: string): void;
  onOpenSplit?(path: string, line?: number): void;
}): JSX.Element {
  const imagePaths = extractToolImagePaths(call, cwd).filter(path => existsSync(path));
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
        return <col key={`content-${index}`} gap="xs">
          <code numbers path={pathLabel}>{content.newText}</code>
          {(onInspect || canSplit) && <row gap="xs">
            {onInspect && <button size="sm" variant="quiet" icon="expand"
              onClick={() => onInspect(basename(pathLabel), { type: 'file', path: pathLabel, content: content.newText }, pathLabel)}>
              Fullscreen
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
      return <col key={`content-${index}`} gap="xs">
        <diff path={pathLabel} hunks={diff.hunks} mode={diffMode} />
        {(onInspect || canSplit) && <row gap="xs">
          {onInspect && <button size="sm" variant="quiet" icon="expand"
            onClick={() => onInspect(basename(pathLabel), { type: 'diff', path: pathLabel, hunks: diff.hunks }, pathLabel)}>
            Fullscreen diff
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
  canSwitchAccount: boolean;
  getBlob(key: string, data: string, mimeType: string): string | undefined;
  onInspect(title: string, target: InspectTarget, subtitle?: string): void;
  onToggleThought(id: string, open: boolean): void;
  onToggleTool(id: string, collapsed: boolean): void;
  onRetry(): void;
  onSwitchModel(): void;
  onSwitchAccount(): void;
  onOpenAccount(): void;
  onOpenChanges(): void;
  onOpenSplit?(path: string, line?: number): void;
  onAttachPath(path: string): void;
  onExport(): void;
  onCopy(text: string): void;
  onResend(text: string): void;
}

export function Entry({ entry, continued, streaming, turnNumber, callbacks }: {
  entry: TranscriptEntry;
  continued?: boolean;
  streaming?: boolean;
  turnNumber?: number;
  callbacks: EntryCallbacks;
}): JSX.Element {
  const showAvatar = callbacks.prefs.transcriptDensity !== 'compact';
  switch (entry.type) {
    case 'message': {
      const msgNode = <message key={entry.id} variant="auto"
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
        {entry.text && (entry.role === 'user' ? <text wrap="char">{entry.text}</text> :
          <md stream={callbacks.working} max={{ w: '80ch' }}>{entry.text}</md>)}
      </message>;
      if (entry.role === 'user' && turnNumber && turnNumber > 1 && showAvatar) {
        const turnLabel = callbacks.prefs.showTimestamps && entry.time ? `Turn ${turnNumber} · ${entry.time}` : `Turn ${turnNumber}`;
        return <col key={`turn-${entry.id}`} gap="sm">
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
        <md key="body">{entry.text}</md>
      </trace>;
    }
    case 'tool': {
      const summary = summarizeToolCall(entry.call, callbacks.cwd);
      const hasMedia = extractToolInlineImages(entry.call).length > 0 ||
        extractToolImagePaths(entry.call, callbacks.cwd).some(path => existsSync(path));
      const running = entry.call.status === 'in_progress' || entry.call.status === 'pending';
      const defaultCollapsed = callbacks.prefs.toolDisplay === 'expanded' ? false : !summary.hasDiff && !hasMedia && entry.call.status !== 'failed';
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
        <ToolBody call={entry.call} cwd={callbacks.cwd} showRawInput={summary.showRawInput} diffMode={callbacks.prefs.diffMode}
          getBlob={callbacks.getBlob} onInspect={callbacks.onInspect} onOpenSplit={callbacks.onOpenSplit} />
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
