/** @jsxImportSource @stencil-hq/tern */
import { access } from 'node:fs/promises';
import type { JSX, Op, OpenOptions, Renderable, TspEvent } from '@stencil-hq/tern';
import type { AgentPlan, TranscriptEntry } from './model';
import type { MotionPref } from './prefs';

export interface TernSurfaceLike {
  readonly id: string;
  readonly closed: boolean;
  readonly blocked: boolean;
  render(view: Renderable): void;
  send(ops: readonly Op[]): void;
  focus(id: string | null): void;
  reveal(id: string, at?: 'start' | 'center' | 'end' | 'nearest'): void;
  scroll(id: string, to: 'start' | 'end' | 'page-up' | 'page-down'): void;
}

export interface TernSessionCapsLike {
  readonly cols: number;
  readonly dark: boolean;
  readonly reduceMotion: boolean;
  readonly features: readonly string[];
}

export interface TernSessionLike {
  readonly caps: TernSessionCapsLike;
  open(options?: OpenOptions): TernSurfaceLike;
}

export interface RenderTimerAdapter {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const DEFAULT_TIMERS: RenderTimerAdapter = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const DEFAULT_PATH_TTL_MS = 15_000;
const MAX_PATH_CACHE_ENTRIES = 512;

/**
 * Non-blocking path existence cache for render hot paths.
 * Synchronous `peek()` never performs filesystem I/O; misses queue an async `access()` probe.
 */
export class AsyncPathPresenceCache {
  private readonly cache = new Map<string, { exists: boolean; at: number }>();
  private readonly inFlight = new Set<string>();
  private _version = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly probeFn: (targetPath: string) => Promise<boolean>;
  private readonly nowFn: () => number;

  constructor(opts?: {
    ttlMs?: number;
    maxEntries?: number;
    probeFn?: (targetPath: string) => Promise<boolean>;
    nowFn?: () => number;
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_PATH_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? MAX_PATH_CACHE_ENTRIES;
    this.nowFn = opts?.nowFn ?? (() => Date.now());
    this.probeFn = opts?.probeFn ?? (async targetPath => {
      try {
        await access(targetPath);
        return true;
      } catch {
        return false;
      }
    });
  }

  get version(): number {
    return this._version;
  }

  peek(targetPath: string, onResolved?: () => void): boolean {
    if (!targetPath || targetPath.includes('\0')) return false;
    const now = this.nowFn();
    const cached = this.cache.get(targetPath);
    if (cached && now - cached.at <= this.ttlMs) {
      return cached.exists;
    }
    const previous = cached?.exists;
    if (!this.inFlight.has(targetPath)) {
      this.inFlight.add(targetPath);
      void this.probeFn(targetPath).then(exists => {
        this.inFlight.delete(targetPath);
        this.setCached(targetPath, exists, this.nowFn());
        if (exists !== (previous ?? false)) {
          this._version++;
          onResolved?.();
        }
      }).catch(() => {
        this.inFlight.delete(targetPath);
      });
    }
    return previous ?? false;
  }

  async probe(targetPath: string): Promise<boolean> {
    if (!targetPath || targetPath.includes('\0')) return false;
    const now = this.nowFn();
    const cached = this.cache.get(targetPath);
    if (cached && now - cached.at <= this.ttlMs) return cached.exists;
    const exists = await this.probeFn(targetPath).catch(() => false);
    this.setCached(targetPath, exists, this.nowFn());
    return exists;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this._version++;
  }

  private setCached(targetPath: string, exists: boolean, at: number): void {
    if (this.cache.has(targetPath)) this.cache.delete(targetPath);
    else if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(targetPath, { exists, at });
  }
}

export interface RenderedEntryRecord {
  wireId: string;
  sig: string;
  settled: boolean;
  node: JSX.Element;
}

export interface TernRenderControllerOptions {
  session: TernSessionLike;
  surface?: TernSurfaceLike;
  mode?: 'inline' | 'screen';
  adopt?: boolean;
  title: string;
  font?: 'sans' | 'mono';
  entryContainerId?: string;
  maxFps?: number;
  motion?: MotionPref;
  initialCols?: number;
  initialRows?: number;
  timers?: RenderTimerAdapter;
}

function clampFps(fps: number | undefined): number {
  if (typeof fps !== 'number' || !Number.isFinite(fps)) return 25;
  return Math.min(60, Math.max(5, Math.round(fps)));
}

/** Determine whether a transcript entry is settled (unlikely to mutate without user interaction). */
export function isEntrySettled(
  entry: TranscriptEntry,
  globalIdx: number,
  totalEntries: number,
  busy: boolean,
  replayingHistory: boolean,
  currentPlan: AgentPlan | undefined,
): boolean {
  if (replayingHistory) return false;
  switch (entry.type) {
    case 'message':
      return entry.role === 'user' || !busy || (!entry.messageId && globalIdx < totalEntries - 1);
    case 'thought':
      return entry.endedAt !== undefined || !busy;
    case 'tool':
      return (entry.call.status === 'completed' || entry.call.status === 'failed') &&
        (!busy || entry.endedAt !== undefined);
    case 'compaction':
      return entry.status === 'completed' || entry.status === 'failed' || entry.status === 'cancelled';
    case 'plan':
      return !busy || entry !== currentPlan;
    case 'notice':
      return true;
  }
}

/**
 * Centralized Tern rendering, adaptive cadence, entry memoization, `settle` batching,
 * and terminal event (`resize`, `theme`, `motion`, `visible`) controller.
 */
export class TernRenderController {
  readonly surface: TernSurfaceLike;
  readonly supportsSettle: boolean;
  private readonly entryContainerId: string;
  private readonly timers: RenderTimerAdapter;
  private readonly entryCache = new WeakMap<TranscriptEntry, { key: string; node: JSX.Element }>();
  private readonly settledSigs = new Map<string, string>();
  private readonly currentByIdScratch = new Map<string, RenderedEntryRecord>();
  private readonly activeAgeSnapshots = new Map<string, { startedAt: number; initialAgeMs: number }>();

  cols: number;
  rows: number;
  dark: boolean;
  capsReduceMotion: boolean;
  visible = true;
  dirtyWhenHidden = false;

  private _maxFps: number;
  private _motionPref: MotionPref;
  private renderTimer: unknown;
  private resizeTimer: unknown;
  private lastRenderAt = 0;
  private disposed = false;

  constructor(opts: TernRenderControllerOptions) {
    this.timers = opts.timers ?? DEFAULT_TIMERS;
    this.entryContainerId = opts.entryContainerId ?? 'main.conversation';
    this.surface = opts.surface ?? opts.session.open({
      mode: opts.mode ?? 'screen',
      title: opts.title,
      font: opts.font ?? 'sans',
      ...(opts.adopt ? { adopt: true } : {}),
    });
    this.supportsSettle = opts.session.caps.features.includes('settle');
    this.cols = opts.initialCols ?? (opts.session.caps.cols || 120);
    this.rows = opts.initialRows ?? 40;
    this.dark = opts.session.caps.dark;
    this.capsReduceMotion = opts.session.caps.reduceMotion;
    this._maxFps = clampFps(opts.maxFps);
    this._motionPref = opts.motion ?? 'auto';
  }

  get maxFps(): number {
    return this._maxFps;
  }

  get motionPref(): MotionPref {
    return this._motionPref;
  }

  updatePreferences(prefs: { maxFps?: number; motion?: MotionPref }): void {
    if (prefs.maxFps !== undefined) this._maxFps = clampFps(prefs.maxFps);
    if (prefs.motion !== undefined) this._motionPref = prefs.motion;
  }

  effectiveReduceMotion(): boolean {
    if (this._motionPref === 'reduced') return true;
    if (this._motionPref === 'full') return false;
    return this.capsReduceMotion;
  }

  effectiveFps(): number {
    return this.effectiveReduceMotion() ? Math.min(this._maxFps, 12) : this._maxFps;
  }

  frameIntervalMs(busy: boolean): number {
    const interval = Math.max(16, Math.round(1000 / this.effectiveFps()));
    return busy ? interval : Math.min(20, interval);
  }

  clearScheduledRender(): void {
    if (this.renderTimer !== undefined) {
      this.timers.clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
  }

  scheduleRender(busy: boolean, renderNowFn: () => void): void {
    if (this.disposed || this.surface.closed) return;
    if (!this.visible) {
      this.dirtyWhenHidden = true;
      return;
    }
    const intervalMs = this.frameIntervalMs(busy);
    const now = this.timers.now();
    if (!this.surface.blocked && now - this.lastRenderAt >= intervalMs && this.renderTimer === undefined) {
      renderNowFn();
      return;
    }
    if (this.renderTimer === undefined) {
      const waitMs = Math.max(8, intervalMs - (now - this.lastRenderAt));
      this.renderTimer = this.timers.setTimeout(() => {
        this.renderTimer = undefined;
        if (!this.disposed && !this.surface.closed && this.visible) {
          renderNowFn();
        } else if (!this.visible) {
          this.dirtyWhenHidden = true;
        }
      }, waitMs);
    }
  }

  scheduleResize(cols: number, rows: number, onResizeSettled: () => void): void {
    if (this.disposed) return;
    if (cols > 0) this.cols = cols;
    if (rows > 0) this.rows = rows;
    if (this.resizeTimer !== undefined) {
      this.timers.clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = this.timers.setTimeout(() => {
      this.resizeTimer = undefined;
      if (!this.disposed && !this.surface.closed) {
        onResizeSettled();
      }
    }, 28);
  }

  handleSessionEvent(event: TspEvent, onViewChange: () => void, stdoutRows?: number): boolean {
    if (event.ev === 'resize') {
      if (event.visible !== undefined) this.visible = event.visible;
      this.scheduleResize(event.cols || this.cols, stdoutRows || this.rows, onViewChange);
      return true;
    }
    if (event.ev === 'theme') {
      this.dark = event.dark;
      onViewChange();
      return true;
    }
    if (event.ev === 'motion') {
      this.capsReduceMotion = event.reduce;
      onViewChange();
      return true;
    }
    if (event.ev === 'visible') {
      this.visible = event.visible;
      if (this.visible && this.dirtyWhenHidden) {
        this.dirtyWhenHidden = false;
        onViewChange();
      }
      return true;
    }
    return false;
  }

  /** Capture elapsed milliseconds once per `(id, startedAt)` so Tern handles native live ticking. */
  stableAge(key: string, startedAt: number | undefined): number {
    if (startedAt === undefined) return 0;
    const existing = this.activeAgeSnapshots.get(key);
    if (existing && existing.startedAt === startedAt) {
      return existing.initialAgeMs;
    }
    const initialAgeMs = Math.max(0, this.timers.now() - startedAt);
    this.activeAgeSnapshots.set(key, { startedAt, initialAgeMs });
    return initialAgeMs;
  }

  renderEntryMemoized(
    entry: TranscriptEntry,
    meta: { sig: string; settled: boolean },
    build: () => JSX.Element,
  ): RenderedEntryRecord {
    const wireId = `${this.entryContainerId}.${entry.id}`;
    const cached = this.entryCache.get(entry);
    if (cached && cached.key === meta.sig) {
      return { wireId, sig: meta.sig, settled: meta.settled, node: cached.node };
    }
    const node = build();
    this.entryCache.set(entry, { key: meta.sig, node });
    return { wireId, sig: meta.sig, settled: meta.settled, node };
  }

  commitFrame(
    view: Renderable,
    renderedEntries: readonly RenderedEntryRecord[],
    replayingHistory: boolean,
  ): readonly string[] {
    this.clearScheduledRender();
    if (this.disposed || this.surface.closed) return [];
    this.surface.render(view);
    this.lastRenderAt = this.timers.now();
    this.dirtyWhenHidden = false;

    const currentById = this.currentByIdScratch;
    const trackSettled = this.supportsSettle && !replayingHistory && !this.surface.blocked;
    if (this.settledSigs.size > 0 || trackSettled) {
      currentById.clear();
      for (const item of renderedEntries) {
        currentById.set(item.wireId, item);
      }
      if (this.settledSigs.size > 0) {
        for (const [wireId, settledSig] of this.settledSigs) {
          const current = currentById.get(wireId);
          if (!current || !current.settled || current.sig !== settledSig) {
            this.settledSigs.delete(wireId);
          }
        }
      }
    }

    if (!trackSettled) {
      return [];
    }

    const newlySettled: string[] = [];
    for (const item of renderedEntries) {
      if (item.settled && !this.settledSigs.has(item.wireId)) {
        newlySettled.push(item.wireId);
      }
    }
    if (newlySettled.length > 0) {
      this.surface.send(newlySettled.map(id => ['settle', id] as Op));
      for (const id of newlySettled) {
        const rec = currentById.get(id);
        if (rec) this.settledSigs.set(id, rec.sig);
      }
    }
    return newlySettled;
  }

  resetSessionTracking(): void {
    this.settledSigs.clear();
    this.activeAgeSnapshots.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearScheduledRender();
    if (this.resizeTimer !== undefined) {
      this.timers.clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
  }
}
