import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Draft } from './draft';
import type { LoadedImageAttachment } from './files';
import { Conversation, type TranscriptEntry } from './model';

export const DEFAULT_HISTORY_VISIBLE = 30;
export const DEFAULT_MAX_IN_MEMORY_CONVERSATIONS = 3;

export const REPLAY_INITIAL_GRACE_MS = 250;
export const REPLAY_SETTLE_MS = 350;
export const REPLAY_MAX_SETTLE_MS = 5_000;

export interface QueuedPrompt {
  id: string;
  text: string;
  files: string[];
  dirs: string[];
  images: LoadedImageAttachment[];
}

export interface SessionUiState {
  sessionId: string;
  draft: Draft;
  undoStack: Draft[];
  historyIndex: number | undefined;
  historyStash: Draft | undefined;
  attachedFiles: string[];
  attachedDirs: string[];
  attachedImages: LoadedImageAttachment[];
  queuedPrompts: QueuedPrompt[];
  lastPrompt: string;
  lastImages: LoadedImageAttachment[];
  lastFiles: string[];
  lastDirs: string[];
  thoughtFoldOverrides: Map<string, boolean>;
  toolFoldOverrides: Map<string, boolean>;
  focusedTurnIndex: number | undefined;
  historyVisibleCount: number;
  previewedMedia: Set<string>;
}

export function createSessionUiState(sessionId: string, initialDraft?: Draft): SessionUiState {
  return {
    sessionId,
    draft: initialDraft ? { ...initialDraft } : { text: '', cursor: 0 },
    undoStack: [],
    historyIndex: undefined,
    historyStash: undefined,
    attachedFiles: [],
    attachedDirs: [],
    attachedImages: [],
    queuedPrompts: [],
    lastPrompt: '',
    lastImages: [],
    lastFiles: [],
    lastDirs: [],
    thoughtFoldOverrides: new Map<string, boolean>(),
    toolFoldOverrides: new Map<string, boolean>(),
    focusedTurnIndex: undefined,
    historyVisibleCount: DEFAULT_HISTORY_VISIBLE,
    previewedMedia: new Set<string>(),
  };
}

export interface SessionStateManagerOptions {
  maxInMemory?: number;
  initialDraft?: Draft;
  onEvictConversation?: (sessionId: string, conversation: Conversation) => void;
}

/**
 * Isolates all mutable per-session UI state (`draft`, `undoStack`, attachments, queue,
 * retry payload, fold overrides, scroll focus) and maintains a true LRU `Conversation`
 * cache bounded to `maxInMemory` (default 3).
 */
export class SessionStateManager {
  private readonly maxInMemory: number;
  private readonly onEvictConversation?: (sessionId: string, conversation: Conversation) => void;
  private readonly uiStates = new Map<string, SessionUiState>();
  private readonly conversations = new Map<string, Conversation>();

  private _activeSessionId = '';
  private _activeState: SessionUiState;
  private _activeConversation: Conversation;
  private queueSequence = 0;

  constructor(opts?: SessionStateManagerOptions) {
    this.maxInMemory = Math.max(1, opts?.maxInMemory ?? DEFAULT_MAX_IN_MEMORY_CONVERSATIONS);
    this.onEvictConversation = opts?.onEvictConversation;
    this._activeState = createSessionUiState('', opts?.initialDraft);
    this._activeConversation = new Conversation();
  }

  get activeSessionId(): string {
    return this._activeSessionId;
  }

  get cachedConversationCount(): number {
    return this.conversations.size;
  }

  getActive(): SessionUiState {
    return this._activeState;
  }

  getConversation(): Conversation {
    return this._activeConversation;
  }

  getCachedConversation(sessionId: string): Conversation | undefined {
    return this.conversations.get(sessionId);
  }

  hasCachedConversation(sessionId: string): boolean {
    return this.conversations.has(sessionId);
  }

  replaceActiveConversation(conversation: Conversation): void {
    this._activeConversation = conversation;
    if (this._activeSessionId) {
      this.touchConversation(this._activeSessionId, conversation);
      this.evictOldestConversations();
    }
  }

  switchSession(
    nextId: string,
    opts?: { freshConversation?: boolean },
  ): { state: SessionUiState; conversation: Conversation; previousCached?: Conversation } {
    const fresh = opts?.freshConversation ?? false;

    if (this._activeSessionId === '') {
      this._activeSessionId = nextId;
      this._activeState.sessionId = nextId;
      this.uiStates.set(nextId, this._activeState);
      this.touchConversation(nextId, this._activeConversation);
      return { state: this._activeState, conversation: this._activeConversation };
    }

    if (this._activeSessionId === nextId) {
      const existing = this.conversations.get(nextId);
      if (fresh) {
        const nextConv = new Conversation();
        this._activeConversation = nextConv;
        this.touchConversation(nextId, nextConv);
        return { state: this._activeState, conversation: nextConv, previousCached: existing };
      }
      this.touchConversation(nextId, this._activeConversation);
      return { state: this._activeState, conversation: this._activeConversation };
    }

    this.uiStates.set(this._activeSessionId, this._activeState);
    this.touchConversation(this._activeSessionId, this._activeConversation);

    const existingConv = this.conversations.get(nextId);
    const nextConv = fresh ? new Conversation() : (existingConv ?? new Conversation());
    const nextState = this.uiStates.get(nextId) ?? createSessionUiState(nextId);
    this.uiStates.set(nextId, nextState);

    this._activeSessionId = nextId;
    this._activeState = nextState;
    this._activeConversation = nextConv;
    this.touchConversation(nextId, nextConv);
    this.evictOldestConversations();

    return {
      state: nextState,
      conversation: nextConv,
      ...(fresh && existingConv ? { previousCached: existingConv } : {}),
    };
  }

  deleteSession(sessionId: string): boolean {
    if (!sessionId || sessionId === this._activeSessionId) return false;
    const removedConv = this.conversations.delete(sessionId);
    const removedState = this.uiStates.delete(sessionId);
    return removedConv || removedState;
  }

  resetDraft(): void {
    this._activeState.draft = { text: '', cursor: 0 };
  }

  recordUndo(prev: Draft, next: Draft): void {
    if (prev.text === next.text) return;
    const stack = this._activeState.undoStack;
    stack.push(prev);
    if (stack.length > 50) stack.shift();
    this._activeState.historyIndex = undefined;
    this._activeState.historyStash = undefined;
  }

  applyUndo(): Draft | undefined {
    const previous = this._activeState.undoStack.pop();
    if (!previous) return undefined;
    this._activeState.draft = previous;
    this._activeState.historyIndex = undefined;
    this._activeState.historyStash = undefined;
    return previous;
  }

  stepPromptHistory(history: readonly string[], direction: -1 | 1): boolean {
    if (!history.length) return false;
    const st = this._activeState;
    if (direction === -1) {
      if (st.historyIndex === undefined) {
        if (st.draft.text !== '') return false;
        st.historyStash = st.draft;
        st.historyIndex = history.length - 1;
      } else if (st.historyIndex > 0) {
        st.historyIndex--;
      } else {
        return true;
      }
      const value = history[st.historyIndex]!;
      st.draft = { text: value, cursor: value.length };
      return true;
    }
    if (st.historyIndex === undefined) return false;
    if (st.historyIndex < history.length - 1) {
      st.historyIndex++;
      const value = history[st.historyIndex]!;
      st.draft = { text: value, cursor: value.length };
      return true;
    }
    st.draft = st.historyStash ?? { text: '', cursor: 0 };
    st.historyIndex = undefined;
    st.historyStash = undefined;
    return true;
  }

  enqueuePrompt(item: Omit<QueuedPrompt, 'id'>): QueuedPrompt {
    const queued: QueuedPrompt = {
      id: `q-${++this.queueSequence}`,
      text: item.text,
      files: [...item.files],
      dirs: [...item.dirs],
      images: [...item.images],
    };
    this._activeState.queuedPrompts.push(queued);
    return queued;
  }

  drainNextQueued(): QueuedPrompt | undefined {
    return this._activeState.queuedPrompts.shift();
  }

  pullQueuedAt(idx: number): QueuedPrompt | undefined {
    const pulled = this._activeState.queuedPrompts.splice(idx, 1)[0];
    if (!pulled) return undefined;
    this._activeState.draft = { text: pulled.text, cursor: pulled.text.length };
    this._activeState.attachedFiles = [...pulled.files];
    this._activeState.attachedDirs = [...pulled.dirs];
    this._activeState.attachedImages = [...pulled.images];
    return pulled;
  }

  dropQueuedAt(idx: number): QueuedPrompt | undefined {
    return this._activeState.queuedPrompts.splice(idx, 1)[0];
  }

  setRetryPayload(
    prompt: string,
    images: readonly LoadedImageAttachment[],
    files: readonly string[],
    dirs: readonly string[],
  ): void {
    this._activeState.lastPrompt = prompt;
    this._activeState.lastImages = [...images];
    this._activeState.lastFiles = [...files];
    this._activeState.lastDirs = [...dirs];
  }

  clearAttachments(): void {
    this._activeState.attachedFiles = [];
    this._activeState.attachedDirs = [];
    this._activeState.attachedImages = [];
  }

  clearPendingDraftInputs(): void {
    this.resetDraft();
    this._activeState.undoStack.length = 0;
    this._activeState.historyIndex = undefined;
    this._activeState.historyStash = undefined;
    this.clearAttachments();
  }

  private touchConversation(sessionId: string, conversation: Conversation): void {
    if (this.conversations.has(sessionId)) this.conversations.delete(sessionId);
    this.conversations.set(sessionId, conversation);
  }

  private evictOldestConversations(): void {
    if (this.conversations.size <= this.maxInMemory) return;
    for (const id of [...this.conversations.keys()]) {
      if (this.conversations.size <= this.maxInMemory) break;
      if (id === this._activeSessionId) continue;
      const evicted = this.conversations.get(id);
      this.conversations.delete(id);
      if (evicted) this.onEvictConversation?.(id, evicted);
    }
  }
}

export function isReplayContentUpdate(update: SessionUpdate): boolean {
  return update.sessionUpdate !== 'session_info_update' &&
    update.sessionUpdate !== 'available_commands_update' &&
    update.sessionUpdate !== 'usage_update' &&
    update.sessionUpdate !== 'config_option_update' &&
    update.sessionUpdate !== 'current_mode_update';
}

export function hasRichConversationHistory(conv: Conversation | undefined): boolean {
  return !!conv?.entries.some(entry => entry.type === 'message' && entry.role === 'agent');
}

export interface ReplayTimerAdapter {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const DEFAULT_REPLAY_TIMERS: ReplayTimerAdapter = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type ReplayPhase = 'idle' | 'awaiting_rpc' | 'settling' | 'fallback_watching';

export interface HistoryReplayCoordinatorOptions {
  initialGraceMs?: number;
  settleMs?: number;
  maxSettleMs?: number;
  timers?: ReplayTimerAdapter;
}

export interface ReplaySettledInfo {
  token: number;
  sessionId: string;
  mode: 'load' | 'resume';
  sawContentUpdate: boolean;
}

/**
 * Coordinates delayed ACP `session/load` replay settling and late-replay duplicate protection
 * via a shadow `Conversation` buffer when disk fallback has already been shown.
 */
export class HistoryReplayCoordinator {
  private readonly initialGraceMs: number;
  private readonly settleMs: number;
  private readonly maxSettleMs: number;
  private readonly timers: ReplayTimerAdapter;

  private phase: ReplayPhase = 'idle';
  private token = 0;
  private targetSessionId = '';
  private mode: 'load' | 'resume' = 'load';
  private sawContentUpdate = false;
  private settleDeadline = 0;
  private settleTimer: unknown;
  private shadowTimer: unknown;
  private shadowDeadline = 0;
  private shadowConversation: Conversation | undefined;
  private preNoticeEntryCount = 0;
  private fallbackHadDiskEntries = false;
  private onSettled: ((info: ReplaySettledInfo) => void) | undefined;
  private onLateRichReplay: ((entries: readonly TranscriptEntry[]) => void) | undefined;

  constructor(opts?: HistoryReplayCoordinatorOptions) {
    this.initialGraceMs = opts?.initialGraceMs ?? REPLAY_INITIAL_GRACE_MS;
    this.settleMs = opts?.settleMs ?? REPLAY_SETTLE_MS;
    this.maxSettleMs = opts?.maxSettleMs ?? REPLAY_MAX_SETTLE_MS;
    this.timers = opts?.timers ?? DEFAULT_REPLAY_TIMERS;
  }

  get currentPhase(): ReplayPhase {
    return this.phase;
  }

  get currentToken(): number {
    return this.token;
  }

  get isReplaying(): boolean {
    return this.phase === 'awaiting_rpc' || this.phase === 'settling';
  }

  begin(sessionId: string, mode: 'load' | 'resume'): number {
    this.clearTimers();
    this.token++;
    this.phase = 'awaiting_rpc';
    this.targetSessionId = sessionId;
    this.mode = mode;
    this.sawContentUpdate = false;
    this.settleDeadline = 0;
    this.shadowDeadline = 0;
    this.shadowConversation = undefined;
    this.preNoticeEntryCount = 0;
    this.fallbackHadDiskEntries = false;
    this.onSettled = undefined;
    this.onLateRichReplay = undefined;
    return this.token;
  }

  markRpcResolved(token: number, onSettled: (info: ReplaySettledInfo) => void): void {
    if (token !== this.token || this.phase !== 'awaiting_rpc') return;
    if (this.mode === 'resume') {
      this.phase = 'idle';
      onSettled({
        token,
        sessionId: this.targetSessionId,
        mode: this.mode,
        sawContentUpdate: this.sawContentUpdate,
      });
      return;
    }
    this.phase = 'settling';
    this.onSettled = onSettled;
    const now = this.timers.now();
    this.settleDeadline = now + this.maxSettleMs;
    const delay = this.sawContentUpdate ? this.settleMs : this.initialGraceMs;
    this.armSettleTimer(Math.min(delay, this.maxSettleMs));
  }

  onUpdate(sessionId: string, update: SessionUpdate, now = this.timers.now()): 'ignored' | 'replaying' | 'shadow' {
    if (!sessionId || sessionId !== this.targetSessionId || !isReplayContentUpdate(update)) {
      return 'ignored';
    }
    if (this.phase === 'awaiting_rpc') {
      this.sawContentUpdate = true;
      return 'replaying';
    }
    if (this.phase === 'settling') {
      this.sawContentUpdate = true;
      const remaining = Math.max(0, this.settleDeadline - now);
      this.armSettleTimer(Math.min(this.settleMs, remaining));
      return 'replaying';
    }
    if (this.phase === 'fallback_watching') {
      if (!this.shadowConversation) {
        this.shadowConversation = new Conversation();
        this.shadowDeadline = now + this.maxSettleMs;
      }
      this.shadowConversation.update(update, now);
      const remaining = Math.max(0, this.shadowDeadline - now);
      this.armShadowTimer(Math.min(this.settleMs, remaining));
      return 'shadow';
    }
    return 'ignored';
  }

  enterFallbackWatching(
    token: number,
    opts: {
      hadDiskEntries: boolean;
      preNoticeEntryCount: number;
      onLateRichReplay: (entries: readonly TranscriptEntry[]) => void;
    },
  ): void {
    if (token !== this.token) return;
    this.clearTimers();
    this.phase = 'fallback_watching';
    this.fallbackHadDiskEntries = opts.hadDiskEntries;
    this.preNoticeEntryCount = opts.preNoticeEntryCount;
    this.onLateRichReplay = opts.onLateRichReplay;
    this.shadowConversation = undefined;
  }

  disarmLateReplay(): void {
    this.clearTimers();
    this.token++;
    this.phase = 'idle';
    this.targetSessionId = '';
    this.shadowConversation = undefined;
    this.onSettled = undefined;
    this.onLateRichReplay = undefined;
  }

  dispose(): void {
    this.disarmLateReplay();
  }

  private armSettleTimer(delayMs: number): void {
    if (this.settleTimer !== undefined) {
      this.timers.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    const activeToken = this.token;
    this.settleTimer = this.timers.setTimeout(() => {
      this.settleTimer = undefined;
      if (activeToken !== this.token || this.phase !== 'settling') return;
      const cb = this.onSettled;
      const info: ReplaySettledInfo = {
        token: activeToken,
        sessionId: this.targetSessionId,
        mode: this.mode,
        sawContentUpdate: this.sawContentUpdate,
      };
      this.phase = 'idle';
      this.onSettled = undefined;
      cb?.(info);
    }, Math.max(0, delayMs));
  }

  private armShadowTimer(delayMs: number): void {
    if (this.shadowTimer !== undefined) {
      this.timers.clearTimeout(this.shadowTimer);
      this.shadowTimer = undefined;
    }
    const activeToken = this.token;
    this.shadowTimer = this.timers.setTimeout(() => {
      this.shadowTimer = undefined;
      if (activeToken !== this.token || this.phase !== 'fallback_watching') return;
      const shadow = this.shadowConversation;
      const cb = this.onLateRichReplay;
      this.phase = 'idle';
      this.shadowConversation = undefined;
      this.onLateRichReplay = undefined;
      if (
        shadow &&
        hasRichConversationHistory(shadow) &&
        (!this.fallbackHadDiskEntries || shadow.entries.length >= this.preNoticeEntryCount)
      ) {
        cb?.(shadow.entries);
      }
    }, Math.max(0, delayMs));
  }

  private clearTimers(): void {
    if (this.settleTimer !== undefined) {
      this.timers.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    if (this.shadowTimer !== undefined) {
      this.timers.clearTimeout(this.shadowTimer);
      this.shadowTimer = undefined;
    }
  }
}
