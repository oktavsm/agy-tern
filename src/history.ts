import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptEntry } from './model';

const MAX_STORE_ENTRIES = 100;
const MAX_STORE_FILES = 30;
const MAX_PROMPT_HISTORY = 50;
const MAX_READ_BYTES = 1_500_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoadedTranscript {
  entries: TranscriptEntry[];
  truncated: boolean;
  source: 'cache' | 'brain';
}

/** Prefer whichever local history source holds richer/newer entries (e.g. session continued externally). */
export function selectRicherTranscript(
  cache: LoadedTranscript | undefined,
  brain: LoadedTranscript | undefined,
): LoadedTranscript | undefined {
  if (!cache) return brain;
  if (!brain) return cache;
  if (brain.entries.length > cache.entries.length) return brain;
  return cache;
}

function defaultPromptHistoryDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  return join(
    xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'),
    'agy-tern',
    'prompt-history',
  );
}

/** Persistent per-workspace prompt history under `$XDG_STATE_HOME/agy-tern/prompt-history` (`0700`/`0600`). */
export class PromptHistoryStore {
  private readonly directory: string;
  private readonly filePath: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, stateDirectory?: string) {
    const cleanCwd = resolve(cwd);
    this.directory = resolve(stateDirectory ?? defaultPromptHistoryDir());
    const digest = createHash('sha256').update(cleanCwd).digest('hex').slice(0, 32);
    this.filePath = join(this.directory, `${digest}.json`);
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async load(): Promise<string[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: number; prompts?: unknown };
      if (parsed?.version !== 1 || !Array.isArray(parsed.prompts)) return [];
      return parsed.prompts
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(-MAX_PROMPT_HISTORY);
    } catch {
      return [];
    }
  }

  private async writePrompts(sliced: string[]): Promise<string[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify({ version: 1, updatedAt: Date.now(), prompts: sliced }), 'utf8');
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return sliced;
  }

  async save(prompts: readonly string[]): Promise<void> {
    await this.runSerialized(async () => {
      const cleaned: string[] = [];
      for (const rawItem of prompts) {
        const item = rawItem.trim();
        if (!item) continue;
        if (cleaned.at(-1) !== item) cleaned.push(item);
      }
      const sliced = cleaned.slice(-MAX_PROMPT_HISTORY);
      if (!sliced.length) return;
      await this.writePrompts(sliced);
    });
  }

  /** Reload disk history and merge a new prompt atomically so concurrent terminals never clobber each other. */
  async append(prompt: string): Promise<string[]> {
    const clean = prompt.trim();
    if (!clean) return this.load();
    return this.runSerialized(async () => {
      const existing = await this.load();
      const merged = existing.at(-1) === clean ? existing : [...existing, clean].slice(-MAX_PROMPT_HISTORY);
      return this.writePrompts(merged);
    });
  }
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
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, stateDirectory?: string) {
    this.cwd = resolve(cwd);
    this.directory = resolve(stateDirectory ?? defaultStateDir());
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  private fileNameFor(sessionId: string): string | undefined {
    const clean = sessionId.trim();
    if (!clean || /[\0-\u001f\u007f]/.test(clean)) return undefined;
    const digest = createHash('sha256').update(`${this.cwd}\n${clean}`).digest('hex').slice(0, 32);
    return `${digest}.json`;
  }

  private filePathFor(sessionId: string): string | undefined {
    const name = this.fileNameFor(sessionId);
    return name ? join(this.directory, name) : undefined;
  }

  async listCachedFiles(): Promise<Set<string>> {
    try {
      return new Set(await readdir(this.directory));
    } catch {
      return new Set();
    }
  }

  hasKnownFile(sessionId: string, knownFiles: ReadonlySet<string>): boolean {
    const name = this.fileNameFor(sessionId);
    return Boolean(name && knownFiles.has(name));
  }

  async save(sessionId: string, entries: readonly TranscriptEntry[]): Promise<void> {
    await this.runSerialized(async () => {
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
    });
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
  searchText?: string;
  truncated: boolean;
}

const MAX_SEARCH_TEXT_CHARS = 8_000;

/** List brain UUID folders present on disk once so batch preview scanning avoids per-session ENOENT probes. */
export async function listAvailableBrainSessionIds(appDataDir?: string): Promise<Set<string>> {
  const baseDir = resolve(appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli'));
  try {
    const entries = await readdir(join(baseDir, 'brain'));
    return new Set(entries.filter(id => UUID_RE.test(id)));
  } catch {
    return new Set();
  }
}

/** Extract compact preview metadata + searchable message text from transcript entries. */
export function buildSessionPreviewFromEntries(
  entries: readonly TranscriptEntry[],
  source: 'cache' | 'brain',
  truncated: boolean,
): SessionPreview {
  let lastUser: string | undefined;
  let lastAgent: string | undefined;
  let messageCount = 0;
  let toolCount = 0;
  const searchChunks: string[] = [];
  let searchChars = 0;
  for (const entry of entries) {
    if (entry.type === 'tool') toolCount++;
    else if (entry.type === 'message') {
      messageCount++;
      const normalized = entry.text.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const line = normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
      if (entry.role === 'user') lastUser = line;
      else if (entry.role === 'agent') lastAgent = line;
      if (searchChars < MAX_SEARCH_TEXT_CHARS) {
        const remaining = MAX_SEARCH_TEXT_CHARS - searchChars;
        const chunk = normalized.slice(0, remaining).toLowerCase();
        searchChunks.push(chunk);
        searchChars += chunk.length + 1;
      }
    }
  }
  const searchText = searchChunks.join(' ');
  return {
    source,
    entryCount: entries.length,
    messageCount,
    toolCount,
    ...(lastUser ? { lastUser } : {}),
    ...(lastAgent ? { lastAgent } : {}),
    ...(searchText ? { searchText } : {}),
    truncated,
  };
}

/** Read a lightweight last-turn preview + chat search text for `/sessions` without invoking ACP `session/load`. */
export async function readSessionPreview(
  sessionId: string,
  store?: TranscriptStore,
  options?: {
    appDataDir?: string;
    maxReadBytes?: number;
    maxEntries?: number;
    knownCacheFiles?: ReadonlySet<string>;
    knownBrainIds?: ReadonlySet<string>;
  },
): Promise<SessionPreview | undefined> {
  const canCheckCache = store && (!options?.knownCacheFiles || store.hasKnownFile(sessionId, options.knownCacheFiles));
  const cacheLoaded = canCheckCache ? await store.load(sessionId) : undefined;
  if (cacheLoaded) {
    return buildSessionPreviewFromEntries(cacheLoaded.entries, cacheLoaded.source, cacheLoaded.truncated);
  }
  const canCheckBrain = !options?.knownBrainIds || options.knownBrainIds.has(sessionId.trim());
  if (!canCheckBrain) return undefined;
  const brainLoaded = await readOfficialBrainTranscript(sessionId, {
    appDataDir: options?.appDataDir,
    maxReadBytes: options?.maxReadBytes ?? 160_000,
    maxEntries: options?.maxEntries ?? 40,
  });
  if (!brainLoaded) return undefined;
  return buildSessionPreviewFromEntries(brainLoaded.entries, brainLoaded.source, brainLoaded.truncated);
}
