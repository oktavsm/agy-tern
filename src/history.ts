import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptEntry } from './model';

const MAX_STORE_ENTRIES = 100;
const MAX_STORE_FILES = 30;
const MAX_READ_BYTES = 1_500_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoadedTranscript {
  entries: TranscriptEntry[];
  truncated: boolean;
  source: 'cache' | 'brain';
}

function sanitizeEntryForDisk(entry: TranscriptEntry): TranscriptEntry | undefined {
  if (entry.type === 'notice' && !entry.error) return undefined;
  if (entry.type === 'message' && entry.images?.length) {
    // Drop heavy base64 image payloads from disk snapshots so state stays small and fast.
    const labels = entry.images.map(img => `[Image: ${img.mimeType}]`).join(' ');
    const text = entry.text ? `${labels}\n\n${entry.text}` : labels;
    return { type: 'message', id: entry.id, role: entry.role, text, ...(entry.time ? { time: entry.time } : {}) };
  }
  return entry;
}

function defaultStateDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  return join(
    xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'),
    'agy-tern',
    'transcripts',
  );
}

/** Local UI transcript snapshot store under `$XDG_STATE_HOME/agy-tern/transcripts` (`0700`/`0600`). */
export class TranscriptStore {
  private readonly directory: string;
  private readonly cwd: string;

  constructor(cwd: string, stateDirectory?: string) {
    this.cwd = resolve(cwd);
    this.directory = resolve(stateDirectory ?? defaultStateDir());
  }

  private filePathFor(sessionId: string): string | undefined {
    const clean = sessionId.trim();
    if (!clean || /[\0-\u001f\u007f]/.test(clean)) return undefined;
    const digest = createHash('sha256').update(`${this.cwd}\n${clean}`).digest('hex').slice(0, 32);
    return join(this.directory, `${digest}.json`);
  }

  async save(sessionId: string, entries: readonly TranscriptEntry[]): Promise<void> {
    const target = this.filePathFor(sessionId);
    if (!target) return;
    const cleaned: TranscriptEntry[] = [];
    for (const entry of entries) {
      const sanitized = sanitizeEntryForDisk(entry);
      if (sanitized) cleaned.push(sanitized);
    }
    if (!cleaned.some(entry => entry.type === 'message')) return;
    const truncated = cleaned.length > MAX_STORE_ENTRIES;
    const sliced = truncated ? cleaned.slice(-MAX_STORE_ENTRIES) : cleaned;
    const payload = JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      truncated,
      entries: sliced,
    });

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(payload, 'utf8');
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    void this.pruneOldFiles().catch(() => {});
  }

  async load(sessionId: string): Promise<LoadedTranscript | undefined> {
    const target = this.filePathFor(sessionId);
    if (!target) return undefined;
    let raw: Buffer;
    try {
      raw = await readFile(target);
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as {
        version?: number;
        truncated?: boolean;
        entries?: unknown;
      };
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return undefined;
      const entries = parsed.entries.filter((item): item is TranscriptEntry =>
        typeof item === 'object' && item !== null && 'type' in item && 'id' in item);
      if (!entries.length) return undefined;
      return { entries, truncated: Boolean(parsed.truncated), source: 'cache' };
    } catch {
      return undefined;
    }
  }

  private async pruneOldFiles(): Promise<void> {
    const files = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    if (files.length <= MAX_STORE_FILES) return;
    const dated = await Promise.all(files.map(async name => {
      const full = join(this.directory, name);
      const info = await stat(full).catch(() => undefined);
      return { full, mtime: info?.mtimeMs ?? 0 };
    }));
    dated.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(dated.slice(MAX_STORE_FILES).map(item => rm(item.full, { force: true })));
  }
}

function unquoteJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeBrainArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args as Record<string, unknown>)) {
    out[key] = unquoteJsonValue(val);
  }
  return out;
}

function mapBrainToolKind(name: string): ToolCallUpdate['kind'] {
  const lower = name.toLowerCase();
  if (lower.includes('read') || lower === 'list_dir') return 'read';
  if (lower.includes('edit') || lower.includes('write')) return 'edit';
  if (lower.includes('command') || lower.includes('bash') || lower === 'execute') return 'execute';
  if (lower.includes('grep') || lower.includes('find') || lower.includes('search')) return 'search';
  return 'other';
}

function formatClockHHMM(isoTimestamp?: string): string | undefined {
  if (!isoTimestamp) return undefined;
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toTimeString().slice(0, 5);
}

function cleanUserPromptText(raw: string): string {
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  if (reqMatch?.[1]) return reqMatch[1].trim();
  return raw.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '').trim();
}

interface RawBrainStep {
  step_index?: number;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
}

/**
 * Read-only bounded tail parser for official Antigravity CLI `transcript.jsonl` logs.
 * Never reads credential files or modifies CLI state; returns `undefined` when absent/invalid.
 */
export async function readOfficialBrainTranscript(
  sessionId: string,
  options?: { appDataDir?: string; maxEntries?: number; maxReadBytes?: number },
): Promise<LoadedTranscript | undefined> {
  const cleanId = sessionId.trim();
  if (!UUID_RE.test(cleanId)) return undefined;
  const baseDir = resolve(options?.appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli'));
  const logPath = join(baseDir, 'brain', cleanId, '.system_generated', 'logs', 'transcript.jsonl');
  let tailText = '';
  let byteOffset = 0;
  try {
    const file = await open(logPath, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0) return undefined;
      const cap = options?.maxReadBytes ?? MAX_READ_BYTES;
      byteOffset = Math.max(0, info.size - cap);
      const length = info.size - byteOffset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buf, 0, length, byteOffset);
      tailText = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }

  const rawLines = tailText.split(/\r?\n/);
  if (byteOffset > 0) rawLines.shift();
  const steps: RawBrainStep[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line) as RawBrainStep);
    } catch {
      // Ignore malformed trailing line safely.
    }
  }
  if (!steps.length) return undefined;

  const projected: TranscriptEntry[] = [];
  let seq = 0;
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    const time = formatClockHHMM(step.created_at);
    const ts = step.created_at ? Date.parse(step.created_at) : undefined;
    if (step.type === 'USER_INPUT' && step.content) {
      const cleaned = cleanUserPromptText(step.content);
      if (cleaned) {
        projected.push({
          type: 'message',
          id: `entry-${++seq}`,
          role: 'user',
          text: cleaned,
          ...(time ? { time } : {}),
        });
      }
    } else if (step.type === 'PLANNER_RESPONSE') {
      if (step.thinking?.trim()) {
        projected.push({
          type: 'thought',
          id: `entry-${++seq}`,
          text: step.thinking.trim(),
          startedAt: Number.isFinite(ts) ? ts! : 0,
          endedAt: Number.isFinite(ts) ? ts! : 0,
        });
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length) {
        const genericResults: string[] = [];
        while (i + 1 < steps.length && steps[i + 1]?.type === 'GENERIC') {
          i++;
          const g = steps[i]!;
          if (g.content) genericResults.push(g.content);
        }
        calls.forEach((tc, idx) => {
          const name = tc.name?.trim() || 'tool';
          const outText = genericResults[idx];
          projected.push({
            type: 'tool',
            id: `entry-${++seq}`,
            call: {
              toolCallId: tc.id?.trim() || `brain-tool-${seq}-${idx}`,
              name,
              kind: mapBrainToolKind(name),
              title: name,
              status: step.status === 'ERROR' ? 'failed' : 'completed',
              rawInput: normalizeBrainArgs(tc.args),
              ...(outText ? { rawOutput: outText } : {}),
            },
          });
        });
      }
      if (step.content?.trim()) {
        projected.push({
          type: 'message',
          id: `entry-${++seq}`,
          role: 'agent',
          text: step.content.trim(),
          ...(time ? { time } : {}),
        });
      }
    } else if (step.type === 'ERROR_MESSAGE' && step.content?.trim()) {
      projected.push({
        type: 'notice',
        id: `entry-${++seq}`,
        text: step.content.trim(),
        error: true,
      });
    }
    i++;
  }

  if (!projected.some(entry => entry.type === 'message')) return undefined;
  const maxEntries = options?.maxEntries ?? 80;
  const truncated = byteOffset > 0 || projected.length > maxEntries;
  return {
    entries: projected.length > maxEntries ? projected.slice(-maxEntries) : projected,
    truncated,
    source: 'brain',
  };
}

export interface SessionPreview {
  source: 'cache' | 'brain';
  entryCount: number;
  messageCount: number;
  toolCount: number;
  lastUser?: string;
  lastAgent?: string;
  truncated: boolean;
}

function compactPreviewLine(raw: string, maxLen = 140): string {
  const single = raw.replace(/\s+/g, ' ').trim();
  return single.length > maxLen ? `${single.slice(0, maxLen - 3)}...` : single;
}

/** Read a lightweight last-turn preview for `/sessions` without invoking ACP `session/load`. */
export async function readSessionPreview(
  sessionId: string,
  store?: TranscriptStore,
  options?: { appDataDir?: string; maxReadBytes?: number },
): Promise<SessionPreview | undefined> {
  const loaded = (await store?.load(sessionId)) ??
    (await readOfficialBrainTranscript(sessionId, {
      appDataDir: options?.appDataDir,
      maxReadBytes: options?.maxReadBytes ?? 280_000,
      maxEntries: 30,
    }));
  if (!loaded) return undefined;
  let lastUser: string | undefined;
  let lastAgent: string | undefined;
  let messageCount = 0;
  let toolCount = 0;
  for (const entry of loaded.entries) {
    if (entry.type === 'tool') toolCount++;
    else if (entry.type === 'message') {
      messageCount++;
      const text = compactPreviewLine(entry.text);
      if (!text) continue;
      if (entry.role === 'user') lastUser = text;
      else if (entry.role === 'agent') lastAgent = text;
    }
  }
  return {
    source: loaded.source,
    entryCount: loaded.entries.length,
    messageCount,
    toolCount,
    ...(lastUser ? { lastUser } : {}),
    ...(lastAgent ? { lastAgent } : {}),
    truncated: loaded.truncated,
  };
}
