import { spawn } from 'node:child_process';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { SessionConfigOption, ToolCallUpdate, UsageUpdate } from '@agentclientprotocol/sdk';
import type { Chip, DiffHunk } from '@stencil-hq/tern';
import { contentText, type AgentPlan, type InlineImage, type TranscriptEntry } from './model';
import type { QuotaRow } from './reports';

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

export interface ToolSummary {
  name?: string;
  title: string;
  target?: string;
  targetKind?: 'command' | 'path' | 'pattern' | 'query' | 'text';
  frame: 'card' | 'inline';
  badges: Chip[];
  exit?: number;
  hasDiff: boolean;
  showRawInput: boolean;
}

export interface ContextUsageSummary {
  percent: number;
  usedLabel: string;
  sizeLabel: string;
  summary: string;
}

export interface PlanSummary {
  done: number;
  total: number;
  activeText?: string;
}

const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

type DiffOp = { kind: 'context' | 'remove' | 'add'; line: string; oldLine: number; newLine: number };

function lcsOps(oldBody: string[], newBody: string[], oldOffset: number, newOffset: number): DiffOp[] {
  const m = oldBody.length;
  const n = newBody.length;
  if (m === 0 && n === 0) return [];
  if (m * n > MAX_LCS_CELLS) {
    const ops: DiffOp[] = [];
    for (let i = 0; i < m; i++) ops.push({ kind: 'remove', line: oldBody[i]!, oldLine: oldOffset + i + 1, newLine: newOffset + 1 });
    for (let j = 0; j < n; j++) ops.push({ kind: 'add', line: newBody[j]!, oldLine: oldOffset + m + 1, newLine: newOffset + j + 1 });
    return ops;
  }

  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] = oldBody[i] === newBody[j]
        ? dp[(i + 1) * width + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldBody[i] === newBody[j]) {
      ops.push({ kind: 'context', line: oldBody[i]!, oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      ops.push({ kind: 'remove', line: oldBody[i]!, oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
      i++;
    } else {
      ops.push({ kind: 'add', line: newBody[j]!, oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: 'remove', line: oldBody[i]!, oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: 'add', line: newBody[j]!, oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
    j++;
  }
  return ops;
}

/** Build unified diff hunks and +/- line counts from before/after text. */
export function buildUnifiedDiffHunks(oldText: string, newText: string, contextLines = 3): DiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldBody = oldLines.slice(prefix, oldLines.length - suffix);
  const newBody = newLines.slice(prefix, newLines.length - suffix);
  const bodyOps = lcsOps(oldBody, newBody, prefix, prefix);

  let added = 0;
  let removed = 0;
  const allOps: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    allOps.push({ kind: 'context', line: oldLines[i]!, oldLine: i + 1, newLine: i + 1 });
  }
  for (const op of bodyOps) {
    if (op.kind === 'add') added++;
    if (op.kind === 'remove') removed++;
    allOps.push(op);
  }
  for (let s = 0; s < suffix; s++) {
    const oldIndex = oldLines.length - suffix + s;
    const newIndex = newLines.length - suffix + s;
    allOps.push({ kind: 'context', line: oldLines[oldIndex]!, oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }

  const changedIndices: number[] = [];
  for (let idx = 0; idx < allOps.length; idx++) {
    if (allOps[idx]!.kind !== 'context') changedIndices.push(idx);
  }
  if (!changedIndices.length) return { hunks: [], added: 0, removed: 0 };

  const ranges: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(allOps.length - 1, idx + contextLines);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const hunks: DiffHunk[] = ranges.map(([start, end]) => {
    const slice = allOps.slice(start, end + 1);
    const first = slice[0]!;
    return {
      oldStart: first.oldLine,
      newStart: first.newLine,
      lines: slice.map(op => `${op.kind === 'add' ? '+' : op.kind === 'remove' ? '-' : ' '}${op.line}`),
    };
  });

  return { hunks, added, removed };
}

/** Prefer a workspace-relative path label when inside cwd. */
export function formatPathLabel(filePath: string, cwd: string): string {
  if (!filePath || !isAbsolute(filePath)) return filePath;
  const rel = relative(cwd, filePath);
  if (!rel) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return filePath;
  return rel;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractExitCode(rawOutput: unknown): number | undefined {
  const record = asRecord(rawOutput);
  if (!record) return undefined;
  const code = record.exitCode ?? record.exit_code ?? record.code;
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined;
}

function normalizeToolName(call: ToolCallUpdate): string | undefined {
  const raw = (call.name ?? call.kind ?? '').trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === 'execute' || lower === 'run_command' || lower === 'bash' || lower === 'shell') return 'bash';
  if (lower === 'read' || lower === 'read_file') return 'read';
  if (lower === 'edit' || lower === 'edit_file' || lower === 'replace_file_content') return 'edit';
  if (lower === 'write' || lower === 'write_file' || lower === 'write_to_file') return 'write';
  if (lower === 'search' || lower === 'grep' || lower === 'find_by_name') return 'search';
  if (lower === 'fetch' || lower === 'web') return 'web';
  return raw;
}

/** Build native Tern <tool> display props from an ACP ToolCallUpdate. */
export function summarizeToolCall(call: ToolCallUpdate, cwd: string): ToolSummary {
  const input = asRecord(call.rawInput);
  const name = normalizeToolName(call);
  const loc = call.locations?.[0];
  let target: string | undefined;
  let targetKind: ToolSummary['targetKind'];

  const command = firstString(input, ['command', 'CommandLine', 'cmd']);
  const pattern = firstString(input, ['pattern', 'Query', 'query', 'regex']);
  const inputPath = firstString(input, ['path', 'file_path', 'filePath', 'target_file', 'TargetFile', 'Path']);
  const url = firstString(input, ['url', 'uri']);

  if (command && (name === 'bash' || call.kind === 'execute')) {
    target = command;
    targetKind = 'command';
  } else if (loc?.path) {
    const formatted = formatPathLabel(loc.path, cwd);
    target = loc.line == null ? formatted : `${formatted}:${loc.line}`;
    targetKind = 'path';
  } else if (inputPath) {
    target = formatPathLabel(inputPath, cwd);
    targetKind = 'path';
  } else if (pattern) {
    target = pattern;
    targetKind = name === 'search' ? 'pattern' : 'query';
  } else if (url) {
    target = url;
    targetKind = 'text';
  }

  let added = 0;
  let removed = 0;
  let hasDiff = false;
  for (const item of call.content ?? []) {
    if (item.type === 'diff') {
      hasDiff = true;
      const diff = buildUnifiedDiffHunks(item.oldText ?? '', item.newText);
      added += diff.added;
      removed += diff.removed;
    }
  }

  const badges: Chip[] = [];
  if (hasDiff) {
    if (added > 0) badges.push({ text: `+${added}`, tone: 'success' });
    if (removed > 0) badges.push({ text: `-${removed}`, tone: 'error' });
  }

  const exit = extractExitCode(call.rawOutput);
  const hasContent = (call.content?.length ?? 0) > 0;
  const hasOutput = call.rawOutput !== undefined && call.rawOutput !== null && call.rawOutput !== '';
  const failed = call.status === 'failed' || (exit !== undefined && exit !== 0);
  const lightweight = (name === 'read' || name === 'search' || name === 'think' || call.kind === 'read' || call.kind === 'search') &&
    !hasDiff && !failed && !hasContent && !hasOutput;

  return {
    name,
    title: call.title ?? call.toolCallId,
    target,
    targetKind,
    frame: lightweight ? 'inline' : 'card',
    badges,
    exit,
    hasDiff,
    showRawInput: call.rawInput !== undefined && !target && !hasContent,
  };
}

/** Format a token count compactly (e.g. 500K, 12.4K, 512). */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(tokens));
}

/** Summarize ACP usage_update into percentage and compact capacity labels. */
export function formatContextUsage(usage: UsageUpdate | undefined): ContextUsageSummary | undefined {
  if (!usage || usage.size <= 0) return undefined;
  const percent = Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 100)));
  const usedLabel = formatCompactTokens(usage.used);
  const sizeLabel = formatCompactTokens(usage.size);
  return {
    percent,
    usedLabel,
    sizeLabel,
    summary: `${percent}% · ${usedLabel}/${sizeLabel}`,
  };
}

/** Summarize the current plan entries for the compact composer HUD. */
export function formatPlanSummary(plan: AgentPlan | undefined): PlanSummary | undefined {
  if (!plan || !plan.entries.length) return undefined;
  let done = 0;
  let activeText: string | undefined;
  for (const entry of plan.entries) {
    if (entry.status === 'completed') done++;
    else if (entry.status === 'in_progress' && !activeText) activeText = entry.content;
  }
  return {
    done,
    total: plan.entries.length,
    activeText,
  };
}

/** Read the current git branch in cwd without modifying state. */
export async function detectGitBranch(cwd: string): Promise<string | undefined> {
  const run = (args: string[]) => new Promise<string | undefined>(resolve => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(undefined);
    }, 1_000);
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    child.once('close', code => {
      clearTimeout(timer);
      const branch = out.trim();
      resolve(code === 0 && branch && branch !== 'HEAD' ? branch : undefined);
    });
  });
  return (await run(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? await run(['symbolic-ref', '--short', 'HEAD']);
}

export interface QuotaMeterRow extends QuotaRow {
  fraction: number;
}

export interface QuotaSummary {
  rows: QuotaMeterRow[];
  tightest: QuotaMeterRow;
  groupCount: number;
}

/** Convert parsed CLI quota rows into meter fractions and tightest-quota summary. */
export function summarizeQuotaRows(rows: readonly QuotaRow[] | undefined): QuotaSummary | undefined {
  if (!rows?.length) return undefined;
  const meterRows: QuotaMeterRow[] = rows.map(row => {
    const pct = Number(row.remaining.slice(0, -1));
    const fraction = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 0;
    return { ...row, fraction };
  });
  let tightest = meterRows[0]!;
  const groups = new Set<string>();
  for (const row of meterRows) {
    groups.add(row.group);
    if (row.fraction < tightest.fraction) tightest = row;
  }
  return { rows: meterRows, tightest, groupCount: groups.size };
}

export interface SessionDiffItem {
  id: string;
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  newFileText?: string;
}

/** Collect all file diff/write snapshots recorded during the current conversation. */
export function collectSessionDiffs(entries: readonly TranscriptEntry[], cwd: string): SessionDiffItem[] {
  const items: SessionDiffItem[] = [];
  for (const entry of entries) {
    if (entry.type !== 'tool') continue;
    for (const [index, content] of (entry.call.content ?? []).entries()) {
      if (content.type !== 'diff') continue;
      const path = formatPathLabel(content.path, cwd);
      if (content.oldText == null) {
        const lines = splitLines(content.newText).length;
        items.push({
          id: `${entry.id}:${index}`,
          path,
          added: lines,
          removed: 0,
          hunks: [],
          newFileText: content.newText,
        });
      } else {
        const diff = buildUnifiedDiffHunks(content.oldText, content.newText);
        items.push({
          id: `${entry.id}:${index}`,
          path,
          added: diff.added,
          removed: diff.removed,
          hunks: diff.hunks,
        });
      }
    }
  }
  return items;
}

/** Find the thinking/reasoning config option advertised by ACP if any. */
export function thinkingOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find(option => option.category === 'thought_level') ?? options.find(option => option.id === 'thought_level');
}

/** Render the active conversation transcript into readable Markdown for /export. */
export function formatTranscriptMarkdown(
  entries: readonly TranscriptEntry[],
  cwd: string,
  meta: { title?: string; sessionId?: string },
): string {
  const lines: string[] = [
    `# ${meta.title || 'Antigravity Session'}`,
    '',
    `- Workspace: \`${cwd}\``,
    ...(meta.sessionId ? [`- Session ID: \`${meta.sessionId}\``] : []),
    '',
  ];
  for (const entry of entries) {
    if (entry.type === 'message') {
      lines.push(`## ${entry.role === 'user' ? 'User' : 'Antigravity'}`, '', entry.text, '');
    } else if (entry.type === 'thought') {
      lines.push('### Thought', '', entry.text, '');
    } else if (entry.type === 'plan') {
      lines.push('### Plan', '');
      for (const item of entry.entries) {
        const mark = item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '~' : ' ';
        lines.push(`- [${mark}] ${item.content}`);
      }
      lines.push('');
    } else if (entry.type === 'tool') {
      const summary = summarizeToolCall(entry.call, cwd);
      const header = [summary.name ?? 'tool', summary.title, summary.target ? `(\`${summary.target}\`)` : ''].filter(Boolean).join(' · ');
      lines.push(`### Tool: ${header}`, '');
      for (const item of entry.call.content ?? []) {
        if (item.type === 'diff') {
          lines.push(`#### ${formatPathLabel(item.path, cwd)}`, '');
          if (item.oldText == null) {
            lines.push('```', item.newText, '```', '');
          } else {
            const diff = buildUnifiedDiffHunks(item.oldText, item.newText);
            lines.push('```diff', ...diff.hunks.flatMap(h => [`@@ -${h.oldStart} +${h.newStart} @@`, ...h.lines]), '```', '');
          }
        }
      }
    } else if (entry.type === 'notice') {
      lines.push(`> ${entry.error ? 'Error' : 'Note'}: ${entry.text}`, '');
    } else if (entry.type === 'compaction') {
      lines.push(`### Context compacted (${entry.status})`, '');
      if (entry.text) lines.push(entry.text, '');
      if (entry.error) lines.push(`> Compaction error: ${entry.error}`, '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Serialize the active conversation transcript into clean JSON for `/export file.json`. */
export function formatTranscriptJson(
  entries: readonly TranscriptEntry[],
  cwd: string,
  meta: { title?: string; sessionId?: string },
): string {
  return `${JSON.stringify({
    title: meta.title || 'Antigravity Session',
    workspace: cwd,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    exportedAt: new Date().toISOString(),
    entries,
  }, null, 2)}\n`;
}

const TOOL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function looksLikeImagePath(candidate: string): boolean {
  return TOOL_IMAGE_EXTS.has(extname(candidate.trim()).toLowerCase());
}

/** Extract unique image/screenshot paths referenced by a tool call's locations, inputs, or diffs. */
export function extractToolImagePaths(call: ToolCallUpdate, cwd: string): string[] {
  const seen = new Set<string>();
  const add = (raw?: string): void => {
    if (!raw || !looksLikeImagePath(raw)) return;
    const trimmed = raw.trim();
    const resolved = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
    seen.add(resolved);
  };
  for (const loc of call.locations ?? []) add(loc.path);
  const input = call.rawInput;
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'filePath', 'target_file', 'TargetFile', 'Path', 'output', 'outputPath', 'screenshotPath']) {
      if (typeof rec[key] === 'string') add(rec[key]);
    }
  }
  for (const item of call.content ?? []) {
    if (item.type === 'diff') add(item.path);
  }
  return [...seen];
}

/** Extract inline base64 image blocks delivered inside a tool call's content array. */
export function extractToolInlineImages(call: ToolCallUpdate): InlineImage[] {
  const out: InlineImage[] = [];
  for (const item of call.content ?? []) {
    if (item.type === 'content' && item.content.type === 'image') {
      out.push({ data: item.content.data, mimeType: item.content.mimeType });
    }
  }
  return out;
}

export interface TranscriptSearchMatch {
  id: string;
  kind: 'message' | 'thought' | 'tool' | 'plan' | 'notice' | 'compaction';
  label: string;
  detail: string;
  preview: string;
  entry: TranscriptEntry;
}

/** Filter transcript entries for /find search modal. */
export function searchTranscript(entries: readonly TranscriptEntry[], cwd: string, query: string): TranscriptSearchMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: TranscriptSearchMatch[] = [];
  for (const entry of entries) {
    let label = '';
    let detail = '';
    let preview = '';
    if (entry.type === 'message') {
      label = entry.role === 'user' ? 'You' : 'Antigravity';
      detail = entry.text.replace(/\s+/g, ' ').trim().slice(0, 90) || '(image message)';
      preview = entry.text;
    } else if (entry.type === 'thought') {
      label = 'Thought';
      detail = entry.text.replace(/\s+/g, ' ').trim().slice(0, 90);
      preview = entry.text;
    } else if (entry.type === 'tool') {
      const summary = summarizeToolCall(entry.call, cwd);
      const bodyParts = (entry.call.content ?? []).map(item =>
        item.type === 'diff'
          ? `${formatPathLabel(item.path, cwd)}\n${item.newText}`
          : item.type === 'content' ? contentText(item.content) : item.terminalId);
      label = `${summary.name ?? 'tool'}: ${summary.title}`;
      detail = summary.target ?? entry.call.status ?? 'tool call';
      preview = [detail, ...bodyParts, typeof entry.call.rawOutput === 'string' ? entry.call.rawOutput : ''].filter(Boolean).join('\n\n');
    } else if (entry.type === 'plan') {
      label = 'Plan';
      detail = `${entry.entries.length} steps`;
      preview = entry.entries.map(item => `[${item.status}] ${item.content}`).join('\n');
    } else if (entry.type === 'compaction') {
      label = `Compaction (${entry.status})`;
      detail = (entry.text || entry.error || 'Context compacted').replace(/\s+/g, ' ').trim().slice(0, 90);
      preview = entry.error ? `${entry.text}\n${entry.error}`.trim() : entry.text || 'Context compacted';
    } else {
      label = entry.error ? 'Error' : 'Notice';
      detail = entry.text.replace(/\s+/g, ' ').trim().slice(0, 90);
      preview = entry.text;
    }
    const haystack = `${label} ${detail} ${preview}`.toLowerCase();
    if (!needle || haystack.includes(needle)) {
      matches.push({ id: entry.id, kind: entry.type, label, detail, preview, entry });
    }
  }
  return matches.reverse();
}
