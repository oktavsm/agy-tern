/** @jsxImportSource @stencil-hq/tern */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { connect, type DiffHunk, type JSX, type PickerGroup, type PickerItem, type PrefsRow, type Session, type Surface, type Tone } from '@stencil-hq/tern';
import type { AuthMethodTerminal, SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { connectAgent } from './agent';
import type { AgentAuthentication, AgentMetadata, AgentOptions, AgentSession, PermissionPrompt, ResourceAttachment } from './contracts';
import { draftKey, editDraft, isCursorOnFirstRow, isCursorOnLastRow, type Draft } from './draft';
import { Conversation, type ToolStep, type TranscriptEntry } from './model';
import { commandCatalog, commandCategory, commandQuery, configLabel, configValues, filterCommands, modelOption, resolveCommand, type Command } from './commands';
import {
  addMcpServer,
  installPlugin,
  listAgents,
  listMcpServers,
  listPlugins,
  parseMcpAddCommand,
  removeMcpServer,
  setMcpServerEnabled,
  setPluginEnabled,
  uninstallPlugin,
  validatePlugin,
  type AgentEntry,
  type McpServerEntry,
  type PluginEntry,
  type PluginValidationReport,
} from './extensions';
import { parseQuotaReport, readOfficialReport, type OfficialReport } from './reports';
import { readOfficialBrainTranscript, TranscriptStore } from './history';
import { SessionNames } from './session-names';
import { PromptTemplatesStore, type PromptTemplate } from './templates';
import { openInTernSplit, runCommandInTernSplit, sendTerminalAttention } from './tern-window';
import { terminalLoginProblem } from './auth';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PREFS,
  DEFAULT_THINKING_ID,
  PrefsStore,
  type ComposerLines,
  type DiffMode,
  type ToolDisplay,
  type TranscriptDensity,
  type UserPrefs,
} from './prefs';
import {
  atMentionQuery,
  detectGitStatus,
  filterWorkspaceEntries,
  formatPromptWithAttachments,
  imageMimeType,
  listDirectoryEntriesPreview,
  listWorkspaceEntries,
  loadDirectorySummaryResources,
  loadEmbeddedResourceAttachments,
  readImageAttachment,
  readGitFileDiff,
  readWorkspaceTextPreview,
  resolvePastedImagePath,
  stripAtMention,
  writeTranscriptExport,
  type GitStatusEntry,
  type LoadedImageAttachment,
  type WorkspaceEntry,
} from './files';
import {
  buildUnifiedDiffHunks,
  clipInlinePreview,
  collectSessionDiffs,
  compactToolHeaderText,
  computeResponsiveLayout,
  countSessionDiffs,
  detectGitBranch,
  extractToolImagePaths,
  extractToolInlineImages,
  formatContextUsage,
  formatPathLabel,
  formatPlanSummary,
  formatTranscriptJson,
  formatTranscriptMarkdown,
  parseUnifiedGitDiff,
  searchTranscript,
  summarizeQuotaRows,
  summarizeToolCall,
  thinkingOption,
  type ResponsiveLayout,
  type SessionDiffItem,
} from './ui-format';
import {
  filterAgentsList,
  filterCommandsForTab,
  filterFindMatches,
  filterMcpServers,
  filterPluginsList,
  filterSessionRows,
  filterTemplatesList,
  groupSelectConfigOptions,
  stepPickerKey,
} from './picker-nav';
import {
  clockTime,
  copyToClipboard,
  Entry,
  hoverKv,
  ToolBody,
  type EntryCallbacks,
  type InspectTarget,
} from './transcript-view';

export interface ChatLaunchState {
  draft?: Draft;
  notice?: { text: string; error: boolean };
  openAccount?: boolean;
  previousSessionId?: string;
  continueLast?: boolean;
  conversationId?: string;
  initialPrompt?: string;
}

export type NativeChatResult = { kind: 'unavailable' } | { kind: 'quit' } |
  { kind: 'login'; method: AuthMethodTerminal; draft: Draft; previousSessionId?: string };

type Panel = { kind: 'commands' } | { kind: 'settings' } | { kind: 'config'; id: string } |
  { kind: 'report'; report: OfficialReport } | { kind: 'permissions' } | { kind: 'sessions' } |
  { kind: 'rename'; sessionId: string } | { kind: 'account' } | { kind: 'account-switch' } |
  { kind: 'changes' } | { kind: 'find' } | { kind: 'tasks' } | { kind: 'mcp' } | { kind: 'plugins' } | { kind: 'agents' } |
  { kind: 'templates' } | { kind: 'template-save' } | { kind: 'mcp-add' } | { kind: 'plugin-install' } |
  { kind: 'confirm'; title: string; detail: string; actionLabel: string; returnTo?: Panel; onConfirm(): void } |
  { kind: 'inspect'; title: string; subtitle?: string; item: InspectTarget };

interface QueuedPrompt {
  id: string;
  text: string;
  files: string[];
  dirs: string[];
  images: LoadedImageAttachment[];
}
interface Choice {
  label: string;
  detail: string;
  value?: string;
  disabled?: boolean;
  choose(): void;
}

export async function runNativeChat(options: AgentOptions, launch?: ChatLaunchState): Promise<NativeChatResult> {
  const stopped = Promise.withResolvers<null>();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let conversation = new Conversation();
  if (launch?.notice && !launch.openAccount) conversation.notice(launch.notice.text, launch.notice.error);
  let outcome: NativeChatResult = { kind: 'quit' };
  let authentication: AgentAuthentication = { terminalMethods: [], logout: false };
  let authenticationKnown = false;
  let authBusy = false;
  let authTask: Promise<void> | undefined;
  const conversations = new Map<string, Conversation>();
  const drafts = new Map<string, Draft>();
  const names = new SessionNames(options.cwd);
  const transcriptStore = new TranscriptStore(options.cwd);
  const localNames = new Map<string, string | undefined>();
  const sessionInfo = new Map<string, SessionInfo>();
  let activeSessionId = '';
  let listedSessions: SessionInfo[] = [];
  let nextSessionsCursor: string | undefined;
  let sessionsLoading = false;
  let sessionsLoadedAt = 0;
  let sessionsPrefetchInFlight: Promise<void> | undefined;
  let lastWorkspaceIndexAt = 0;
  let sessionOperation: string | undefined;
  let sessionTask: Promise<void> | undefined;
  const permissions: PermissionPrompt[] = [];
  let session: Session | null = null;
  let surface: Surface | undefined;
  let agent: AgentSession | undefined;
  let startup: Promise<void> | undefined;
  let connectRunner: ((resumeId?: string) => Promise<void>) | undefined;
  function reconnectAgent(): void {
    if (quitting || !disconnected || agentConnecting || authBusy || busy || permissions.length || !connectRunner) return;
    startup = connectRunner(activeSessionId || undefined);
  }
  let turn: Promise<void> | undefined;
  let draft: Draft = launch?.draft ?? { text: '', cursor: 0 };
  let phase = 'Connecting to Antigravity';
  let approvalChoice = 0;
  let busy = false;
  let cancelling = false;
  let disconnected = false;
  let agentConnecting = false;
  let quitting = false;
  let metadata: AgentMetadata = { configOptions: [], availableCommands: [] };
  let panel: Panel | undefined;
  let panelDraft: Draft = { text: '', cursor: 0 };
  let panelSelection = 0;
  let commandSelection = 0;
  let autocompleteDismissed = false;
  let changingConfig = false;
  let panelError = '';
  let reportText = '';
  let reportLoading = false;
  let reportAbort: AbortController | undefined;
  let reportTask: Promise<void> | undefined;
  let configTask: Promise<void> | undefined;
  const expandedThoughts = new Set<string>();
  const thoughtFoldOverrides = new Map<string, boolean>();
  const toolFoldOverrides = new Map<string, boolean>();
  let lastPrompt = '';
  let lastImages: LoadedImageAttachment[] = [];
  let lastFiles: string[] = [];
  let lastDirs: string[] = [];
  const undoStack: Draft[] = [];
  const promptHistory: string[] = [];
  let historyIndex: number | undefined;
  let historyStash: Draft | undefined;
  let gitBranch: string | undefined;
  const workspaceName = basename(options.cwd) || options.cwd;
  const prefsStore = new PrefsStore();
  let prefsReady: Promise<void> = Promise.resolve();
  const templatesStore = new PromptTemplatesStore(options.cwd);
  let templatesList: PromptTemplate[] = [];
  let userPrefs: UserPrefs = { ...DEFAULT_PREFS };
  let prefsPage = 'appearance';
  let pickerTab = 'all';
  let pickerSelected = '';
  let usageTab = 'overview';
  let workspaceEntries: WorkspaceEntry[] = [];
  let ignoredPathsSet = new Set<string>();
  let attachedFiles: string[] = [];
  let attachedDirs: string[] = [];
  let attachedImages: LoadedImageAttachment[] = [];
  let gitChanges: GitStatusEntry[] = [];
  const gitDiffCache = new Map<string, { status: 'loading' | 'ready'; hunks: DiffHunk[]; error?: string }>();
  let mcpServers: McpServerEntry[] = [];
  let pluginsList: PluginEntry[] = [];
  let agentsList: AgentEntry[] = [];
  let extLoading = false;
  let extAbort: AbortController | undefined;
  let fileSelection = 0;
  let toastMessage: { text: string; sub?: string } | undefined;
  let toastTimer: NodeJS.Timeout | undefined;
  let liveTickTimer: NodeJS.Timeout | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  let lastRenderAt = 0;
  let replaySettleTimer: NodeJS.Timeout | undefined;
  let replayingHistory = false;
  let replayPlaceholderId: string | undefined;
  let replayCachedFallback: Conversation | undefined;
  let replayNoticeMode: 'load' | 'resume' = 'load';
  const DEFAULT_HISTORY_VISIBLE = 30;
  let historyVisibleCount = DEFAULT_HISTORY_VISIBLE;
  let cachedDiffCountConversation: Conversation | undefined;
  let cachedDiffCountRev = -1;
  let cachedDiffCount = 0;
  let cachedDiffsConversation: Conversation | undefined;
  let cachedDiffsRev = -1;
  let cachedSessionDiffs: SessionDiffItem[] = [];
  const entryRenderCache = new WeakMap<TranscriptEntry, { key: string; node: JSX.Element }>();

  function getSessionDiffs(): SessionDiffItem[] {
    if (cachedDiffsConversation !== conversation || cachedDiffsRev !== conversation.revision) {
      cachedDiffsConversation = conversation;
      cachedDiffsRev = conversation.revision;
      cachedSessionDiffs = collectSessionDiffs(conversation.entries, options.cwd);
    }
    return cachedSessionDiffs;
  }
  let turnStartedAt: number | undefined;
  const queuedPrompts: QueuedPrompt[] = [];
  let queueSequence = 0;
  const blobCache = new Map<string, string>();
  const previewedMedia = new Set<string>();
  const previousSessionId = launch?.previousSessionId;
  let inspectReturnPanel: Panel | undefined;
  let viewportCols = process.stdout.columns || 120;
  let viewportRows = process.stdout.rows || 40;
  const onStdoutResize = (): void => {
    viewportCols = process.stdout.columns || viewportCols;
    viewportRows = process.stdout.rows || viewportRows;
    render();
  };

  function editorWrapWidth(): number {
    return Math.max(24, viewportCols - 14);
  }

  function currentResponsiveLayout(extra?: {
    hasPermission?: boolean;
    hasSuggestionsOrAt?: boolean;
    hasAttachments?: boolean;
    hasHud?: boolean;
  }): ResponsiveLayout {
    return computeResponsiveLayout(viewportCols, viewportRows, {
      userComposerLines: userPrefs.composerLines,
      userShowKeyLegend: userPrefs.showKeyLegend,
      hasPermission: extra?.hasPermission ?? permissions.length > 0,
      hasSuggestionsOrAt: extra?.hasSuggestionsOrAt ?? false,
      queuedCount: queuedPrompts.length,
      hasAttachments: extra?.hasAttachments ?? (attachedFiles.length > 0 || attachedDirs.length > 0 || attachedImages.length > 0),
      hasImageAttachments: attachedImages.length > 0,
      hasHud: extra?.hasHud ?? false,
    });
  }

  function recordUndo(prev: Draft, next: Draft): void {
    if (prev.text === next.text) return;
    undoStack.push(prev);
    if (undoStack.length > 50) undoStack.shift();
    historyIndex = undefined;
    historyStash = undefined;
  }

  function applyUndo(): void {
    const previous = undoStack.pop();
    if (!previous) return;
    draft = previous;
    historyIndex = undefined;
    historyStash = undefined;
    autocompleteDismissed = false;
    render();
  }

  function stepPromptHistory(direction: -1 | 1): boolean {
    if (!promptHistory.length) return false;
    if (direction === -1) {
      if (historyIndex === undefined) {
        if (draft.text !== '') return false;
        historyStash = draft;
        historyIndex = promptHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      } else {
        return true;
      }
      const value = promptHistory[historyIndex]!;
      draft = { text: value, cursor: value.length };
      return true;
    }
    if (historyIndex === undefined) return false;
    if (historyIndex < promptHistory.length - 1) {
      historyIndex++;
      const value = promptHistory[historyIndex]!;
      draft = { text: value, cursor: value.length };
      return true;
    }
    draft = historyStash ?? { text: '', cursor: 0 };
    historyIndex = undefined;
    historyStash = undefined;
    return true;
  }

  function exportCurrentTranscript(requestedName?: string): void {
    const meta = {
      title: activeSessionId ? sessionTitle(activeSessionId) : undefined,
      sessionId: activeSessionId || undefined,
    };
    const isJson = requestedName?.trim().toLowerCase().endsWith('.json') ?? false;
    const payload = isJson
      ? formatTranscriptJson(conversation.entries, options.cwd, meta)
      : formatTranscriptMarkdown(conversation.entries, options.cwd, meta);
    void writeTranscriptExport(options.cwd, payload, requestedName).then(rel => {
      if (!quitting) showToast('Exported transcript', rel);
    }).catch(error => {
      if (!quitting) {
        conversation.notice(error instanceof Error ? error.message : String(error), true);
        render();
      }
    });
  }

  function syncLiveTick(active: boolean): void {
    if (active && !liveTickTimer && !quitting) {
      liveTickTimer = setInterval(() => {
        if (quitting || !busy) { syncLiveTick(false); return; }
        render();
      }, 1_000);
    } else if (!active && liveTickTimer) {
      clearInterval(liveTickTimer);
      liveTickTimer = undefined;
    }
  }

  function showToast(text: string, sub?: string): void {
    clearTimeout(toastTimer);
    toastMessage = { text, sub };
    render();
    toastTimer = setTimeout(() => {
      toastMessage = undefined;
      render();
    }, 2_600);
  }

  function updatePrefs(patch: Partial<UserPrefs>): void {
    userPrefs = { ...userPrefs, ...patch };
    render();
    void prefsStore.update(patch).catch(error => {
      if (!quitting) showToast('Could not save preferences', error instanceof Error ? error.message : String(error));
    });
  }

  function resetPrefs(): void {
    userPrefs = { ...DEFAULT_PREFS };
    render();
    void prefsStore.reset().then(() => {
      if (!quitting) showToast('Local UI preferences reset');
    }).catch(error => {
      if (!quitting) showToast('Could not reset preferences', error instanceof Error ? error.message : String(error));
    });
  }

  function clearPermissions(): void {
    for (const permission of permissions.splice(0)) permission.answer(null);
    approvalChoice = 0;
  }

  function quit(): void {
    outcome = { kind: 'quit' };
    if (quitting) return;
    quitting = true;
    clearTimeout(renderTimer);
    renderTimer = undefined;
    clearTimeout(toastTimer);
    toastTimer = undefined;
    clearTimeout(replaySettleTimer);
    replaySettleTimer = undefined;
    reportAbort?.abort();
    extAbort?.abort();
    syncLiveTick(false);
    clearPermissions();
    controller.abort();
    stopped.resolve(null);
  }

  function clearReplayState(): void {
    clearTimeout(replaySettleTimer);
    replaySettleTimer = undefined;
    replayingHistory = false;
    replayPlaceholderId = undefined;
    replayCachedFallback = undefined;
  }

  function hasRichHistory(conv: Conversation | undefined): boolean {
    return !!conv?.entries.some(entry => entry.type === 'message' && entry.role === 'agent');
  }

  function persistActiveTranscript(): Promise<void> {
    if (!activeSessionId || !conversation.entries.some(entry => entry.type === 'message')) {
      return Promise.resolve();
    }
    return transcriptStore.save(activeSessionId, conversation.entries).catch(() => {});
  }

  async function hydrateSessionHistoryFallback(
    targetSessionId: string,
    fallback: Conversation | undefined,
    mode: 'load' | 'resume',
  ): Promise<void> {
    if (quitting || hasRichHistory(conversation)) return;
    if (fallback && hasRichHistory(fallback)) {
      conversation = fallback;
      return;
    }
    const disk = (await transcriptStore.load(targetSessionId)) ?? (await readOfficialBrainTranscript(targetSessionId));
    if (quitting) return;
    const replayedNonNotice = conversation.entries.filter(entry => entry.type !== 'notice').length;
    if (disk && disk.entries.length > replayedNonNotice) {
      conversation.restoreEntries([
        ...disk.entries,
        {
          type: 'notice',
          id: `history-restored-${Date.now()}`,
          text: disk.truncated
            ? `Showing latest ${disk.entries.length} entries from local session history.`
            : 'Restored conversation history from local session log.',
          error: false,
        },
      ]);
      return;
    }
    if (!replayedNonNotice) {
      conversation.notice(mode === 'resume'
        ? 'Resumed active ACP session context without replaying earlier history. Send a message to continue.'
        : 'Antigravity loaded this session context without replaying earlier history. Send a message to continue.');
    } else {
      conversation.notice('Antigravity replayed partial user history; backend session context is active.');
    }
  }

  function finishHistoryReplay(): void {
    if (quitting) return;
    clearTimeout(replaySettleTimer);
    replaySettleTimer = undefined;
    const placeholderId = replayPlaceholderId;
    replayingHistory = false;
    replayPlaceholderId = undefined;
    replayCachedFallback = undefined;
    if (placeholderId) conversation.removeNotice(placeholderId);
    if (!busy && !sessionOperation && !disconnected && !agentConnecting) phase = 'Ready';
    render();
    if (!panel) surface?.scroll('main.conversation', 'end');
  }

  function beginHistoryReplay(mode: 'load' | 'resume', fallback?: Conversation): void {
    clearReplayState();
    replayingHistory = true;
    replayNoticeMode = mode;
    replayCachedFallback = fallback;
  }

  function markReplayActivity(): void {
    if (!replayingHistory || quitting) return;
    clearTimeout(replaySettleTimer);
    replaySettleTimer = setTimeout(finishHistoryReplay, 40);
  }

  function scheduleRender(): void {
    if (quitting || !surface || surface.closed) return;
    const intervalMs = busy ? 40 : 20;
    const now = Date.now();
    if (!surface.blocked && now - lastRenderAt >= intervalMs && !renderTimer) {
      render();
      return;
    }
    if (!renderTimer) {
      const waitMs = Math.max(8, intervalMs - (now - lastRenderAt));
      renderTimer = setTimeout(() => {
        renderTimer = undefined;
        if (!quitting) render();
      }, waitMs);
    }
  }

  function terminate(): void {
    process.exitCode = 143;
    quit();
  }

  function interrupt(): void {
    process.exitCode = 130;
    quit();
  }

  function inputError(): void {
    process.exitCode = 1;
    quit();
  }

  function answer(permission: PermissionPrompt, optionId: string | null): void {
    // Ignore a click on a frame whose approval has already been resolved.
    if (quitting || permissions[0]?.id !== permission.id) return;
    const option = permission.request.options.find(option => option.optionId === optionId);
    if (optionId !== null && option?.kind !== 'allow_once' && option?.kind !== 'reject_once') return;
    permissions.shift();
    approvalChoice = 0;
    const step = conversation.getTool(permission.request.toolCall.toolCallId);
    if (step) step.approved = option?.kind === 'allow_once' ? 'once' : 'denied';
    permission.answer(optionId);
    render();
  }

  function stop(): void {
    if (!agent || !busy || cancelling) return;
    cancelling = true;
    phase = 'Cancelling';
    clearPermissions();
    render();
    void agent.cancel().catch(error => {
      if (quitting) return;
      cancelling = false;
      phase = 'Cancellation failed';
      conversation.notice(error instanceof Error ? error.message : String(error), true);
      render();
    });
  }

  function blobForImage(cacheKey: string, base64: string, mimeType: string): string | undefined {
    const existing = blobCache.get(cacheKey);
    if (existing) return existing;
    if (!session || session.closed) return undefined;
    try {
      const id = session.blob(Buffer.from(base64, 'base64'), mimeType);
      if (blobCache.size >= 32) {
        const oldest = blobCache.keys().next().value;
        if (oldest !== undefined) blobCache.delete(oldest);
      }
      blobCache.set(cacheKey, id);
      return id;
    } catch {
      return undefined;
    }
  }

  function openInspect(title: string, item: InspectTarget, subtitle?: string): void {
    if (permissions.length || quitting) return;
    if (panel && panel.kind !== 'inspect') inspectReturnPanel = panel;
    else if (!panel) inspectReturnPanel = undefined;
    openPanel({ kind: 'inspect', title, subtitle, item });
  }

  function parentPanel(current: Panel): Panel | undefined {
    if (current.kind === 'inspect') return inspectReturnPanel;
    if (current.kind === 'confirm') return current.returnTo;
    if (current.kind === 'template-save') return { kind: 'templates' };
    if (current.kind === 'mcp-add') return { kind: 'mcp' };
    if (current.kind === 'plugin-install') return { kind: 'plugins' };
    if (current.kind === 'account-switch') return { kind: 'account' };
    return undefined;
  }

  function closePanel(): void {
    if (authBusy) return;
    reportAbort?.abort();
    extAbort?.abort();
    if (panel?.kind === 'inspect' && inspectReturnPanel) {
      const back = inspectReturnPanel;
      inspectReturnPanel = undefined;
      openPanel(back);
      return;
    }
    inspectReturnPanel = undefined;
    panel = undefined;
    panelError = '';
    gitDiffCache.clear();
    cachedDiffsConversation = undefined;
    cachedSessionDiffs = [];
    autocompleteDismissed = true;
    render();
    surface?.focus('dock.draft');
  }

  function stepBackPanel(): void {
    if (authBusy || !panel) return;
    const back = parentPanel(panel);
    if (back) {
      inspectReturnPanel = undefined;
      openPanel(back);
      return;
    }
    closePanel();
  }

  function loadReport(command: OfficialReport): void {
    reportAbort?.abort();
    const request = new AbortController();
    reportAbort = request;
    reportLoading = true;
    reportText = '';
    panelError = '';
    render();
    reportTask = readOfficialReport({ ...options, signal }, command, request.signal).then(text => {
      if (!request.signal.aborted) reportText = text;
    }).catch(error => {
      if (!request.signal.aborted) panelError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (reportAbort !== request) return;
      reportLoading = false;
      render();
    });
  }

  function sessionTitle(id: string): string {
    return localNames.get(id) || sessionInfo.get(id)?.title || `Conversation ${id.slice(0, 8)}`;
  }

  function modeOption(): SessionConfigOption | undefined {
    return metadata.configOptions.find(option => option.id === 'mode' || option.category === 'mode');
  }

  function availableCommands(): Command[] {
    const commands = commandCatalog(metadata.availableCommands);
    return agent && !disconnected ? commands : commands.filter(command =>
      command.local === 'account' || command.local === 'login' || command.local === 'help' || command.local === 'exit');
  }

  function loginMethod(): AuthMethodTerminal | undefined {
    return authentication.terminalMethods.find(method => !terminalLoginProblem(method)) ?? authentication.terminalMethods[0];
  }

  function requestLogin(changeAccount: boolean): void {
    if (busy || changingConfig || sessionOperation || permissions.length || authBusy || quitting) return;
    const method = loginMethod();
    const problem = method ? terminalLoginProblem(method) : 'agy did not advertise a supported terminal login method.';
    if (!method || problem) { panelError = problem ?? 'No terminal login method.'; render(); return; }
    const connected = agent;
    if (changeAccount && (!connected || disconnected || !authentication.logout)) {
      panelError = 'A connected agy session with logout support is required to change accounts.';
      render();
      return;
    }
    authBusy = true;
    panelError = '';
    reportAbort?.abort();
    render();
    authTask = (async () => {
      await reportTask;
      if (quitting) return;
      const handoffSessionId = activeSessionId || undefined;
      if (changeAccount) await connected?.logout();
      if (quitting) return;
      quit();
      outcome = { kind: 'login', method, draft, ...(handoffSessionId ? { previousSessionId: handoffSessionId } : {}) };
    })().catch(error => {
      if (!quitting) panelError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      authBusy = false;
      render();
    });
  }

  function runSessionAction(label: string, action: (connected: AgentSession) => Promise<void>): void {
    if (!agent || busy || changingConfig || sessionOperation || authBusy || disconnected || permissions.length || quitting) return;
    sessionOperation = label;
    panelError = '';
    render();
    sessionTask = action(agent).catch(error => {
      if (quitting) return;
      const message = error instanceof Error ? error.message : String(error);
      if (panel?.kind === 'sessions' || panel?.kind === 'rename') panelError = message;
      else conversation.notice(message, true);
      phase = 'Session action failed';
    }).finally(() => {
      sessionOperation = undefined;
      render();
    });
  }

  function loadSessions(append = false, silent = false): void {
    const active = agent;
    if (!active?.capabilities.listSessions || disconnected || quitting) return;
    if (sessionsPrefetchInFlight && !append) return;
    sessionsLoading = true;
    if (!silent) { panelError = ''; render(); }
    const task = (async () => {
      const response = await active.listSessions(append ? nextSessionsCursor : undefined);
      if (quitting) return;
      const rows = new Map((append ? listedSessions : []).map(row => [row.sessionId, row]));
      for (const row of response.sessions) {
        rows.set(row.sessionId, row);
        sessionInfo.set(row.sessionId, row);
      }
      listedSessions = [...rows.values()];
      nextSessionsCursor = response.nextCursor ?? undefined;
      sessionsLoadedAt = Date.now();
      await Promise.all(response.sessions.map(async row => {
        localNames.set(row.sessionId, await names.get(row.sessionId));
      }));
      if (!append) panelSelection = 0;
    })().catch(error => {
      if (!quitting && !silent) {
        panelError = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      if (sessionsPrefetchInFlight === task) sessionsPrefetchInFlight = undefined;
      sessionsLoading = false;
      if (!quitting) render();
    });
    if (!append) sessionsPrefetchInFlight = task;
  }

  function loadExtensions(kind: 'mcp' | 'plugins' | 'agents'): void {
    extAbort?.abort();
    const request = new AbortController();
    extAbort = request;
    extLoading = true;
    panelError = '';
    render();
    const task = kind === 'mcp'
      ? listMcpServers({ ...options, signal }, request.signal).then(rows => { mcpServers = rows; })
      : kind === 'plugins'
        ? listPlugins({ ...options, signal }, request.signal).then(rows => { pluginsList = rows; })
        : listAgents({ ...options, signal }, request.signal).then(rows => { agentsList = rows; });
    void task.catch(error => {
      if (!request.signal.aborted && !quitting) panelError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (extAbort !== request || quitting) return;
      extLoading = false;
      render();
    });
  }

  function runExtAction(action: (reqSignal: AbortSignal) => Promise<void>): void {
    if (extLoading) return;
    extAbort?.abort();
    const request = new AbortController();
    extAbort = request;
    extLoading = true;
    panelError = '';
    render();
    void action(request.signal).catch(error => {
      if (!request.signal.aborted && !quitting) panelError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (extAbort !== request || quitting) return;
      extLoading = false;
      render();
    });
  }

  function toggleMcp(name: string, enable: boolean): void {
    runExtAction(async reqSignal => {
      await setMcpServerEnabled({ ...options, signal }, name, enable, reqSignal);
      mcpServers = await listMcpServers({ ...options, signal }, reqSignal);
      if (!quitting) showToast(`${name} ${enable ? 'enabled' : 'disabled'}`, 'Applies to new agy sessions');
    });
  }

  function runAddMcp(raw: string): void {
    let spec;
    try {
      spec = parseMcpAddCommand(raw);
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
      render();
      return;
    }
    runExtAction(async reqSignal => {
      await addMcpServer({ ...options, signal }, spec, reqSignal);
      mcpServers = await listMcpServers({ ...options, signal }, reqSignal);
      if (!quitting) {
        pickerSelected = spec.name;
        openPanel({ kind: 'mcp' });
        showToast(`Added MCP server ${spec.name}`, 'Applies to new agy sessions');
      }
    });
  }

  function runRemoveMcp(name: string): void {
    runExtAction(async reqSignal => {
      await removeMcpServer({ ...options, signal }, name, reqSignal);
      mcpServers = await listMcpServers({ ...options, signal }, reqSignal);
      if (!quitting) {
        pickerSelected = mcpServers[0]?.name ?? '';
        openPanel({ kind: 'mcp' });
        showToast(`Removed MCP server ${name}`);
      }
    });
  }

  function togglePlugin(name: string, enable: boolean): void {
    runExtAction(async reqSignal => {
      await setPluginEnabled({ ...options, signal }, name, enable, reqSignal);
      pluginsList = await listPlugins({ ...options, signal }, reqSignal);
      if (!quitting) showToast(`${name} ${enable ? 'enabled' : 'disabled'}`, 'Applies to new agy sessions');
    });
  }

  function formatValidationReport(plugin: PluginEntry, report: PluginValidationReport): string {
    const hasErrors = report.findings.some(f => f.severity.toLowerCase() === 'error');
    const componentSummary = Object.entries(report.components).map(([k, v]) => `${k}=${v}`).join(', ');
    const lines = [
      `# Plugin validation: ${report.name || plugin.name}`,
      '',
      `- Directory: \`${report.dir || plugin.path}\``,
      `- Valid: ${hasErrors ? 'no' : 'yes'}`,
      `- Manifest: \`${report.manifest || 'unknown'}\``,
      ...(componentSummary ? [`- Components: ${componentSummary}`] : []),
      `- Findings: ${report.findings.length}`,
    ];
    if (report.findings.length) {
      lines.push('', '## Findings', '');
      for (const finding of report.findings) {
        const location = finding.file ? `\`${finding.file}\`: ` : '';
        lines.push(`- **${finding.severity.toUpperCase()}**: ${location}${finding.message}`);
      }
    }
    return lines.join('\n');
  }

  function runValidatePlugin(plugin: PluginEntry): void {
    if (!plugin.path) {
      panelError = 'Plugin path was not reported by agy.';
      render();
      return;
    }
    runExtAction(async reqSignal => {
      const report = await validatePlugin({ ...options, signal }, plugin.path, false, reqSignal);
      if (!quitting) {
        const text = formatValidationReport(plugin, report);
        const hasErrors = report.findings.some(f => f.severity.toLowerCase() === 'error');
        openInspect(`Validate: ${plugin.name}`, { type: 'file', path: plugin.path, content: text },
          !report.findings.length ? 'Validation passed' : `${report.findings.length} finding(s)${hasErrors ? ' (errors)' : ''}`);
      }
    });
  }

  function runInstallPlugin(target: string): void {
    runExtAction(async reqSignal => {
      await installPlugin({ ...options, signal }, target, reqSignal);
      pluginsList = await listPlugins({ ...options, signal }, reqSignal);
      if (!quitting) {
        openPanel({ kind: 'plugins' });
        showToast('Installed plugin', target.trim());
      }
    });
  }

  function runUninstallPlugin(name: string): void {
    runExtAction(async reqSignal => {
      await uninstallPlugin({ ...options, signal }, name, reqSignal);
      pluginsList = await listPlugins({ ...options, signal }, reqSignal);
      if (!quitting) {
        pickerSelected = pluginsList[0]?.name ?? '';
        openPanel({ kind: 'plugins' });
        showToast(`Uninstalled plugin ${name}`);
      }
    });
  }

  function loadTemplates(): void {
    runExtAction(async () => {
      templatesList = await templatesStore.list();
    });
  }

  function savePromptTemplate(name: string, text: string): void {
    runExtAction(async () => {
      templatesList = await templatesStore.save(name, text);
      if (!quitting) {
        const savedName = name.trim();
        pickerSelected = savedName;
        openPanel({ kind: 'templates' });
        showToast('Saved workspace template', savedName);
      }
    });
  }

  function removePromptTemplate(name: string): void {
    runExtAction(async () => {
      templatesList = await templatesStore.remove(name);
      if (!quitting) {
        pickerSelected = templatesList[0]?.name ?? '';
        openPanel({ kind: 'templates' });
        showToast('Deleted workspace template', name);
      }
    });
  }

  function openSplit(filePath: string, line?: number): void {
    void openInTernSplit(options.cwd, filePath, { line }).then(result => {
      if (quitting) return;
      if (result.ok && result.target) showToast('Opened in Tern split', formatPathLabel(result.target, options.cwd));
      else showToast('Could not open Tern split', result.error ?? 'Unknown error');
    });
  }

  function setWorkspaceEntries(entries: WorkspaceEntry[]): void {
    workspaceEntries = entries;
    ignoredPathsSet = new Set(entries.filter(item => item.ignored).map(item => item.path));
  }

  function refreshWorkspaceFiles(): void {
    lastWorkspaceIndexAt = Date.now();
    void listWorkspaceEntries(options.cwd, 2_400, options.additionalDirectories).then(entries => {
      if (!quitting) { setWorkspaceEntries(entries); render(); }
    }).catch(() => {});
  }

  async function applyPreferredConfigOptions(
    connected: AgentSession,
    allowExplicitWarnings: boolean,
    applyDefaults = true,
  ): Promise<void> {
    const requestedModel = options.initialConfig?.model;
    const requestedThinking = options.initialConfig?.thinking;
    const requestedMode = options.initialConfig?.mode;
    const preferredModel = requestedModel ?? (applyDefaults ? (userPrefs.rememberModel && userPrefs.lastModel ? userPrefs.lastModel : DEFAULT_MODEL_ID) : undefined);
    const preferredThinking = requestedThinking ?? (applyDefaults ? (userPrefs.rememberModel && userPrefs.lastThinking ? userPrefs.lastThinking : DEFAULT_THINKING_ID) : undefined);

    const requests: Array<{ opt: SessionConfigOption | undefined; wanted: string; label: string; explicit: boolean }> = [
      ...(preferredModel ? [{ opt: modelOption(connected.metadata.configOptions), wanted: preferredModel, label: 'model', explicit: !!requestedModel }] : []),
      ...(requestedMode ? [{
        opt: connected.metadata.configOptions.find(o => o.category === 'mode' || o.id === 'mode'),
        wanted: requestedMode,
        label: 'mode',
        explicit: true,
      }] : []),
      ...(preferredThinking ? [{ opt: thinkingOption(connected.metadata.configOptions), wanted: preferredThinking, label: 'thinking level', explicit: !!requestedThinking }] : []),
    ];
    for (const item of requests) {
      if (quitting) break;
      if (!item.opt) {
        if (item.explicit && allowExplicitWarnings) {
          conversation.notice(`Requested --${item.label.replace(' level', '')} "${item.wanted}", but this ACP session did not advertise that option.`);
        }
        continue;
      }
      const matched = configValues(item.opt).find(val =>
        val.value === item.wanted || val.name.toLowerCase() === item.wanted.toLowerCase());
      if (!matched) {
        if (item.explicit && allowExplicitWarnings) {
          conversation.notice(`Requested --${item.label.replace(' level', '')} "${item.wanted}" was not among session options.`, true);
        }
        continue;
      }
      if (item.opt.currentValue === matched.value) continue;
      try {
        await connected.setConfigOption(item.opt.id, matched.value);
        metadata = connected.metadata;
      } catch (err) {
        if (item.explicit && allowExplicitWarnings) {
          conversation.notice(`Failed to apply --${item.label.replace(' level', '')}: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      }
    }
  }

  function loadGitDiffPreview(entry: GitStatusEntry): void {
    if (gitDiffCache.has(entry.path) || entry.status === '?' || entry.status === '??') return;
    gitDiffCache.set(entry.path, { status: 'loading', hunks: [] });
    void readGitFileDiff(options.cwd, entry.path).then(patch => {
      if (quitting) return;
      const parsed = parseUnifiedGitDiff(patch);
      gitDiffCache.set(entry.path, { status: 'ready', hunks: parsed.hunks });
      render();
    }).catch(() => {
      if (!quitting) {
        gitDiffCache.set(entry.path, { status: 'ready', hunks: [], error: 'Unable to read git diff' });
        render();
      }
    });
  }

  function promptRunCommand(command: string): void {
    const trimmed = command.trim();
    if (!trimmed || permissions.length || quitting) return;
    const preview = trimmed.replace(/\s+/g, ' ').slice(0, 120);
    openPanel({
      kind: 'confirm',
      title: 'Run command in Tern split?',
      detail: `Executes in ${options.cwd}: ${preview}${trimmed.length > 120 ? '...' : ''}`,
      actionLabel: 'Run in split',
      returnTo: panel,
      onConfirm: () => {
        panel = undefined;
        panelError = '';
        render();
        surface?.focus('dock.draft');
        void runCommandInTernSplit(options.cwd, trimmed).then(result => {
          if (quitting) return;
          if (result.ok) showToast('Running in Tern split', preview.slice(0, 48));
          else showToast('Could not run in Tern split', result.error ?? 'Unknown error');
        });
      },
    });
  }

  function openConversation(id: string, requestedMode?: 'load' | 'resume'): void {
    if (id === activeSessionId) { closePanel(); return; }
    const cached = conversations.get(id);
    const mode: 'load' | 'resume' = requestedMode ?? (cached && hasRichHistory(cached) && agent?.capabilities.resumeSession ? 'resume' : 'load');
    runSessionAction(mode === 'resume' ? 'Resuming conversation' : 'Opening conversation', async connected => {
      await persistActiveTranscript();
      beginHistoryReplay(mode, cached);
      try {
        if (mode === 'resume' && connected.resumeSession) await connected.resumeSession(id);
        else await connected.loadSession(id);
      } catch (err) {
        clearReplayState();
        throw err;
      }
      if (mode === 'load') finishHistoryReplay();
      else clearReplayState();
      await hydrateSessionHistoryFallback(id, cached, mode);
      await applyPreferredConfigOptions(connected, false, true);
      phase = 'Ready';
      closePanel();
      surface?.scroll('main.conversation', 'end');
    });
  }

  function closeSavedSession(id: string): void {
    runSessionAction('Closing session', async connected => {
      if (!connected.closeSession) throw new Error('Antigravity ACP does not support closing sessions.');
      await connected.closeSession(id);
      listedSessions = listedSessions.filter(row => row.sessionId !== id);
      pickerSelected = listedSessions[0]?.sessionId ?? '';
      showToast('Session closed on agy', sessionTitle(id));
      render();
    });
  }

  function newConversation(): void {
    runSessionAction('Starting conversation', async connected => {
      clearReplayState();
      await connected.newSession();
      await applyPreferredConfigOptions(connected, false);
      phase = 'Ready';
      closePanel();
    });
  }

  function saveName(id: string, value: string): void {
    runSessionAction('Saving local name', async () => {
      await names.set(id, value);
      localNames.set(id, value.trim() || undefined);
      phase = 'Ready';
      closePanel();
    });
  }

  function openPanel(next: Panel): void {
    if (permissions.length || quitting) return;
    reportAbort?.abort();
    extAbort?.abort();
    panel = next;
    const name = next.kind === 'rename' ? localNames.get(next.sessionId) ?? sessionInfo.get(next.sessionId)?.title ?? '' : '';
    panelDraft = { text: name, cursor: name.length };
    panelSelection = 0;
    panelError = '';
    pickerTab = 'all';
    pickerSelected = '';
    if (next.kind === 'report') usageTab = 'overview';
    if (next.kind === 'changes') pickerTab = 'edits';
    if (next.kind !== 'inspect') inspectReturnPanel = undefined;
    if (next.kind === 'config') {
      const option = metadata.configOptions.find(candidate => candidate.id === next.id);
      if (option && option.type === 'select') pickerSelected = option.currentValue;
    }
    if (next.kind === 'sessions') pickerSelected = activeSessionId;
    autocompleteDismissed = true;
    render();
    const needsCustomFocus = next.kind === 'rename' || next.kind === 'template-save' ||
      next.kind === 'mcp-add' || next.kind === 'plugin-install' ||
      (next.kind === 'config' && metadata.configOptions.find(candidate => candidate.id === next.id)?.type === 'boolean');
    const isPickerPanel = next.kind === 'commands' || next.kind === 'config' || next.kind === 'sessions' ||
      next.kind === 'changes' || next.kind === 'find' || next.kind === 'tasks' || next.kind === 'mcp' || next.kind === 'plugins' ||
      next.kind === 'agents' || next.kind === 'templates';
    const targetFocus = next.kind === 'settings' ? 'layer.prefs'
      : isPickerPanel && !needsCustomFocus ? 'layer.picker'
      : needsCustomFocus ? 'layer.panel.query' : null;
    surface?.focus(targetFocus);
    if (next.kind === 'report') loadReport(next.report);
    if (next.kind === 'mcp' || next.kind === 'plugins' || next.kind === 'agents') loadExtensions(next.kind);
    if (next.kind === 'templates') loadTemplates();
    if (next.kind === 'sessions' && agent?.capabilities.listSessions) {
      if (!sessionsPrefetchInFlight && (!listedSessions.length || Date.now() - sessionsLoadedAt >= 30_000)) {
        loadSessions(false, listedSessions.length > 0);
      }
    }
    if (next.kind === 'changes') {
      gitDiffCache.clear();
      void detectGitStatus(options.cwd).then(rows => {
        if (!quitting) { gitChanges = rows; render(); }
      }).catch(() => {});
    }
  }

  function changeConfig(option: SessionConfigOption, value: string | boolean): void {
    if (!agent || busy || changingConfig || sessionOperation || authBusy || disconnected || permissions.length) return;
    changingConfig = true;
    panelError = '';
    render();
    configTask = agent.setConfigOption(option.id, value).then(() => {
      if (!quitting && userPrefs.rememberModel && typeof value === 'string') {
        if (option.category === 'model' || option.id === 'model') updatePrefs({ lastModel: value });
        else if (option.category === 'thought_level' || option.id === 'thought_level') updatePrefs({ lastThinking: value });
      }
      if (!quitting && panel?.kind !== 'settings') closePanel();
      else if (!quitting) showToast(`${option.name} updated`);
    }).catch(error => {
      panelError = error instanceof Error ? error.message : String(error);
      if (panel?.kind === 'settings') showToast(`Could not update ${option.name}`, panelError);
    }).finally(() => {
      changingConfig = false;
      render();
    });
  }

  function chooseCommand(command: Command, args = '', completeOnly = false): void {
    if (permissions.length || authBusy || quitting) return;
    if (completeOnly || (!command.local && command.hint && !args)) {
      draft = { text: `/${command.name} ${args}`, cursor: command.name.length + 2 + args.length };
      closePanel();
      return;
    }
    if (command.local) {
      if (args && command.local !== 'model' && command.local !== 'sessions' && command.local !== 'rename' &&
        command.local !== 'export' && command.local !== 'find' && command.local !== 'templates') {
        conversation.notice(`/${command.name} does not take arguments in this frontend.`, true);
        render();
        return;
      }
      if (draft.text.startsWith('/')) draft = { text: '', cursor: 0 };
      switch (command.local) {
        case 'exit': quit(); return;
        case 'help': openPanel({ kind: 'commands' }); return;
        case 'account':
        case 'login': openPanel({ kind: 'account' }); return;
        case 'switch-account': openPanel({ kind: 'account-switch' }); return;
        case 'settings': openPanel({ kind: 'settings' }); return;
        case 'permissions': openPanel({ kind: 'permissions' }); return;
        case 'changes': openPanel({ kind: 'changes' }); return;
        case 'tasks': openPanel({ kind: 'tasks' }); return;
        case 'find':
          openPanel({ kind: 'find' });
          if (args) { panelDraft = { text: args, cursor: args.length }; render(); }
          return;
        case 'export': {
          closePanel();
          exportCurrentTranscript(args);
          return;
        }
        case 'expand':
        case 'collapse': {
          const expand = command.local === 'expand';
          for (const entry of conversation.entries) {
            if (entry.type === 'thought') thoughtFoldOverrides.set(entry.id, expand);
            else if (entry.type === 'tool') toolFoldOverrides.set(entry.id, !expand);
          }
          closePanel();
          showToast(expand ? 'Expanded all cards' : 'Collapsed all cards');
          return;
        }
        case 'sessions':
          openPanel({ kind: 'sessions' });
          if (args) { panelDraft = { text: args, cursor: args.length }; render(); }
          return;
        case 'new': newConversation(); return;
        case 'rename':
          openPanel({ kind: 'rename', sessionId: activeSessionId });
          if (args) { panelDraft = { text: args, cursor: args.length }; render(); }
          return;
        case 'usage': openPanel({ kind: 'report', report: 'usage' }); return;
        case 'credits': openPanel({ kind: 'report', report: 'credits' }); return;
        case 'changelog': openPanel({ kind: 'report', report: 'changelog' }); return;
        case 'mcp': openPanel({ kind: 'mcp' }); return;
        case 'plugins': openPanel({ kind: 'plugins' }); return;
        case 'agents': openPanel({ kind: 'agents' }); return;
        case 'templates':
          openPanel({ kind: 'templates' });
          if (args) { panelDraft = { text: args, cursor: args.length }; render(); }
          return;
        case 'model': {
          const option = modelOption(metadata.configOptions);
          if (!option) { openPanel({ kind: 'settings' }); panelError = 'This agy session did not supply a model selector.'; render(); return; }
          if (args) {
            const value = configValues(option).find(value => value.value === args || value.name.toLowerCase() === args.toLowerCase());
            openPanel({ kind: 'config', id: option.id });
            if (value) changeConfig(option, value.value);
            else { panelError = 'Choose one of the models supplied by this agy session.'; render(); }
          } else openPanel({ kind: 'config', id: option.id });
          return;
        }
      }
    }
    if (busy || changingConfig || sessionOperation || authBusy) return;
    closePanel();
    draft = { text: '', cursor: 0 };
    submitPrompt(`/${command.name}${args ? ` ${args}` : ''}`);
  }

  function submitPrompt(
    text: string,
    images: readonly LoadedImageAttachment[] = [],
    attachedFilePaths: readonly string[] = [],
    attachedDirPaths: readonly string[] = [],
  ): void {
    if (!agent || busy || changingConfig || sessionOperation || authBusy || disconnected || permissions.length) return;
    lastPrompt = text;
    lastImages = [...images];
    lastFiles = [...attachedFilePaths];
    lastDirs = [...attachedDirPaths];
    busy = true;
    turnStartedAt = Date.now();
    cancelling = false;
    autocompleteDismissed = true;
    phase = 'Working';
    const transcriptText = images.length
      ? `${images.map(image => `[Image: ${image.path}]`).join(' ')}${text ? `\n\n${text}` : ''}`
      : text;
    conversation.startPrompt(transcriptText, clockTime());
    syncLiveTick(true);
    render();
    surface?.scroll('main.conversation', 'end');
    const activeAgent = agent;
    const promptBody = text || 'Inspect the attached image.';
    let completedNormally = false;
    const entryCountBeforePrompt = conversation.entries.length;
    turn = (async () => {
      const resources: ResourceAttachment[] = [];
      if (activeAgent.promptCapabilities?.embeddedContext && (attachedFilePaths.length || attachedDirPaths.length)) {
        const [fileLoaded, dirLoaded] = await Promise.all([
          attachedFilePaths.length ? loadEmbeddedResourceAttachments(options.cwd, attachedFilePaths) : Promise.resolve({ resources: [], overflowPaths: [] }),
          attachedDirPaths.length ? loadDirectorySummaryResources(options.cwd, attachedDirPaths) : Promise.resolve([]),
        ]);
        resources.push(...fileLoaded.resources, ...dirLoaded);
      }
      const reason = await activeAgent.prompt(promptBody, images, resources);
      if (quitting || disconnected) return;
      completedNormally = reason === 'end_turn';
      phase = reason === 'cancelled' ? 'Cancelled' : reason === 'end_turn' ? 'Ready' : `Stopped: ${reason.replaceAll('_', ' ')}`;
    })().catch(error => {
      if (quitting) return;
      phase = 'Prompt failed';
      conversation.notice(error instanceof Error ? error.message : String(error), true, true);
    }).finally(() => {
      const elapsed = turnStartedAt ? Date.now() - turnStartedAt : 0;
      conversation.finishTurn(Date.now(), !completedNormally);
      void persistActiveTranscript();
      busy = false;
      turnStartedAt = undefined;
      cancelling = false;
      syncLiveTick(false);
      clearPermissions();
      if (!quitting && userPrefs.notifyOnTurnComplete && elapsed >= 8_000) {
        sendTerminalAttention('agy-tern', completedNormally ? 'Turn complete' : phase);
      }
      const touchedWorkspace = conversation.entries.slice(entryCountBeforePrompt).some(entry =>
        entry.type === 'tool' && (entry.call.kind === 'edit' || entry.call.kind === 'execute' ||
          entry.call.content?.some(item => item.type === 'diff')));
      if (!quitting && !disconnected && (touchedWorkspace || Date.now() - lastWorkspaceIndexAt > 30_000)) {
        refreshWorkspaceFiles();
      }
      if (completedNormally && !quitting && !disconnected && !permissions.length && queuedPrompts.length > 0) {
        const next = queuedPrompts.shift()!;
        submitPrompt(formatPromptWithAttachments(next.text, next.files, next.dirs), next.images, next.files, next.dirs);
        return;
      }
      render();
      surface?.scroll('main.conversation', 'end');
    });
  }

  function send(): void {
    if (changingConfig || sessionOperation || authBusy || permissions.length) return;
    if (!draft.text.trim() && !attachedFiles.length && !attachedDirs.length && !attachedImages.length) return;
    const text = draft.text;
    if (text.trimStart().startsWith('/') && !attachedFiles.length && !attachedDirs.length && !attachedImages.length) {
      const match = resolveCommand(text, availableCommands());
      if (match) {
        if (busy && !match.command.local) {
          // Non-local server slash commands wait cleanly in queue like prompts.
        } else {
          chooseCommand(match.command, match.args);
          return;
        }
      } else {
        conversation.notice('Command not available in this session. Use /help to see supported commands.', true);
        render();
        return;
      }
    }
    if (!agent || disconnected) return;
    const trimmedPrompt = text.trim();
    if (trimmedPrompt && promptHistory.at(-1) !== trimmedPrompt) promptHistory.push(trimmedPrompt);
    const filesToSend = attachedFiles;
    const dirsToSend = attachedDirs;
    const imagesToSend = attachedImages;
    draft = { text: '', cursor: 0 };
    undoStack.length = 0;
    historyIndex = undefined;
    historyStash = undefined;
    attachedFiles = [];
    attachedDirs = [];
    attachedImages = [];
    if (busy) {
      queuedPrompts.push({ id: `q-${++queueSequence}`, text, files: filesToSend, dirs: dirsToSend, images: imagesToSend });
      showToast('Queued follow-up prompt', trimmedPrompt || `${imagesToSend.length} image(s)`);
      render();
      return;
    }
    submitPrompt(formatPromptWithAttachments(text, filesToSend, dirsToSend), imagesToSend, filesToSend, dirsToSend);
  }

  function autocomplete(): Command[] {
    const query = commandQuery(draft.text);
    return !panel && !autocompleteDismissed && query !== undefined && !permissions.length && !sessionOperation && !authBusy
      ? filterCommands(availableCommands(), query) : [];
  }

  function activeAtMention(): { start: number; end: number; query: string } | undefined {
    if (panel || autocompleteDismissed || permissions.length || sessionOperation || authBusy) return undefined;
    if (commandQuery(draft.text) !== undefined) return undefined;
    return atMentionQuery(draft.text, draft.cursor);
  }

  function atFileMatches(): WorkspaceEntry[] {
    const mention = activeAtMention();
    if (!mention) return [];
    const imagePaths = new Set(attachedImages.map(image => image.path));
    return filterWorkspaceEntries(
      workspaceEntries.filter(entry =>
        entry.kind === 'dir'
          ? !attachedDirs.includes(entry.path)
          : !attachedFiles.includes(entry.path) && !imagePaths.has(entry.path)),
      mention.query,
      10,
    );
  }

  function isDirectoryTarget(targetPath: string): boolean {
    if (targetPath.endsWith('/')) return true;
    try {
      return statSync(resolve(options.cwd, targetPath)).isDirectory();
    } catch {
      return false;
    }
  }

  function attachFile(target: string | WorkspaceEntry): void {
    const entry: WorkspaceEntry = typeof target === 'string'
      ? {
        path: isDirectoryTarget(target) ? (target.endsWith('/') ? target : `${target}/`) : target,
        kind: isDirectoryTarget(target) ? 'dir' : 'file',
        ignored: ignoredPathsSet.has(target) || ignoredPathsSet.has(`${target}/`),
      }
      : target;
    const mention = activeAtMention();
    if (mention) draft = stripAtMention(draft, mention);
    fileSelection = 0;
    autocompleteDismissed = true;
    if (entry.kind === 'dir') {
      const dirPath = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
      if (!attachedDirs.includes(dirPath)) attachedDirs = [...attachedDirs, dirPath];
      render();
      surface?.focus('dock.draft');
      return;
    }
    const filePath = entry.path;
    if (imageMimeType(filePath)) {
      if (!agent?.promptCapabilities?.image) {
        render();
        showToast('Images not supported', 'This ACP agent did not advertise image prompt support');
        surface?.focus('dock.draft');
        return;
      }
      render();
      void readImageAttachment(options.cwd, filePath).then(loaded => {
        if (!quitting && !attachedImages.some(item => item.path === loaded.path)) {
          attachedImages = [...attachedImages, loaded];
        }
        render();
        surface?.focus('dock.draft');
      }).catch(error => {
        if (!quitting) showToast('Could not attach image', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (!attachedFiles.includes(filePath)) attachedFiles = [...attachedFiles, filePath];
    render();
    surface?.focus('dock.draft');
  }

  function removeAttachment(filePath: string): void {
    attachedFiles = attachedFiles.filter(item => item !== filePath);
    render();
    surface?.focus('dock.draft');
  }

  function removeDirAttachment(dirPath: string): void {
    attachedDirs = attachedDirs.filter(item => item !== dirPath);
    render();
    surface?.focus('dock.draft');
  }

  function removeImageAttachment(filePath: string): void {
    attachedImages = attachedImages.filter(item => item.path !== filePath);
    render();
    surface?.focus('dock.draft');
  }

  function panelChoices(): Choice[] {
    if (!panel || panel.kind === 'report' || panel.kind === 'changes' || panel.kind === 'find' || panel.kind === 'inspect' ||
      panel.kind === 'commands' || panel.kind === 'mcp' || panel.kind === 'plugins' || panel.kind === 'agents' ||
      panel.kind === 'templates') return [];
    let choices: Choice[];
    if (panel.kind === 'account' || panel.kind === 'account-switch') {
      const method = loginMethod();
      const problem = method ? terminalLoginProblem(method) : 'No terminal login method advertised';
      const disabled = busy || changingConfig || !!sessionOperation || authBusy || !!problem;
      if (panel.kind === 'account-switch') return [
        { label: 'Cancel', detail: 'Keep the current login unchanged.', choose: () => openPanel({ kind: 'account' }) },
        { label: 'Sign out and choose account', detail: 'Clear shared agy credentials, then start official interactive login.',
          disabled: disabled || !agent || disconnected || !authentication.logout, choose: () => requestLogin(true) },
      ];
      return [
        { label: 'Sign in', detail: 'Open official terminal login. A cached account may be reused.',
          disabled, choose: () => requestLogin(false) },
        { label: 'Change account', detail: 'Review the shared-login warning before signing out and choosing another account.',
          disabled: disabled || !agent || disconnected || !authentication.logout, choose: () => openPanel({ kind: 'account-switch' }) },
        { label: 'Quota and usage', detail: 'Read the active account’s official CLI quota report.',
          disabled: !agent || disconnected, choose: () => openPanel({ kind: 'report', report: 'usage' }) },
        { label: 'Back to conversation', detail: 'Keep the current login and conversation.', choose: closePanel },
      ];
    }
    if (panel.kind === 'permissions') {
      const mode = modeOption();
      return [
        ...(mode ? [{ label: 'Change session mode', detail: 'Choose a mode supplied by agy; not an OS sandbox guarantee.',
          value: configLabel(mode), choose: () => openPanel({ kind: 'config', id: mode.id }) }] : []),
        { label: 'Back to conversation', detail: 'Leave permission and sandbox information.', choose: closePanel },
      ];
    }
    if (panel.kind === 'rename') {
      const id = panel.sessionId;
      return [
        { label: 'Save local name', detail: 'Stored only by agy-tern, not renamed in Antigravity.', choose: () => saveName(id, panelDraft.text) },
        { label: 'Use agy title', detail: 'Remove this frontend’s local name.', choose: () => saveName(id, '') },
      ];
    }
    if (panel.kind === 'template-save') {
      const trimmed = draft.text.trim();
      return [
        { label: 'Save current draft as template',
          detail: trimmed ? `Save "${trimmed.slice(0, 48)}${trimmed.length > 48 ? '...' : ''}"` : 'Type a prompt in the composer draft first.',
          disabled: !trimmed || extLoading, choose: () => savePromptTemplate(panelDraft.text, draft.text) },
        { label: 'Back to templates', detail: 'Return without saving.', choose: () => openPanel({ kind: 'templates' }) },
      ];
    }
    if (panel.kind === 'mcp-add') {
      return [
        { label: 'Add MCP server', detail: 'Runs `agy mcp add` using official CLI syntax.',
          disabled: !panelDraft.text.trim() || extLoading, choose: () => runAddMcp(panelDraft.text) },
        { label: 'Cancel', detail: 'Return to MCP servers.', choose: () => openPanel({ kind: 'mcp' }) },
      ];
    }
    if (panel.kind === 'plugin-install') {
      return [
        { label: 'Install plugin', detail: 'Runs `agy plugin install` for this directory or plugin@marketplace.',
          disabled: !panelDraft.text.trim() || extLoading, choose: () => runInstallPlugin(panelDraft.text) },
        { label: 'Cancel', detail: 'Return to plugins.', choose: () => openPanel({ kind: 'plugins' }) },
      ];
    }
    if (panel.kind === 'confirm') {
      const confirmPanel = panel;
      return [
        { label: confirmPanel.actionLabel, detail: confirmPanel.detail, disabled: extLoading, choose: confirmPanel.onConfirm },
        { label: 'Cancel', detail: 'Return without making changes.',
          choose: () => { if (confirmPanel.returnTo) openPanel(confirmPanel.returnTo); else closePanel(); } },
      ];
    }
    if (panel.kind === 'sessions') {
      const query = panelDraft.text.toLowerCase();
      const rows = new Map(listedSessions.map(row => [row.sessionId, row]));
      if (activeSessionId) rows.set(activeSessionId, sessionInfo.get(activeSessionId) ?? { sessionId: activeSessionId, cwd: options.cwd });
      const matching = [...rows.values()].filter(row =>
        `${sessionTitle(row.sessionId)} ${row.title ?? ''} ${row.sessionId}`.toLowerCase().includes(query));
      matching.sort((a, b) => Number(b.sessionId === activeSessionId) - Number(a.sessionId === activeSessionId) ||
        (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
      return [
        { label: 'New conversation', detail: 'Start a separate official ACP session; keep this conversation available.',
          choose: newConversation },
        { label: 'Name current conversation', detail: 'Set a private, local label. Antigravity’s own title is unchanged.',
          choose: () => openPanel({ kind: 'rename', sessionId: activeSessionId }) },
        ...(agent?.capabilities.listSessions ? [{ label: 'Refresh conversations', detail: 'Read session metadata through official ACP.',
          choose: () => loadSessions() }] : []),
        ...matching.map(row => ({
          label: sessionTitle(row.sessionId),
          detail: `${row.updatedAt ?? 'No timestamp reported'} · ${row.sessionId}${localNames.get(row.sessionId) ? ' · Local name' : ''}`,
          value: row.sessionId === activeSessionId ? 'Current' : 'Open',
          disabled: row.sessionId !== activeSessionId && !agent?.capabilities.loadSession,
          choose: () => openConversation(row.sessionId),
        })),
        ...(nextSessionsCursor ? [{ label: 'Load older conversations', detail: 'Read the next page from agy.',
          choose: () => loadSessions(true) }] : []),
      ];
    }
    if (panel.kind === 'settings') {
      choices = metadata.configOptions.map(option => ({
        label: option.name, detail: option.description ?? option.id, value: configLabel(option),
        choose: () => openPanel({ kind: 'config', id: option.id }),
      }));
    } else if (panel.kind === 'config') {
      const id = panel.id;
      const option = metadata.configOptions.find(option => option.id === id);
      choices = option?.type === 'boolean' ? [true, false].map(value => ({
        label: value ? 'On' : 'Off', detail: option.description ?? option.name,
        value: option.currentValue === value ? 'Current' : undefined, choose: () => changeConfig(option, value),
      })) : option ? configValues(option).map(value => ({
        label: value.name, detail: value.description ?? value.value,
        value: option.currentValue === value.value ? 'Current' : undefined, choose: () => changeConfig(option, value.value),
      })) : [];
    } else {
      choices = [];
    }
    const query = panelDraft.text.toLowerCase();
    return choices.filter(choice => `${choice.label} ${choice.detail}`.toLowerCase().includes(query));
  }

  function renderPrefsPanel(): JSX.Element {
    const pages = [
      { id: 'appearance', label: 'Appearance & UI', icon: 'appearance' as const },
      { id: 'session', label: 'Session & Model', icon: 'model' as const },
      { id: 'permissions', label: 'Permissions & Sandbox', icon: 'shield' as const },
      { id: 'keys', label: 'Keybindings', icon: 'keyboard' as const },
    ];
    const leadByPage: Record<string, string> = {
      appearance: 'Transcript rendering, diff layout, and composer settings saved locally for agy-tern.',
      session: 'Dynamic session options supplied by agy over ACP. Changes apply to the active session.',
      permissions: 'Session mode reported by agy and sandbox boundary status.',
      keys: 'Keyboard shortcuts for the native composer, transcript, and one-time approvals.',
    };
    const lockReason = busy || changingConfig || !!sessionOperation || disconnected || !agent
      ? 'Wait until the active session is idle and connected'
      : undefined;
    const sessionRows: PrefsRow[] = metadata.configOptions.map(option => ({
      id: `cfg:${option.id}`,
      label: option.name,
      hint: option.description ?? option.id,
      disabled: lockReason,
      control: option.type === 'boolean'
        ? { k: 'switch', on: Boolean(option.currentValue) }
        : {
          k: 'choice',
          value: option.currentValue,
          style: configValues(option).length <= 3 ? 'segmented' : 'menu',
          options: configValues(option).map(entry => ({
            value: entry.value,
            label: entry.name,
            detail: entry.description ?? undefined,
          })),
        },
    }));
    const mode = modeOption();
    return <prefs key="prefs" title="agy-tern settings" page={prefsPage}
      lead={leadByPage[prefsPage]} query={panelDraft.text} cursor={panelDraft.cursor}
      pages={pages}
      sections={[
        {
          id: 'transcript',
          title: 'Transcript & Diffs',
          page: 'appearance',
          rows: [
            {
              id: 'diffMode',
              label: 'Diff layout',
              hint: 'How file edit diffs render inside tool cards',
              changed: userPrefs.diffMode !== DEFAULT_PREFS.diffMode,
              defaultLabel: DEFAULT_PREFS.diffMode,
              control: {
                k: 'choice',
                value: userPrefs.diffMode,
                style: 'segmented',
                options: [
                  { value: 'auto', label: 'Auto' },
                  { value: 'unified', label: 'Unified' },
                  { value: 'split', label: 'Split' },
                ],
              },
            },
            {
              id: 'toolDisplay',
              label: 'Tool activity default',
              hint: 'Compact collapses read/search/command bodies until clicked; Expanded opens all tools',
              changed: userPrefs.toolDisplay !== DEFAULT_PREFS.toolDisplay,
              defaultLabel: DEFAULT_PREFS.toolDisplay,
              control: {
                k: 'choice',
                value: userPrefs.toolDisplay,
                style: 'segmented',
                options: [
                  { value: 'compact', label: 'Compact' },
                  { value: 'expanded', label: 'Expanded' },
                ],
              },
            },
            {
              id: 'thoughtExpanded',
              label: 'Expand Thought blocks by default',
              hint: 'Keep agent reasoning open automatically instead of collapsed as Thought >',
              changed: userPrefs.thoughtExpanded !== DEFAULT_PREFS.thoughtExpanded,
              control: { k: 'switch', on: userPrefs.thoughtExpanded },
            },
            {
              id: 'transcriptDensity',
              label: 'Transcript density',
              hint: 'Comfortable adds turn dividers and avatars; Compact tightens spacing',
              changed: userPrefs.transcriptDensity !== DEFAULT_PREFS.transcriptDensity,
              defaultLabel: DEFAULT_PREFS.transcriptDensity,
              control: {
                k: 'choice',
                value: userPrefs.transcriptDensity,
                style: 'segmented',
                options: [
                  { value: 'comfortable', label: 'Comfortable' },
                  { value: 'compact', label: 'Compact' },
                ],
              },
            },
            {
              id: 'showTimestamps',
              label: 'Show turn timestamps',
              hint: 'Display HH:MM timestamps on messages and turn dividers',
              changed: userPrefs.showTimestamps !== DEFAULT_PREFS.showTimestamps,
              control: { k: 'switch', on: userPrefs.showTimestamps },
            },
            {
              id: 'autoPreviewMedia',
              label: 'Auto-open modal popup for images during turns',
              hint: 'Default off: screenshots and images display inline; click any image to open its modal preview',
              changed: userPrefs.autoPreviewMedia !== DEFAULT_PREFS.autoPreviewMedia,
              control: { k: 'switch', on: userPrefs.autoPreviewMedia },
            },
            {
              id: 'notifyOnTurnComplete',
              label: 'Terminal attention notifications',
              hint: 'Notify terminal when long turns (>= 8s) finish or approvals await',
              changed: userPrefs.notifyOnTurnComplete !== DEFAULT_PREFS.notifyOnTurnComplete,
              control: { k: 'switch', on: userPrefs.notifyOnTurnComplete },
            },
          ],
        },
        {
          id: 'composer',
          title: 'Composer & Dock',
          page: 'appearance',
          rows: [
            {
              id: 'composerLines',
              label: 'Composer max lines',
              hint: 'Maximum visible lines before the input box scrolls',
              changed: userPrefs.composerLines !== DEFAULT_PREFS.composerLines,
              defaultLabel: String(DEFAULT_PREFS.composerLines),
              control: {
                k: 'choice',
                value: String(userPrefs.composerLines),
                style: 'segmented',
                options: [
                  { value: '4', label: '4 lines' },
                  { value: '6', label: '6 lines' },
                  { value: '10', label: '10 lines' },
                ],
              },
            },
            {
              id: 'showKeyLegend',
              label: 'Show shortcut legend below dock',
              hint: 'Approval shortcuts still appear automatically while a permission prompt is active',
              changed: userPrefs.showKeyLegend !== DEFAULT_PREFS.showKeyLegend,
              control: { k: 'switch', on: userPrefs.showKeyLegend },
            },
            {
              id: 'resetPrefs',
              label: 'Reset local UI preferences',
              hint: 'Restore default transcript and composer settings without touching agy session config',
              control: { k: 'action', act: 'reset-prefs', label: 'Reset defaults' },
            },
          ],
        },
        {
          id: 'acp-session',
          title: sessionRows.length ? 'Server Session Options' : 'No ACP Options Reported',
          page: 'session',
          rows: sessionRows.length ? sessionRows : [{
            id: 'no-acp-options',
            label: 'No session settings supplied by agy',
            hint: 'Available options appear here after ACP session creation',
          }],
        },
        {
          id: 'model-memory',
          title: 'Model Defaults & Memory',
          page: 'session',
          rows: [
            {
              id: 'rememberModel',
              label: 'Remember last selected model & thinking level',
              hint: `Falls back to ${DEFAULT_MODEL_ID} (${DEFAULT_THINKING_ID}) for new sessions until changed`,
              changed: userPrefs.rememberModel !== DEFAULT_PREFS.rememberModel,
              control: { k: 'switch', on: userPrefs.rememberModel },
            },
            {
              id: 'clearRememberedModel',
              label: 'Reset remembered model choice',
              hint: userPrefs.lastModel || userPrefs.lastThinking
                ? `Saved: ${userPrefs.lastModel ?? DEFAULT_MODEL_ID} · ${userPrefs.lastThinking ?? DEFAULT_THINKING_ID}`
                : `Using built-in default (${DEFAULT_MODEL_ID} · ${DEFAULT_THINKING_ID})`,
              changed: !!(userPrefs.lastModel || userPrefs.lastThinking),
              control: { k: 'action', act: 'clear-remembered-model', label: 'Use default' },
            },
          ],
        },
        {
          id: 'perms-summary',
          title: 'Sandbox & Mode',
          page: 'permissions',
          rows: [
            ...(mode && mode.type === 'select' ? [{
              id: `cfg:${mode.id}`,
              label: mode.name,
              hint: 'Session mode supplied by agy; Plan mode does not verify read-only OS enforcement',
              disabled: lockReason,
              control: {
                k: 'choice' as const,
                value: mode.currentValue,
                style: 'segmented' as const,
                options: configValues(mode).map(entry => ({ value: entry.value, label: entry.name })),
              },
            }] : []),
            {
              id: 'sandbox-flag',
              label: 'Sandbox status (--sandbox)',
              hint: 'Requested when launching agy acp; OS containment and allow/deny rules are owned by agy',
              control: { k: 'action', act: 'open-permissions', label: 'View details' },
            },
            {
              id: 'account-shortcut',
              label: 'Account & official login',
              hint: 'Manage shared agy CLI authentication or check quota',
              control: { k: 'action', act: 'open-account', label: 'Open Account' },
            },
          ],
        },
        {
          id: 'keys-list',
          title: 'Shortcuts',
          page: 'keys',
          rows: [
            { id: 'k-send', label: 'Send message', control: { k: 'keys', keys: [['enter']] } },
            { id: 'k-newline', label: 'Insert newline', control: { k: 'keys', keys: [['shift', 'enter']] } },
            { id: 'k-line-edges', label: 'Line start / end (shell style)', control: { k: 'keys', keys: [['ctrl', 'a'], ['ctrl', 'e']] } },
            { id: 'k-words', label: 'Jump by word', control: { k: 'keys', keys: [['ctrl', 'left'], ['ctrl', 'right']] } },
            { id: 'k-lines-hist', label: 'Move line / prompt history (when empty)', control: { k: 'keys', keys: [['up'], ['down']] } },
            { id: 'k-kill', label: 'Delete word / line start / line end', control: { k: 'keys', keys: [['ctrl', 'w'], ['ctrl', 'u'], ['ctrl', 'k']] } },
            { id: 'k-undo', label: 'Undo composer edit', control: { k: 'keys', keys: [['ctrl', 'z']] } },
            { id: 'k-slash', label: 'Slash commands', control: { k: 'keys', keys: [['/']] } },
            { id: 'k-at', label: 'Attach file or image (or paste image path)', control: { k: 'keys', keys: [['@']] } },
            { id: 'k-stop', label: 'Stop turn / Close modal', control: { k: 'keys', keys: [['esc']] } },
            { id: 'k-scroll', label: 'Scroll conversation', control: { k: 'keys', keys: [['page_up'], ['page_down']] } },
            { id: 'k-allow', label: 'Allow / Deny tool once', control: { k: 'keys', keys: [['ctrl', 'y'], ['ctrl', 'n']] } },
            { id: 'k-quit', label: 'Quit frontend', control: { k: 'keys', keys: [['ctrl', 'q']] } },
          ],
        },
      ]}
      onAction={{
        close: closePanel,
        page: event => {
          if (typeof event.value === 'string') { prefsPage = event.value; render(); }
        },
        'reset-prefs': resetPrefs,
        'clear-remembered-model': () => {
          updatePrefs({ lastModel: undefined, lastThinking: undefined });
          showToast('Remembered model cleared', `Default for new sessions: ${DEFAULT_MODEL_ID} (${DEFAULT_THINKING_ID})`);
        },
        'open-permissions': () => openPanel({ kind: 'permissions' }),
        'open-account': () => openPanel({ kind: 'account' }),
      }}
      onChange={event => {
        const key = event.item;
        if (!key) return;
        if (key === 'diffMode' && (event.value === 'auto' || event.value === 'unified' || event.value === 'split')) {
          updatePrefs({ diffMode: event.value as DiffMode });
        } else if (key === 'toolDisplay' && (event.value === 'compact' || event.value === 'expanded')) {
          updatePrefs({ toolDisplay: event.value as ToolDisplay });
        } else if (key === 'thoughtExpanded' && typeof event.value === 'boolean') {
          updatePrefs({ thoughtExpanded: event.value });
        } else if (key === 'transcriptDensity' && (event.value === 'comfortable' || event.value === 'compact')) {
          updatePrefs({ transcriptDensity: event.value as TranscriptDensity });
        } else if (key === 'showTimestamps' && typeof event.value === 'boolean') {
          updatePrefs({ showTimestamps: event.value });
        } else if (key === 'autoPreviewMedia' && typeof event.value === 'boolean') {
          updatePrefs({ autoPreviewMedia: event.value });
        } else if (key === 'notifyOnTurnComplete' && typeof event.value === 'boolean') {
          updatePrefs({ notifyOnTurnComplete: event.value });
        } else if (key === 'rememberModel' && typeof event.value === 'boolean') {
          updatePrefs({ rememberModel: event.value });
        } else if (key === 'showKeyLegend' && typeof event.value === 'boolean') {
          updatePrefs({ showKeyLegend: event.value });
        } else if (key === 'composerLines') {
          const n = Number(event.value);
          if (n === 4 || n === 6 || n === 10) updatePrefs({ composerLines: n as ComposerLines });
        } else if (key.startsWith('cfg:')) {
          const configId = key.slice(4);
          const option = metadata.configOptions.find(candidate => candidate.id === configId);
          if (option && (typeof event.value === 'string' || typeof event.value === 'boolean')) {
            changeConfig(option, event.value);
          }
        }
      }} />;
  }

  function renderSelectConfigPicker(option: Extract<SessionConfigOption, { type: 'select' }>): JSX.Element {
    const query = panelDraft.text.trim().toLowerCase();
    const groups = groupSelectConfigOptions(option);
    const visibleGroups = groups
      .filter(group => pickerTab === 'all' || group.id === pickerTab)
      .map(group => ({
        ...group,
        options: group.options.filter(val =>
          `${val.name} ${val.value} ${val.description ?? ''}`.toLowerCase().includes(query)),
      }))
      .filter(group => group.options.length > 0);
    const flat = visibleGroups.flatMap(group => group.options.map(val => ({ group, val })));
    const selectedId = flat.some(entry => entry.val.value === pickerSelected)
      ? pickerSelected
      : flat[0]?.val.value ?? '';
    const highlighted = flat.find(entry => entry.val.value === selectedId);
    const order: Array<string | PickerGroup> = [];
    for (const group of visibleGroups) {
      if (visibleGroups.length > 1 || groups.length > 1) {
        order.push({ group: group.id, label: group.label, count: group.options.length });
      }
      for (const val of group.options) order.push(val.value);
    }
    const items: PickerItem[] = flat.map(({ val }) => ({
      id: val.value,
      label: val.name,
      detail: val.description ?? (val.value !== val.name ? val.value : undefined),
      badges: option.currentValue === val.value ? [{ text: 'Current', tone: 'success' }] : undefined,
      node: 'pv',
    }));
    const totalCount = groups.reduce((sum, group) => sum + group.options.length, 0);
    const tabs = groups.length > 1
      ? [
        { id: 'all', label: 'All', count: totalCount },
        ...groups.map(group => ({ id: group.id, label: group.label, count: group.options.length })),
      ]
      : undefined;

    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title={option.name} icon={option.category === 'model' || option.id === 'model' ? 'model' : 'settings'}
      subtitle={option.description ?? 'Options supplied by the active agy ACP session'}
      placeholder={`Search ${option.name.toLowerCase()}...`}
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={tabs} tab={tabs ? pickerTab : undefined}
      order={order} items={items} selected={selectedId} current={[option.currentValue]}
      state={changingConfig ? 'loading' : panelError ? 'error' : 'ready'}
      message={changingConfig ? `Applying ${option.name} through agy...` : panelError || (busy ? 'Wait for the active turn before changing this option.' : undefined)}
      empty="No matching options supplied by this agy session."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'apply', label: `Use ${option.name.toLowerCase()}`, primary: true, keys: ['enter'],
          disabled: (!highlighted || busy || changingConfig || disconnected) ? true : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={event => {
        if (!busy && !changingConfig && !disconnected) changeConfig(option, event.item);
      }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; render(); }
        },
        apply: () => {
          if (highlighted && !busy && !changingConfig && !disconnected) changeConfig(option, highlighted.val.value);
        },
      }}>
      {highlighted && <kv key="pv" items={[
        { k: 'Name', v: highlighted.val.name },
        { k: 'Option ID', v: highlighted.val.value },
        { k: 'Group', v: highlighted.group.label },
        ...(highlighted.val.description ? [{ k: 'Description', v: highlighted.val.description }] : []),
        { k: 'Status', v: highlighted.val.value === option.currentValue ? 'Active in session' : 'Available via ACP metadata' },
      ]} />}
    </picker>;
  }

  function renderSessionsPicker(): JSX.Element {
    const rows = new Map(listedSessions.map(row => [row.sessionId, row]));
    if (activeSessionId) rows.set(activeSessionId, sessionInfo.get(activeSessionId) ?? { sessionId: activeSessionId, cwd: options.cwd });
    const allRows = [...rows.values()];
    const namedRows = allRows.filter(row => !!localNames.get(row.sessionId));
    const filtered = filterSessionRows(allRows, localNames, activeSessionId, sessionTitle, pickerTab, panelDraft.text);
    const selectedId = filtered.some(row => row.sessionId === pickerSelected)
      ? pickerSelected
      : filtered[0]?.sessionId ?? '';
    const highlighted = filtered.find(row => row.sessionId === selectedId);
    const items: PickerItem[] = filtered.map(row => {
      const badges = [
        ...(row.sessionId === activeSessionId ? [{ text: 'Current', tone: 'success' as const }] : []),
        ...(previousSessionId && row.sessionId === previousSessionId ? [{ text: 'Previous', tone: 'info' as const }] : []),
        ...(localNames.get(row.sessionId) ? [{ text: 'Local name', tone: 'accent' as const }] : []),
      ];
      return {
        id: row.sessionId,
        label: sessionTitle(row.sessionId),
        detail: `${row.updatedAt ?? 'No timestamp'} · ${row.sessionId.slice(0, 12)}`,
        badges: badges.length ? badges : undefined,
        disabled: row.sessionId !== activeSessionId && !agent?.capabilities.loadSession
          ? 'agy does not advertise loading previous sessions' : undefined,
        node: 'pv',
      };
    });
    const cannotSwitch = busy || changingConfig || !!sessionOperation || disconnected;
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Workspace conversations" icon="history"
      subtitle={`Filtered by cwd reported by agy (${options.cwd}); original workspace is not verified.`}
      placeholder="Search conversations by title, local name, or ID..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[
        { id: 'all', label: 'All', count: allRows.length },
        { id: 'named', label: 'Local named', count: namedRows.length },
      ]}
      tab={pickerTab}
      order={filtered.map(row => row.sessionId)}
      items={items} selected={selectedId}
      current={activeSessionId ? [activeSessionId] : undefined}
      state={sessionOperation || (sessionsLoading && !listedSessions.length) ? 'loading' : panelError ? 'error' : 'ready'}
      message={sessionOperation ?? (sessionsLoading ? 'Syncing conversations from agy...' : panelError || (!agent?.capabilities.listSessions ? 'agy does not advertise session listing.' : undefined))}
      empty="No saved conversations matched your filter."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'new', label: 'New', disabled: cannotSwitch ? (true as const) : undefined },
        { id: 'rename', label: 'Rename', disabled: (cannotSwitch || !activeSessionId) ? (true as const) : undefined },
        ...(agent?.capabilities.listSessions ? [{ id: 'refresh', label: 'Refresh', disabled: cannotSwitch ? (true as const) : undefined }] : []),
        ...(nextSessionsCursor ? [{ id: 'more', label: 'Load older', disabled: cannotSwitch ? (true as const) : undefined }] : []),
        ...(agent?.capabilities.resumeSession ? [{ id: 'resume', label: 'Fast resume',
          disabled: (cannotSwitch || !highlighted || highlighted.sessionId === activeSessionId) ? (true as const) : undefined }] : []),
        ...(agent?.capabilities.closeSession ? [{ id: 'closeSession', label: 'Close session',
          disabled: (cannotSwitch || !highlighted || highlighted.sessionId === activeSessionId) ? (true as const) : undefined }] : []),
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'open', label: 'Open', primary: true, keys: ['enter'],
          disabled: (cannotSwitch || !highlighted || (highlighted.sessionId !== activeSessionId && !agent?.capabilities.loadSession)) ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={event => {
        if (!cannotSwitch) openConversation(event.item);
      }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; render(); }
        },
        new: newConversation,
        rename: () => openPanel({ kind: 'rename', sessionId: activeSessionId }),
        refresh: () => loadSessions(),
        more: () => loadSessions(true),
        resume: () => {
          if (highlighted && !cannotSwitch) openConversation(highlighted.sessionId, 'resume');
        },
        closeSession: () => {
          if (highlighted && !cannotSwitch && highlighted.sessionId !== activeSessionId) closeSavedSession(highlighted.sessionId);
        },
        open: () => {
          if (highlighted && !cannotSwitch) openConversation(highlighted.sessionId, 'load');
        },
      }}>
      {highlighted && <kv key="pv" items={[
        { k: 'Title', v: sessionTitle(highlighted.sessionId) },
        { k: 'Session ID', v: highlighted.sessionId },
        { k: 'Reported cwd', v: highlighted.cwd },
        { k: 'Updated', v: highlighted.updatedAt ?? 'Not reported' },
        { k: 'Label source', v: localNames.get(highlighted.sessionId) ? 'Local agy-tern label (not renamed on server)' : 'Reported by agy' },
      ]} />}
    </picker>;
  }

  function renderChangesPicker(): JSX.Element {
    const query = panelDraft.text.trim().toLowerCase();
    const sessionDiffs = getSessionDiffs();
    const filteredEdits = sessionDiffs.filter(item => item.path.toLowerCase().includes(query));
    const filteredGit = gitChanges.filter(item => `${item.status} ${item.path}`.toLowerCase().includes(query));
    const usingGit = pickerTab === 'git';
    const order = usingGit ? filteredGit.map(item => `git:${item.path}`) : filteredEdits.map(item => item.id);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlightedEdit = usingGit ? undefined : filteredEdits.find(item => item.id === selectedId);
    const highlightedGit = usingGit ? filteredGit.find(item => `git:${item.path}` === selectedId) : undefined;
    const highlightedGitDiff = highlightedGit
      ? [...sessionDiffs].reverse().find(item => item.path === highlightedGit.path)
      : undefined;
    if (highlightedGit && !highlightedGitDiff) {
      loadGitDiffPreview(highlightedGit);
    }
    const cachedGitDiff = highlightedGit ? gitDiffCache.get(highlightedGit.path) : undefined;
    const highlightedPath = highlightedEdit?.path ?? highlightedGit?.path;

    const items: PickerItem[] = usingGit
      ? filteredGit.map(entry => ({
        id: `git:${entry.path}`,
        label: basename(entry.path),
        detail: entry.path,
        badges: [{
          text: entry.status,
          tone: entry.status === 'D' ? 'error' as const : entry.status === '?' || entry.status === 'A' ? 'success' as const : 'accent' as const,
        }],
        node: 'pv',
      }))
      : filteredEdits.map(item => ({
        id: item.id,
        label: basename(item.path),
        detail: item.path,
        badges: [
          ...(item.added ? [{ text: `+${item.added}`, tone: 'success' as const }] : []),
          ...(item.removed ? [{ text: `-${item.removed}`, tone: 'error' as const }] : []),
        ],
        node: 'pv',
      }));

    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Changes" icon="diff"
      subtitle="Session edits and git status"
      placeholder="Filter modified paths..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[
        { id: 'edits', label: 'Session edits', count: sessionDiffs.length },
        { id: 'git', label: 'Git status', count: gitChanges.length },
      ]}
      tab={usingGit ? 'git' : 'edits'}
      order={order} items={items} selected={selectedId}
      state="ready"
      empty={usingGit ? 'Working tree is clean or git status is unavailable.' : 'No file edits recorded in this conversation yet.'}
      preview={highlightedPath ? 'below' : 'none'}
      actions={[
        { id: 'refresh', label: 'Refresh git' },
        { id: 'inspect', label: 'Fullscreen', disabled: !highlightedPath ? (true as const) : undefined },
        { id: 'split', label: 'Tern split',
          disabled: !highlightedPath || !existsSync(resolve(options.cwd, highlightedPath)) ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'attach', label: 'Attach to draft', primary: true, keys: ['enter'],
          disabled: !highlightedPath ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => {
        if (highlightedPath) { closePanel(); attachFile(highlightedPath); }
      }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; pickerSelected = ''; render(); }
        },
        refresh: () => {
          gitDiffCache.clear();
          void detectGitStatus(options.cwd).then(rows => {
            if (!quitting) { gitChanges = rows; render(); }
          }).catch(() => {});
        },
        split: () => {
          const line = highlightedEdit?.hunks[0]?.newStart ?? cachedGitDiff?.hunks[0]?.newStart;
          if (highlightedPath) openSplit(highlightedPath, line);
        },
        inspect: () => {
          const targetEdit = highlightedEdit ?? highlightedGitDiff;
          if (targetEdit) {
            if (targetEdit.newFileText !== undefined) {
              openInspect(basename(targetEdit.path), { type: 'file', path: targetEdit.path, content: targetEdit.newFileText }, targetEdit.path);
            } else {
              openInspect(basename(targetEdit.path), { type: 'diff', path: targetEdit.path, hunks: targetEdit.hunks }, targetEdit.path);
            }
          } else if (highlightedGit && cachedGitDiff?.hunks.length) {
            openInspect(basename(highlightedGit.path), { type: 'diff', path: highlightedGit.path, hunks: cachedGitDiff.hunks }, highlightedGit.path);
          } else if (highlightedGit) {
            void readWorkspaceTextPreview(options.cwd, highlightedGit.path).then(preview => {
              if (!quitting) openInspect(basename(highlightedGit.path), { type: 'file', path: preview.path, content: preview.text, truncated: preview.truncated }, highlightedGit.path);
            }).catch(() => {});
          }
        },
        attach: () => {
          if (highlightedPath) { closePanel(); attachFile(highlightedPath); }
        },
      }}>
      {highlightedEdit && (highlightedEdit.newFileText !== undefined
        ? <code key="pv" numbers path={highlightedEdit.path}>{highlightedEdit.newFileText}</code>
        : highlightedEdit.hunks.length
          ? <diff key="pv" mode={userPrefs.diffMode} path={highlightedEdit.path} hunks={highlightedEdit.hunks} />
          : <kv key="pv" items={[{ k: 'File', v: highlightedEdit.path }, { k: 'Status', v: 'No line delta recorded' }]} />)}
      {!highlightedEdit && highlightedGit && (highlightedGitDiff
        ? (highlightedGitDiff.newFileText !== undefined
          ? <code key="pv" numbers path={highlightedGitDiff.path}>{highlightedGitDiff.newFileText}</code>
          : <diff key="pv" mode={userPrefs.diffMode} path={highlightedGitDiff.path} hunks={highlightedGitDiff.hunks} />)
        : cachedGitDiff?.status === 'loading'
          ? <spinner key="pv" label={`Reading git diff for ${highlightedGit.path}`} />
          : cachedGitDiff?.hunks.length
            ? <diff key="pv" mode={userPrefs.diffMode} path={highlightedGit.path} hunks={cachedGitDiff.hunks} />
            : <kv key="pv" items={[
              { k: 'Path', v: highlightedGit.path },
              { k: 'Git status', v: highlightedGit.status },
              { k: 'Diff', v: 'No text diff (untracked or binary)' },
            ]} />)}
    </picker>;
  }

  function inspectFindMatch(match: ReturnType<typeof searchTranscript>[number]): void {
    const entry = match.entry;
    if (entry.type === 'tool') {
      const imgPath = extractToolImagePaths(entry.call, options.cwd).find(p => existsSync(p));
      if (imgPath) {
        const label = formatPathLabel(imgPath, options.cwd);
        openInspect(basename(label), { type: 'image-path', path: imgPath }, label);
        return;
      }
      const inlineImgs = extractToolInlineImages(entry.call);
      if (inlineImgs.length) {
        const img = inlineImgs[0]!;
        const blob = blobForImage(`tool:${entry.id}:0`, img.data, img.mimeType);
        if (blob) {
          openInspect(match.label, { type: 'image-blob', blob, mimeType: img.mimeType }, img.mimeType);
          return;
        }
      }
      const diffContent = entry.call.content?.find(c => c.type === 'diff');
      if (diffContent && diffContent.type === 'diff') {
        const label = formatPathLabel(diffContent.path, options.cwd);
        if (diffContent.oldText == null) {
          openInspect(basename(label), { type: 'file', path: label, content: diffContent.newText }, label);
        } else {
          const diff = buildUnifiedDiffHunks(diffContent.oldText, diffContent.newText);
          openInspect(basename(label), { type: 'diff', path: label, hunks: diff.hunks }, label);
        }
        return;
      }
    } else if (entry.type === 'message' && entry.images?.length) {
      const img = entry.images[0]!;
      const blob = blobForImage(`${entry.id}:img:0`, img.data, img.mimeType);
      if (blob && !entry.text.trim()) {
        openInspect(match.label, { type: 'image-blob', blob, mimeType: img.mimeType }, img.mimeType);
        return;
      }
    }
    openInspect(match.label, { type: 'file', path: match.detail || match.label, content: match.preview || match.detail }, match.detail);
  }

  function renderFindPicker(): JSX.Element {
    const matches = searchTranscript(conversation.entries, options.cwd, panelDraft.text);
    const tabs = [
      { id: 'all', label: 'All', count: matches.length },
      { id: 'message', label: 'Messages', count: matches.filter(m => m.kind === 'message').length },
      { id: 'tool', label: 'Tools & Diffs', count: matches.filter(m => m.kind === 'tool').length },
      { id: 'thought', label: 'Thoughts', count: matches.filter(m => m.kind === 'thought').length },
    ];
    const filtered = pickerTab === 'all' ? matches : matches.filter(m => m.kind === pickerTab);
    const order = filtered.map(m => m.id);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(m => m.id === selectedId);
    const items: PickerItem[] = filtered.map(m => ({
      id: m.id,
      label: m.label,
      detail: m.detail,
      badges: [{ text: m.kind.toUpperCase(), tone: m.kind === 'tool' ? 'info' as const : m.kind === 'plan' ? 'accent' as const : 'neutral' as const }],
      node: 'pv',
    }));
    const hlImgPath = highlighted?.entry.type === 'tool'
      ? extractToolImagePaths(highlighted.entry.call, options.cwd).find(p => existsSync(p))
      : undefined;

    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Find" icon="slash"
      subtitle="Search transcript entries"
      placeholder="Type keywords to filter transcript..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={tabs}
      tab={pickerTab}
      order={order} items={items} selected={selectedId}
      state="ready"
      empty={conversation.entries.length ? 'No transcript entries match your search.' : 'Transcript is empty.'}
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'copy', label: 'Copy', disabled: !highlighted ? (true as const) : undefined },
        { id: 'jump', label: 'Jump to chat', disabled: !highlighted ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'inspect', label: 'Inspect', primary: true, keys: ['enter'],
          disabled: !highlighted ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => { if (highlighted) inspectFindMatch(highlighted); }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; pickerSelected = ''; render(); }
        },
        copy: () => {
          if (!highlighted) return;
          void copyToClipboard(highlighted.preview || highlighted.detail).then(copied => {
            if (!quitting) showToast(copied ? 'Copied match to clipboard' : 'Clipboard unavailable');
          });
        },
        jump: () => {
          if (!highlighted) return;
          const targetEntry = highlighted.entry;
          const idx = conversation.entries.indexOf(targetEntry);
          if (idx >= 0) {
            const needed = conversation.entries.length - idx;
            if (needed > historyVisibleCount) historyVisibleCount = needed + 20;
          }
          if (targetEntry.type === 'thought') thoughtFoldOverrides.set(targetEntry.id, true);
          else if (targetEntry.type === 'tool') toolFoldOverrides.set(targetEntry.id, false);
          closePanel();
          surface?.reveal(`main.conversation.${targetEntry.id}`, 'start');
        },
        inspect: () => { if (highlighted) inspectFindMatch(highlighted); },
      }}>
      {highlighted && <col key="pv" gap="xs">
        <text><span s="muted">{highlighted.detail}</span></text>
        {hlImgPath && <col align="center"><media path={hlImgPath} /></col>}
        <md>{(highlighted.preview || highlighted.detail).slice(0, 1200)}</md>
      </col>}
    </picker>;
  }

  function renderInspectOverlay(p: Extract<Panel, { kind: 'inspect' }>): JSX.Element {
    const item = p.item;
    const isMedia = item.type === 'image-path' || item.type === 'image-blob';
    const isDir = item.type === 'dir';
    const rLayout = currentResponsiveLayout();
    const overlaySize = isMedia ? rLayout.panelSize : rLayout.inspectSize;
    const bodyMaxH = rLayout.inspectBodyMaxH;
    const copyText = item.type === 'file' ? item.content
      : item.type === 'diff' ? item.hunks.flatMap(h => h.lines).join('\n')
      : isDir ? item.preview.entries.map(e => `${e.kind === 'dir' ? `${e.name}/` : e.name}${e.ignored ? ' [gitignored]' : ''}`).join('\n')
      : undefined;
    const attachablePath = item.type === 'image-path' || item.type === 'diff' || item.type === 'file'
      ? item.path
      : isDir ? item.preview.path : undefined;
    const cleanInspectDir = isDir ? item.preview.path.replace(/\/+$/, '') : '';
    const parentInspectDir = isDir && cleanInspectDir.includes('/')
      ? `${cleanInspectDir.slice(0, cleanInspectDir.lastIndexOf('/'))}/`
      : isDir && cleanInspectDir && cleanInspectDir !== '.'
        ? '.'
        : undefined;

    return <overlay key="panel" anchor="center" modal size={overlaySize}
      head={p.title}
      icon={isMedia ? 'file-image' : isDir ? 'folder' : item.type === 'diff' ? 'diff' : 'file'}
      meta={p.subtitle}
      end={<button keys={['esc']} variant="quiet" onClick={closePanel}>Close</button>}
      foot={<row gap="xs" justify="between" align="center" wrap>
        <text><span s="muted">{item.type === 'file' && item.truncated ? 'Preview truncated at 64 KB · '
          : isDir && item.preview.truncated ? `Showing ${item.preview.entries.length} of ${item.preview.totalCount} entries · ` : ''}Esc closes without cancelling</span></text>
        <row gap="xs">
          {parentInspectDir && <button size="sm" icon="back" onClick={() => {
            void listDirectoryEntriesPreview(options.cwd, parentInspectDir).then(pv => {
              if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
            }).catch(() => {});
          }}>Up</button>}
          {item.type === 'diff' && <button size="sm" onClick={() => {
            const next: DiffMode = userPrefs.diffMode === 'auto' ? 'unified' : userPrefs.diffMode === 'unified' ? 'split' : 'auto';
            updatePrefs({ diffMode: next });
          }}>Layout: {userPrefs.diffMode}</button>}
          {copyText !== undefined && <button size="sm" icon="copy" onClick={() => {
            void copyToClipboard(copyText).then(copied => {
              if (!quitting) showToast(copied ? 'Copied to clipboard' : 'Clipboard unavailable');
            });
          }}>Copy</button>}
          {attachablePath && !isMedia && existsSync(resolve(options.cwd, attachablePath.replace(/\/+$/, ''))) && <>
            {!isDir && <button size="sm" icon="split" onClick={() => openSplit(attachablePath)}>Tern split</button>}
            <button size="sm" variant="primary" onClick={() => {
              closePanel();
              attachFile(attachablePath);
            }}>Attach</button>
          </>}
        </row>
      </row>}>
      {item.type === 'image-path' && <col align="center" justify="center" gap="sm">
        <media path={item.path} />
      </col>}
      {item.type === 'image-blob' && <col align="center" justify="center" gap="sm">
        <image blob={item.blob} alt={item.name ?? item.mimeType} />
      </col>}
      {item.type === 'diff' && (item.hunks.length
        ? <scroll max={{ h: bodyMaxH }}><diff mode={userPrefs.diffMode} path={item.path} hunks={item.hunks} /></scroll>
        : <text><span s="muted">No diff hunks recorded.</span></text>)}
      {item.type === 'file' && <scroll max={{ h: bodyMaxH }}>
        <code numbers path={item.path}>{item.content}</code>
      </scroll>}
      {isDir && <scroll max={{ h: bodyMaxH }}>
        <col gap="xs">
          <kv items={[
            { k: 'Directory', v: item.preview.path },
            { k: 'Items', v: String(item.preview.totalCount) },
          ]} />
          <list max={{ lines: rLayout.dirListMaxLines }} empty="Directory is empty.">
            {item.preview.entries.map(entry => <item key={entry.path}
              icon={entry.kind === 'dir' ? 'folder' : imageMimeType(entry.name) ? 'file-image' : 'file'}
              label={entry.kind === 'dir' ? `${entry.name}/` : entry.name}
              detail={entry.ignored ? `${entry.path} [gitignored]` : entry.path}
              value={entry.ignored ? 'gitignored' : entry.kind === 'dir' ? 'Dir' : 'File'}
              onClick={() => {
                if (entry.kind === 'dir') {
                  void listDirectoryEntriesPreview(options.cwd, entry.path).then(pv => {
                    if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
                  }).catch(() => {});
                } else {
                  closePanel();
                  attachFile(entry.path);
                }
              }} />)}
          </list>
        </col>
      </scroll>}
    </overlay>;
  }

  function renderCommandsPicker(): JSX.Element {
    const all = filterCommands(availableCommands(), panelDraft.text);
    const tabs = [
      { id: 'all', label: 'All', count: all.length },
      { id: 'frontend', label: 'Frontend', count: all.filter(c => commandCategory(c) === 'frontend').length },
      { id: 'workflow', label: 'Workflows', count: all.filter(c => commandCategory(c) === 'workflow').length },
      { id: 'skill', label: 'Skills', count: all.filter(c => commandCategory(c) === 'skill').length },
    ];
    const filtered = filterCommandsForTab(availableCommands(), pickerTab, panelDraft.text);
    const order = filtered.map(c => c.name);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(c => c.name === selectedId);
    const items: PickerItem[] = filtered.map(cmd => {
      const cat = commandCategory(cmd);
      return {
        id: cmd.name,
        label: `/${cmd.name}`,
        detail: cmd.description,
        badges: [{
          text: cat === 'frontend' ? 'Frontend' : cat === 'workflow' ? 'Workflow' : 'Skill',
          tone: cat === 'frontend' ? 'accent' as const : cat === 'workflow' ? 'info' as const : 'neutral' as const,
        }],
        node: 'pv',
      };
    });
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Commands & skills" icon="slash"
      subtitle="Frontend, workflows, and skills"
      placeholder="Filter commands by name or description..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={tabs} tab={pickerTab} order={order} items={items} selected={selectedId}
      state="ready"
      empty="No commands match your filter."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'fill', label: 'Fill draft', disabled: !highlighted ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'run', label: highlighted?.local ? 'Open' : highlighted?.hint ? 'Prepare' : 'Send', primary: true, keys: ['enter'],
          disabled: !highlighted ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => { if (highlighted) chooseCommand(highlighted); }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; pickerSelected = ''; render(); }
        },
        fill: () => { if (highlighted) chooseCommand(highlighted, '', true); },
        run: () => { if (highlighted) chooseCommand(highlighted); },
      }}>
      {highlighted && <col key="pv" gap="xs">
        <kv items={[
          { k: 'Command', v: `/${highlighted.name}${highlighted.hint ? ` <${highlighted.hint}>` : ''}` },
          { k: 'Owner', v: highlighted.local ? 'agy-tern native panel' : `Official agy (${commandCategory(highlighted)})` },
        ]} />
        <md>{highlighted.description}</md>
      </col>}
    </picker>;
  }

  function renderMcpPicker(): JSX.Element {
    const visible = filterMcpServers(mcpServers, 'all', panelDraft.text);
    const filtered = filterMcpServers(mcpServers, pickerTab, panelDraft.text);
    const order = filtered.map(s => s.name);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(s => s.name === selectedId);
    const items: PickerItem[] = filtered.map(server => ({
      id: server.name,
      label: server.name,
      detail: server.target || server.type,
      badges: [
        { text: server.type, tone: 'neutral' as const },
        { text: server.status, tone: server.status === 'enabled' ? 'success' as const : 'muted' as const },
      ],
      node: 'pv',
    }));
    const canToggle = !!highlighted && !extLoading;
    const targetEnabled = highlighted?.status !== 'enabled';
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="MCP servers" icon="settings"
      subtitle="Configured via agy mcp CLI"
      placeholder="Filter MCP servers..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[
        { id: 'all', label: 'All', count: visible.length },
        { id: 'enabled', label: 'Enabled', count: visible.filter(s => s.status === 'enabled').length },
        { id: 'disabled', label: 'Disabled', count: visible.filter(s => s.status !== 'enabled').length },
      ]}
      tab={pickerTab} order={order} items={items} selected={selectedId}
      state={extLoading ? 'loading' : panelError ? 'error' : 'ready'}
      message={extLoading ? 'Querying official `agy mcp`...' : (panelError || undefined)}
      empty="No MCP servers configured."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'refresh', label: 'Refresh', disabled: extLoading ? (true as const) : undefined },
        { id: 'add', label: 'Add', disabled: extLoading ? (true as const) : undefined },
        { id: 'remove', label: 'Remove', disabled: !canToggle ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'toggle', label: highlighted ? (targetEnabled ? 'Enable' : 'Disable') : 'Toggle', primary: true, keys: ['enter'],
          disabled: !canToggle ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => { if (canToggle && highlighted) toggleMcp(highlighted.name, targetEnabled); }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; pickerSelected = ''; render(); }
        },
        refresh: () => loadExtensions('mcp'),
        add: () => openPanel({ kind: 'mcp-add' }),
        remove: () => {
          if (!canToggle || !highlighted) return;
          openPanel({
            kind: 'confirm',
            title: `Remove MCP server "${highlighted.name}"?`,
            detail: `Runs \`agy mcp remove ${highlighted.name}\` via official CLI.`,
            actionLabel: 'Remove MCP server',
            returnTo: { kind: 'mcp' },
            onConfirm: () => runRemoveMcp(highlighted.name),
          });
        },
        toggle: () => { if (canToggle && highlighted) toggleMcp(highlighted.name, targetEnabled); },
      }}>
      {highlighted && <kv key="pv" items={[
        { k: 'Server', v: highlighted.name },
        { k: 'Transport', v: highlighted.type },
        { k: 'Status', v: highlighted.status },
        { k: 'Command / URL', v: highlighted.target || 'Not reported' },
      ]} />}
    </picker>;
  }

  function renderPluginsPicker(): JSX.Element {
    const visible = filterPluginsList(pluginsList, 'all', panelDraft.text);
    const filtered = filterPluginsList(pluginsList, pickerTab, panelDraft.text);
    const order = filtered.map(p => p.name);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(p => p.name === selectedId);
    const items: PickerItem[] = filtered.map(plugin => ({
      id: plugin.name,
      label: plugin.name,
      detail: `${plugin.skills.length} skill${plugin.skills.length === 1 ? '' : 's'}${plugin.rules.length ? ` · ${plugin.rules.length} rule` : ''}`,
      badges: [
        ...(plugin.version ? [{ text: `v${plugin.version}`, tone: 'neutral' as const }] : []),
        { text: plugin.enabled ? 'enabled' : 'disabled', tone: plugin.enabled ? 'success' as const : 'muted' as const },
      ],
      node: 'pv',
    }));
    const canToggle = !!highlighted && !extLoading;
    const targetEnabled = !(highlighted?.enabled ?? false);
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Plugins & skills" icon="compass"
      subtitle="Installed Antigravity plugins via official `agy plugin list --json`"
      placeholder="Filter plugins or skill names..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[
        { id: 'all', label: 'All', count: visible.length },
        { id: 'enabled', label: 'Enabled', count: visible.filter(p => p.enabled).length },
        { id: 'disabled', label: 'Disabled', count: visible.filter(p => !p.enabled).length },
      ]}
      tab={pickerTab} order={order} items={items} selected={selectedId}
      state={extLoading ? 'loading' : panelError ? 'error' : 'ready'}
      message={extLoading ? 'Reading installed plugins...' : (panelError || undefined)}
      empty="No plugins match your filter."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'refresh', label: 'Refresh', disabled: extLoading ? (true as const) : undefined },
        ...(highlighted?.enabled && highlighted.skills.length ? [{ id: 'useSkill', label: `Use /${highlighted.skills[0]}`, disabled: extLoading ? (true as const) : undefined }] : []),
        { id: 'validate', label: 'Validate', disabled: !highlighted?.path || extLoading ? (true as const) : undefined },
        { id: 'install', label: 'Install', disabled: extLoading ? (true as const) : undefined },
        { id: 'uninstall', label: 'Uninstall', disabled: !canToggle ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'toggle', label: highlighted ? (targetEnabled ? 'Enable' : 'Disable') : 'Toggle', primary: true, keys: ['enter'],
          disabled: !canToggle ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => { if (canToggle && highlighted) togglePlugin(highlighted.name, targetEnabled); }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; pickerSelected = ''; render(); }
        },
        refresh: () => loadExtensions('plugins'),
        useSkill: () => {
          const skillName = highlighted?.skills[0];
          if (!skillName) return;
          closePanel();
          draft = { text: `/${skillName} `, cursor: skillName.length + 2 };
          render();
          surface?.focus('dock.draft');
        },
        validate: () => { if (highlighted && !extLoading) runValidatePlugin(highlighted); },
        install: () => openPanel({ kind: 'plugin-install' }),
        uninstall: () => {
          if (!canToggle || !highlighted) return;
          openPanel({
            kind: 'confirm',
            title: `Uninstall plugin "${highlighted.name}"?`,
            detail: `Runs \`agy plugin uninstall ${highlighted.name}\` via official CLI.`,
            actionLabel: 'Uninstall plugin',
            returnTo: { kind: 'plugins' },
            onConfirm: () => runUninstallPlugin(highlighted.name),
          });
        },
        toggle: () => { if (canToggle && highlighted) togglePlugin(highlighted.name, targetEnabled); },
      }}>
      {highlighted && <col key="pv" gap="xs">
        <kv items={[
          { k: 'Plugin', v: `${highlighted.name}${highlighted.version ? ` (v${highlighted.version})` : ''}` },
          { k: 'Status', v: highlighted.enabled ? 'Enabled' : 'Disabled' },
          ...(highlighted.source ? [{ k: 'Source', v: highlighted.source }] : []),
          { k: 'Path', v: highlighted.path || 'Not reported' },
          ...(highlighted.rules.length ? [{ k: 'Rules', v: highlighted.rules.join(', ') }] : []),
        ]} />
        {highlighted.skills.length > 0 && <text wrap="word">
          <span s="muted">Skills: </span>
          <span>{highlighted.skills.map(s => `/${s}`).join(', ')}</span>
        </text>}
      </col>}
    </picker>;
  }

  function renderAgentsPicker(): JSX.Element {
    const extraDirs = options.additionalDirectories ?? [];
    const filtered = filterAgentsList(agentsList, panelDraft.text);
    const order = filtered.map(a => a.name);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(a => a.name === selectedId);
    const items: PickerItem[] = filtered.map(a => ({
      id: a.name,
      label: a.name,
      detail: a.detail || 'Custom agy agent',
      badges: options.agentName === a.name ? [{ text: 'Active', tone: 'success' as const }] : undefined,
      node: 'pv',
    }));
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Agents & workspace scope" icon="tern"
      subtitle={`Active profile: ${options.agentName ?? 'Default'} · Workspace roots: ${1 + extraDirs.length}`}
      placeholder="Filter agents..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[{ id: 'all', label: 'Configured agents', count: filtered.length }]}
      tab="all" order={order} items={items} selected={selectedId}
      state={extLoading ? 'loading' : panelError ? 'error' : 'ready'}
      message={extLoading ? 'Checking `agy agent`...' : (panelError || undefined)}
      empty="No custom agents reported by `agy agent`. Launch with `--agent <name>` or `--add-dir <dir>` to customize scope."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'refresh', label: 'Refresh', disabled: extLoading ? (true as const) : undefined },
        { id: 'close', label: 'Close', primary: true, keys: ['esc'] },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onAction={{
        close: closePanel,
        refresh: () => loadExtensions('agents'),
      }}>
      {highlighted && <kv key="pv" items={[
        { k: 'Agent', v: highlighted.name },
        { k: 'Details', v: highlighted.detail || 'Configured in official agy CLI' },
        { k: 'Launch flag', v: `agy-tern --agent ${highlighted.name}` },
        ...(extraDirs.length ? [{ k: 'Extra roots (--add-dir)', v: extraDirs.join(', ') }] : []),
      ]} />}
    </picker>;
  }

  function renderTemplatesPicker(): JSX.Element {
    const filtered = filterTemplatesList(templatesList, panelDraft.text);
    const order = filtered.map(tpl => tpl.name);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(tpl => tpl.name === selectedId);
    const items: PickerItem[] = filtered.map(tpl => ({
      id: tpl.name,
      label: tpl.name,
      detail: tpl.text.replace(/\s+/g, ' ').slice(0, 72),
      node: 'pv',
    }));
    const insertTemplate = (tpl: PromptTemplate): void => {
      closePanel();
      draft = { text: tpl.text, cursor: tpl.text.length };
      render();
      surface?.focus('dock.draft');
    };
    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Workspace prompt templates" icon="edit"
      subtitle={`Saved locally per workspace (${workspaceName})`}
      placeholder="Filter templates..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[{ id: 'all', label: 'Templates', count: filtered.length }]}
      tab="all" order={order} items={items} selected={selectedId}
      state={extLoading ? 'loading' : panelError ? 'error' : 'ready'}
      message={panelError || undefined}
      empty="No workspace prompt templates saved yet. Draft a prompt first, then click Save draft."
      preview={highlighted ? 'below' : 'none'}
      actions={[
        { id: 'save', label: 'Save draft', disabled: !draft.text.trim() || extLoading ? (true as const) : undefined },
        { id: 'delete', label: 'Delete', disabled: !highlighted || extLoading ? (true as const) : undefined },
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'insert', label: 'Insert into draft', primary: true, keys: ['enter'],
          disabled: !highlighted ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => { if (highlighted) insertTemplate(highlighted); }}
      onAction={{
        close: closePanel,
        save: () => openPanel({ kind: 'template-save' }),
        delete: () => {
          if (!highlighted) return;
          openPanel({
            kind: 'confirm',
            title: `Delete template "${highlighted.name}"?`,
            detail: 'Removes this saved prompt snippet from local workspace storage.',
            actionLabel: 'Delete template',
            returnTo: { kind: 'templates' },
            onConfirm: () => removePromptTemplate(highlighted.name),
          });
        },
        insert: () => { if (highlighted) insertTemplate(highlighted); },
      }}>
      {highlighted && <col key="pv" gap="xs">
        <text><span s="muted">Updated {highlighted.updatedAt.slice(0, 10)}</span></text>
        <code wrap>{highlighted.text}</code>
      </col>}
    </picker>;
  }

  function activeToolSteps(): ToolStep[] {
    return conversation.entries.filter((entry): entry is ToolStep =>
      entry.type === 'tool' && (entry.call.status === 'in_progress' || entry.call.status === 'pending'));
  }

  function inspectTaskStep(step: ToolStep): void {
    const s = summarizeToolCall(step.call, options.cwd);
    const detailText = [
      `Tool: ${s.title}`,
      ...(s.target ? [`Target: ${s.target}`] : []),
      ...(s.fullCommand ? [`Command:\n${s.fullCommand}`] : []),
      ...(step.call.rawInput !== undefined ? [`Input:\n${JSON.stringify(step.call.rawInput, null, 2)}`] : []),
      ...(step.call.rawOutput !== undefined ? [`Output:\n${typeof step.call.rawOutput === 'string' ? step.call.rawOutput : JSON.stringify(step.call.rawOutput, null, 2)}`] : []),
    ].join('\n\n');
    openInspect(s.title, { type: 'file', path: 'task.log', content: detailText }, s.target);
  }

  function renderTasksPicker(): JSX.Element {
    const query = panelDraft.text.trim().toLowerCase();
    const allTools = conversation.entries
      .filter((entry): entry is ToolStep => entry.type === 'tool')
      .slice()
      .reverse();
    const filtered = allTools.filter(step => {
      const summary = summarizeToolCall(step.call, options.cwd);
      const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
      if (pickerTab === 'running' && !isRunning) return false;
      if (pickerTab === 'done' && isRunning) return false;
      if (!query) return true;
      return `${summary.title} ${summary.target ?? ''} ${step.call.toolCallId}`.toLowerCase().includes(query);
    });
    const order = filtered.map(step => step.id);
    const selectedId = order.includes(pickerSelected) ? pickerSelected : (order[0] ?? '');
    const highlighted = filtered.find(step => step.id === selectedId);
    const highlightedSummary = highlighted ? summarizeToolCall(highlighted.call, options.cwd) : undefined;
    const now = Date.now();
    const runningCount = allTools.filter(step => step.call.status === 'in_progress' || step.call.status === 'pending').length;

    const items: PickerItem[] = filtered.map(step => {
      const summary = summarizeToolCall(step.call, options.cwd);
      const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
      const elapsedMs = isRunning && step.startedAt !== undefined
        ? Math.max(0, now - step.startedAt)
        : step.startedAt !== undefined && step.endedAt !== undefined
          ? Math.max(0, step.endedAt - step.startedAt)
          : undefined;
      const elapsedLabel = elapsedMs !== undefined ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
      return {
        id: step.id,
        label: summary.title,
        detail: [summary.target, elapsedLabel].filter(Boolean).join(' · ') || step.call.toolCallId,
        badges: [
          {
            text: isRunning ? 'Running' : step.call.status === 'failed' ? 'Failed' : 'Done',
            tone: isRunning ? 'accent' : step.call.status === 'failed' ? 'error' : 'success',
          },
          ...(summary.exit !== undefined ? [{ text: `exit ${summary.exit}`, tone: summary.exit === 0 ? ('neutral' as const) : ('error' as const) }] : []),
        ],
        node: 'pv',
      };
    });

    const modalSize = currentResponsiveLayout().panelSize;
    return <picker key="picker" size={modalSize} title="Tasks & tool activity" icon="timer"
      subtitle={busy || runningCount ? `${runningCount} active tool(s) in current turn · Stop cancels the active ACP turn` : `${allTools.length} tool call(s) recorded in this session`}
      placeholder="Filter tasks by tool, command, or path..."
      query={panelDraft.text} cursor={panelDraft.cursor}
      tabs={[
        { id: 'all', label: 'All', count: allTools.length },
        { id: 'running', label: 'Running', count: runningCount },
        { id: 'done', label: 'Finished', count: allTools.length - runningCount },
      ]}
      tab={pickerTab}
      order={order}
      items={items} selected={selectedId}
      state="ready"
      empty={pickerTab === 'running' ? 'No tool tasks are currently running.' : 'No tool activity recorded in this conversation yet.'}
      preview={highlighted ? 'below' : 'none'}
      actions={[
        ...(busy ? [{ id: 'stopTurn', label: cancelling ? 'Stopping...' : 'Stop active turn', keys: ['esc'], disabled: cancelling ? (true as const) : undefined }] : []),
        { id: 'close', label: 'Close', keys: ['esc'] },
        { id: 'inspect', label: 'Inspect details', primary: true, keys: ['enter'], disabled: !highlighted ? (true as const) : undefined },
      ]}
      onSelect={event => { pickerSelected = event.item; render(); }}
      onActivate={() => {
        if (highlighted) inspectTaskStep(highlighted);
      }}
      onAction={{
        close: closePanel,
        tab: event => {
          if (typeof event.value === 'string') { pickerTab = event.value; render(); }
        },
        stopTurn: () => stop(),
        inspect: () => {
          if (highlighted) inspectTaskStep(highlighted);
        },
      }}>
      {highlighted && highlightedSummary && <ToolBody call={highlighted.call} cwd={options.cwd} showRawInput={highlightedSummary.showRawInput}
        fullCommand={highlightedSummary.fullCommand} diffMode={userPrefs.diffMode}
        getBlob={blobForImage} onInspect={openInspect} onOpenSplit={openSplit}
        onCopy={text => { void copyToClipboard(text).then(ok => { if (!quitting) showToast(ok ? 'Copied to clipboard' : 'Clipboard unavailable'); }); }} />}
    </picker>;
  }

  function renderPanel(): JSX.Element | null {
    if (!panel) return null;
    const currentPanel = panel;
    if (currentPanel.kind === 'settings') return renderPrefsPanel();
    const config = currentPanel.kind === 'config' ? metadata.configOptions.find(option => option.id === currentPanel.id) : undefined;
    if (currentPanel.kind === 'config' && config?.type === 'select') return renderSelectConfigPicker(config);
    if (currentPanel.kind === 'commands') return renderCommandsPicker();
    if (currentPanel.kind === 'mcp') return renderMcpPicker();
    if (currentPanel.kind === 'plugins') return renderPluginsPicker();
    if (currentPanel.kind === 'agents') return renderAgentsPicker();
    if (currentPanel.kind === 'templates') return renderTemplatesPicker();
    if (currentPanel.kind === 'sessions') return renderSessionsPicker();
    if (currentPanel.kind === 'changes') return renderChangesPicker();
    if (currentPanel.kind === 'find') return renderFindPicker();
    if (currentPanel.kind === 'tasks') return renderTasksPicker();
    if (currentPanel.kind === 'inspect') return renderInspectOverlay(currentPanel);

    const mode = modeOption();
    const title = currentPanel.kind === 'report' ? (currentPanel.report === 'usage' ? 'Usage & Quota' : `Official agy /${currentPanel.report}`)
      : currentPanel.kind === 'permissions' ? 'Permissions & sandbox'
      : currentPanel.kind === 'rename' ? 'Local conversation name'
      : currentPanel.kind === 'template-save' ? 'Save prompt template'
      : currentPanel.kind === 'mcp-add' ? 'Add MCP server'
      : currentPanel.kind === 'plugin-install' ? 'Install Antigravity plugin'
      : currentPanel.kind === 'confirm' ? currentPanel.title
      : currentPanel.kind === 'account' ? 'Account & sign-in'
      : currentPanel.kind === 'account-switch' ? 'Change shared account?'
      : config?.name ?? 'Session option';
    const choices = panelChoices();
    const selected = Math.min(panelSelection, Math.max(0, choices.length - 1));
    const quotas = currentPanel.kind === 'report' && currentPanel.report === 'usage' ? parseQuotaReport(reportText) : undefined;
    const quotaSummary = summarizeQuotaRows(quotas);
    const contextUsage = formatContextUsage(metadata.usage);
    const method = loginMethod();
    const loginProblem = method ? terminalLoginProblem(method) : undefined;

    const rLayout = currentResponsiveLayout();
    return <overlay key="panel" head={title} modal size={rLayout.panelSize}
      icon={currentPanel.kind === 'report' ? 'context' : currentPanel.kind === 'permissions' ? 'shield' :
        currentPanel.kind === 'account' || currentPanel.kind === 'account-switch' ? 'user' : 'slash'}
      end={<button keys={['esc']} variant="quiet" disabled={authBusy} onClick={closePanel}>Close</button>}>
      {currentPanel.kind === 'report' ? <>
        {currentPanel.report === 'usage' ? <col gap="md">
          <tabs variant="segmented" active={usageTab}
            items={[
              { id: 'overview', label: 'Overview' },
              { id: 'details', label: 'Details' },
              { id: 'raw', label: 'Raw report' },
            ]}
            onChange={event => { usageTab = String(event.value ?? 'overview'); render(); }} />
          {reportLoading && <spinner label="Reading official /usage report" />}
          {usageTab === 'overview' && <>
            <stats items={[
              {
                label: 'Tightest quota',
                value: quotaSummary ? quotaSummary.tightest.remaining : (reportLoading ? 'Loading' : 'Unavailable'),
                sub: quotaSummary
                  ? `${quotaSummary.tightest.group} · ${quotaSummary.tightest.limit}${metadata.tier ? ` · ${metadata.tier.name}` : ''}`
                  : (metadata.tier ? `${metadata.tier.name} · Official CLI /usage` : 'From official CLI /usage'),
                tone: quotaSummary
                  ? (quotaSummary.tightest.fraction <= 0.15 ? 'error' : quotaSummary.tightest.fraction <= 0.35 ? 'warning' : 'success')
                  : 'muted',
              },
              {
                label: 'Model groups',
                value: quotaSummary ? String(quotaSummary.groupCount) : '0',
                sub: quotaSummary ? `${quotaSummary.rows.length} tracked limits` : 'Parsed from /usage',
                tone: 'neutral',
              },
              {
                label: 'Session context',
                value: contextUsage ? `${contextUsage.percent}%` : 'Not reported',
                sub: contextUsage ? `${contextUsage.usedLabel} / ${contextUsage.sizeLabel} tokens` : 'Waiting for ACP usage_update',
                tone: contextUsage ? 'info' : 'muted',
              },
            ]} />
            {quotaSummary ? <table cols={[
              { id: 'group', head: 'Model group', grow: 1, priority: 4 },
              { id: 'limit', head: 'Limit', priority: 2 },
              { id: 'meter', head: 'Quota bar', priority: 3 },
              { id: 'remaining', head: 'Left', align: 'end', mono: true, priority: 4 },
              { id: 'reset', head: 'Reset', mono: true, priority: 1 },
            ]} rows={quotaSummary.rows.map((row, index) => ({
              id: `quota-${index}`,
              cells: {
                group: row.group,
                limit: row.limit,
                meter: { meter: {
                  value: row.fraction,
                  tone: row.fraction <= 0.15 ? 'error' : row.fraction <= 0.35 ? 'warning' : 'success',
                } },
                remaining: row.remaining,
                reset: row.reset,
              },
              title: `${row.group}: ${row.limit}, ${row.remaining} remaining, reset ${row.reset}`,
            }))} /> : reportText && <md>{reportText}</md>}
          </>}
          {usageTab === 'details' && <>
            {(metadata.tier || metadata.usage) ? <kv items={[
              ...(metadata.tier ? [{ k: 'Subscription tier', v: metadata.tier.name }] : []),
              ...(metadata.usage ? [
                { k: 'Session context tokens', v: metadata.usage.used.toLocaleString() },
                { k: 'Context window', v: metadata.usage.size.toLocaleString() },
                ...(metadata.usage.cost ? [{ k: 'Session cost', v: `${metadata.usage.cost.amount} ${metadata.usage.cost.currency}` }] : []),
              ] : []),
            ]} /> : <text>No session-context usage or plan tier has been reported by ACP yet.</text>}
            {quotas ? <table cols={[
              { id: 'group', head: 'Model group', grow: 1, priority: 4 },
              { id: 'limit', head: 'Limit', priority: 2 },
              { id: 'remaining', head: 'Remaining', align: 'end', mono: true, priority: 3 },
              { id: 'reset', head: 'Reset', mono: true, priority: 1 },
            ]} rows={quotas.map((row, index) => ({
              id: `detail-${index}`,
              cells: { group: row.group, limit: row.limit, remaining: row.remaining, reset: row.reset },
            }))} /> : reportText && <md>{reportText}</md>}
          </>}
          {usageTab === 'raw' && (reportText
            ? <code wrap>{reportText}</code>
            : <text><span s="muted">No raw report output captured yet.</span></text>)}
        </col> : <>
          {reportLoading && <spinner label={`Reading official /${currentPanel.report} report`} />}
          {reportText && <md>{reportText}</md>}
        </>}
        {panelError && <text wrap="word"><span s="error">{panelError}</span></text>}
        <button keys={['enter']} on={panelSelection % 2 === 0} disabled={reportLoading && 'Report is loading'}
          onClick={() => loadReport(currentPanel.report)}>Refresh report</button>
        <text wrap="word">Tab selects Refresh or Close. Enter activates; Esc returns to the conversation.</text>
      </> : <>
        {currentPanel.kind === 'account' && <>
          <kv items={[
            { k: 'ACP connection', v: disconnected ? 'Disconnected' : agent ? 'Connected; model access not guaranteed' : 'Connecting' },
            { k: 'Subscription tier', v: metadata.tier ? metadata.tier.name : 'Not reported by ACP' },
            { k: 'Account identity', v: 'Not exposed by this ACP connection' },
            { k: 'Credential owner', v: 'Official agy shared authentication' },
          ]} />
          <text wrap="word">Sign in through agy’s interactive flow. This frontend stores no accounts or tokens. Switching requires signing in again, not selecting a saved-account pool. Login reconnects a fresh session and keeps your unsent draft.</text>
          {!authenticationKnown && <text wrap="word">{disconnected ? 'No login descriptor received. Use the official CLI terminal login from your shell.' : 'Waiting for agy to advertise sign-in options.'}</text>}
          {authenticationKnown && !method && <text>agy did not advertise terminal sign-in support.</text>}
          {loginProblem && <text wrap="word"><span s="error">{loginProblem}</span></text>}
          {method && !loginProblem && <code wrap>{JSON.stringify([options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
          {(busy || changingConfig || sessionOperation) && <text>Wait for the active operation before signing in or changing accounts.</text>}
        </>}
        {currentPanel.kind === 'account-switch' && <>
          <text wrap="word">This signs out first. Antigravity shares credentials across CLI, App and IDE extensions, so they may also lose their login. If login is cancelled, the old credentials are not restored.</text>
          <text wrap="word">Choose your other account in the official login flow. Afterwards this frontend starts a fresh session and keeps only your unsent draft. It does not replay the failed prompt or automatically transfer the old conversation.</text>
          {method && <code wrap>{JSON.stringify([options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
        </>}
        {currentPanel.kind === 'permissions' && <>
          <kv items={[
            { k: 'Session mode', v: mode ? configLabel(mode) : 'Not reported by agy' },
            { k: 'Agent profile', v: options.agentName ?? 'Default' },
            { k: 'Workspace roots', v: options.additionalDirectories?.length ? `${options.cwd} (+${options.additionalDirectories.length} --add-dir)` : options.cwd },
            { k: 'Sandbox flag', v: '--sandbox requested' },
            { k: 'OS containment', v: 'Not reported through ACP; not verified' },
            { k: 'ACP capabilities', v: [
              ...(agent?.promptCapabilities?.image ? ['image'] : []),
              ...(agent?.promptCapabilities?.embeddedContext ? ['embeddedContext'] : []),
              ...(agent?.capabilities.loadSession ? ['load'] : []),
              ...(agent?.capabilities.resumeSession ? ['resume'] : []),
              ...(agent?.capabilities.closeSession ? ['close'] : []),
              ...(agent?.capabilities.additionalDirectories ? ['add-dir'] : []),
            ].join(', ') || 'Connecting...' },
            { k: 'Effective allow/deny rules', v: 'Owned by agy; not reported through ACP' },
            { k: 'Frontend approvals', v: 'One-time allow or deny only; never automatic' },
          ]} />
          <text wrap="word">Existing agy rules can run tools without another prompt. Plan mode does not prove read-only access.</text>
          <text wrap="word">No permission bypass flag is enabled. This frontend does not provide filesystem or terminal RPC.</text>
        </>}
        {currentPanel.kind === 'rename' && <text wrap="word">Local to agy-tern; does not rename the conversation in Antigravity. Up to 160 characters. Leave empty to use agy’s title.</text>}
        {currentPanel.kind === 'template-save' && <text wrap="word">Enter a short template name (e.g. review-diff). Saved locally per workspace in your XDG state directory.</text>}
        {currentPanel.kind === 'mcp-add' && <text wrap="word">Syntax: [--type stdio|http] &lt;name&gt; &lt;commandOrUrl&gt; [args...]. Executed via `agy mcp add`.</text>}
        {currentPanel.kind === 'plugin-install' && <text wrap="word">Enter a local plugin directory path or `plugin@marketplace` identifier. Executed via `agy plugin install`.</text>}
        {currentPanel.kind === 'confirm' && <text wrap="word">{currentPanel.detail}</text>}
        {currentPanel.kind !== 'permissions' && currentPanel.kind !== 'account' && currentPanel.kind !== 'account-switch' && currentPanel.kind !== 'confirm' && <input key="query"
          aria={currentPanel.kind === 'rename' ? 'Local conversation name' : currentPanel.kind === 'template-save' ? 'Template name'
            : currentPanel.kind === 'mcp-add' ? 'MCP server command' : currentPanel.kind === 'plugin-install' ? 'Plugin target'
            : `Filter ${title.toLowerCase()}`}
          text={panelDraft.text} cursor={panelDraft.cursor} anchor={panelDraft.anchor}
          placeholder={currentPanel.kind === 'rename' ? 'Conversation name (local)'
            : currentPanel.kind === 'template-save' ? 'e.g. audit-security'
            : currentPanel.kind === 'mcp-add' ? 'e.g. --type stdio github npx -y @modelcontextprotocol/server-github'
            : currentPanel.kind === 'plugin-install' ? 'e.g. /path/to/plugin or my-plugin@official'
            : `Filter ${title.toLowerCase()}`}
          onFocus={() => surface?.focus('layer.panel.query')}
          onEdit={event => { panelDraft = editDraft(panelDraft, event); panelSelection = 0; render(); }} />}
        {panelError && <text wrap="word"><span s="error">{panelError}</span></text>}
        <list key="choices" selected={`layer.panel.choices.row-${selected}`} max={{ lines: rLayout.modalListMaxLines }}
          empty="No matching choices.">
          {choices.map((choice, index) => <item key={`row-${index}`} label={choice.label} detail={choice.detail}
            value={choice.value} title={`${choice.label}: ${choice.detail}`}
            disabled={choice.disabled || authBusy || changingConfig || !!sessionOperation || (currentPanel.kind === 'config' && busy) ||
              (currentPanel.kind === 'rename' && busy)}
            onClick={choice.choose} />)}
        </list>
        {extLoading && <spinner label="Running official agy CLI command" />}
        {changingConfig && <spinner label="Applying the session option through agy" />}
        {sessionOperation && <spinner label={sessionOperation} />}
        {authBusy && <spinner label="Preparing official login; signing out if confirmed" />}
        {currentPanel.kind === 'config' && busy && <text>Wait for the active turn before changing this option.</text>}
        {currentPanel.kind === 'rename' && busy && <text>Wait for the active turn before changing conversation names.</text>}
        <text wrap="word">Up/Down or Tab selects; Enter chooses; Esc closes. Hover a row for its full description.</text>
      </>}
    </overlay>;
  }

  function render(): void {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    if (!surface || surface.closed || quitting) return;
    if (process.stdout.rows) viewportRows = process.stdout.rows;
    lastRenderAt = Date.now();
    const permission = permissions[0];
    const approvalCall = permission && (conversation.getTool(permission.request.toolCall.toolCallId)?.call ?? permission.request.toolCall);
    const approvalSummary = approvalCall ? summarizeToolCall(approvalCall, options.cwd) : undefined;
    const offered = permission?.request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once') ?? [];
    const selectedChoice = offered[approvalChoice];
    const firstDeny = offered.find(option => option.kind === 'reject_once');
    const suggestions = autocomplete();
    const selectedCommand = Math.min(commandSelection, Math.max(0, suggestions.length - 1));
    const atMatches = atFileMatches();
    const selectedFile = Math.min(fileSelection, Math.max(0, atMatches.length - 1));
    const currentModel = modelOption(metadata.configOptions);
    const currentThinking = thinkingOption(metadata.configOptions);
    const currentMode = modeOption();
    const draftCommand = resolveCommand(draft.text, availableCommands());
    const hasAttachments = attachedFiles.length > 0 || attachedDirs.length > 0 || attachedImages.length > 0;
    const hasDraftContent = !!(draft.text.trim() || hasAttachments);
    const canSend = hasDraftContent && !busy && !changingConfig && !sessionOperation && !authBusy && !permission &&
      !!((agent && !disconnected) || (draftCommand && !hasAttachments));
    const canQueue = hasDraftContent && busy && !changingConfig && !sessionOperation && !authBusy && !permission &&
      !!agent && !disconnected;
    const activePlan = conversation.currentPlan;
    const planSummary = formatPlanSummary(activePlan);
    const contextUsage = formatContextUsage(metadata.usage);
    if (cachedDiffCountConversation !== conversation || cachedDiffCountRev !== conversation.revision) {
      cachedDiffCountConversation = conversation;
      cachedDiffCountRev = conversation.revision;
      cachedDiffCount = countSessionDiffs(conversation.entries);
    }
    const sessionDiffCount = cachedDiffCount;
    const loginAvailable = !!loginMethod() && !terminalLoginProblem(loginMethod()!) && !!agent && !disconnected && authentication.logout;
    const agentStatus: Tone = disconnected || phase.includes('failed') ? 'error' : busy ? 'warning' : agent ? 'success' : 'muted';
    const renderNow = lastRenderAt || Date.now();
    const activeTools = activeToolSteps();
    const showHud = !!(planSummary || contextUsage || busy || activeTools.length > 0);
    const activeToolTop = activeTools.at(-1);
    const activeToolSummary = activeToolTop ? summarizeToolCall(activeToolTop.call, options.cwd) : undefined;
    const liveTaskLabel = activeToolSummary
      ? `Running${activeTools.length > 1 ? ` (${activeTools.length})` : ''}: ${activeToolSummary.title}${activeToolSummary.target ? ` · ${compactToolHeaderText(activeToolSummary.target, 36)}` : ''}`
      : phase;
    const activeAgeMs = activeToolTop?.startedAt !== undefined
      ? Math.max(0, Date.now() - activeToolTop.startedAt)
      : turnStartedAt ? Math.max(0, Date.now() - turnStartedAt) : 0;
    const layout = currentResponsiveLayout({
      hasPermission: !!permission,
      hasSuggestionsOrAt: suggestions.length > 0 || atMatches.length > 0,
      hasAttachments,
      hasHud: showHud,
    });
    const entryCallbacks: EntryCallbacks = {
      cwd: options.cwd,
      working: busy,
      now: renderNow,
      agentStatus,
      prefs: userPrefs,
      proseMaxW: layout.proseMaxW,
      thoughtFoldOverrides,
      toolFoldOverrides,
      canRetry: !!(lastPrompt || lastImages.length) && !busy && !!agent && !disconnected && !permission,
      canReconnect: disconnected && !agentConnecting && !authBusy && !busy,
      canSwitchAccount: loginAvailable && !busy && !authBusy,
      getBlob: blobForImage,
      onInspect: openInspect,
      onToggleThought(id, open) {
        thoughtFoldOverrides.set(id, open);
        render();
      },
      onToggleTool(id, collapsed) {
        toolFoldOverrides.set(id, collapsed);
        render();
      },
      onRetry() {
        if (lastPrompt || lastImages.length || lastFiles.length || lastDirs.length) submitPrompt(lastPrompt, lastImages, lastFiles, lastDirs);
      },
      onReconnect() {
        reconnectAgent();
      },
      onSwitchModel() {
        openPanel(currentModel ? { kind: 'config', id: currentModel.id } : { kind: 'settings' });
      },
      onSwitchAccount() {
        openPanel({ kind: 'account-switch' });
      },
      onOpenAccount() {
        openPanel({ kind: 'account' });
      },
      onOpenChanges() {
        openPanel({ kind: 'changes' });
      },
      onOpenSplit(path, line) {
        openSplit(path, line);
      },
      onRunCommand(command) {
        promptRunCommand(command);
      },
      onAttachPath(path) {
        attachFile(path);
      },
      onExport() {
        exportCurrentTranscript();
      },
      onCopy(text) {
        void copyToClipboard(text).then(copied => {
          if (!quitting) showToast(copied ? 'Copied to clipboard' : 'Clipboard utility unavailable', copied ? undefined : 'Install wl-copy or xclip to copy');
        });
      },
      onResend(text) {
        draft = { text, cursor: text.length };
        render();
        surface?.focus('dock.draft');
      },
    };
    const editorButtons = busy
      ? [
        ...(hasDraftContent ? [{ act: 'send', text: 'Queue', icon: 'plus', variant: 'default' as const,
          disabled: !canQueue }] : []),
        { act: 'stop', text: 'Stop', icon: 'stop', variant: 'danger' as const, keys: ['esc'],
          disabled: cancelling && 'Cancellation requested' },
      ]
      : [{ act: 'send', text: 'Send', icon: 'send', variant: permission ? 'default' as const : 'primary' as const,
        disabled: !canSend }];

    const dockLines = 0; // Replaced by layout.scrollMaxH
    void dockLines;
    const allEntries = conversation.entries;
    const totalEntries = allEntries.length;
    const hiddenCount = Math.max(0, totalEntries - historyVisibleCount);
    const visibleEntries = hiddenCount > 0 ? allEntries.slice(hiddenCount) : allEntries;
    let turnCounter = 0;
    for (let i = 0; i < hiddenCount; i++) {
      const earlier = allEntries[i]!;
      if (earlier.type === 'message' && earlier.role === 'user') turnCounter++;
    }
    const renderEntryNode = (entry: TranscriptEntry, idxInVisible: number): JSX.Element => {
      const globalIdx = hiddenCount + idxInVisible;
      const prev = globalIdx > 0 ? allEntries[globalIdx - 1] : undefined;
      const continued = entry.type === 'message' && prev?.type === 'message' && prev.role === entry.role;
      const streaming = busy && globalIdx === totalEntries - 1 && entry.type === 'message' && entry.role === 'agent';
      const recent = globalIdx >= Math.max(0, totalEntries - 8);
      const turnNumber = entry.type === 'message' && entry.role === 'user' ? ++turnCounter : undefined;
      const isRunning = streaming ||
        (entry.type === 'thought' && entry.endedAt === undefined && busy) ||
        (entry.type === 'tool' && (entry.call.status === 'in_progress' || entry.call.status === 'pending')) ||
        (entry.type === 'compaction' && (entry.status === 'in_progress' || entry.status === 'queued'));
      const foldKey = entry.type === 'thought' || entry.type === 'compaction'
        ? String(thoughtFoldOverrides.get(entry.id) ?? '')
        : entry.type === 'tool' ? String(toolFoldOverrides.get(entry.id) ?? '') : '';
      const errorKey = entry.type === 'notice' && entry.error
        ? `${Number(entryCallbacks.canRetry)}${Number(entryCallbacks.canReconnect)}${Number(entryCallbacks.canSwitchAccount)}` : '';
      const sig = `${conversation.revisionOf(entry)}|${continued ? 1 : 0}|${streaming ? 1 : 0}|${recent ? 1 : 0}|${turnNumber ?? ''}|${isRunning ? Math.floor(renderNow / 1000) : 0}|${foldKey}|${errorKey}|${agentStatus}|${userPrefs.diffMode}|${userPrefs.toolDisplay}|${Number(userPrefs.thoughtExpanded)}|${userPrefs.transcriptDensity}|${Number(userPrefs.showTimestamps)}|${layout.proseMaxW}`;
      const cached = entryRenderCache.get(entry);
      if (cached && cached.key === sig) return cached.node;
      const node = <Entry key={entry.id} entry={entry} continued={continued} streaming={streaming} recent={recent} turnNumber={turnNumber} callbacks={entryCallbacks} />;
      entryRenderCache.set(entry, { key: sig, node });
      return node;
    };
    surface.render({
      main: <col>
        <scroll key="conversation" stick={visibleEntries.length ? 'end' : undefined} max={{ h: layout.scrollMaxH }} gap="md" aria="Conversation">
          {hiddenCount > 0 && <row key="older-history" justify="between" align="center" gap="sm" wrap>
            <text><span s="muted">{hiddenCount} earlier {hiddenCount === 1 ? 'entry' : 'entries'} hidden for speed</span></text>
            <row gap="xs">
              <button size="sm" variant="quiet" onClick={() => { historyVisibleCount += 50; render(); }}>Load 50 more</button>
              <button size="sm" variant="quiet" onClick={() => { historyVisibleCount = totalEntries; render(); }}>Show all ({totalEntries})</button>
            </row>
          </row>}
          {visibleEntries.length ? visibleEntries.map(renderEntryNode) :
            <col key="empty-wrap" gap={layout.compactEmpty ? 'sm' : 'md'} align="center">
              <empty icon={layout.compactEmpty ? undefined : 'tern'} title={agent ? 'Ask Antigravity about this project' : disconnected ? 'Antigravity is unavailable' : 'Opening an ACP session'}
                text={layout.compactEmpty ? (agent ? 'Use / for commands or @ for files & dirs.' : disconnected ? 'Open /account to sign in.' : 'Opening ACP session...') : (agent ? 'Type / for commands or @ to attach files, directories, and images (including gitignored entries). Thoughts, diffs, and one-time approvals appear here.' :
                  disconnected ? 'Open /account to sign in, or Quit to return to your shell.' : 'The official agy process handles authentication and tools.')} />
              {agent && !disconnected && !permission && viewportRows >= 20 && <suggestions variant="chips"
                items={[
                  { id: 'explain', text: 'Summarize this project structure', icon: 'compass' },
                  { id: 'changes', text: 'Review /changes', icon: 'diff' },
                  { id: 'settings', text: 'Open /settings', icon: 'settings' },
                  { id: 'sessions', text: 'Open /sessions', icon: 'history' },
                ]}
                onActivate={event => {
                  if (event.item === 'settings') openPanel({ kind: 'settings' });
                  else if (event.item === 'sessions') openPanel({ kind: 'sessions' });
                  else if (event.item === 'changes') openPanel({ kind: 'changes' });
                  else if (event.item === 'explain') submitPrompt('Summarize this project structure.');
                }} />}
            </col>}
        </scroll>
      </col>,
      dock: <col gap="xs">
        {showHud && <row key="hud" justify="between" align="center" gap="sm" wrap>
          <row gap="sm" align="center" wrap>
            {(busy || activeTools.length > 0) && <row key="live-turn" gap="sm" align="center">
              <spinner style="braille" />
              <shimmer text={liveTaskLabel} />
              <elapsed age={activeAgeMs} />
              <button size="sm" variant="quiet" onClick={() => openPanel({ kind: 'tasks' })}>Tasks</button>
              <button size="sm" variant="danger" disabled={cancelling && 'Cancellation requested'} onClick={stop}>
                {cancelling ? 'Stopping...' : 'Stop'}
              </button>
            </row>}
            {activePlan && planSummary && <checklist key="plan-hud" mode="hud"
              note={`${planSummary.done}/${planSummary.total}`}
              phases={[{ title: 'Tasks', items: activePlan.entries.map((item, index) => ({
                id: String(index), text: item.content,
                status: item.status === 'in_progress' ? 'active' : item.status === 'completed' ? 'done' : 'pending',
              })) }]} />}
          </row>
          {contextUsage && <meter key="context" style="bar" size="sm"
            value={contextUsage.percent / 100}
            thresholds={{ warn: 0.75, bad: 0.9 }}
            label={contextUsage.summary}
            title={`Session context: ${metadata.usage?.used.toLocaleString()} / ${metadata.usage?.size.toLocaleString()} tokens (click for /usage)`}
            hovercard={hoverKv([
              { k: 'Context used', v: `${metadata.usage?.used.toLocaleString()} tokens` },
              { k: 'Window', v: `${metadata.usage?.size.toLocaleString()} tokens` },
              ...(metadata.tier ? [{ k: 'Subscription tier', v: metadata.tier.name }] : []),
              { k: 'Action', v: 'Click to open /usage' },
            ])}
            onClick={() => { if (agent && !disconnected && !permission) openPanel({ kind: 'report', report: 'usage' }); }} />}
        </row>}
        {permission && approvalCall && approvalSummary && <tool key={`approval-${permission.id}`}
          title={approvalSummary.title}
          name={approvalSummary.name}
          target={approvalSummary.target}
          targetKind={approvalSummary.targetKind}
          status="pending" note="Approval required">
          <text>Choose a one-time permission for this tool. Tab selects a choice; Ctrl+Y allows, Ctrl+N denies. Enter never approves.</text>
          <scroll max={{ h: layout.approvalBodyMaxH }}><ToolBody call={approvalCall} cwd={options.cwd} showRawInput={approvalSummary.showRawInput} diffMode={userPrefs.diffMode} /></scroll>
          <buttons variant="toolbar" label="One-time permission choices">
            {offered.map(option => <button key={option.optionId} on={option === selectedChoice}
              variant={option === selectedChoice && option.kind === 'allow_once' ? 'primary' : 'default'}
              keys={option === selectedChoice ? ['ctrl', option.kind === 'allow_once' ? 'y' : 'n'] : undefined}
              onClick={() => answer(permission, option.optionId)}>{option.name}</button>)}
            {!firstDeny && <button keys={['ctrl', 'n']} onClick={() => answer(permission, null)}>Cancel request</button>}
          </buttons>
          {permissions.length > 1 && <text wrap="char"><span s="muted">Queued: {permissions.slice(1).map(next =>
            next.request.toolCall.title ?? next.request.toolCall.toolCallId).join('; ')}</span></text>}
        </tool>}
        {suggestions.length > 0 && <list key="commands" selected={`dock.commands.row-${selectedCommand}`} max={{ lines: layout.dockPopupMaxLines }}>
          {suggestions.map((command, index) => <item key={`row-${index}`} label={`/${command.name}`}
            detail={command.description} value={command.hint ? 'Arguments' : command.local ? 'Panel' : 'agy'}
            title={`/${command.name}: ${command.description}${command.hint ? ` · ${command.hint}` : ''}`}
            onClick={() => chooseCommand(command)} />)}
        </list>}
        {atMatches.length > 0 && <list key="files" selected={`dock.files.row-${selectedFile}`} max={{ lines: layout.dockPopupMaxLines }}>
          {atMatches.map((entry, index) => {
            const isDir = entry.kind === 'dir';
            const cleanPath = isDir ? entry.path.replace(/\/+$/, '') : entry.path;
            const isImg = !isDir && !!imageMimeType(entry.path);
            const icon = isDir ? 'folder' : isImg ? 'file-image' : 'file';
            const label = isDir ? `${basename(cleanPath) || cleanPath}/` : basename(entry.path);
            const detail = entry.ignored ? `${entry.path} [gitignored]` : entry.path;
            const value = isDir
              ? (entry.ignored ? 'Dir · gitignored' : 'Directory')
              : isImg
                ? (entry.ignored ? 'Image · gitignored' : 'Image')
                : (entry.ignored ? 'gitignored' : 'Attach');
            return <item key={`row-${index}`} icon={icon} label={label}
              detail={detail} value={value} title={`Attach ${detail}`}
              onClick={() => attachFile(entry)} />;
          })}
        </list>}
        {queuedPrompts.length > 0 && <col key="queue" gap="xs">
          {queuedPrompts.map((item, idx) => {
            const label = item.text.trim().replace(/\s+/g, ' ');
            const preview = label.length > 64 ? `${label.slice(0, 61)}...` : (label || `${item.images.length} image(s)`);
            const metaParts = [
              ...(item.files.length ? [`${item.files.length} file${item.files.length === 1 ? '' : 's'}`] : []),
              ...(item.dirs.length ? [`${item.dirs.length} dir${item.dirs.length === 1 ? '' : 's'}`] : []),
              ...(item.images.length ? [`${item.images.length} image${item.images.length === 1 ? '' : 's'}`] : []),
            ];
            return <row key={item.id} justify="between" align="center" gap="sm">
              <text wrap="char">
                <span s="accent">Queued #{idx + 1}</span>
                <span>: {preview}</span>
                {metaParts.length > 0 && <span s="muted"> ({metaParts.join(', ')})</span>}
              </text>
              <row gap="xs">
                <button size="sm" variant="quiet" onClick={() => {
                  const pulled = queuedPrompts.splice(idx, 1)[0];
                  if (!pulled) return;
                  draft = { text: pulled.text, cursor: pulled.text.length };
                  attachedFiles = [...pulled.files];
                  attachedDirs = [...pulled.dirs];
                  attachedImages = [...pulled.images];
                  render();
                  surface?.focus('dock.draft');
                }}>Edit</button>
                <button size="sm" variant="quiet" onClick={() => {
                  queuedPrompts.splice(idx, 1);
                  render();
                }}>Drop</button>
              </row>
            </row>;
          })}
        </col>}
        {hasAttachments && <row key="attachments" gap="xs" wrap>
          {attachedImages.map(image => <attachment key={`img:${image.path}`} variant="tile"
            name={basename(image.path)} mime={image.mimeType} size={image.size} path={image.path}
            blob={blobForImage(`att:${image.path}`, image.data, image.mimeType)}
            actions={[{ act: 'preview', icon: 'expand', title: 'Center preview' }]}
            removable
            onAction={{
              preview: () => {
                const blob = blobForImage(`att:${image.path}`, image.data, image.mimeType);
                if (blob) openInspect(basename(image.path), { type: 'image-blob', blob, mimeType: image.mimeType, name: basename(image.path) }, image.path);
              },
              remove: () => removeImageAttachment(image.path),
            }} />)}
          {attachedDirs.map(dir => {
            const clean = dir.replace(/\/+$/, '');
            const isIgnored = ignoredPathsSet.has(dir);
            return <attachment key={`dir:${dir}`} variant="chip" ext="DIR" mime="inode/directory"
              name={`${basename(clean) || clean}/`}
              path={dir} meta={isIgnored ? `${dir} · gitignored` : `${dir} · directory`}
              actions={[{ act: 'preview', icon: 'expand', title: 'Inspect directory' }]}
              removable
              onAction={{
                preview: () => {
                  void listDirectoryEntriesPreview(options.cwd, dir).then(pv => {
                    if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
                  }).catch(() => {});
                },
                remove: () => removeDirAttachment(dir),
              }} />;
          })}
          {attachedFiles.map(file => {
            const isIgnored = ignoredPathsSet.has(file);
            return <attachment key={file} variant="chip" name={basename(file)}
              path={file} meta={isIgnored ? `${file} · gitignored` : file}
              actions={[{ act: 'preview', icon: 'expand', title: 'Inspect file' }]}
              removable
              onAction={{
                preview: () => {
                  void readWorkspaceTextPreview(options.cwd, file).then(pv => {
                    if (!quitting) openInspect(basename(file), { type: 'file', path: pv.path, content: pv.text, truncated: pv.truncated }, file);
                  }).catch(() => {});
                },
                remove: () => removeAttachment(file),
              }} />;
          })}
        </row>}
        <editor key="draft" aria="Message to Antigravity" text={draft.text} cursor={draft.cursor} anchor={draft.anchor}
          placeholder={disconnected ? 'Use /account to sign in, or draft a message' : busy ? 'Draft your next message' : 'Message Antigravity, / for commands, @ for files & dirs'}
          readonly={authBusy} maxLines={layout.composerMaxLines} variant="field"
          buttons={editorButtons}
          onFocus={() => surface?.focus('dock.draft')}
          onEdit={event => { if (!authBusy) { const next = editDraft(draft, event); recordUndo(draft, next); draft = next; autocompleteDismissed = false; commandSelection = 0; fileSelection = 0; render(); } }}
          onUndo={() => { if (!authBusy) applyUndo(); }}
          onAction={{ send, stop }} />
        <status key="bar">
          <seg key="state" priority={10}
            tone={busy || authBusy || agentConnecting || !!sessionOperation ? 'accent' : disconnected || phase.includes('failed') ? 'error' : agent ? 'success' : 'muted'}
            text={authBusy ? 'Signing in' : sessionOperation ?? phase}
            title={disconnected && !agentConnecting ? 'Click to reconnect agy ACP' : busy ? 'Click to inspect running task (/tasks)' : undefined}
            onClick={() => {
              if (disconnected && !agentConnecting && !authBusy) reconnectAgent();
              else if (busy && !permission && !authBusy) openPanel({ kind: 'tasks' });
            }} />
          {historyIndex !== undefined && <seg key="history" priority={6} icon="history" tone="accent"
            text={`History ${historyIndex + 1}/${promptHistory.length}`}
            title="Up/Down cycles sent prompts; type to keep editing" />}
          <seg key="model" priority={9} icon="model"
            tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
            text={currentModel ? configLabel(currentModel) : 'Model'}
            hovercard={hoverKv([
              { k: 'Model', v: currentModel ? configLabel(currentModel) : 'Not reported' },
              ...(currentModel ? [{ k: 'Option ID', v: String(currentModel.currentValue) }] : []),
              { k: 'Shortcut', v: 'Click or type /model' },
            ])}
            onClick={() => {
              if (agent && !disconnected && !permission) {
                openPanel(currentModel ? { kind: 'config', id: currentModel.id } : { kind: 'settings' });
              }
            }} />
          {currentThinking && <seg key="thinking" priority={7} icon="thinking"
            tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
            text={configLabel(currentThinking)}
            hovercard={hoverKv([
              { k: 'Thinking level', v: configLabel(currentThinking) },
              { k: 'Action', v: 'Click to change reasoning effort' },
            ])}
            onClick={() => {
              if (agent && !disconnected && !permission) openPanel({ kind: 'config', id: currentThinking.id });
            }} />}
          <seg key="mode" priority={6} icon="shield"
            tone={(!agent || !!permission) ? 'muted' : undefined}
            text={currentMode ? configLabel(currentMode) : 'Permissions'}
            hovercard={hoverKv([
              { k: 'Mode', v: currentMode ? configLabel(currentMode) : 'Not reported' },
              { k: 'Sandbox', v: '--sandbox requested (unverified)' },
              { k: 'Shortcut', v: 'Click or type /permissions' },
            ])}
            onClick={() => {
              if (agent && !permission) openPanel({ kind: 'permissions' });
            }} />
          <seg key="sessions" priority={4} icon="history"
            tone={(!agent || disconnected || !!permission || busy || changingConfig || !!sessionOperation) ? 'muted' : undefined}
            text={activeSessionId ? sessionTitle(activeSessionId) : 'Sessions'}
            hovercard={hoverKv([
              { k: 'Conversation', v: activeSessionId ? sessionTitle(activeSessionId) : 'No active session' },
              ...(activeSessionId ? [{ k: 'Session ID', v: activeSessionId }] : []),
              { k: 'Shortcut', v: 'Click or type /sessions' },
            ])}
            onClick={() => {
              if (agent && !disconnected && !permission && !busy && !changingConfig && !sessionOperation) {
                openPanel({ kind: 'sessions' });
              }
            }} />
          <seg key="branch" priority={2} icon="branch"
            text={gitBranch ? `${workspaceName} · ${gitBranch}` : workspaceName}
            title={options.cwd} />
          {(options.agentName || (options.additionalDirectories?.length ?? 0) > 0) && <seg key="scope" priority={5} icon="tern"
            text={[
              ...(options.agentName ? [options.agentName] : []),
              ...(options.additionalDirectories?.length ? [`+${options.additionalDirectories.length} dir`] : []),
            ].join(' · ')}
            hovercard={hoverKv([
              { k: 'Agent profile', v: options.agentName ?? 'Default' },
              { k: 'Workspace roots', v: String(1 + (options.additionalDirectories?.length ?? 0)) },
              { k: 'Shortcut', v: 'Click or type /agents' },
            ])}
            onClick={() => { if (!permission && !authBusy) openPanel({ kind: 'agents' }); }} />}
          {sessionDiffCount > 0 && <seg key="changes" side="right" priority={8} icon="diff" tone="accent"
            text={`Changes (${sessionDiffCount})`}
            title={`Inspect ${sessionDiffCount} session edit${sessionDiffCount === 1 ? '' : 's'} (/changes)`}
            onClick={() => { if (!permission && !authBusy) openPanel({ kind: 'changes' }); }} />}
          <seg key="commands" side="right" priority={5} icon="slash" text="Commands"
            tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
            title="Commands (/)"
            onClick={() => { if (agent && !disconnected && !permission) openPanel({ kind: 'commands' }); }} />
          <seg key="settings" side="right" priority={6} icon="settings" text="Settings"
            title="Settings & Preferences (/settings)"
            onClick={() => { if (!permission && !authBusy) openPanel({ kind: 'settings' }); }} />
          {!contextUsage && <seg key="usage" side="right" priority={5} icon="context" text="Usage"
            tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
            title="Usage & Quota (/usage)"
            onClick={() => { if (agent && !disconnected && !permission) openPanel({ kind: 'report', report: 'usage' }); }} />}
          <seg key="account" side="right" priority={8} icon="user"
            text={metadata.tier && viewportCols >= 96 ? metadata.tier.name : 'Account'}
            hovercard={hoverKv([
              { k: 'ACP', v: disconnected ? 'Disconnected' : agent ? 'Connected' : 'Connecting' },
              { k: 'Subscription tier', v: metadata.tier ? metadata.tier.name : 'Not reported' },
              { k: 'Shortcut', v: 'Click or type /account' },
            ])}
            onClick={() => { if (!permission && !authBusy) openPanel({ kind: 'account' }); }} />
          <seg key="quit" side="right" priority={9} icon="power" text="Quit"
            title="Quit frontend (Ctrl+Q)"
            onClick={quit} />
        </status>
        {layout.showKeyLegend && <text key="keys" wrap="word">
          <span s="key">Enter</span><span s="muted"> send  </span>
          <span s="key">/</span><span s="muted"> commands  </span>
          <span s="key">@</span><span s="muted"> files/dirs  </span>
          <span s="key">Shift+Enter</span><span s="muted"> newline  </span>
          <span s="key">Esc</span><span s="muted"> stop  </span>
          <span s="key">PgUp/PgDn</span><span s="muted"> scroll  </span>
          {permission && <><span s="key">Tab/Shift+Tab</span><span s="muted"> choice  </span>
            <span s="key">Ctrl+Y</span><span s="muted"> allow  </span>
            <span s="key">Ctrl+N</span><span s="muted"> deny  </span></>}
          <span s="key">Ctrl+Q</span><span s="muted"> quit</span>
        </text>}
      </col>,
      layer: <col>
        {toastMessage && <toast key="toast" text={toastMessage.text} sub={toastMessage.sub} />}
        {renderPanel()}
      </col>,
    });
  }

  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  process.on('SIGHUP', quit);
  process.stdout.on('resize', onStdoutResize);
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
  process.stdin.on('error', inputError);
  signal.addEventListener('abort', quit, { once: true });
  try {
    session = await connect({ app: 'agy-tern', features: ['edit', 'undo'], exitHooks: false });
    if (!session) return quitting ? outcome : { kind: 'unavailable' };
    if (signal.aborted || quitting) return outcome;
    surface = session.open({ mode: 'screen', title: 'Antigravity · agy-tern', font: 'sans' });
    prefsReady = prefsStore.load().then(loaded => {
      if (!quitting) { userPrefs = loaded; render(); }
    }).catch(() => {});
    refreshWorkspaceFiles();
    void detectGitBranch(options.cwd).then(branch => {
      if (!quitting && branch) { gitBranch = branch; render(); }
    });
    if (launch?.openAccount) {
      openPanel({ kind: 'account' });
      panelError = launch.notice?.text ?? '';
    }
    render();
    surface.focus(launch?.openAccount ? null : 'dock.draft');

    const startAgentConnection = (resumeId?: string): Promise<void> => {
      if (quitting || agentConnecting) return Promise.resolve();
      agentConnecting = true;
      disconnected = false;
      phase = resumeId ? 'Reconnecting to Antigravity' : 'Connecting to Antigravity';
      render();
      return connectAgent({ ...options, signal }, {
        authentication(next) {
          if (!quitting) { authentication = next; authenticationKnown = true; render(); }
        },
        metadata(next) {
          if (!quitting) { metadata = next; commandSelection = 0; render(); }
        },
        sessionChanged(id) {
          if (activeSessionId) {
            void persistActiveTranscript();
            conversations.set(activeSessionId, conversation);
            if (conversations.size > 12) {
              const oldest = conversations.keys().next().value;
              if (oldest !== undefined && oldest !== id) conversations.delete(oldest);
            }
            drafts.set(activeSessionId, draft);
            conversation = new Conversation();
            draft = drafts.get(id) ?? { text: '', cursor: 0 };
            expandedThoughts.clear();
            thoughtFoldOverrides.clear();
            toolFoldOverrides.clear();
            previewedMedia.clear();
            gitDiffCache.clear();
            historyVisibleCount = DEFAULT_HISTORY_VISIBLE;
            cachedDiffCountConversation = undefined;
            cachedDiffsConversation = undefined;
            cachedSessionDiffs = [];
          }
          activeSessionId = id;
          clearPermissions();
          render();
        },
        update(notification) {
          if (quitting) return;
          const update = notification.update;
          if (update.sessionUpdate === 'session_info_update') {
            const info = sessionInfo.get(notification.sessionId) ?? { sessionId: notification.sessionId, cwd: options.cwd };
            if (update.title !== undefined) info.title = update.title;
            if (update.updatedAt !== undefined) info.updatedAt = update.updatedAt;
            sessionInfo.set(notification.sessionId, info);
          }
          if (!busy || update.sessionUpdate !== 'user_message_chunk') {
            conversation.update(update, Date.now(), busy ? clockTime() : undefined);
          }
          if (replayingHistory && update.sessionUpdate !== 'session_info_update' &&
            update.sessionUpdate !== 'available_commands_update' && update.sessionUpdate !== 'usage_update') {
            if (replayPlaceholderId) {
              conversation.removeNotice(replayPlaceholderId);
              replayPlaceholderId = undefined;
            }
            markReplayActivity();
          }
          if (busy && !replayingHistory && userPrefs.autoPreviewMedia && !panel && !permissions.length) {
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
              const call = conversation.getTool(update.toolCallId)?.call;
              if (call) {
                const imgPath = extractToolImagePaths(call, options.cwd).find(p => existsSync(p) && !previewedMedia.has(`path:${p}`));
                if (imgPath) {
                  previewedMedia.add(`path:${imgPath}`);
                  const label = formatPathLabel(imgPath, options.cwd);
                  openInspect(basename(label), { type: 'image-path', path: imgPath }, label);
                  return;
                }
                const inlineImg = extractToolInlineImages(call)[0];
                if (inlineImg) {
                  const imgKey = `tool-inline:${call.toolCallId}:${inlineImg.data.slice(0, 48)}`;
                  if (!previewedMedia.has(imgKey)) {
                    previewedMedia.add(imgKey);
                    const blob = blobForImage(imgKey, inlineImg.data, inlineImg.mimeType);
                    if (blob) {
                      openInspect(call.title ?? 'Live image preview', { type: 'image-blob', blob, mimeType: inlineImg.mimeType }, inlineImg.mimeType);
                      return;
                    }
                  }
                }
              }
            } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'image') {
              const imgKey = `msg-inline:${notification.sessionId}:${update.content.data.slice(0, 48)}`;
              if (!previewedMedia.has(imgKey)) {
                previewedMedia.add(imgKey);
                const blob = blobForImage(imgKey, update.content.data, update.content.mimeType);
                if (blob) {
                  openInspect('Live image preview', { type: 'image-blob', blob, mimeType: update.content.mimeType }, update.content.mimeType);
                  return;
                }
              }
            }
          }
          scheduleRender();
        },
        permission(prompt) {
          if (quitting || authBusy || cancelling || disconnected) { prompt.answer(null); return; }
          closePanel();
          conversation.tool(prompt.request.toolCall);
          if (!prompt.request.options.some(option => option.kind === 'allow_once')) {
            const deny = prompt.request.options.find(option => option.kind === 'reject_once');
            conversation.tool(prompt.request.toolCall).approved = 'denied';
            conversation.notice(`${prompt.request.toolCall.title ?? prompt.request.toolCall.toolCallId}: no one-time allowance offered; request denied.`);
            prompt.answer(deny?.optionId ?? null);
          } else {
            permissions.push(prompt);
            if (userPrefs.notifyOnTurnComplete) {
              sendTerminalAttention('agy-tern', `Approval required: ${prompt.request.toolCall.title ?? 'tool call'}`);
            }
          }
          render();
        },
        diagnostic(text) {
          if (!quitting) { conversation.notice(text); render(); }
        },
        disconnected(message) {
          if (quitting) return;
          agent = undefined;
          agentConnecting = false;
          disconnected = true;
          phase = 'Disconnected';
          clearPermissions();
          conversation.notice(message, true);
          process.exitCode = 1;
          render();
        },
      }).then(async connected => {
        if (quitting) { await connected.close(); return; }
        await prefsReady;
        if (quitting) { await connected.close(); return; }
        agent = connected;
        agentConnecting = false;
        process.exitCode = undefined;
        metadata = connected.metadata;
        activeSessionId = connected.sessionId;
        const targetId = resumeId ?? launch?.conversationId;
        const loadingExisting = Boolean((targetId && targetId !== connected.sessionId) || (!resumeId && launch?.continueLast));
        if (!resumeId && !loadingExisting) {
          await applyPreferredConfigOptions(connected, true, true);
        }
        if (quitting) return;
        if (targetId && targetId !== connected.sessionId) {
          try {
            if (connected.capabilities.loadSession) {
              beginHistoryReplay('load');
              await connected.loadSession(targetId);
              finishHistoryReplay();
              await hydrateSessionHistoryFallback(targetId, undefined, 'load');
            } else if (connected.capabilities.resumeSession && connected.resumeSession) {
              await connected.resumeSession(targetId);
              await hydrateSessionHistoryFallback(targetId, undefined, 'resume');
            } else if (!resumeId) {
              conversation.notice(`Cannot open --conversation ${targetId}: session load/resume not advertised.`, true);
            }
          } catch (err) {
            clearReplayState();
            conversation.notice(`Failed to open conversation ${targetId}: ${err instanceof Error ? err.message : String(err)}`, true);
          }
          await applyPreferredConfigOptions(connected, !resumeId, true);
        } else if (!resumeId && launch?.continueLast && connected.capabilities.listSessions) {
          try {
            const list = await connected.listSessions();
            const sorted = [...list.sessions].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
            const latest = sorted[0];
            if (latest && latest.sessionId !== connected.sessionId) {
              if (connected.capabilities.loadSession) {
                beginHistoryReplay('load');
                await connected.loadSession(latest.sessionId);
                finishHistoryReplay();
                await hydrateSessionHistoryFallback(latest.sessionId, undefined, 'load');
              } else if (connected.capabilities.resumeSession && connected.resumeSession) {
                await connected.resumeSession(latest.sessionId);
                await hydrateSessionHistoryFallback(latest.sessionId, undefined, 'resume');
              }
              await applyPreferredConfigOptions(connected, true, true);
            } else if (!latest) {
              conversation.notice('No previous conversation found in this workspace for --continue; started a new session.');
            }
          } catch (err) {
            clearReplayState();
            conversation.notice(`Failed to continue latest conversation: ${err instanceof Error ? err.message : String(err)}`, true);
          }
        }
        if (quitting) return;
        phase = replayingHistory ? 'Syncing history' : 'Ready';
        render();
        if (!replayingHistory) surface?.scroll('main.conversation', 'end');
        if (!resumeId && connected.capabilities.listSessions && !listedSessions.length) {
          loadSessions(false, true);
        }
        if (resumeId) showToast('Reconnected to Antigravity');
        else if (launch?.initialPrompt && !disconnected) submitPrompt(launch.initialPrompt);
      }).catch(error => {
        if (quitting) return;
        agent = undefined;
        agentConnecting = false;
        disconnected = true;
        phase = 'Connection failed';
        clearPermissions();
        conversation.notice(error instanceof Error ? error.message : String(error), true);
        process.exitCode = 1;
        render();
      });
    };

    connectRunner = startAgentConnection;
    startup = startAgentConnection();
    while (!quitting) {
      const input = await Promise.race([session.next(), stopped.promise]);
      if (!input || surface.closed) break;
      if (input.type === 'event') {
        if (input.event.ev === 'resize') {
          viewportCols = input.event.cols || process.stdout.columns || viewportCols;
          viewportRows = process.stdout.rows || viewportRows;
          render();
          scheduleRender();
        } else if (input.event.ev === 'error') {
          conversation.notice(`Tern: ${input.event.msg}`, true);
          render();
        }
        continue;
      }
      const key = input.key;
      if (((key.ctrl || key.meta) && key.name === 'q') || (key.ctrl && key.name === 'c')) { quit(); continue; }
      if (key.name === 'escape') {
        if (panel) stepBackPanel();
        else if (autocomplete().length) { autocompleteDismissed = true; render(); }
        else stop();
        continue;
      }
      if (panel && !permissions.length) {
        const current = panel;
        if (current.kind === 'inspect') {
          continue;
        }
        if (current.kind === 'settings') {
          const pages = ['appearance', 'session', 'permissions', 'keys'];
          if (key.name === 'tab') {
            const idx = Math.max(0, pages.indexOf(prefsPage));
            prefsPage = pages[(idx + (key.shift ? pages.length - 1 : 1)) % pages.length]!;
          } else {
            panelDraft = draftKey(panelDraft, key).draft;
          }
          render();
          continue;
        }
        const configOpt = current.kind === 'config' ? metadata.configOptions.find(candidate => candidate.id === current.id) : undefined;
        if (current.kind === 'commands' || current.kind === 'mcp' || current.kind === 'plugins' || current.kind === 'agents' ||
          current.kind === 'templates' || current.kind === 'find' || current.kind === 'tasks' || current.kind === 'changes' ||
          current.kind === 'sessions' || (current.kind === 'config' && configOpt?.type === 'select')) {
          let tabIds: string[] = [];
          let visibleIds: string[] = [];
          let activate: (chosenId: string) => void = () => {};
          if (current.kind === 'commands') {
            tabIds = ['all', 'frontend', 'workflow', 'skill'];
            const matches = filterCommandsForTab(availableCommands(), pickerTab, panelDraft.text);
            visibleIds = matches.map(c => c.name);
            activate = chosenId => {
              const cmd = matches.find(c => c.name === chosenId);
              if (cmd) chooseCommand(cmd);
            };
          } else if (current.kind === 'mcp') {
            tabIds = ['all', 'enabled', 'disabled'];
            const matches = filterMcpServers(mcpServers, pickerTab, panelDraft.text);
            visibleIds = matches.map(s => s.name);
            activate = chosenId => {
              if (extLoading) return;
              const srv = matches.find(s => s.name === chosenId);
              if (srv) toggleMcp(srv.name, srv.status !== 'enabled');
            };
          } else if (current.kind === 'plugins') {
            tabIds = ['all', 'enabled', 'disabled'];
            const matches = filterPluginsList(pluginsList, pickerTab, panelDraft.text);
            visibleIds = matches.map(p => p.name);
            activate = chosenId => {
              if (extLoading) return;
              const plug = matches.find(p => p.name === chosenId);
              if (plug) togglePlugin(plug.name, !plug.enabled);
            };
          } else if (current.kind === 'agents') {
            tabIds = ['all'];
            visibleIds = filterAgentsList(agentsList, panelDraft.text).map(a => a.name);
            activate = () => closePanel();
          } else if (current.kind === 'templates') {
            tabIds = ['all'];
            const matches = filterTemplatesList(templatesList, panelDraft.text);
            visibleIds = matches.map(t => t.name);
            activate = chosenId => {
              const tpl = matches.find(t => t.name === chosenId);
              if (!tpl) return;
              closePanel();
              draft = { text: tpl.text, cursor: tpl.text.length };
              render();
              surface?.focus('dock.draft');
            };
          } else if (current.kind === 'find') {
            tabIds = ['all', 'message', 'tool', 'thought'];
            const matches = filterFindMatches(searchTranscript(conversation.entries, options.cwd, panelDraft.text), pickerTab);
            visibleIds = matches.map(m => m.id);
            activate = chosenId => {
              const match = matches.find(m => m.id === chosenId);
              if (match) inspectFindMatch(match);
            };
          } else if (current.kind === 'tasks') {
            const needle = panelDraft.text.trim().toLowerCase();
            const allTools = conversation.entries
              .filter((entry): entry is ToolStep => entry.type === 'tool')
              .slice()
              .reverse()
              .filter(step => {
                const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
                if (pickerTab === 'running' && !isRunning) return false;
                if (pickerTab === 'done' && isRunning) return false;
                if (!needle) return true;
                const summary = summarizeToolCall(step.call, options.cwd);
                return `${summary.title} ${summary.target ?? ''} ${step.call.toolCallId}`.toLowerCase().includes(needle);
              });
            tabIds = ['all', 'running', 'done'];
            visibleIds = allTools.map(s => s.id);
            activate = chosenId => {
              const step = allTools.find(s => s.id === chosenId);
              if (step) inspectTaskStep(step);
            };
          } else if (current.kind === 'changes') {
            const needle = panelDraft.text.trim().toLowerCase();
            const sessionDiffs = getSessionDiffs();
            const usingGit = pickerTab === 'git';
            const filteredEdits = sessionDiffs.filter(item => item.path.toLowerCase().includes(needle));
            const filteredGit = gitChanges.filter(item => `${item.status} ${item.path}`.toLowerCase().includes(needle));
            tabIds = ['edits', 'git'];
            visibleIds = usingGit ? filteredGit.map(item => `git:${item.path}`) : filteredEdits.map(item => item.id);
            activate = chosenId => {
              const chosenPath = usingGit
                ? filteredGit.find(item => `git:${item.path}` === chosenId)?.path
                : filteredEdits.find(item => item.id === chosenId)?.path;
              if (chosenPath) { closePanel(); attachFile(chosenPath); }
            };
          } else if (current.kind === 'sessions') {
            const rows = new Map(listedSessions.map(row => [row.sessionId, row]));
            if (activeSessionId) rows.set(activeSessionId, sessionInfo.get(activeSessionId) ?? { sessionId: activeSessionId, cwd: options.cwd });
            tabIds = ['all', 'named'];
            visibleIds = filterSessionRows([...rows.values()], localNames, activeSessionId, sessionTitle, pickerTab, panelDraft.text)
              .map(row => row.sessionId);
            activate = chosenId => {
              if (!changingConfig && !sessionOperation && !busy && !disconnected &&
                (chosenId === activeSessionId || agent?.capabilities.loadSession)) {
                openConversation(chosenId);
              }
            };
          } else if (configOpt?.type === 'select') {
            const groups = groupSelectConfigOptions(configOpt);
            tabIds = groups.length > 1 ? ['all', ...groups.map(g => g.id)] : [];
            const needle = panelDraft.text.trim().toLowerCase();
            visibleIds = configValues(configOpt)
              .filter(val => {
                if (pickerTab !== 'all') {
                  const g = groups.find(group => group.id === pickerTab);
                  if (g && !g.options.some(entry => entry.value === val.value)) return false;
                }
                return `${val.name} ${val.value} ${val.description ?? ''}`.toLowerCase().includes(needle);
              })
              .map(val => val.value);
            activate = chosenId => {
              if (!changingConfig && !busy && !disconnected) changeConfig(configOpt, chosenId);
            };
          }
          const step = stepPickerKey({ tab: pickerTab, selected: pickerSelected, draft: panelDraft }, key, tabIds, visibleIds);
          pickerTab = step.tab;
          pickerSelected = step.selected;
          panelDraft = step.draft;
          if (step.activateId) {
            activate(step.activateId);
            continue;
          }
          render();
          continue;
        }
        const choices = panelChoices();
        if (current.kind === 'report' && current.report === 'usage' && (key.name === 'left' || key.name === 'right')) {
          const tabs = ['overview', 'details', 'raw'];
          const idx = Math.max(0, tabs.indexOf(usageTab));
          usageTab = tabs[(idx + (key.name === 'left' ? tabs.length - 1 : 1)) % tabs.length]!;
        } else if (key.name === 'tab' || key.name === 'down' || key.name === 'up') {
          const count = current.kind === 'report' ? 2 : choices.length;
          const previous = key.name === 'up' || (key.name === 'tab' && key.shift);
          panelSelection = count ? (panelSelection + (previous ? count - 1 : 1)) % count : 0;
        } else if (key.name === 'enter' && !key.shift && !changingConfig && !sessionOperation && !authBusy) {
          if (current.kind === 'report') {
            if (panelSelection % 2) closePanel();
            else if (!reportLoading) loadReport(current.report);
          } else {
            const choice = choices[Math.min(panelSelection, choices.length - 1)];
            if (!choice?.disabled) choice?.choose();
          }
        } else if (current.kind !== 'report' && current.kind !== 'permissions' && current.kind !== 'account' &&
          current.kind !== 'account-switch' && current.kind !== 'confirm') {
          panelDraft = draftKey(panelDraft, key).draft;
          panelSelection = 0;
        }
        render();
        continue;
      }
      const suggestions = autocomplete();
      if (suggestions.length && (key.name === 'up' || key.name === 'down')) {
        commandSelection = (commandSelection + (key.name === 'up' ? suggestions.length - 1 : 1)) % suggestions.length;
        render();
        continue;
      }
      if (suggestions.length && !key.shift && (key.name === 'enter' || key.name === 'tab')) {
        chooseCommand(suggestions[Math.min(commandSelection, suggestions.length - 1)], '', key.name === 'tab');
        continue;
      }
      const fileMatches = atFileMatches();
      if (fileMatches.length && (key.name === 'up' || key.name === 'down')) {
        fileSelection = (fileSelection + (key.name === 'up' ? fileMatches.length - 1 : 1)) % fileMatches.length;
        render();
        continue;
      }
      if (fileMatches.length && !key.shift && (key.name === 'enter' || key.name === 'tab')) {
        attachFile(fileMatches[Math.min(fileSelection, fileMatches.length - 1)]!);
        continue;
      }
      if (key.name === 'page_up' || key.name === 'page_down') {
        surface.scroll('main.conversation', key.name === 'page_up' ? 'page-up' : 'page-down');
        continue;
      }
      if (key.name === 'tab' && permissions[0]) {
        const choices = permissions[0].request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once');
        approvalChoice = (approvalChoice + (key.shift ? choices.length - 1 : 1)) % choices.length;
        render();
        continue;
      }
      if ((key.ctrl || key.meta) && (key.name === 'y' || key.name === 'n') && permissions[0]) {
        const permission = permissions[0];
        const choices = permission.request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once');
        const kind = key.name === 'y' ? 'allow_once' : 'reject_once';
        const selected = choices[approvalChoice];
        const choice = selected?.kind === kind ? selected : choices.find(option => option.kind === kind);
        if (choice || key.name === 'n') answer(permission, choice?.optionId ?? null);
        continue;
      }
      if (authBusy) continue;
      if ((key.ctrl || key.meta) && !key.alt && key.name === 'z') {
        applyUndo();
        continue;
      }
      if (key.name === 'paste' && key.text) {
        const pastedImg = resolvePastedImagePath(options.cwd, key.text);
        if (pastedImg) {
          attachFile(pastedImg);
          continue;
        }
      }
      const wrapWidth = editorWrapWidth();
      if (!key.ctrl && !key.alt && !key.meta && !key.shift && (key.name === 'up' || key.name === 'down')) {
        const dir = key.name === 'up' ? -1 : 1;
        const canStepHistory = dir === -1
          ? (draft.text === '' || (historyIndex !== undefined && isCursorOnFirstRow(draft.text, draft.cursor, wrapWidth)))
          : (historyIndex !== undefined && isCursorOnLastRow(draft.text, draft.cursor, wrapWidth));
        if (canStepHistory && stepPromptHistory(dir)) {
          autocompleteDismissed = true;
          commandSelection = 0;
          fileSelection = 0;
          render();
          continue;
        }
      }
      const result = draftKey(draft, key, { wrapWidth });
      recordUndo(draft, result.draft);
      draft = result.draft;
      autocompleteDismissed = false;
      commandSelection = 0;
      fileSelection = 0;
      if (result.send) send();
      else render();
    }
  } catch (error) {
    if (!session) throw error;
    process.exitCode = 1;
    disconnected = true;
    busy = false;
    phase = 'Frontend failed';
    clearPermissions();
    conversation.notice(error instanceof Error ? error.message : String(error), true);
    render();
    while (!quitting && !session.closed && surface && !surface.closed) {
      const input = await Promise.race([session.next(), stopped.promise]);
      if (!input || (input.type === 'key' && (input.key.name === 'escape' ||
        ((input.key.ctrl || input.key.meta) && input.key.name === 'q') || (input.key.ctrl && input.key.name === 'c')))) break;
    }
  } finally {
    if (!quitting) quit();
    try {
      await persistActiveTranscript();
      await startup;
      await agent?.close();
      await turn;
      await configTask;
      await reportTask;
      await sessionTask;
      await authTask;
    } finally {
      try { await session?.close(); }
      finally {
        process.off('SIGTERM', terminate);
        process.off('SIGINT', interrupt);
        process.off('SIGHUP', quit);
        process.stdout.off('resize', onStdoutResize);
        process.stdin.off('end', quit);
        process.stdin.off('close', quit);
        process.stdin.off('error', inputError);
        signal.removeEventListener('abort', quit);
        clearTimeout(toastTimer);
        syncLiveTick(false);
      }
    }
  }
  return outcome;
}
