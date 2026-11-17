import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type DiffMode = 'auto' | 'unified' | 'split';
export type ToolDisplay = 'compact' | 'expanded';
export type ComposerLines = 4 | 6 | 10;
export type TranscriptDensity = 'comfortable' | 'compact';
export type MotionPref = 'auto' | 'full' | 'reduced';

export const DEFAULT_MODEL_ID = 'gemini-4-hydrogen';
export const DEFAULT_THINKING_ID = 'high';

export interface UserPrefs {
  diffMode: DiffMode;
  toolDisplay: ToolDisplay;
  thoughtExpanded: boolean;
  showKeyLegend: boolean;
  composerLines: ComposerLines;
  transcriptDensity: TranscriptDensity;
  showTimestamps: boolean;
  autoPreviewMedia: boolean;
  notifyOnTurnComplete: boolean;
  rememberModel: boolean;
  maxFps: number;
  motion: MotionPref;
  lastModel?: string;
  lastThinking?: string;
}

export const DEFAULT_PREFS: Readonly<UserPrefs> = Object.freeze({
  diffMode: 'auto',
  toolDisplay: 'compact',
  thoughtExpanded: false,
  showKeyLegend: true,
  composerLines: 6,
  transcriptDensity: 'comfortable',
  showTimestamps: true,
  autoPreviewMedia: false,
  notifyOnTurnComplete: true,
  rememberModel: true,
  maxFps: 25,
  motion: 'auto',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize raw persisted JSON into validated UserPrefs with safe defaults. */
export function normalizePrefs(raw: unknown): UserPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_PREFS };
  const diffMode: DiffMode = raw.diffMode === 'unified' || raw.diffMode === 'split' ? raw.diffMode : 'auto';
  const toolDisplay: ToolDisplay = raw.toolDisplay === 'expanded' ? 'expanded' : 'compact';
  const thoughtExpanded = typeof raw.thoughtExpanded === 'boolean' ? raw.thoughtExpanded : DEFAULT_PREFS.thoughtExpanded;
  const showKeyLegend = typeof raw.showKeyLegend === 'boolean' ? raw.showKeyLegend : DEFAULT_PREFS.showKeyLegend;
  const composerLines: ComposerLines = raw.composerLines === 4 || raw.composerLines === 10 ? raw.composerLines : 6;
  const transcriptDensity: TranscriptDensity = raw.transcriptDensity === 'compact' ? 'compact' : 'comfortable';
  const showTimestamps = typeof raw.showTimestamps === 'boolean' ? raw.showTimestamps : DEFAULT_PREFS.showTimestamps;
  const autoPreviewMedia = typeof raw.autoPreviewMedia === 'boolean' ? raw.autoPreviewMedia : DEFAULT_PREFS.autoPreviewMedia;
  const notifyOnTurnComplete = typeof raw.notifyOnTurnComplete === 'boolean' ? raw.notifyOnTurnComplete : DEFAULT_PREFS.notifyOnTurnComplete;
  const rememberModel = typeof raw.rememberModel === 'boolean' ? raw.rememberModel : DEFAULT_PREFS.rememberModel;
  const maxFps = typeof raw.maxFps === 'number' && Number.isFinite(raw.maxFps)
    ? Math.min(60, Math.max(5, Math.round(raw.maxFps)))
    : DEFAULT_PREFS.maxFps;
  const motion: MotionPref = raw.motion === 'full'
    ? 'full'
    : (raw.motion === 'reduced' || raw.motion === 'reduce')
      ? 'reduced'
      : 'auto';
  const lastModel = typeof raw.lastModel === 'string' && raw.lastModel.trim() ? raw.lastModel.trim() : undefined;
  const lastThinking = typeof raw.lastThinking === 'string' && raw.lastThinking.trim() ? raw.lastThinking.trim() : undefined;
  return {
    diffMode,
    toolDisplay,
    thoughtExpanded,
    showKeyLegend,
    composerLines,
    transcriptDensity,
    showTimestamps,
    autoPreviewMedia,
    notifyOnTurnComplete,
    rememberModel,
    maxFps,
    motion,
    ...(lastModel ? { lastModel } : {}),
    ...(lastThinking ? { lastThinking } : {}),
  };
}

function decodePrefsBuffer(contents: Buffer): UserPrefs {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents);
    return normalizePrefs(JSON.parse(text));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Local UI preferences stored in user state (never affects ACP credentials or server config). */
export class PrefsStore {
  private readonly directory: string;
  private readonly filePath: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(stateDirectory?: string) {
    const xdgState = process.env.XDG_STATE_HOME;
    this.directory = resolve(stateDirectory ?? join(
      xdgState && isAbsolute(xdgState) ? xdgState : join(homedir(), '.local', 'state'),
      'agy-tern',
    ));
    this.filePath = join(this.directory, 'prefs.json');
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => {});
    return next;
  }

  loadSync(): UserPrefs {
    let contents: Buffer;
    try {
      contents = readFileSync(this.filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...DEFAULT_PREFS };
      throw error;
    }
    return decodePrefsBuffer(contents);
  }

  async load(): Promise<UserPrefs> {
    let contents: Buffer;
    try {
      contents = await readFile(this.filePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...DEFAULT_PREFS };
      throw error;
    }
    return decodePrefsBuffer(contents);
  }

  private async writeNormalized(prefs: UserPrefs): Promise<UserPrefs> {
    const normalized = normalizePrefs(prefs);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      } finally {
        await file.close();
      }
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return normalized;
  }

  async save(prefs: UserPrefs): Promise<UserPrefs> {
    return this.runSerialized(() => this.writeNormalized(prefs));
  }

  async update(patch: Partial<UserPrefs>): Promise<UserPrefs> {
    return this.runSerialized(async () => {
      const current = await this.load();
      return this.writeNormalized({ ...current, ...patch });
    });
  }

  async reset(): Promise<UserPrefs> {
    return this.save({ ...DEFAULT_PREFS });
  }
}
