import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionConfigOption, ToolCallUpdate, UsageUpdate } from '@agentclientprotocol/sdk';
import type { Chip, DiffHunk } from '@stencil-hq/tern';
import { contentText, type AgentPlan, type InlineImage, type ToolStep, type TranscriptEntry } from './model';
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
  fullCommand?: string;
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
const MAX_DIFF_CACHE_ENTRIES = 64;

interface DiffCacheRecord {
  oldText: string;
  newText: string;
  contextLines: number;
  result: DiffResult;
}

interface DiffCountRecord {
  oldText: string;
  newText: string;
  counts: { added: number; removed: number };
}

const DIFF_CACHE = new Map<string, DiffCacheRecord>();
const DIFF_COUNT_CACHE = new Map<string, DiffCountRecord>();

function fnv1aPair(a: string, b: string, tag: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < a.length; i++) {
    const c = a.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c << 3) | (c >>> 13)), 0x85ebca6b);
  }
  h1 = Math.imul(h1 ^ 0xff, 0x01000193);
  h2 = Math.imul(h2 ^ 0xff, 0x85ebca6b);
  for (let i = 0; i < b.length; i++) {
    const c = b.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 11)), 0x85ebca6b);
  }
  return `${h1 >>> 0}:${h2 >>> 0}:${a.length}:${b.length}:${tag}`;
}

function fnv1aSingle(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c << 3) | (c >>> 13)), 0x85ebca6b);
  }
  return `${h1 >>> 0}:${h2 >>> 0}:${text.length}`;
}

function cacheSetBounded<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

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

/** Compute +/- line counts from before/after text using 1D-DP LCS without allocating full hunks. */
export function countDiffLines(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 };
  if (!oldText) return { added: splitLines(newText).length, removed: 0 };
  if (!newText) return { added: 0, removed: splitLines(oldText).length };

  const pairKey = fnv1aPair(oldText, newText, 'count');
  const cachedCount = DIFF_COUNT_CACHE.get(pairKey);
  if (cachedCount && cachedCount.oldText === oldText && cachedCount.newText === newText) {
    cacheSetBounded(DIFF_COUNT_CACHE, pairKey, cachedCount, MAX_DIFF_CACHE_ENTRIES);
    return cachedCount.counts;
  }
  const hunkKey = fnv1aPair(oldText, newText, '3');
  const cachedHunk = DIFF_CACHE.get(hunkKey);
  if (cachedHunk && cachedHunk.oldText === oldText && cachedHunk.newText === newText && cachedHunk.contextLines === 3) {
    return { added: cachedHunk.result.added, removed: cachedHunk.result.removed };
  }

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
  const m = oldLines.length - prefix - suffix;
  const n = newLines.length - prefix - suffix;
  let counts: { added: number; removed: number };
  if (m === 0 || n === 0 || m * n > MAX_LCS_CELLS) {
    counts = { added: n, removed: m };
  } else {
    const oldBody = oldLines.slice(prefix, oldLines.length - suffix);
    const newBody = newLines.slice(prefix, newLines.length - suffix);
    const shortBody = m <= n ? oldBody : newBody;
    const longBody = m <= n ? newBody : oldBody;
    const dp = new Uint32Array(shortBody.length + 1);
    for (let i = 1; i <= longBody.length; i++) {
      let prevDiag = 0;
      const longLine = longBody[i - 1]!;
      for (let j = 1; j <= shortBody.length; j++) {
        const saved = dp[j]!;
        if (longLine === shortBody[j - 1]!) dp[j] = prevDiag + 1;
        else if (dp[j - 1]! > dp[j]!) dp[j] = dp[j - 1]!;
        prevDiag = saved;
      }
    }
    const lcsLen = dp[shortBody.length]!;
    counts = { added: n - lcsLen, removed: m - lcsLen };
  }
  cacheSetBounded(DIFF_COUNT_CACHE, pairKey, { oldText, newText, counts }, MAX_DIFF_CACHE_ENTRIES);
  return counts;
}

/** Build unified diff hunks and +/- line counts from before/after text. */
export function buildUnifiedDiffHunks(oldText: string, newText: string, contextLines = 3): DiffResult {
  const cacheKey = fnv1aPair(oldText, newText, String(contextLines));
  const cached = DIFF_CACHE.get(cacheKey);
  if (cached && cached.oldText === oldText && cached.newText === newText && cached.contextLines === contextLines) {
    cacheSetBounded(DIFF_CACHE, cacheKey, cached, MAX_DIFF_CACHE_ENTRIES);
    return cached.result;
  }
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
  if (!changedIndices.length) {
    const emptyResult: DiffResult = { hunks: [], added: 0, removed: 0 };
    cacheSetBounded(DIFF_CACHE, cacheKey, { oldText, newText, contextLines, result: emptyResult }, MAX_DIFF_CACHE_ENTRIES);
    return emptyResult;
  }

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

  const result: DiffResult = { hunks, added, removed };
  cacheSetBounded(DIFF_CACHE, cacheKey, { oldText, newText, contextLines, result }, MAX_DIFF_CACHE_ENTRIES);
  return result;
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

/** Collapse newlines/whitespace into one compact single-line summary for tool headers. */
export function compactToolHeaderText(raw: string, maxChars = 88): string {
  const single = raw.replace(/\s+/g, ' ').trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, Math.max(8, maxChars - 3)).trimEnd()}...`;
}

/** Build native Tern <tool> display props from an ACP ToolCallUpdate. */
export function summarizeToolCall(
  call: ToolCallUpdate,
  cwd: string,
  opts?: { includeDiffStats?: boolean },
): ToolSummary {
  const includeDiffStats = opts?.includeDiffStats !== false;
  const input = asRecord(call.rawInput);
  const name = normalizeToolName(call);
  const loc = call.locations?.[0];
  let target: string | undefined;
  let targetKind: ToolSummary['targetKind'];
  let fullCommand: string | undefined;

  const command = firstString(input, ['command', 'CommandLine', 'cmd']);
  const pattern = firstString(input, ['pattern', 'Query', 'query', 'regex']);
  const inputPath = firstString(input, ['path', 'file_path', 'filePath', 'target_file', 'TargetFile', 'Path']);
  const url = firstString(input, ['url', 'uri']);

  if (command && (name === 'bash' || call.kind === 'execute')) {
    target = compactToolHeaderText(command, 88);
    targetKind = 'command';
    if (command.includes('\n') || command.trim().length > 88) fullCommand = command;
  } else if (loc?.path) {
    const formatted = formatPathLabel(loc.path, cwd);
    target = loc.line == null ? formatted : `${formatted}:${loc.line}`;
    targetKind = 'path';
  } else if (inputPath) {
    target = formatPathLabel(inputPath, cwd);
    targetKind = 'path';
  } else if (pattern) {
    target = compactToolHeaderText(pattern, 80);
    targetKind = name === 'search' ? 'pattern' : 'query';
  } else if (url) {
    target = compactToolHeaderText(url, 88);
    targetKind = 'text';
  }

  let added = 0;
  let removed = 0;
  let hasDiff = false;
  for (const item of call.content ?? []) {
    if (item.type === 'diff') {
      hasDiff = true;
      if (includeDiffStats) {
        const counts = countDiffLines(item.oldText ?? '', item.newText);
        added += counts.added;
        removed += counts.removed;
      }
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

  const rawTitle = (call.title ?? call.toolCallId).trim();
  const isExecute = name === 'bash' || call.kind === 'execute';
  let title = compactToolHeaderText(rawTitle, 72);
  if (isExecute && (rawTitle.includes('\n') || rawTitle.length > 88 || (target && compactToolHeaderText(rawTitle, 88) === target))) {
    title = 'Run command';
    if (!target) {
      target = compactToolHeaderText(rawTitle, 88);
      targetKind = 'command';
      if (rawTitle.includes('\n') || rawTitle.length > 88) fullCommand = rawTitle;
    }
  }

  return {
    name,
    title,
    target,
    targetKind,
    ...(fullCommand ? { fullCommand } : {}),
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

/** Count recorded file edits/writes cheaply without computing diff hunks. */
export function countSessionDiffs(entries: readonly TranscriptEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== 'tool') continue;
    for (const content of entry.call.content ?? []) {
      if (content.type === 'diff') count++;
    }
  }
  return count;
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

function resolveLocalImageCandidate(raw: string, cwd: string): string | undefined {
  let candidate = raw.trim();
  if (!candidate || /^https?:\/\//i.test(candidate) || /^data:/i.test(candidate)) return undefined;
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }
  if (!looksLikeImagePath(candidate)) return undefined;
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
}

/** Extract unique image/screenshot paths referenced by a tool call's locations, inputs, diffs, or outputs. */
export function extractToolImagePaths(call: ToolCallUpdate, cwd: string): string[] {
  const seen = new Set<string>();
  const add = (raw?: string): void => {
    if (!raw) return;
    const resolved = resolveLocalImageCandidate(raw, cwd);
    if (resolved) seen.add(resolved);
  };
  for (const loc of call.locations ?? []) add(loc.path);
  for (const container of [call.rawInput, call.rawOutput]) {
    const rec = asRecord(container);
    if (!rec) continue;
    for (const key of ['path', 'file', 'file_path', 'filePath', 'target_file', 'TargetFile', 'Path', 'output', 'outputPath', 'screenshotPath', 'imagePath', 'url']) {
      if (typeof rec[key] === 'string') add(rec[key]);
    }
  }
  for (const item of call.content ?? []) {
    if (item.type === 'diff') add(item.path);
  }
  return [...seen];
}

/** Build plain text inspection summary for a tool step (shared by /tasks and UI inspect). */
export function buildTaskDetailText(step: ToolStep, cwd: string): string {
  const s = summarizeToolCall(step.call, cwd, { includeDiffStats: false });
  return [
    `Tool: ${s.title}`,
    ...(s.target ? [`Target: ${s.target}`] : []),
    ...(s.fullCommand ? [`Command:\n${s.fullCommand}`] : []),
    ...(step.call.rawInput !== undefined ? [`Input:\n${JSON.stringify(step.call.rawInput, null, 2)}`] : []),
    ...(step.call.rawOutput !== undefined
      ? [`Output:\n${typeof step.call.rawOutput === 'string' ? step.call.rawOutput : JSON.stringify(step.call.rawOutput, null, 2)}`]
      : []),
  ].join('\n\n');
}

/** Extract resolved local image candidates referenced via Markdown images or backticked paths inside prose without FS I/O. */
export function extractMarkdownImageCandidates(text: string, cwd: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const addCandidate = (raw: string): void => {
    const resolved = resolveLocalImageCandidate(raw, cwd);
    if (resolved) seen.add(resolved);
  };
  for (const match of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) {
    if (match[1]) addCandidate(match[1]);
  }
  for (const match of text.matchAll(/`([^\n`]+\.(?:png|jpe?g|webp|gif))`/gi)) {
    if (match[1]) addCandidate(match[1]);
  }
  return [...seen];
}

/** Extract existing local image paths referenced via Markdown images or backticked paths inside prose. */
export function extractMarkdownImagePaths(
  text: string,
  cwd: string,
  pathExists: (targetPath: string) => boolean = existsSync,
): string[] {
  return extractMarkdownImageCandidates(text, cwd).filter(pathExists);
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

interface IndexedSearchEntry {
  match: TranscriptSearchMatch;
  haystack: string;
}

interface FindIndexCacheRecord {
  revision: number;
  cwd: string;
  indexed: IndexedSearchEntry[];
}

interface FindQueryCacheRecord {
  entries: readonly TranscriptEntry[];
  revision: number;
  cwd: string;
  needle: string;
  matches: TranscriptSearchMatch[];
}

const FIND_INDEX_CACHE = new WeakMap<readonly TranscriptEntry[], FindIndexCacheRecord>();
const FIND_QUERY_CACHE = new Map<string, FindQueryCacheRecord>();
const MAX_FIND_QUERY_CACHE = 24;

function buildIndexedSearchEntry(entry: TranscriptEntry, cwd: string): IndexedSearchEntry {
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
    const summary = summarizeToolCall(entry.call, cwd, { includeDiffStats: false });
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
  return {
    match: { id: entry.id, kind: entry.type, label, detail, preview, entry },
    haystack,
  };
}

/** Cached transcript search keyed by `(entries, revision, cwd, query)`. */
export function searchTranscriptCached(
  entries: readonly TranscriptEntry[],
  revision: number,
  cwd: string,
  query: string,
): TranscriptSearchMatch[] {
  const needle = query.trim().toLowerCase();
  const queryKey = `${revision}:${cwd}:${needle}`;
  const cachedQuery = FIND_QUERY_CACHE.get(queryKey);
  if (
    cachedQuery &&
    cachedQuery.entries === entries &&
    cachedQuery.revision === revision &&
    cachedQuery.cwd === cwd &&
    cachedQuery.needle === needle
  ) {
    cacheSetBounded(FIND_QUERY_CACHE, queryKey, cachedQuery, MAX_FIND_QUERY_CACHE);
    return cachedQuery.matches;
  }

  let idxRecord = FIND_INDEX_CACHE.get(entries);
  if (!idxRecord || idxRecord.revision !== revision || idxRecord.cwd !== cwd) {
    idxRecord = {
      revision,
      cwd,
      indexed: entries.map(entry => buildIndexedSearchEntry(entry, cwd)),
    };
    FIND_INDEX_CACHE.set(entries, idxRecord);
  }

  const matches: TranscriptSearchMatch[] = [];
  for (let i = idxRecord.indexed.length - 1; i >= 0; i--) {
    const item = idxRecord.indexed[i]!;
    if (!needle || item.haystack.includes(needle)) matches.push(item.match);
  }
  cacheSetBounded(FIND_QUERY_CACHE, queryKey, { entries, revision, cwd, needle, matches }, MAX_FIND_QUERY_CACHE);
  return matches;
}

/** Filter transcript entries for /find search modal. */
export function searchTranscript(entries: readonly TranscriptEntry[], cwd: string, query: string): TranscriptSearchMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: TranscriptSearchMatch[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const item = buildIndexedSearchEntry(entries[i]!, cwd);
    if (!needle || item.haystack.includes(needle)) matches.push(item.match);
  }
  return matches;
}

const RUNNABLE_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'fish', 'console', 'terminal']);

export interface MarkdownSegment {
  kind: 'prose' | 'code';
  text: string;
  lang?: string;
  runnable?: boolean;
  closed?: boolean;
}

export function isRunnableCodeLang(lang?: string): boolean {
  const normalized = lang?.trim().toLowerCase();
  return !!normalized && RUNNABLE_LANGS.has(normalized);
}

interface MdCacheRecord {
  markdown: string;
  segments: MarkdownSegment[];
}

interface StreamMdPrefixRecord {
  prefix: string;
  segments: MarkdownSegment[];
  offset: number;
}

const MD_SEGMENT_CACHE = new Map<string, MdCacheRecord>();
const MAX_MD_CACHE_ENTRIES = 64;
const STREAM_MD_PREFIX_CACHE: StreamMdPrefixRecord[] = [];
const MAX_STREAM_PREFIX_CACHE = 8;
const STREAM_CACHE_MIN_LEN = 2_048;

function fastMarkdownKey(text: string): string {
  const len = text.length;
  if (len <= 64) return `${len}:${text}`;
  const mid = len >> 1;
  return `${len}:${text.slice(0, 20)}:${text.slice(mid - 8, mid + 8)}:${text.slice(-20)}`;
}

function trimSlice(text: string, start: number, end: number): string {
  let s = start;
  let e = end;
  while (s < e && text.charCodeAt(s) <= 32) s++;
  while (e > s && text.charCodeAt(e - 1) <= 32) e--;
  return text.slice(s, e);
}

function parseFenceOpen(text: string, lineStart: number, lineEnd: number): { char: '`' | '~'; len: number; lang: string } | undefined {
  let i = lineStart;
  let spaces = 0;
  while (i < lineEnd && spaces < 3 && text.charCodeAt(i) === 32) {
    spaces++;
    i++;
  }
  if (i >= lineEnd) return undefined;
  const ch = text.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return undefined; // '`' or '~'
  let len = 0;
  while (i < lineEnd && text.charCodeAt(i) === ch) {
    len++;
    i++;
  }
  if (len < 3) return undefined;
  const info = trimSlice(text, i, lineEnd);
  if (ch === 96 && info.includes('`')) return undefined;
  const sp = info.search(/\s/);
  const lang = sp === -1 ? info : info.slice(0, sp);
  return { char: ch === 96 ? '`' : '~', len, lang };
}

function isFenceClose(text: string, lineStart: number, lineEnd: number, fenceChar: '`' | '~', fenceLen: number): boolean {
  let i = lineStart;
  let spaces = 0;
  while (i < lineEnd && spaces < 3 && text.charCodeAt(i) === 32) {
    spaces++;
    i++;
  }
  if (i >= lineEnd) return false;
  const expected = fenceChar === '`' ? 96 : 126;
  if (text.charCodeAt(i) !== expected) return false;
  let len = 0;
  while (i < lineEnd && text.charCodeAt(i) === expected) {
    len++;
    i++;
  }
  if (len < fenceLen) return false;
  while (i < lineEnd) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 13) return false;
    i++;
  }
  return true;
}

/** Split Markdown into prose chunks and fenced code blocks for per-block copy and run controls. */
export function splitMarkdownSegments(markdown: string): MarkdownSegment[] {
  if (!markdown) return [];
  if (!markdown.includes('```') && !markdown.includes('~~~')) {
    const text = markdown.replace(/\r\n?/g, '\n').trim();
    return text ? [{ kind: 'prose', text }] : [];
  }

  const mdKey = fastMarkdownKey(markdown);
  const cached = MD_SEGMENT_CACHE.get(mdKey);
  if (cached && cached.markdown === markdown) {
    cacheSetBounded(MD_SEGMENT_CACHE, mdKey, cached, MAX_MD_CACHE_ENTRIES);
    return cached.segments;
  }

  const normalized = markdown.includes('\r') ? markdown.replace(/\r\n?/g, '\n') : markdown;
  let segments: MarkdownSegment[] = [];
  let startOffset = 0;

  if (normalized.length >= STREAM_CACHE_MIN_LEN) {
    for (let idx = STREAM_MD_PREFIX_CACHE.length - 1; idx >= 0; idx--) {
      const rec = STREAM_MD_PREFIX_CACHE[idx]!;
      if (rec.offset <= normalized.length && normalized.startsWith(rec.prefix)) {
        segments = rec.segments.slice();
        startOffset = rec.offset;
        break;
      }
    }
  }

  let proseStart = -1;
  let fenceChar: '`' | '~' | undefined;
  let fenceLen = 0;
  let fenceLang = '';
  let codeStart = 0;
  let latestStableOffset = 0;
  let latestStableCount = 0;

  const flushProse = (proseEnd: number): void => {
    if (proseStart < 0) return;
    const text = trimSlice(normalized, proseStart, proseEnd);
    if (text) segments.push({ kind: 'prose', text });
    proseStart = -1;
  };

  let lineStart = startOffset;
  const nLen = normalized.length;
  while (lineStart <= nLen) {
    const nlIdx = normalized.indexOf('\n', lineStart);
    const hasNewline = nlIdx !== -1;
    const lineEnd = hasNewline ? nlIdx : nLen;

    if (!fenceChar) {
      const opened = parseFenceOpen(normalized, lineStart, lineEnd);
      if (opened) {
        flushProse(lineStart);
        fenceChar = opened.char;
        fenceLen = opened.len;
        fenceLang = opened.lang;
        codeStart = hasNewline ? nlIdx + 1 : nLen;
      } else if (proseStart < 0) {
        proseStart = lineStart;
      }
    } else if (isFenceClose(normalized, lineStart, lineEnd, fenceChar, fenceLen)) {
      const rawEnd = lineStart > codeStart && normalized.charCodeAt(lineStart - 1) === 10 ? lineStart - 1 : lineStart;
      const code = rawEnd > codeStart ? normalized.slice(codeStart, rawEnd) : '';
      const lang = fenceLang || undefined;
      segments.push({
        kind: 'code',
        text: code,
        ...(lang ? { lang } : {}),
        runnable: isRunnableCodeLang(lang) && code.trim().length > 0,
        closed: true,
      });
      fenceChar = undefined;
      fenceLen = 0;
      fenceLang = '';
      if (hasNewline) {
        latestStableOffset = nlIdx + 1;
        latestStableCount = segments.length;
      }
    }

    if (!hasNewline) break;
    lineStart = nlIdx + 1;
  }

  if (fenceChar) {
    const code = nLen >= codeStart ? normalized.slice(codeStart, nLen) : '';
    const lang = fenceLang || undefined;
    segments.push({
      kind: 'code',
      text: code,
      ...(lang ? { lang } : {}),
      runnable: false,
      closed: false,
    });
  } else {
    flushProse(nLen);
  }

  if (normalized.length >= STREAM_CACHE_MIN_LEN && latestStableOffset > startOffset && latestStableCount > 0) {
    STREAM_MD_PREFIX_CACHE.push({
      prefix: normalized.slice(0, latestStableOffset),
      segments: segments.slice(0, latestStableCount),
      offset: latestStableOffset,
    });
    if (STREAM_MD_PREFIX_CACHE.length > MAX_STREAM_PREFIX_CACHE) {
      STREAM_MD_PREFIX_CACHE.shift();
    }
  }

  cacheSetBounded(MD_SEGMENT_CACHE, mdKey, { markdown, segments }, MAX_MD_CACHE_ENTRIES);
  return segments;
}

/** Parse standard `git diff` unified output into Tern DiffHunk blocks. */
export function parseUnifiedGitDiff(patchText: string): { hunks: DiffHunk[]; added: number; removed: number } {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let current: { oldStart: number; newStart: number; lines: string[] } | undefined;

  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    const hdr = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hdr) {
      if (current) hunks.push(current);
      current = { oldStart: Number(hdr[1]), newStart: Number(hdr[2]), lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      hunks.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith('+')) {
      added++;
      current.lines.push(line);
    } else if (line.startsWith('-')) {
      removed++;
      current.lines.push(line);
    } else if (line.startsWith(' ')) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return { hunks, added, removed };
}

/** Clip multi-line preview text for compact inline tool cards while keeping full copy/fullscreen intact. */
export function clipInlinePreview(text: string, maxLines = 24, maxChars = 3_000): { text: string; truncated: boolean } {
  const sliced = text.length > maxChars ? text.slice(0, maxChars) : text;
  const lines = sliced.split('\n');
  if (lines.length <= maxLines && text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

/** Clip diff hunks to a bounded inline preview line count to keep Tern DOM light. */
export function clipDiffHunks(hunks: readonly DiffHunk[], maxLines = 32): { hunks: DiffHunk[]; truncated: boolean } {
  const out: DiffHunk[] = [];
  let remaining = maxLines;
  for (const hunk of hunks) {
    if (remaining <= 0) return { hunks: out, truncated: true };
    if (hunk.lines.length <= remaining) {
      out.push(hunk);
      remaining -= hunk.lines.length;
    } else {
      out.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: hunk.lines.slice(0, remaining) });
      return { hunks: out, truncated: true };
    }
  }
  return { hunks: out, truncated: false };
}

/** Extract clean copyable text from a tool call's rawOutput payload. */
export function extractToolOutputText(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null || rawOutput === '') return undefined;
  if (typeof rawOutput === 'string') {
    const cleaned = rawOutput.trimEnd();
    return cleaned ? cleaned : undefined;
  }
  if (typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
    const rec = rawOutput as Record<string, unknown>;
    const stdout = typeof rec.stdout === 'string' ? rec.stdout.trimEnd() : undefined;
    const stderr = typeof rec.stderr === 'string' ? rec.stderr.trimEnd() : undefined;
    if (stdout !== undefined || stderr !== undefined) {
      const joined = [stdout, stderr].filter(Boolean).join('\n');
      return joined || undefined;
    }
  }
  return JSON.stringify(rawOutput, null, 2);
}

export interface ResponsiveLayout {
  panelSize: 'lg' | 'full';
  inspectSize: 'lg' | 'full';
  proseMaxW: `${number}ch`;
  scrollMaxH: `${number}lines`;
  inspectBodyMaxH: `${number}lines`;
  approvalBodyMaxH: `${number}lines`;
  composerMaxLines: number;
  dockPopupMaxLines: number;
  modalListMaxLines: number;
  dirListMaxLines: number;
  showKeyLegend: boolean;
  compactEmpty: boolean;
}

export interface ResponsiveLayoutInput {
  userComposerLines: number;
  userShowKeyLegend: boolean;
  hasPermission: boolean;
  hasSuggestionsOrAt: boolean;
  queuedCount: number;
  hasAttachments: boolean;
  hasImageAttachments: boolean;
  hasHud: boolean;
}

/** Derive responsive bounds for transcript scrollback, prose measure, dock, and modals from terminal size. */
export function computeResponsiveLayout(
  cols: number,
  rows: number,
  opts: ResponsiveLayoutInput,
): ResponsiveLayout {
  const safeCols = Math.max(30, Math.round(cols));
  const safeRows = Math.max(12, Math.round(rows));
  const compactWidth = safeCols < 84;
  const compactHeight = safeRows < 26;
  const panelSize: 'lg' | 'full' = compactWidth || compactHeight ? 'full' : 'lg';
  const inspectSize: 'lg' | 'full' = safeCols >= 104 || compactWidth || compactHeight ? 'full' : 'lg';
  const proseMaxW = `${Math.max(34, Math.min(116, safeCols - 12))}ch` as const;
  const showKeyLegend = (opts.userShowKeyLegend && safeRows >= 18) || opts.hasPermission;
  const composerMaxLines = Math.min(opts.userComposerLines, Math.max(2, Math.floor(safeRows * 0.25)));
  const dockPopupMaxLines = safeRows < 20 ? 3 : safeRows < 28 ? 4 : 6;
  const modalListMaxLines = Math.max(4, Math.min(12, Math.floor(safeRows * 0.45)));
  const dirListMaxLines = Math.max(6, Math.min(24, safeRows - 14));
  const inspectBodyMaxH = `${Math.max(5, safeRows - 9)}lines` as const;
  const approvalBodyLines = Math.max(4, Math.min(10, Math.floor(safeRows * 0.3)));
  const approvalBodyMaxH = `${approvalBodyLines}lines` as const;
  const compactEmpty = safeRows < 22 || safeCols < 56;

  const baseDock = 5 + (showKeyLegend ? (safeCols < 80 ? 2 : 1) : 0);
  const popupRows = opts.hasPermission
    ? approvalBodyLines + 4
    : opts.hasSuggestionsOrAt
      ? dockPopupMaxLines + 1
      : 0;
  const attachRows = opts.hasAttachments ? (opts.hasImageAttachments ? 4 : 2) : 0;
  const hudRows = opts.hasHud ? 2 : 0;
  const queuedRows = opts.queuedCount ? Math.min(opts.queuedCount * 2, 4) : 0;
  const reserved = Math.min(safeRows - 4, baseDock + popupRows + attachRows + hudRows + queuedRows);
  const scrollMaxH = `${Math.max(4, safeRows - reserved)}lines` as const;

  return {
    panelSize,
    inspectSize,
    proseMaxW,
    scrollMaxH,
    inspectBodyMaxH,
    approvalBodyMaxH,
    composerMaxLines,
    dockPopupMaxLines,
    modalListMaxLines,
    dirListMaxLines,
    showKeyLegend,
    compactEmpty,
  };
}
