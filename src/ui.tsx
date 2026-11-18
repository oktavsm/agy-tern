/** @jsxImportSource @stencil-hq/tern */
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { connect, type DiffHunk, type EditEvent, type JSX, type Renderable, type Session, type Surface, type Tone } from '@stencil-hq/tern';
import type { AuthMethodTerminal, SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { connectAgent } from './agent';
import { terminalLoginProblem, type AgentAuthentication, type AgentMetadata, type AgentOptions, type AgentSession, type ConnectionStage, type ElicitationPrompt, type PermissionPrompt, type ResourceAttachment } from './contracts';
import {
  createFollowUpSessionState,
  formatFollowUpPromptReply,
  parseElicitationRequest,
  validateElicitationAnswers,
  type FollowUpSessionState,
  type QuestionField,
} from './follow-up';
import { draftKey, editDraft, isCursorOnFirstRow, isCursorOnLastRow, type Draft } from './draft';
import { Conversation, type ToolStep, type TranscriptEntry } from './model';
import { commandCatalog, commandQuery, configLabel, configValues, filterCommands, modelOption, resolveCommand, type Command } from './commands';
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
import { readOfficialReport, type OfficialReport } from './reports';
import {
  buildSessionPreviewFromEntries,
  listAvailableBrainSessionIds,
  PromptHistoryStore,
  readOfficialBrainTranscript,
  readSessionPreview,
  selectRicherTranscript,
  TranscriptStore,
  type SessionPreview,
} from './history';
import { SessionNames } from './session-names';
import { PromptTemplatesStore, type PromptTemplate } from './templates';
import { openInTernSplit, runCommandInTernSplit, sendTerminalAttention } from './tern-window';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PREFS,
  DEFAULT_THINKING_ID,
  PrefsStore,
  type DiffMode,
  type MotionPref,
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
  readClipboardImage,
  readImageAttachment,
  readGitFileDiff,
  readWorkspaceTextPreview,
  resolvePastedImagePath,
  searchWorkspacePrefix,
  stripAtMention,
  writeTranscriptExport,
  type GitStatusEntry,
  type LoadedImageAttachment,
  type WorkspaceEntry,
} from './files';
import {
  buildTaskDetailText,
  buildUnifiedDiffHunks,
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
  searchTranscriptCached,
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
  buildSettingsViewData,
  isPrefsPageId,
  stepSettingsKey,
  type UpdateStatusState,
} from './settings-nav';
import {
  clockTime,
  copyToClipboard,
  Entry,
  hoverKv,
  ToolBody,
  type EntryCallbacks,
  type InspectTarget,
} from './transcript-view';
import {
  hasRichConversationHistory,
  HistoryReplayCoordinator,
  SessionStateManager,
  type ReplaySettledInfo,
} from './session-state';
import {
  AsyncPathPresenceCache,
  isEntrySettled,
  TernRenderController,
  type RenderedEntryRecord,
} from './tern-render';
import {
  renderActivePanel,
  type Choice,
  type Panel,
} from './panels';

export interface ChatLaunchState {
  draft?: Draft;
  notice?: { text: string; error: boolean };
  openAccount?: boolean;
  previousSessionId?: string;
  continueLast?: boolean;
  conversationId?: string;
  initialPrompt?: string;
  maxFps?: number;
  motion?: MotionPref;
}

export type NativeChatResult = { kind: 'unavailable' } | { kind: 'quit' } |
  { kind: 'login'; method: AuthMethodTerminal; draft: Draft; previousSessionId?: string };

const DOCK_DRAFT_ID = 'dock.shell.composer.line.draft';

const COMPOSER_LAYOUT_CSS = [
  ".sf-col[data-role='agy.dock.center'] {",
  '  width: 100%;',
  '  max-width: 92ch;',
  '  align-self: center;',
  '  margin-left: auto;',
  '  margin-right: auto;',
  '  box-sizing: border-box;',
  '  padding-left: 8px;',
  '  padding-right: 8px;',
  '}',
  ".sf-col[data-role='agy.dock.center'] .sf-col[data-role='omp.editor'],",
  ".sf-col[data-role='agy.dock.center'] .sf-col[data-role^='omp.editor.'] {",
  '  margin: 0 0 2px;',
  '}',
  ".sf-col[data-role='agy.dock.center'] .sf-row[data-role='omp.composer.bar'] > .sf-place {",
  '  display: none;',
  '}',
  ".sf-col[data-role='agy.dock.center'] .sf-row[data-role='omp.working'],",
  ".sf-col[data-role='agy.dock.center'] .sf-col[data-role='omp.queue'] {",
  '  margin-left: 0;',
  '  margin-right: 0;',
  '}',
  ".sf-col[data-role='agy.dock.center'] .sf-status[data-role='agy.dock.status'] {",
  '  padding-left: 4px;',
  '  padding-right: 4px;',
  '}',
  ".sf-col[data-role='agy.dock.center'] .sf-text[data-role='agy.dock.keys'] {",
  '  text-align: center;',
  '}',
  '.sf-scroll.scroll {',
  '  flex: 1 1 0 !important;',
  '  min-height: 0 !important;',
  '}',
  '.sf-scroll.scroll > .sf-scroll-view {',
  '  flex: 1 1 0 !important;',
  '  min-height: 0 !important;',
  '}',
  '.sf-overlay .sf-scroll.scroll,',
  '.sf-tool .sf-scroll.scroll {',
  '  flex: 0 1 auto !important;',
  '}',
  '.sf-overlay .sf-scroll.scroll > .sf-scroll-view,',
  '.sf-tool .sf-scroll.scroll > .sf-scroll-view {',
  '  flex: 0 1 auto !important;',
  '}',
  '.sf-scroll.can > .sf-scroll-bar {',
  '  user-select: none;',
  '  -webkit-user-select: none;',
  '  width: 14px;',
  '  cursor: grab;',
  '}',
  '.sf-scroll.can > .sf-scroll-bar.held {',
  '  cursor: grabbing;',
  '}',
].join('\n');

function thinkingToEffort(value: string | undefined): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'none' || normalized === '0') return 'off';
  if (normalized === 'minimal' || normalized === 'min') return 'minimal';
  if (normalized === 'low') return 'low';
  if (normalized === 'xhigh' || normalized === 'very_high') return 'xhigh';
  if (normalized === 'max') return 'max';
  if (normalized === 'medium' || normalized === 'med') return 'medium';
  return 'high';
}

export async function runNativeChat(options: AgentOptions, launch?: ChatLaunchState): Promise<NativeChatResult> {
  const stopped = Promise.withResolvers<null>();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let outcome: NativeChatResult = { kind: 'quit' };
  let authentication: AgentAuthentication = { terminalMethods: [], logout: false };
  let authenticationKnown = false;
  let authBusy = false;
  let authTask: Promise<void> | undefined;
  const names = new SessionNames(options.cwd);
  const transcriptStore = new TranscriptStore(options.cwd);
  const promptHistoryStore = new PromptHistoryStore(options.cwd);
  const localNames = new Map<string, string | undefined>();
  const sessionInfo = new Map<string, SessionInfo>();
  const sessionPreviewCache = new Map<string, SessionPreview | null>();
  const sessionPreviewInFlight = new Set<string>();
  const stateManager = new SessionStateManager({
    maxInMemory: 3,
    initialDraft: launch?.draft,
    onEvictConversation: (evictedId, evictedConv) => {
      if (!quitting && evictedConv.entries.some(entry => entry.type === 'message')) {
        sessionPreviewCache.delete(evictedId);
        void transcriptStore.save(evictedId, evictedConv.entries).catch(() => {});
      }
    },
  });
  if (launch?.notice && !launch.openAccount) {
    stateManager.getConversation().notice(launch.notice.text, launch.notice.error);
  }
  const replayCoordinator = new HistoryReplayCoordinator();
  const pathPresenceCache = new AsyncPathPresenceCache();
  let listedSessions: SessionInfo[] = [];
  let allListedSessions: SessionInfo[] = [];
  let nextSessionsCursor: string | undefined;
  let allNextSessionsCursor: string | undefined;
  let sessionsLoading = false;
  let allSessionsLoading = false;
  let sessionsLoadedAt = 0;
  let allSessionsLoadedAt = 0;
  let sessionsPrefetchInFlight: Promise<void> | undefined;
  let allSessionsPrefetchInFlight: Promise<void> | undefined;
  let sessionIndexing: { done: number; total: number } | undefined;
  let sessionSearchToken = 0;
  let connectionStage: ConnectionStage | undefined;
  let connectStartedAt: number | undefined;
  let startupSyncingConfig = false;
  const externalTranscriptStores = new Map<string, TranscriptStore>();
  let lastWorkspaceIndexAt = 0;
  let sessionOperation: string | undefined;
  let sessionTask: Promise<void> | undefined;
  const permissions: PermissionPrompt[] = [];
  const elicitations: ElicitationPrompt[] = [];
  let followUpState: FollowUpSessionState | undefined;
  let session: Session | null = null;
  let surface: Surface | undefined;
  let renderController: TernRenderController | undefined;
  let agent: AgentSession | undefined;
  let startup: Promise<void> | undefined;
  let connectRunner: ((resumeId?: string) => Promise<void>) | undefined;
  function reconnectAgent(): void {
    if (quitting || !disconnected || agentConnecting || authBusy || busy || permissions.length || !connectRunner) return;
    startup = connectRunner(stateManager.activeSessionId || undefined);
  }
  let turn: Promise<void> | undefined;
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
  let configSyncPromise: Promise<void> = Promise.resolve();
  let configSyncToken = 0;
  let workspaceEntriesVersion = 0;
  let cachedCmdKey = '';
  let cachedCmdResult: Command[] = [];
  let cachedAtKey = '';
  let cachedAtResult: WorkspaceEntry[] = [];
  const prefixSearchCache = new Map<string, WorkspaceEntry[]>();
  const prefixSearchInFlight = new Set<string>();
  const promptHistory: string[] = [];
  let gitBranch: string | undefined;
  const workspaceName = basename(options.cwd) || options.cwd;
  const prefsStore = new PrefsStore();
  const templatesStore = new PromptTemplatesStore(options.cwd);
  let templatesList: PromptTemplate[] = [];
  const loadedPrefs = prefsStore.loadSync();
  let userPrefs: UserPrefs = {
    ...loadedPrefs,
    ...(launch?.maxFps !== undefined ? { maxFps: launch.maxFps } : {}),
    ...(launch?.motion !== undefined ? { motion: launch.motion } : {}),
  };
  let prefsPage = 'appearance';
  let prefsFocus: string | undefined;
  let updateStatus: UpdateStatusState | undefined;
  let settingsChildPanel = false;
  let pickerTab = 'all';
  let pickerSelected = '';
  let usageTab = 'overview';
  let workspaceEntries: WorkspaceEntry[] = [];
  let ignoredPathsSet = new Set<string>();
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
  let replayPlaceholderId: string | undefined;
  let cachedDiffCountConversation: Conversation | undefined;
  let cachedDiffCountRev = -1;
  let cachedDiffCount = 0;
  let cachedActiveToolsConversation: Conversation | undefined;
  let cachedActiveToolsRev = -1;
  let cachedActiveTools: ToolStep[] = [];
  const hoverKvCache = new Map<string, { sig: string; node: ReturnType<typeof hoverKv> }>();

  function cachedHoverKv(slot: string, sig: string, rows: () => ReadonlyArray<{ k: string; v: string }>): ReturnType<typeof hoverKv> {
    const existing = hoverKvCache.get(slot);
    if (existing && existing.sig === sig) return existing.node;
    const node = hoverKv([...rows()]);
    hoverKvCache.set(slot, { sig, node });
    return node;
  }
  let cachedDiffsConversation: Conversation | undefined;
  let cachedDiffsRev = -1;
  let cachedSessionDiffs: SessionDiffItem[] = [];

  function getSessionDiffs(): SessionDiffItem[] {
    const activeConv = stateManager.getConversation();
    if (cachedDiffsConversation !== activeConv || cachedDiffsRev !== activeConv.revision) {
      cachedDiffsConversation = activeConv;
      cachedDiffsRev = activeConv.revision;
      cachedSessionDiffs = collectSessionDiffs(activeConv.entries, options.cwd);
    }
    return cachedSessionDiffs;
  }
  let turnStartedAt: number | undefined;
  const blobCache = new Map<string, string>();
  const previousSessionId = launch?.previousSessionId;
  let inspectReturnPanel: Panel | undefined;
  const viewportCols = (): number => renderController?.cols ?? (process.stdout.columns || 120);
  const viewportRows = (): number => renderController?.rows ?? (process.stdout.rows || 40);
  const pathExists = (targetPath: string): boolean => pathPresenceCache.peek(targetPath, scheduleRender);
  const onStdoutResize = (): void => {
    const nextCols = process.stdout.columns || viewportCols();
    const nextRows = process.stdout.rows || viewportRows();
    if (renderController) renderController.scheduleResize(nextCols, nextRows, render);
  };

  function editorWrapWidth(): number {
    return Math.max(24, viewportCols() - 14);
  }

  function currentResponsiveLayout(extra?: {
    hasPermission?: boolean;
    hasSuggestionsOrAt?: boolean;
    hasAttachments?: boolean;
    hasHud?: boolean;
  }): ResponsiveLayout {
    const st = stateManager.getActive();
    return computeResponsiveLayout(viewportCols(), viewportRows(), {
      userComposerLines: userPrefs.composerLines,
      userShowKeyLegend: userPrefs.showKeyLegend,
      hasPermission: extra?.hasPermission ?? permissions.length > 0,
      hasSuggestionsOrAt: extra?.hasSuggestionsOrAt ?? false,
      queuedCount: st.queuedPrompts.length,
      hasAttachments: extra?.hasAttachments ?? (st.attachedFiles.length > 0 || st.attachedDirs.length > 0 || st.attachedImages.length > 0),
      hasImageAttachments: st.attachedImages.length > 0,
      hasHud: extra?.hasHud ?? false,
    });
  }

  function recordUndo(prev: Draft, next: Draft): void {
    stateManager.recordUndo(prev, next);
  }

  function applyUndo(): void {
    if (!stateManager.applyUndo()) return;
    autocompleteDismissed = false;
    render();
  }

  function stepPromptHistory(direction: -1 | 1): boolean {
    return stateManager.stepPromptHistory(promptHistory, direction);
  }

  function exportCurrentTranscript(requestedName?: string): void {
    const sid = stateManager.activeSessionId;
    const conv = stateManager.getConversation();
    const meta = {
      title: sid ? sessionTitle(sid) : undefined,
      sessionId: sid || undefined,
    };
    const isJson = requestedName?.trim().toLowerCase().endsWith('.json') ?? false;
    const payload = isJson
      ? formatTranscriptJson(conv.entries, options.cwd, meta)
      : formatTranscriptMarkdown(conv.entries, options.cwd, meta);
    void writeTranscriptExport(options.cwd, payload, requestedName).then(rel => {
      if (!quitting) showToast('Exported transcript', rel);
    }).catch(error => {
      if (!quitting) {
        stateManager.getConversation().notice(error instanceof Error ? error.message : String(error), true);
        render();
      }
    });
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
    renderController?.updatePreferences({ maxFps: userPrefs.maxFps, motion: userPrefs.motion });
    render();
    void prefsStore.update(patch).catch(error => {
      if (!quitting) showToast('Could not save preferences', error instanceof Error ? error.message : String(error));
    });
  }

  function resetPrefs(): void {
    userPrefs = { ...DEFAULT_PREFS };
    renderController?.updatePreferences({ maxFps: userPrefs.maxFps, motion: userPrefs.motion });
    render();
    void prefsStore.reset().then(() => {
      if (!quitting) showToast('Local UI preferences reset');
    }).catch(error => {
      if (!quitting) showToast('Could not reset preferences', error instanceof Error ? error.message : String(error));
    });
  }

  function checkUpdatesManually(): void {
    if (quitting || updateStatus?.checking) return;
    updateStatus = { checking: true };
    render();
    void import('./updater')
      .then(async m => {
        const latestTag = await m.resolveLatestTag({ signal: AbortSignal.timeout(5_000) });
        const updateAvailable = m.compareSemver(latestTag, m.CURRENT_VERSION) > 0;
        if (quitting) return;
        updateStatus = { checking: false, latestTag, updateAvailable };
        showToast(
          updateAvailable ? `Update available: ${latestTag}` : `Up to date (v${m.CURRENT_VERSION})`,
          updateAvailable ? 'Run `agy-tern update` in your terminal to upgrade' : undefined,
        );
        render();
      })
      .catch(error => {
        if (quitting) return;
        const message = error instanceof Error ? error.message : String(error);
        updateStatus = { checking: false, error: message };
        showToast('Update check failed', message);
        render();
      });
  }

  function clearPermissions(): void {
    for (const permission of permissions.splice(0)) permission.answer(null);
    approvalChoice = 0;
  }

  function clearElicitations(): void {
    for (const req of elicitations.splice(0)) req.answer(null);
    if (panel?.kind === 'followup' && panel.source === 'elicitation') {
      panel = undefined;
      followUpState = undefined;
    }
  }

  function openUsageModal(): void {
    if (permissionOrAuthBlocked()) return;
    openPanel({ kind: 'report', report: 'usage' });
  }

  function permissionOrAuthBlocked(): boolean {
    return quitting || authBusy || permissions.length > 0;
  }

  function activateNextElicitation(): void {
    const next = elicitations[0];
    if (!next) {
      if (panel?.kind === 'followup' && panel.source === 'elicitation') {
        followUpState = undefined;
        closePanel();
      }
      return;
    }
    const parsed = parseElicitationRequest(next.request);
    if (parsed.mode === 'url') {
      followUpState = undefined;
      openPanel({
        kind: 'followup',
        source: 'elicitation',
        title: parsed.title,
        message: parsed.message,
        urlMode: { elicitationId: parsed.elicitationId, url: parsed.url },
      });
      return;
    }
    if (parsed.mode === 'unsupported') {
      elicitations.shift();
      next.answer({ action: 'decline' });
      activateNextElicitation();
      return;
    }
    followUpState = createFollowUpSessionState(parsed.title, parsed.message, parsed.fields);
    openPanel({
      kind: 'followup',
      source: 'elicitation',
      title: parsed.title,
      message: parsed.message,
    });
  }

  function openFollowUpModal(title: string, message: string, fields: readonly QuestionField[]): void {
    if (permissionOrAuthBlocked() || elicitations.length > 0) return;
    followUpState = createFollowUpSessionState(title, message, fields);
    openPanel({ kind: 'followup', source: 'prompt', title, message });
  }

  function submitFollowUp(): void {
    if (panel?.kind !== 'followup') return;
    if (panel.source === 'elicitation') {
      const active = elicitations[0];
      if (!active) { closePanel(); return; }
      if (panel.urlMode) {
        elicitations.shift();
        active.answer({ action: 'accept' });
        activateNextElicitation();
        render();
        return;
      }
      if (!followUpState) return;
      const checked = validateElicitationAnswers(followUpState.fields, followUpState);
      if (!checked.ok) {
        followUpState.error = checked.error;
        followUpState.activeFieldIdx = checked.fieldIndex;
        render();
        return;
      }
      elicitations.shift();
      followUpState = undefined;
      active.answer({ action: 'accept', content: checked.content });
      activateNextElicitation();
      render();
      return;
    }
    if (!followUpState) { closePanel(); return; }
    const reply = formatFollowUpPromptReply(followUpState);
    if (!reply) {
      followUpState.error = 'Select an option or enter an answer before sending.';
      render();
      return;
    }
    followUpState = undefined;
    closePanel();
    if (!busy && agent && !disconnected) {
      submitPrompt(reply);
    } else if (busy) {
      stateManager.enqueuePrompt({ text: reply, files: [], dirs: [], images: [] });
      showToast('Queued follow-up reply');
      render();
    } else {
      stateManager.getActive().draft = { text: reply, cursor: reply.length };
      render();
    }
  }

  function declineFollowUp(): void {
    if (panel?.kind !== 'followup' || panel.source !== 'elicitation') {
      cancelFollowUp();
      return;
    }
    const active = elicitations.shift();
    followUpState = undefined;
    active?.answer({ action: 'decline' });
    activateNextElicitation();
    render();
  }

  function cancelFollowUp(): void {
    if (panel?.kind !== 'followup') return;
    if (panel.source === 'elicitation') {
      const active = elicitations.shift();
      followUpState = undefined;
      active?.answer({ action: 'cancel' });
      activateNextElicitation();
      render();
      return;
    }
    followUpState = undefined;
    closePanel();
  }

  function quit(): void {
    outcome = { kind: 'quit' };
    if (quitting) return;
    quitting = true;
    clearTimeout(toastTimer);
    toastTimer = undefined;
    replayCoordinator.dispose();
    renderController?.dispose();
    pathPresenceCache.clear();
    reportAbort?.abort();
    extAbort?.abort();
    clearPermissions();
    clearElicitations();
    controller.abort();
    stopped.resolve(null);
  }

  function clearReplayState(): void {
    replayCoordinator.disarmLateReplay();
    replayPlaceholderId = undefined;
  }

  function storeForSessionCwd(rowCwd?: string): TranscriptStore {
    if (!rowCwd || rowCwd === options.cwd) return transcriptStore;
    let store = externalTranscriptStores.get(rowCwd);
    if (!store) {
      store = new TranscriptStore(rowCwd);
      externalTranscriptStores.set(rowCwd, store);
    }
    return store;
  }

  function warmSessionSearchIndex(rows: readonly SessionInfo[]): void {
    const missing = rows.filter(row => row.sessionId && !sessionPreviewCache.has(row.sessionId));
    if (!missing.length || quitting) {
      sessionIndexing = undefined;
      return;
    }
    const token = ++sessionSearchToken;
    const total = missing.length;
    let done = 0;
    sessionIndexing = { done, total };
    void (async () => {
      const [knownBrainIds, knownCacheFiles] = await Promise.all([
        listAvailableBrainSessionIds(),
        transcriptStore.listCachedFiles(),
      ]);
      if (quitting || token !== sessionSearchToken) return;
      const activeSid = stateManager.activeSessionId;
      if (activeSid) {
        const activeConv = stateManager.getConversation();
        if (activeConv.entries.length && !sessionPreviewCache.has(activeSid)) {
          sessionPreviewCache.set(activeSid, buildSessionPreviewFromEntries(activeConv.entries, 'cache', false));
        }
      }
      let cursor = 0;
      const workerCount = Math.min(6, missing.length);
      const runWorker = async (): Promise<void> => {
        while (cursor < missing.length && !quitting && token === sessionSearchToken) {
          const row = missing[cursor++]!;
          const sid = row.sessionId;
          if (!sessionPreviewCache.has(sid)) {
            const store = storeForSessionCwd(row.cwd);
            const isLocalStore = store === transcriptStore;
            const preview = await readSessionPreview(sid, store, {
              maxReadBytes: 96_000,
              maxEntries: 30,
              ...(isLocalStore ? { knownCacheFiles } : {}),
              knownBrainIds,
            }).catch(() => undefined);
            sessionPreviewCache.set(sid, preview ?? null);
          }
          done++;
          sessionIndexing = { done, total };
          if (done % 12 === 0 && !quitting && panel?.kind === 'sessions') scheduleRender();
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    })().catch(() => {}).finally(() => {
      if (token !== sessionSearchToken) return;
      sessionIndexing = undefined;
      if (!quitting && panel?.kind === 'sessions') scheduleRender();
    });
  }

  function requestSessionPreview(id: string): void {
    if (!id || sessionPreviewCache.has(id) || sessionPreviewInFlight.has(id) || quitting) return;
    if (id === stateManager.activeSessionId) {
      const activeConv = stateManager.getConversation();
      if (activeConv.entries.length) {
        sessionPreviewCache.set(id, buildSessionPreviewFromEntries(activeConv.entries, 'cache', false));
        if (!quitting && panel?.kind === 'sessions') scheduleRender();
        return;
      }
    }
    sessionPreviewInFlight.add(id);
    const store = storeForSessionCwd(sessionInfo.get(id)?.cwd);
    void readSessionPreview(id, store).then(preview => {
      sessionPreviewInFlight.delete(id);
      sessionPreviewCache.set(id, preview ?? null);
      if (!quitting && panel?.kind === 'sessions') scheduleRender();
    }).catch(() => {
      sessionPreviewInFlight.delete(id);
      sessionPreviewCache.set(id, null);
    });
  }

  function jumpUserTurn(direction: -1 | 1): void {
    const st = stateManager.getActive();
    const conv = stateManager.getConversation();
    const userEntries = conv.entries.filter(
      (entry): entry is Extract<TranscriptEntry, { type: 'message' }> => entry.type === 'message' && entry.role === 'user',
    );
    if (!userEntries.length || !surface) return;
    let nextIdx: number;
    if (st.focusedTurnIndex === undefined) {
      nextIdx = direction === -1 ? userEntries.length - 1 : userEntries.length;
    } else {
      nextIdx = st.focusedTurnIndex + direction;
    }
    if (nextIdx >= userEntries.length) {
      st.focusedTurnIndex = undefined;
      surface.scroll('main.conversation', 'end');
      showToast('Jumped to latest');
      return;
    }
    nextIdx = Math.max(0, nextIdx);
    st.focusedTurnIndex = nextIdx;
    const target = userEntries[nextIdx]!;
    const globalIdx = conv.entries.indexOf(target);
    if (globalIdx >= 0) {
      const needed = conv.entries.length - globalIdx;
      if (needed > st.historyVisibleCount) {
        st.historyVisibleCount = needed + 20;
        render();
      }
    }
    surface.reveal(`main.conversation.${target.id}`, 'start');
    showToast(`Turn ${nextIdx + 1}/${userEntries.length}`);
  }

  async function loadDeeperBrainHistory(): Promise<void> {
    const targetId = stateManager.activeSessionId;
    if (!targetId || quitting || busy) return;
    const brain = await readOfficialBrainTranscript(targetId, { maxEntries: 400, maxReadBytes: 8_000_000 });
    if (quitting || stateManager.activeSessionId !== targetId) return;
    if (!brain || !brain.entries.length) {
      showToast('No older brain log entries found');
      return;
    }
    const conv = stateManager.getConversation();
    conv.restoreEntries([
      ...brain.entries,
      {
        type: 'notice',
        id: `history-restored-${Date.now()}`,
        text: brain.truncated
          ? `Showing latest ${brain.entries.length} entries from official session log.`
          : `Loaded full ${brain.entries.length} entries from official session log.`,
        error: false,
      },
    ]);
    const st = stateManager.getActive();
    st.historyVisibleCount = Math.max(st.historyVisibleCount, brain.entries.length + 10);
    render();
    showToast(`Loaded ${brain.entries.length} history entries`);
  }

  function persistActiveTranscript(): Promise<void> {
    const sid = stateManager.activeSessionId;
    const conv = stateManager.getConversation();
    if (!sid || !conv.entries.some(entry => entry.type === 'message')) {
      return Promise.resolve();
    }
    sessionPreviewCache.delete(sid);
    return transcriptStore.save(sid, conv.entries).catch(() => {});
  }

  async function hydrateSessionHistoryFallback(
    token: number,
    targetSessionId: string,
    fallback: Conversation | undefined,
    mode: 'load' | 'resume',
  ): Promise<void> {
    const currentConv = stateManager.getConversation();
    if (quitting || stateManager.activeSessionId !== targetSessionId || hasRichConversationHistory(currentConv)) return;
    if (fallback && hasRichConversationHistory(fallback)) {
      stateManager.replaceActiveConversation(fallback);
      render();
      return;
    }
    const [cache, brain] = await Promise.all([
      transcriptStore.load(targetSessionId),
      readOfficialBrainTranscript(targetSessionId),
    ]);
    if (quitting || stateManager.activeSessionId !== targetSessionId || replayCoordinator.currentToken !== token) return;
    const liveConv = stateManager.getConversation();
    if (hasRichConversationHistory(liveConv)) return;
    const disk = selectRicherTranscript(cache, brain);
    const preNoticeEntryCount = liveConv.entries.filter(entry => entry.type !== 'notice').length;
    const hadDiskEntries = Boolean(disk && disk.entries.length > preNoticeEntryCount);
    if (hadDiskEntries && disk) {
      liveConv.restoreEntries([
        ...disk.entries,
        {
          type: 'notice',
          id: `history-restored-${Date.now()}`,
          text: disk.truncated
            ? `Showing latest ${disk.entries.length} entries from local session history.`
            : 'Restored conversation history from local session log.',
          error: false,
          ...(disk.truncated ? { action: 'load_deeper_history' as const } : {}),
        },
      ]);
    } else if (!preNoticeEntryCount) {
      liveConv.notice(mode === 'resume'
        ? 'Resumed active ACP session context without replaying earlier history. Send a message to continue.'
        : 'Antigravity loaded this session context without replaying earlier history. Send a message to continue.');
    } else {
      liveConv.notice('Antigravity replayed partial user history; backend session context is active.');
    }
    replayCoordinator.enterFallbackWatching(token, {
      hadDiskEntries,
      preNoticeEntryCount,
      onLateRichReplay: entries => {
        if (quitting || stateManager.activeSessionId !== targetSessionId) return;
        stateManager.getConversation().restoreEntries(entries);
        render();
        if (!panel) surface?.scroll('main.conversation', 'end');
      },
    });
  }

  function settleHistoryReplay(
    token: number,
    targetSessionId: string,
    fallback: Conversation | undefined,
    mode: 'load' | 'resume',
  ): void {
    replayCoordinator.markRpcResolved(token, (info: ReplaySettledInfo) => {
      void (async () => {
        if (quitting || stateManager.activeSessionId !== targetSessionId) return;
        const placeholderId = replayPlaceholderId;
        replayPlaceholderId = undefined;
        if (placeholderId) stateManager.getConversation().removeNotice(placeholderId);
        await hydrateSessionHistoryFallback(info.token, info.sessionId, fallback, mode);
        if (quitting || stateManager.activeSessionId !== targetSessionId) return;
        if (!busy && !sessionOperation && !disconnected && !agentConnecting) phase = 'Ready';
        render();
        if (!panel) surface?.scroll('main.conversation', 'end');
      })();
    });
  }

  function beginHistoryReplay(targetSessionId: string, mode: 'load' | 'resume'): number {
    replayPlaceholderId = undefined;
    return replayCoordinator.begin(targetSessionId, mode);
  }

  function scheduleRender(): void {
    if (quitting || !renderController) return;
    renderController.scheduleRender(busy, render);
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
    const step = stateManager.getConversation().getTool(permission.request.toolCall.toolCallId);
    if (step) step.approved = option?.kind === 'allow_once' ? 'once' : 'denied';
    permission.answer(optionId);
    render();
  }

  function stop(): void {
    if (!agent || !busy || cancelling) return;
    cancelling = true;
    phase = 'Cancelling';
    clearPermissions();
    clearElicitations();
    render();
    void agent.cancel().catch(error => {
      if (quitting) return;
      cancelling = false;
      phase = 'Cancellation failed';
      stateManager.getConversation().notice(error instanceof Error ? error.message : String(error), true);
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

  function openInspectFile(rawPath: string, line?: number): void {
    if (permissions.length || quitting || !rawPath) return;
    const abs = resolve(options.cwd, rawPath);
    const label = formatPathLabel(abs, options.cwd);
    const subtitle = line ? `${label}:${line}` : label;
    try {
      const info = statSync(abs);
      if (info.isDirectory()) {
        void listDirectoryEntriesPreview(options.cwd, abs).then(pv => {
          if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
        }).catch(err => {
          if (!quitting) showToast('Cannot inspect directory', err instanceof Error ? err.message : label);
        });
        return;
      }
    } catch {
      // Fall through to readWorkspaceTextPreview so any clean error surface shows via toast.
    }
    if (imageMimeType(abs)) {
      openInspect(basename(label), { type: 'image-path', path: abs }, subtitle);
      return;
    }
    void readWorkspaceTextPreview(options.cwd, abs).then(pv => {
      if (!quitting) openInspect(basename(label), { type: 'file', path: pv.path, content: pv.text, truncated: pv.truncated }, subtitle);
    }).catch(err => {
      if (!quitting) showToast('Cannot open file', err instanceof Error ? err.message : label);
    });
  }

  function parentPanel(current: Panel): Panel | undefined {
    if (current.kind === 'inspect') return inspectReturnPanel;
    if (current.kind === 'confirm') return current.returnTo;
    if (current.kind === 'template-save') return { kind: 'templates' };
    if (current.kind === 'mcp-add') return { kind: 'mcp' };
    if (current.kind === 'plugin-install') return { kind: 'plugins' };
    if (current.kind === 'account-switch') return { kind: 'account' };
    if ((current.kind === 'permissions' || current.kind === 'account' || current.kind === 'config') && settingsChildPanel) {
      return { kind: 'settings' };
    }
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
    settingsChildPanel = false;
    prefsFocus = undefined;
    panel = undefined;
    panelError = '';
    sessionSearchToken++;
    sessionIndexing = undefined;
    gitDiffCache.clear();
    cachedDiffsConversation = undefined;
    cachedSessionDiffs = [];
    autocompleteDismissed = true;
    render();
    surface?.focus(DOCK_DRAFT_ID);
  }

  function stepBackPanel(): void {
    if (authBusy || !panel) return;
    if (panel.kind === 'followup') {
      cancelFollowUp();
      return;
    }
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
      const handoffSessionId = stateManager.activeSessionId || undefined;
      if (changeAccount) await connected?.logout();
      if (quitting) return;
      quit();
      outcome = { kind: 'login', method, draft: stateManager.getActive().draft, ...(handoffSessionId ? { previousSessionId: handoffSessionId } : {}) };
    })().catch(error => {
      if (!quitting) panelError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      authBusy = false;
      render();
    });
  }

  function runSessionAction(label: string, action: (connected: AgentSession) => Promise<void>): void {
    if (!agent || busy || changingConfig || sessionOperation || authBusy || disconnected || permissions.length || quitting) return;
    configSyncToken++;
    sessionOperation = label;
    panelError = '';
    render();
    const active = agent;
    sessionTask = (async () => {
      await configSyncPromise.catch(() => {});
      if (quitting) return;
      await action(active);
    })().catch(error => {
      if (quitting) return;
      const message = error instanceof Error ? error.message : String(error);
      if (panel?.kind === 'sessions' || panel?.kind === 'rename') panelError = message;
      else stateManager.getConversation().notice(message, true);
      phase = 'Session action failed';
    }).finally(() => {
      sessionOperation = undefined;
      render();
    });
  }

  function loadSessions(append = false, silent = false, allWorkspaces = false): void {
    const active = agent;
    if (!active?.capabilities.listSessions || disconnected || quitting) return;
    const inFlight = allWorkspaces ? allSessionsPrefetchInFlight : sessionsPrefetchInFlight;
    if (inFlight && !append) {
      if (!silent) {
        if (allWorkspaces) allSessionsLoading = true;
        else sessionsLoading = true;
        panelError = '';
        render();
      }
      return;
    }
    if (allWorkspaces) allSessionsLoading = true;
    else sessionsLoading = true;
    if (!silent) { panelError = ''; render(); }
    const task = (async () => {
      let cursor = append ? (allWorkspaces ? allNextSessionsCursor : nextSessionsCursor) : undefined;
      const rows = new Map((append ? (allWorkspaces ? allListedSessions : listedSessions) : []).map(row => [row.sessionId, row]));
      const maxPages = append ? 1 : 5;
      for (let page = 0; page < maxPages; page++) {
        const response = await active.listSessions(cursor, allWorkspaces ? { allWorkspaces: true } : undefined);
        if (quitting) return;
        for (const row of response.sessions) {
          rows.set(row.sessionId, row);
          sessionInfo.set(row.sessionId, row);
        }
        const merged = [...rows.values()];
        cursor = response.nextCursor ?? undefined;
        if (allWorkspaces) {
          allListedSessions = merged;
          allNextSessionsCursor = cursor;
          allSessionsLoadedAt = Date.now();
        } else {
          listedSessions = merged;
          nextSessionsCursor = cursor;
          sessionsLoadedAt = Date.now();
        }
        if (page === 0 && !append) panelSelection = 0;
        if (!quitting && panel?.kind === 'sessions') render();
        const missingNameIds = response.sessions
          .map(row => row.sessionId)
          .filter(id => !localNames.has(id));
        if (missingNameIds.length) {
          const foundNames = await names.getMany(missingNameIds);
          let changed = false;
          for (const [sid, found] of foundNames) {
            if (found) changed = true;
            localNames.set(sid, found);
          }
          if (changed && !quitting && panel?.kind === 'sessions') scheduleRender();
        }
        if (!cursor) break;
      }
      if (!quitting && panel?.kind === 'sessions') {
        warmSessionSearchIndex(allWorkspaces ? allListedSessions : listedSessions);
      }
    })().catch(error => {
      if (!quitting && !silent) {
        panelError = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      if (allWorkspaces) {
        if (allSessionsPrefetchInFlight === task) allSessionsPrefetchInFlight = undefined;
        allSessionsLoading = false;
      } else {
        if (sessionsPrefetchInFlight === task) sessionsPrefetchInFlight = undefined;
        sessionsLoading = false;
      }
      if (!quitting) render();
    });
    if (!append) {
      if (allWorkspaces) allSessionsPrefetchInFlight = task;
      else sessionsPrefetchInFlight = task;
    }
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
    workspaceEntriesVersion++;
    prefixSearchCache.clear();
    cachedAtKey = '';
    ignoredPathsSet = new Set(entries.filter(item => item.ignored).map(item => item.path));
  }

  function refreshWorkspaceFiles(): void {
    lastWorkspaceIndexAt = Date.now();
    void listWorkspaceEntries(options.cwd, 2_400, options.additionalDirectories).then(entries => {
      if (!quitting) { setWorkspaceEntries(entries); render(); }
    }).catch(() => {});
  }

  function startupStageLabel(stage: ConnectionStage | undefined): string {
    switch (stage) {
      case 'spawning': return 'Starting agy process (1/4)';
      case 'initializing': return 'Checking ACP & account auth (2/4)';
      case 'opening_session': return 'Opening workspace session (3/4)';
      case 'syncing_config': return 'Syncing model & mode (4/4)';
      default: return phase || 'Connecting to Antigravity';
    }
  }

  function startConfigSync(
    connected: AgentSession,
    allowExplicitWarnings: boolean,
    applyDefaults = true,
  ): Promise<void> {
    const token = ++configSyncToken;
    const sessionId = connected.sessionId;
    startupSyncingConfig = true;
    connectionStage = 'syncing_config';
    if (!busy && !sessionOperation && !disconnected) scheduleRender();
    const task = applyPreferredConfigOptions(
      connected,
      allowExplicitWarnings,
      applyDefaults,
      () => quitting || token !== configSyncToken || connected.sessionId !== sessionId,
    ).catch(() => {}).finally(() => {
      if (!quitting && token === configSyncToken) {
        startupSyncingConfig = false;
        if (connectionStage === 'syncing_config') connectionStage = undefined;
        scheduleRender();
      }
    });
    configSyncPromise = task;
    return task;
  }

  async function applyPreferredConfigOptions(
    connected: AgentSession,
    allowExplicitWarnings: boolean,
    applyDefaults = true,
    shouldCancel?: () => boolean,
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
      if (quitting || shouldCancel?.()) break;
      if (!item.opt) {
        if (item.explicit && allowExplicitWarnings) {
          stateManager.getConversation().notice(`Requested --${item.label.replace(' level', '')} "${item.wanted}", but this ACP session did not advertise that option.`);
        }
        continue;
      }
      const matched = configValues(item.opt).find(val =>
        val.value === item.wanted || val.name.toLowerCase() === item.wanted.toLowerCase());
      if (!matched) {
        if (item.explicit && allowExplicitWarnings) {
          stateManager.getConversation().notice(`Requested --${item.label.replace(' level', '')} "${item.wanted}" was not among session options.`, true);
        }
        continue;
      }
      if (item.opt.currentValue === matched.value) continue;
      try {
        await connected.setConfigOption(item.opt.id, matched.value);
        metadata = connected.metadata;
      } catch (err) {
        if (item.explicit && allowExplicitWarnings) {
          stateManager.getConversation().notice(`Failed to apply --${item.label.replace(' level', '')}: ${err instanceof Error ? err.message : String(err)}`, true);
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
        surface?.focus(DOCK_DRAFT_ID);
        void runCommandInTernSplit(options.cwd, trimmed).then(result => {
          if (quitting) return;
          if (result.ok) showToast('Running in Tern split', preview.slice(0, 48));
          else showToast('Could not run in Tern split', result.error ?? 'Unknown error');
        });
      },
    });
  }

  function openConversation(id: string, requestedMode?: 'load' | 'resume'): void {
    if (id === stateManager.activeSessionId) { closePanel(); return; }
    const cached = stateManager.getCachedConversation(id);
    const mode: 'load' | 'resume' = requestedMode ?? (cached && hasRichConversationHistory(cached) && agent?.capabilities.resumeSession ? 'resume' : 'load');
    runSessionAction(mode === 'resume' ? 'Resuming conversation' : 'Opening conversation', async connected => {
      await persistActiveTranscript();
      const token = beginHistoryReplay(id, mode);
      try {
        if (mode === 'resume' && connected.resumeSession) await connected.resumeSession(id);
        else await connected.loadSession(id);
      } catch (err) {
        clearReplayState();
        throw err;
      }
      settleHistoryReplay(token, id, cached, mode);
      void startConfigSync(connected, false, true);
      phase = replayCoordinator.isReplaying ? 'Syncing history' : 'Ready';
      closePanel();
      surface?.scroll('main.conversation', 'end');
    });
  }

  function closeSavedSession(id: string): void {
    runSessionAction('Closing session', async connected => {
      if (!connected.closeSession) throw new Error('Antigravity ACP does not support closing sessions.');
      await connected.closeSession(id);
      stateManager.deleteSession(id);
      listedSessions = listedSessions.filter(row => row.sessionId !== id);
      pickerSelected = listedSessions[0]?.sessionId ?? '';
      showToast('Session closed on agy', sessionTitle(id));
      render();
    });
  }

  function newConversation(): void {
    runSessionAction('Starting conversation', async connected => {
      await persistActiveTranscript();
      clearReplayState();
      await connected.newSession();
      void startConfigSync(connected, false);
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
    const prevPanel = panel;
    if (next.kind === 'settings') {
      settingsChildPanel = false;
    } else if (prevPanel?.kind === 'settings' &&
      (next.kind === 'permissions' || next.kind === 'account' || next.kind === 'config')) {
      settingsChildPanel = true;
    } else if (!(settingsChildPanel && (next.kind === 'account-switch' || next.kind === 'account'))) {
      settingsChildPanel = false;
    }
    panel = next;
    const name = next.kind === 'rename' ? localNames.get(next.sessionId) ?? sessionInfo.get(next.sessionId)?.title ?? '' : '';
    panelDraft = { text: name, cursor: name.length };
    panelSelection = 0;
    panelError = '';
    pickerTab = 'all';
    pickerSelected = '';
    if (next.kind === 'report') usageTab = 'overview';
    if (next.kind === 'changes') pickerTab = 'edits';
    if (next.kind === 'sessions') pickerTab = 'workspace';
    if (next.kind !== 'inspect') inspectReturnPanel = undefined;
    if (next.kind === 'config') {
      const option = metadata.configOptions.find(candidate => candidate.id === next.id);
      if (option && option.type === 'select') pickerSelected = option.currentValue;
    }
    if (next.kind === 'sessions') pickerSelected = stateManager.activeSessionId;
    autocompleteDismissed = true;
    render();
    const needsCustomFocus = next.kind === 'rename' || next.kind === 'template-save' ||
      next.kind === 'mcp-add' || next.kind === 'plugin-install' ||
      (next.kind === 'config' && metadata.configOptions.find(candidate => candidate.id === next.id)?.type === 'boolean');
    const isPickerPanel = next.kind === 'commands' || next.kind === 'config' || next.kind === 'sessions' ||
      next.kind === 'changes' || next.kind === 'find' || next.kind === 'tasks' || next.kind === 'mcp' || next.kind === 'plugins' ||
      next.kind === 'agents' || next.kind === 'templates';
    const firstFollowUpField = next.kind === 'followup' ? followUpState?.fields[0] : undefined;
    const followUpFocus = next.kind === 'followup' && firstFollowUpField &&
      (firstFollowUpField.kind === 'text' || firstFollowUpField.kind === 'number' || firstFollowUpField.kind === 'integer')
      ? `layer.panel.overlay-scroll.input-${firstFollowUpField.name}`
      : null;
    const targetFocus = next.kind === 'settings' ? 'layer.prefs'
      : isPickerPanel && !needsCustomFocus ? 'layer.picker'
      : needsCustomFocus ? 'layer.panel.query'
      : followUpFocus;
    surface?.focus(targetFocus);
    if (next.kind === 'report') loadReport(next.report);
    if (next.kind === 'mcp' || next.kind === 'plugins' || next.kind === 'agents') loadExtensions(next.kind);
    if (next.kind === 'templates') loadTemplates();
    if (next.kind === 'sessions' && agent?.capabilities.listSessions) {
      if (sessionsPrefetchInFlight) {
        sessionsLoading = true;
        render();
      } else if (!listedSessions.length || Date.now() - sessionsLoadedAt >= 3_000) {
        loadSessions(false, false, false);
      } else {
        warmSessionSearchIndex(listedSessions);
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
    configSyncToken++;
    changingConfig = true;
    panelError = '';
    render();
    const active = agent;
    configTask = configSyncPromise.catch(() => {}).then(() => {
      if (quitting) return;
      return active.setConfigOption(option.id, value);
    }).then(() => {
      if (!quitting && userPrefs.rememberModel && typeof value === 'string') {
        if (option.category === 'model' || option.id === 'model') updatePrefs({ lastModel: value });
        else if (option.category === 'thought_level' || option.id === 'thought_level') updatePrefs({ lastThinking: value });
      }
      if (!quitting && panel?.kind !== 'settings') stepBackPanel();
      else if (!quitting) showToast(`${option.name} updated`);
    }).catch(error => {
      panelError = error instanceof Error ? error.message : String(error);
      if (panel?.kind === 'settings') showToast(`Could not update ${option.name}`, panelError);
    }).finally(() => {
      changingConfig = false;
      render();
    });
  }

  function attachClipboardImage(): void {
    if (quitting || authBusy || permissions.length) return;
    if (agent && !agent.promptCapabilities?.image) {
      showToast('Images not supported', 'This ACP agent did not advertise image prompt support');
      return;
    }
    void readClipboardImage().then(loaded => {
      if (quitting) return;
      const st = stateManager.getActive();
      if (!st.attachedImages.some(item => item.path === loaded.path)) {
        st.attachedImages = [...st.attachedImages, loaded];
      }
      showToast('Attached clipboard image', `${loaded.mimeType} (${Math.max(1, Math.round(loaded.size / 1024))} KB)`);
      render();
      surface?.focus(DOCK_DRAFT_ID);
    }).catch(error => {
      if (!quitting) showToast('Clipboard image unavailable', error instanceof Error ? error.message : String(error));
    });
  }

  function chooseCommand(command: Command, args = '', completeOnly = false): void {
    if (permissions.length || authBusy || quitting) return;
    const st = stateManager.getActive();
    if (completeOnly || (!command.local && command.hint && !args)) {
      st.draft = { text: `/${command.name} ${args}`, cursor: command.name.length + 2 + args.length };
      closePanel();
      return;
    }
    if (command.local) {
      if (args && command.local !== 'model' && command.local !== 'sessions' && command.local !== 'rename' &&
        command.local !== 'export' && command.local !== 'find' && command.local !== 'templates') {
        stateManager.getConversation().notice(`/${command.name} does not take arguments in this frontend.`, true);
        render();
        return;
      }
      if (st.draft.text.startsWith('/')) stateManager.resetDraft();
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
        case 'paste-image': closePanel(); attachClipboardImage(); return;
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
          for (const entry of stateManager.getConversation().entries) {
            if (entry.type === 'thought') st.thoughtFoldOverrides.set(entry.id, expand);
            else if (entry.type === 'tool') st.toolFoldOverrides.set(entry.id, !expand);
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
          openPanel({ kind: 'rename', sessionId: stateManager.activeSessionId });
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
    stateManager.resetDraft();
    submitPrompt(`/${command.name}${args ? ` ${args}` : ''}`);
  }

  function submitPrompt(
    text: string,
    images: readonly LoadedImageAttachment[] = [],
    attachedFilePaths: readonly string[] = [],
    attachedDirPaths: readonly string[] = [],
  ): void {
    if (!agent || busy || changingConfig || sessionOperation || authBusy || disconnected || permissions.length) return;
    replayCoordinator.disarmLateReplay();
    stateManager.setRetryPayload(text, images, attachedFilePaths, attachedDirPaths);
    const activeConv = stateManager.getConversation();
    busy = true;
    stateManager.getActive().focusedTurnIndex = undefined;
    turnStartedAt = Date.now();
    cancelling = false;
    autocompleteDismissed = true;
    phase = 'Working';
    const transcriptText = images.length
      ? `${images.map(image => `[Image: ${image.path}]`).join(' ')}${text ? `\n\n${text}` : ''}`
      : text;
    activeConv.startPrompt(transcriptText, clockTime());
    render();
    surface?.scroll('main.conversation', 'end');
    const activeAgent = agent;
    const promptBody = text || 'Inspect the attached image.';
    let completedNormally = false;
    const entryCountBeforePrompt = activeConv.entries.length;
    turn = (async () => {
      const resources: ResourceAttachment[] = [];
      await configSyncPromise.catch(() => {});
      if (quitting || disconnected) return;
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
      activeConv.notice(error instanceof Error ? error.message : String(error), true, true);
    }).finally(() => {
      const elapsed = turnStartedAt ? Date.now() - turnStartedAt : 0;
      activeConv.finishTurn(Date.now(), !completedNormally);
      if (activeConv === stateManager.getConversation()) {
        void persistActiveTranscript();
      }
      busy = false;
      turnStartedAt = undefined;
      cancelling = false;
      clearPermissions();
      if (!quitting && userPrefs.notifyOnTurnComplete && elapsed >= 8_000) {
        sendTerminalAttention('agy-tern', completedNormally ? 'Turn complete' : phase);
      }
      const touchedWorkspace = activeConv.entries.slice(entryCountBeforePrompt).some(entry =>
        entry.type === 'tool' && (entry.call.kind === 'edit' || entry.call.kind === 'execute' ||
          entry.call.content?.some(item => item.type === 'diff')));
      if (!quitting && !disconnected && (touchedWorkspace || Date.now() - lastWorkspaceIndexAt > 30_000)) {
        refreshWorkspaceFiles();
      }
      const currentState = stateManager.getActive();
      if (completedNormally && !quitting && !disconnected && !permissions.length && currentState.queuedPrompts.length > 0) {
        const next = stateManager.drainNextQueued();
        if (next) {
          submitPrompt(formatPromptWithAttachments(next.text, next.files, next.dirs), next.images, next.files, next.dirs);
          return;
        }
      }
      render();
      surface?.scroll('main.conversation', 'end');
    });
  }

  function send(): void {
    if (changingConfig || sessionOperation || authBusy || permissions.length) return;
    const st = stateManager.getActive();
    if (!st.draft.text.trim() && !st.attachedFiles.length && !st.attachedDirs.length && !st.attachedImages.length) return;
    const text = st.draft.text;
    if (text.trimStart().startsWith('/') && !st.attachedFiles.length && !st.attachedDirs.length && !st.attachedImages.length) {
      const match = resolveCommand(text, availableCommands());
      if (match) {
        if (busy && !match.command.local) {
          // Non-local server slash commands wait cleanly in queue like prompts.
        } else {
          chooseCommand(match.command, match.args);
          return;
        }
      } else {
        stateManager.getConversation().notice('Command not available in this session. Use /help to see supported commands.', true);
        render();
        return;
      }
    }
    if (!agent || disconnected) return;
    const trimmedPrompt = text.trim();
    if (trimmedPrompt && promptHistory.at(-1) !== trimmedPrompt) {
      promptHistory.push(trimmedPrompt);
      if (promptHistory.length > 50) promptHistory.splice(0, promptHistory.length - 50);
      void promptHistoryStore.append(trimmedPrompt).then(merged => {
        if (!quitting && merged.length) {
          promptHistory.splice(0, promptHistory.length, ...merged);
        }
      }).catch(() => {});
    }
    const filesToSend = [...st.attachedFiles];
    const dirsToSend = [...st.attachedDirs];
    const imagesToSend = [...st.attachedImages];
    stateManager.clearPendingDraftInputs();
    if (busy) {
      stateManager.enqueuePrompt({ text, files: filesToSend, dirs: dirsToSend, images: imagesToSend });
      showToast('Queued follow-up prompt', trimmedPrompt || `${imagesToSend.length} image(s)`);
      render();
      return;
    }
    submitPrompt(formatPromptWithAttachments(text, filesToSend, dirsToSend), imagesToSend, filesToSend, dirsToSend);
  }

  function autocomplete(): Command[] {
    const query = commandQuery(stateManager.getActive().draft.text);
    const active = !panel && !autocompleteDismissed && query !== undefined && !permissions.length && !sessionOperation && !authBusy;
    if (!active || query === undefined) return [];
    const cmds = availableCommands();
    const key = `${query}|${cmds.length}|${metadata.availableCommands.length}`;
    if (key === cachedCmdKey) return cachedCmdResult;
    cachedCmdKey = key;
    cachedCmdResult = filterCommands(cmds, query);
    return cachedCmdResult;
  }

  function activeAtMention(): { start: number; end: number; query: string } | undefined {
    const currentDraft = stateManager.getActive().draft;
    if (panel || autocompleteDismissed || permissions.length || sessionOperation || authBusy) return undefined;
    if (commandQuery(currentDraft.text) !== undefined) return undefined;
    return atMentionQuery(currentDraft.text, currentDraft.cursor);
  }

  function triggerPrefixSearch(query: string): void {
    const clean = query.trim();
    if (clean.length < 2 || prefixSearchCache.has(clean) || prefixSearchInFlight.has(clean) || quitting) return;
    prefixSearchInFlight.add(clean);
    void searchWorkspacePrefix(options.cwd, clean, 120, options.additionalDirectories).then(found => {
      prefixSearchInFlight.delete(clean);
      if (prefixSearchCache.size >= 32) {
        const oldest = prefixSearchCache.keys().next().value;
        if (oldest !== undefined) prefixSearchCache.delete(oldest);
      }
      prefixSearchCache.set(clean, found);
      cachedAtKey = '';
      if (!quitting && found.length) {
        for (const item of found) {
          if (item.ignored) ignoredPathsSet.add(item.path);
        }
        scheduleRender();
      }
    }).catch(() => {
      prefixSearchInFlight.delete(clean);
      prefixSearchCache.set(clean, []);
    });
  }

  function atFileMatches(): WorkspaceEntry[] {
    const mention = activeAtMention();
    if (!mention) return [];
    const st = stateManager.getActive();
    const prefixExtra = prefixSearchCache.get(mention.query.trim()) ?? [];
    const key = `${mention.query}|${workspaceEntriesVersion}|${st.attachedFiles.join(',')}|${st.attachedDirs.join(',')}|${st.attachedImages.map(i => i.path).join(',')}|${prefixExtra.length}`;
    if (key === cachedAtKey) return cachedAtResult;

    const imagePaths = new Set(st.attachedImages.map(image => image.path));
    const combined = prefixExtra.length ? [...workspaceEntries, ...prefixExtra] : workspaceEntries;
    const seen = new Set<string>();
    const available: WorkspaceEntry[] = [];
    for (const entry of combined) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      if (entry.kind === 'dir' ? st.attachedDirs.includes(entry.path) : (st.attachedFiles.includes(entry.path) || imagePaths.has(entry.path))) {
        continue;
      }
      available.push(entry);
    }
    const matches = filterWorkspaceEntries(available, mention.query, 10);
    cachedAtKey = key;
    cachedAtResult = matches;
    if ((workspaceEntries.length >= 2_400 || (mention.query.includes('/') && matches.length < 5)) && !prefixExtra.length) {
      triggerPrefixSearch(mention.query);
    }
    return matches;
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
    const st = stateManager.getActive();
    const mention = activeAtMention();
    if (mention) st.draft = stripAtMention(st.draft, mention);
    fileSelection = 0;
    autocompleteDismissed = true;
    if (entry.kind === 'dir') {
      const dirPath = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
      if (!st.attachedDirs.includes(dirPath)) st.attachedDirs = [...st.attachedDirs, dirPath];
      render();
      surface?.focus(DOCK_DRAFT_ID);
      return;
    }
    const filePath = entry.path;
    if (imageMimeType(filePath)) {
      if (!agent?.promptCapabilities?.image) {
        render();
        showToast('Images not supported', 'This ACP agent did not advertise image prompt support');
        surface?.focus(DOCK_DRAFT_ID);
        return;
      }
      render();
      void readImageAttachment(options.cwd, filePath).then(loaded => {
        const currentSt = stateManager.getActive();
        if (!quitting && !currentSt.attachedImages.some(item => item.path === loaded.path)) {
          currentSt.attachedImages = [...currentSt.attachedImages, loaded];
        }
        render();
        surface?.focus(DOCK_DRAFT_ID);
      }).catch(error => {
        if (!quitting) showToast('Could not attach image', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (!st.attachedFiles.includes(filePath)) st.attachedFiles = [...st.attachedFiles, filePath];
    render();
    surface?.focus(DOCK_DRAFT_ID);
  }

  function removeAttachment(filePath: string): void {
    const st = stateManager.getActive();
    st.attachedFiles = st.attachedFiles.filter(item => item !== filePath);
    render();
    surface?.focus(DOCK_DRAFT_ID);
  }

  function removeDirAttachment(dirPath: string): void {
    const st = stateManager.getActive();
    st.attachedDirs = st.attachedDirs.filter(item => item !== dirPath);
    render();
    surface?.focus(DOCK_DRAFT_ID);
  }

  function removeImageAttachment(filePath: string): void {
    const st = stateManager.getActive();
    st.attachedImages = st.attachedImages.filter(item => item.path !== filePath);
    render();
    surface?.focus(DOCK_DRAFT_ID);
  }

  function panelChoices(): Choice[] {
    if (!panel || panel.kind === 'report' || panel.kind === 'changes' || panel.kind === 'find' || panel.kind === 'inspect' ||
      panel.kind === 'commands' || panel.kind === 'mcp' || panel.kind === 'plugins' || panel.kind === 'agents' ||
      panel.kind === 'templates' || panel.kind === 'sessions' || panel.kind === 'settings') return [];
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
      const trimmed = stateManager.getActive().draft.text.trim();
      return [
        { label: 'Save current draft as template',
          detail: trimmed ? `Save "${trimmed.slice(0, 48)}${trimmed.length > 48 ? '...' : ''}"` : 'Type a prompt in the composer draft first.',
          disabled: !trimmed || extLoading, choose: () => savePromptTemplate(panelDraft.text, stateManager.getActive().draft.text) },
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
    if (panel.kind === 'config') {
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

  function inspectFindMatch(match: ReturnType<typeof searchTranscript>[number]): void {
    const entry = match.entry;
    if (entry.type === 'tool') {
      const imgPath = extractToolImagePaths(entry.call, options.cwd).find(pathExists);
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

  function activeToolSteps(): ToolStep[] {
    const conv = stateManager.getConversation();
    if (cachedActiveToolsConversation === conv && cachedActiveToolsRev === conv.revision) {
      return cachedActiveTools;
    }
    cachedActiveToolsConversation = conv;
    cachedActiveToolsRev = conv.revision;
    cachedActiveTools = conv.entries.filter((entry): entry is ToolStep =>
      entry.type === 'tool' && (entry.call.status === 'in_progress' || entry.call.status === 'pending'));
    return cachedActiveTools;
  }

  function inspectTaskStep(step: ToolStep): void {
    const s = summarizeToolCall(step.call, options.cwd);
    const detailText = buildTaskDetailText(step, options.cwd);
    openInspect(s.title, { type: 'file', path: 'task.log', content: detailText }, s.target);
  }

  function renderPanel(): JSX.Element | null {
    if (!panel) return null;
    const conv = stateManager.getConversation();
    const st = stateManager.getActive();
    return renderActivePanel({
      panel,
      options,
      workspaceName,
      rLayout: currentResponsiveLayout(),
      agent,
      metadata,
      authentication,
      authenticationKnown,
      disconnected,
      agentConnecting,
      authBusy,
      busy,
      cancelling,
      changingConfig,
      extLoading,
      reportLoading,
      reportText,
      sessionsLoading,
      allSessionsLoading,
      sessionOperation,
      activeSessionId: stateManager.activeSessionId,
      previousSessionId,
      listedSessions,
      allListedSessions,
      nextSessionsCursor,
      allNextSessionsCursor,
      sessionInfo,
      localNames,
      sessionPreviews: sessionPreviewCache,
      sessionIndexing,
      mcpServers,
      pluginsList,
      agentsList,
      templatesList,
      gitChanges,
      gitDiffCache,
      entries: conv.entries,
      entriesRevision: conv.revision,
      draftText: st.draft.text,
      panelDraft,
      panelSelection,
      pickerTab,
      pickerSelected,
      prefsPage,
      prefsFocus,
      updateStatus,
      usageTab,
      panelError,
      userPrefs,
      commands: availableCommands(),
      sessionDiffs: panel.kind === 'changes' ? getSessionDiffs() : [],
      choices: panelChoices(),
      loginMethod: loginMethod(),
      modeOption: modeOption(),
      sessionTitle,
      pathExists,
      blobForImage,
      onRender: render,
      onFocus: target => surface?.focus(target === 'dock.draft' ? DOCK_DRAFT_ID : target),
      onEditPanelDraft: (event: EditEvent) => {
        panelDraft = editDraft(panelDraft, event);
        panelSelection = 0;
        render();
      },
      onSetPickerTab: (tab, clearSelected) => {
        pickerTab = tab;
        if (clearSelected) pickerSelected = '';
        if (panel?.kind === 'sessions' && tab === 'all' && agent?.capabilities.listSessions) {
          if (allSessionsPrefetchInFlight) {
            allSessionsLoading = true;
          } else if (!allListedSessions.length || Date.now() - allSessionsLoadedAt >= 15_000) {
            loadSessions(false, false, true);
            return;
          } else {
            warmSessionSearchIndex(allListedSessions);
          }
        }
        render();
      },
      onSetPickerSelected: item => {
        pickerSelected = item;
        render();
      },
      onSetPrefsPage: page => {
        if (!isPrefsPageId(page)) return;
        prefsPage = page;
        prefsFocus = undefined;
        panelDraft = { text: '', cursor: 0 };
        render();
      },
      onSetPrefsFocus: rowId => {
        prefsFocus = rowId;
      },
      onSetUsageTab: tab => {
        usageTab = tab;
        render();
      },
      onOpenPanel: openPanel,
      onClosePanel: closePanel,
      onUpdatePrefs: updatePrefs,
      onResetPrefs: resetPrefs,
      onCheckUpdates: checkUpdatesManually,
      onShowToast: showToast,
      onChangeConfig: changeConfig,
      onChooseCommand: chooseCommand,
      onOpenConversation: openConversation,
      onNewConversation: newConversation,
      onLoadSessions: (append, allWorkspaces) => loadSessions(Boolean(append), false, Boolean(allWorkspaces)),
      onCloseSavedSession: closeSavedSession,
      onRequestSessionPreview: requestSessionPreview,
      onLoadExtensions: loadExtensions,
      onToggleMcp: toggleMcp,
      onRemoveMcp: runRemoveMcp,
      onTogglePlugin: togglePlugin,
      onValidatePlugin: runValidatePlugin,
      onUninstallPlugin: runUninstallPlugin,
      onRemoveTemplate: removePromptTemplate,
      onSetDraft: next => {
        stateManager.getActive().draft = next;
        render();
      },
      onRefreshGitChanges: () => {
        gitDiffCache.clear();
        void detectGitStatus(options.cwd).then(rows => {
          if (!quitting) { gitChanges = rows; render(); }
        }).catch(() => {});
      },
      onLoadGitDiffPreview: loadGitDiffPreview,
      onInspectGitFile: filePath => {
        void readWorkspaceTextPreview(options.cwd, filePath).then(preview => {
          if (!quitting) openInspect(basename(filePath), { type: 'file', path: preview.path, content: preview.text, truncated: preview.truncated }, filePath);
        }).catch(() => {});
      },
      onOpenInspect: openInspect,
      onOpenSplit: openSplit,
      onAttachFile: attachFile,
      onInspectFindMatch: inspectFindMatch,
      onJumpToEntry: targetEntry => {
        const activeConv = stateManager.getConversation();
        const activeSt = stateManager.getActive();
        const idx = activeConv.entries.indexOf(targetEntry);
        if (idx >= 0) {
          const needed = activeConv.entries.length - idx;
          if (needed > activeSt.historyVisibleCount) activeSt.historyVisibleCount = needed + 20;
        }
        if (targetEntry.type === 'thought') activeSt.thoughtFoldOverrides.set(targetEntry.id, true);
        else if (targetEntry.type === 'tool') activeSt.toolFoldOverrides.set(targetEntry.id, false);
        closePanel();
        surface?.reveal(`main.conversation.${targetEntry.id}`, 'start');
      },
      onInspectDirPath: dirPath => {
        void listDirectoryEntriesPreview(options.cwd, dirPath).then(pv => {
          if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
        }).catch(() => {});
      },
      onCopy: text => {
        void copyToClipboard(text).then(copied => {
          if (!quitting) showToast(copied ? 'Copied to clipboard' : 'Clipboard unavailable', copied ? undefined : 'Install wl-copy or xclip to copy');
        });
      },
      onStopTurn: stop,
      onLoadReport: loadReport,
      followUp: followUpState,
      onUpdateFollowUp: updater => {
        if (!followUpState || quitting) return;
        updater(followUpState);
        render();
      },
      onSubmitFollowUp: submitFollowUp,
      onDeclineFollowUp: declineFollowUp,
      onCancelFollowUp: cancelFollowUp,
    });
  }

  function render(): void {
    const rc = renderController;
    rc?.clearScheduledRender();
    if (!rc || !surface || surface.closed || quitting) return;
    if (process.stdout.rows) rc.rows = process.stdout.rows;
    const conv = stateManager.getConversation();
    const st = stateManager.getActive();
    const sid = stateManager.activeSessionId;
    const permission = permissions[0];
    const approvalCall = permission && (conv.getTool(permission.request.toolCall.toolCallId)?.call ?? permission.request.toolCall);
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
    const draftCommand = st.draft.text.trimStart().startsWith('/')
      ? resolveCommand(st.draft.text, availableCommands())
      : undefined;
    const hasAttachments = st.attachedFiles.length > 0 || st.attachedDirs.length > 0 || st.attachedImages.length > 0;
    const hasDraftContent = !!(st.draft.text.trim() || hasAttachments);
    const canSend = hasDraftContent && !busy && !changingConfig && !sessionOperation && !authBusy && !permission &&
      !!((agent && !disconnected) || (draftCommand && !hasAttachments));
    const canQueue = hasDraftContent && busy && !changingConfig && !sessionOperation && !authBusy && !permission &&
      !!agent && !disconnected;
    const activePlan = conv.currentPlan;
    const planSummary = formatPlanSummary(activePlan);
    const contextUsage = formatContextUsage(metadata.usage);
    if (cachedDiffCountConversation !== conv || cachedDiffCountRev !== conv.revision) {
      cachedDiffCountConversation = conv;
      cachedDiffCountRev = conv.revision;
      cachedDiffCount = countSessionDiffs(conv.entries);
    }
    const sessionDiffCount = cachedDiffCount;
    const loginAvailable = !!loginMethod() && !terminalLoginProblem(loginMethod()!) && !!agent && !disconnected && authentication.logout;
    const agentStatus: Tone = disconnected || phase.includes('failed') ? 'error' : busy ? 'warning' : agent ? 'success' : 'muted';
    const renderNow = Date.now();
    const activeTools = activeToolSteps();
    const rowsNow = viewportRows();
    const colsNow = viewportCols();
    const showComposerBar = rowsNow >= 18;
    const startupBusy = agentConnecting || startupSyncingConfig || Boolean(sessionOperation);
    const startupLabel = sessionOperation ?? startupStageLabel(connectionStage);
    const showHud = !!(busy || startupBusy || activeTools.length > 0 || (planSummary && activePlan) || (!showComposerBar && contextUsage));
    const activeToolTop = activeTools.at(-1);
    const activeToolSummary = activeToolTop ? summarizeToolCall(activeToolTop.call, options.cwd) : undefined;
    const liveTaskLabel = activeToolSummary
      ? `Running${activeTools.length > 1 ? ` (${activeTools.length})` : ''}: ${activeToolSummary.title}${activeToolSummary.target ? ` · ${compactToolHeaderText(activeToolSummary.target, 36)}` : ''}`
      : phase;
    const hudAgeMs = rc.stableAge(
      activeToolTop ? `hud:${activeToolTop.id}` : startupBusy ? 'hud:startup' : 'hud:turn',
      activeToolTop?.startedAt ?? (startupBusy ? connectStartedAt : turnStartedAt),
    );
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
      thoughtFoldOverrides: st.thoughtFoldOverrides,
      toolFoldOverrides: st.toolFoldOverrides,
      canRetry: !!(st.lastPrompt || st.lastImages.length) && !busy && !!agent && !disconnected && !permission,
      canReconnect: disconnected && !agentConnecting && !authBusy && !busy,
      canSwitchAccount: loginAvailable && !busy && !authBusy,
      pathExists,
      getBlob: blobForImage,
      onInspect: openInspect,
      onInspectFile: openInspectFile,
      onToggleThought(id, open) {
        st.thoughtFoldOverrides.set(id, open);
        render();
      },
      onToggleTool(id, collapsed) {
        st.toolFoldOverrides.set(id, collapsed);
        render();
      },
      onRetry() {
        if (st.lastPrompt || st.lastImages.length || st.lastFiles.length || st.lastDirs.length) {
          submitPrompt(st.lastPrompt, st.lastImages, st.lastFiles, st.lastDirs);
        }
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
        stateManager.getActive().draft = { text, cursor: text.length };
        render();
        surface?.focus(DOCK_DRAFT_ID);
      },
      onLoadDeeperHistory() {
        void loadDeeperBrainHistory();
      },
      onOpenFollowUp: openFollowUpModal,
    };

    const allEntries = conv.entries;
    const totalEntries = allEntries.length;
    const hiddenCount = Math.max(0, totalEntries - st.historyVisibleCount);
    const visibleEntries = hiddenCount > 0 ? allEntries.slice(hiddenCount) : allEntries;
    let turnCounter = 0;
    for (let i = 0; i < hiddenCount; i++) {
      const earlier = allEntries[i]!;
      if (earlier.type === 'message' && earlier.role === 'user') turnCounter++;
    }
    const renderedEntries: RenderedEntryRecord[] = [];
    const renderEntryNode = (entry: TranscriptEntry, idxInVisible: number): JSX.Element => {
      const globalIdx = hiddenCount + idxInVisible;
      const prev = globalIdx > 0 ? allEntries[globalIdx - 1] : undefined;
      const continued = entry.type === 'message' && prev?.type === 'message' && prev.role === entry.role;
      const streaming = busy && globalIdx === totalEntries - 1 && entry.type === 'message' && entry.role === 'agent';
      const recent = globalIdx >= Math.max(0, totalEntries - 8);
      const turnNumber = entry.type === 'message' && entry.role === 'user' ? ++turnCounter : undefined;
      const settled = isEntrySettled(entry, globalIdx, totalEntries, busy, replayCoordinator.isReplaying, activePlan);
      const foldKey = entry.type === 'thought' || entry.type === 'compaction'
        ? String(st.thoughtFoldOverrides.get(entry.id) ?? '')
        : entry.type === 'tool' ? String(st.toolFoldOverrides.get(entry.id) ?? '') : '';
      const errorKey = entry.type === 'notice' && entry.error
        ? `${Number(entryCallbacks.canRetry)}${Number(entryCallbacks.canReconnect)}${Number(entryCallbacks.canSwitchAccount)}` : '';
      const stableAgeMs = entry.type === 'thought' || entry.type === 'tool'
        ? rc.stableAge(entry.id, entry.startedAt)
        : 0;
      const entryNow = entry.type === 'thought' || entry.type === 'tool'
        ? ((entry.startedAt ?? renderNow) + stableAgeMs)
        : renderNow;
      const entryAgentStatus = entry.type === 'message' && entry.role === 'agent' ? agentStatus : '';
      const entryRecent = entry.type === 'tool' ? (recent ? 1 : 0) : 0;
      const sig = `${conv.revisionOf(entry)}|${continued ? 1 : 0}|${streaming ? 1 : 0}|${entryRecent}|${turnNumber ?? ''}|${settled ? 1 : 0}|${foldKey}|${errorKey}|${entryAgentStatus}|${userPrefs.diffMode}|${userPrefs.toolDisplay}|${Number(userPrefs.thoughtExpanded)}|${userPrefs.transcriptDensity}|${Number(userPrefs.showTimestamps)}|${layout.proseMaxW}|${pathPresenceCache.version}`;
      const record = rc.renderEntryMemoized(entry, { sig, settled }, () => (
        <Entry key={entry.id} entry={entry} continued={continued} streaming={streaming} recent={recent} turnNumber={turnNumber}
          callbacks={entryNow === renderNow ? entryCallbacks : { ...entryCallbacks, now: entryNow }} />
      ));
      renderedEntries.push(record);
      return record.node;
    };
    const canSendQueueHead = !busy && !permission && !changingConfig && !sessionOperation && !authBusy && !!agent && !disconnected;
    const view: Renderable = {
      main: <col>
        <scroll key="conversation" bar="always" stick={visibleEntries.length ? 'end' : undefined}
          max={session?.caps.features.includes('styles') ? undefined : { h: layout.scrollMaxH }} gap="md" aria="Conversation">
          {hiddenCount > 0 && <row key="older-history" justify="between" align="center" gap="sm" wrap>
            <text><span s="muted">{hiddenCount} earlier {hiddenCount === 1 ? 'entry' : 'entries'} hidden for speed</span></text>
            <row gap="xs">
              <button size="sm" variant="quiet" onClick={() => { st.historyVisibleCount += 50; render(); }}>Load 50 more</button>
              <button size="sm" variant="quiet" onClick={() => { st.historyVisibleCount = totalEntries; render(); }}>Show all ({totalEntries})</button>
            </row>
          </row>}
          {visibleEntries.length ? visibleEntries.map(renderEntryNode) :
            <col key="empty-wrap" gap={layout.compactEmpty ? 'sm' : 'md'} align="center">
              {!agent && !disconnected && <row key="startup-progress" gap="sm" align="center">
                <spinner style="starburst" />
                <shimmer text={startupStageLabel(connectionStage)} />
                <elapsed age={hudAgeMs} />
              </row>}
              <empty icon={layout.compactEmpty ? undefined : 'tern'} title={agent ? 'Ask Antigravity about this project' : disconnected ? 'Antigravity is unavailable' : 'Connecting to Antigravity'}
                text={layout.compactEmpty ? (agent ? 'Use / for commands or @ for files & dirs.' : disconnected ? 'Open /account to sign in.' : startupStageLabel(connectionStage)) : (agent ? 'Type / for commands or @ to attach files, directories, and images (including gitignored entries). Thoughts, diffs, and one-time approvals appear here.' :
                  disconnected ? 'Open /account to sign in, or Quit to return to your shell.' : 'Initializing ACP subprocess, verifying shared agy authentication, and opening session...')} />
              {agent && !disconnected && !permission && rowsNow >= 20 && <suggestions variant="chips"
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
      dock: <col align="center" gap="none">
        <col key="shell" role="agy.dock.center" max={{ w: '92ch' }} gap="xs">
          {showHud && <row key="hud" role="omp.working" justify="between" align="center" gap="sm" wrap>
            <row gap="sm" align="center" wrap>
              {(busy || activeTools.length > 0) ? <row key="live-turn" gap="sm" align="center">
                <spinner style="starburst" />
                <shimmer text={liveTaskLabel} />
                <elapsed age={hudAgeMs} />
                <button size="sm" variant="quiet" onClick={() => openPanel({ kind: 'tasks' })}>Tasks</button>
                <button size="sm" variant="danger" disabled={cancelling && 'Cancellation requested'} onClick={stop}>
                  {cancelling ? 'Stopping...' : 'Stop'}
                </button>
              </row> : startupBusy && <row key="startup-hud" gap="sm" align="center">
                <spinner style="starburst" />
                <shimmer text={startupLabel} />
                <elapsed age={hudAgeMs} />
              </row>}
              {activePlan && planSummary && <checklist key="plan-hud" mode="hud"
                note={`${planSummary.done}/${planSummary.total}`}
                phases={[{ title: 'Tasks', items: activePlan.entries.map((item, index) => ({
                  id: String(index), text: item.content,
                  status: item.status === 'in_progress' ? 'active' : item.status === 'completed' ? 'done' : 'pending',
                })) }]} />}
            </row>
            {!showComposerBar && contextUsage && <meter key="context" style="bar" size="sm"
              value={contextUsage.percent / 100}
              thresholds={{ warn: 0.75, bad: 0.9 }}
              label={contextUsage.summary}
              title={`Session context: ${metadata.usage?.used.toLocaleString()} / ${metadata.usage?.size.toLocaleString()} tokens (click for /usage)`}
              hovercard={cachedHoverKv(
                'hud-context',
                `${metadata.usage?.used ?? ''}|${metadata.usage?.size ?? ''}|${metadata.usage?.cost?.amount ?? ''}|${metadata.usage?.cost?.currency ?? ''}|${metadata.tier?.name ?? ''}`,
                () => [
                  { k: 'Context used', v: `${metadata.usage?.used.toLocaleString()} tokens` },
                  { k: 'Window', v: `${metadata.usage?.size.toLocaleString()} tokens` },
                  ...(metadata.usage?.cost ? [{ k: 'Session cost', v: `${metadata.usage.cost.amount} ${metadata.usage.cost.currency}` }] : []),
                  ...(metadata.tier ? [{ k: 'Subscription tier', v: metadata.tier.name }] : []),
                  { k: 'Action', v: 'Click to open /usage' },
                ],
              )}
              onClick={() => { if (agent && !disconnected && !permission) openPanel({ kind: 'report', report: 'usage' }); }} />}
          </row>}
          {permission && approvalCall && approvalSummary && <tool key={`approval-${permission.id}`}
            title={approvalSummary.title}
            name={approvalSummary.name}
            target={approvalSummary.target}
            targetKind={approvalSummary.targetKind}
            status="pending" note="Approval required">
            <text>Choose a one-time permission for this tool. Tab selects a choice; Ctrl+Y allows, Ctrl+N denies. Enter never approves.</text>
            <scroll bar="always" max={{ h: layout.approvalBodyMaxH }}>
              <ToolBody call={approvalCall} cwd={options.cwd} showRawInput={approvalSummary.showRawInput}
                fullCommand={approvalSummary.fullCommand} diffMode={userPrefs.diffMode}
                pathExists={pathExists} getBlob={blobForImage} onInspect={openInspect}
                onOpenSplit={openSplit} onCopy={entryCallbacks.onCopy} />
            </scroll>
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
          {suggestions.length > 0 && <list key="commands" selected={`dock.shell.commands.row-${selectedCommand}`} max={{ lines: layout.dockPopupMaxLines }}>
            {suggestions.map((command, index) => <item key={`row-${index}`} label={`/${command.name}`}
              detail={command.description} value={command.hint ? 'Arguments' : command.local ? 'Panel' : 'agy'}
              title={`/${command.name}: ${command.description}${command.hint ? ` · ${command.hint}` : ''}`}
              onClick={() => chooseCommand(command)} />)}
          </list>}
          {atMatches.length > 0 && <list key="files" selected={`dock.shell.files.row-${selectedFile}`} max={{ lines: layout.dockPopupMaxLines }}>
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
          {st.queuedPrompts.length > 0 && <col key="queue" role="omp.queue" gap="xs">
            {st.queuedPrompts.map((item, idx) => {
              const label = item.text.trim().replace(/\s+/g, ' ');
              const preview = label.length > 64 ? `${label.slice(0, 61)}...` : (label || `${item.images.length} image(s)`);
              const metaParts = [
                ...(item.files.length ? [`${item.files.length} file${item.files.length === 1 ? '' : 's'}`] : []),
                ...(item.dirs.length ? [`${item.dirs.length} dir${item.dirs.length === 1 ? '' : 's'}`] : []),
                ...(item.images.length ? [`${item.images.length} image${item.images.length === 1 ? '' : 's'}`] : []),
              ];
              return <row key={item.id} role="omp.queue.item" justify="between" align="center" gap="sm">
                <text wrap="char">
                  <span s="accent">Queued #{idx + 1}</span>
                  <span>: {preview}</span>
                  {metaParts.length > 0 && <span s="muted"> ({metaParts.join(', ')})</span>}
                </text>
                <row gap="xs">
                  {idx === 0 && canSendQueueHead && <button size="sm" variant="primary" onClick={() => {
                    const next = stateManager.pullQueuedAt(0);
                    if (!next) return;
                    submitPrompt(formatPromptWithAttachments(next.text, next.files, next.dirs), next.images, next.files, next.dirs);
                  }}>Send</button>}
                  <button size="sm" variant="quiet" onClick={() => {
                    const pulled = stateManager.pullQueuedAt(idx);
                    if (!pulled) return;
                    const currentSt = stateManager.getActive();
                    currentSt.draft = { text: pulled.text, cursor: pulled.text.length };
                    currentSt.attachedFiles = [...pulled.files];
                    currentSt.attachedDirs = [...pulled.dirs];
                    currentSt.attachedImages = [...pulled.images];
                    render();
                    surface?.focus(DOCK_DRAFT_ID);
                  }}>Edit</button>
                  <button size="sm" variant="quiet" onClick={() => {
                    stateManager.dropQueuedAt(idx);
                    render();
                  }}>Drop</button>
                </row>
              </row>;
            })}
          </col>}
          <col key="composer" role="omp.editor" tone={busy ? 'pending' : undefined} gap="xs">
            {hasAttachments && <row key="attachments" role="omp.composer.chips" gap="xs" wrap>
              {st.attachedImages.map(image => <attachment key={`img:${image.path}`} variant="tile"
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
              {st.attachedDirs.map(dir => {
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
              {st.attachedFiles.map(file => {
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
            <row key="line" role="omp.composer.line" align="start" gap="sm">
              <editor key="draft" grow={1} aria="Message to Antigravity" text={st.draft.text} cursor={st.draft.cursor} anchor={st.draft.anchor}
                placeholder={disconnected ? 'Use /account to sign in, or draft a message' : busy ? 'Draft your next message' : 'Message Antigravity, / for commands, @ for files & dirs'}
                readonly={authBusy} maxLines={layout.composerMaxLines} variant="well"
                onFocus={() => surface?.focus(DOCK_DRAFT_ID)}
                onEdit={event => {
                  if (!authBusy) {
                    const currentSt = stateManager.getActive();
                    const next = editDraft(currentSt.draft, event);
                    recordUndo(currentSt.draft, next);
                    currentSt.draft = next;
                    autocompleteDismissed = false;
                    commandSelection = 0;
                    fileSelection = 0;
                    scheduleRender();
                  }
                }}
                onUndo={() => { if (!authBusy) applyUndo(); }}
                onSend={send}
                onAction={{ send, stop }} />
            </row>
            <row key="composer-bar" role="omp.composer.bar" justify="between" align="center" gap="sm">
              <row gap="xs" align="center">
                {showComposerBar && currentModel && <button size="sm" variant="quiet" icon="model"
                  disabled={(!agent || disconnected || !!permission) && 'Wait until connected'}
                  title="Change model (/model)"
                  onClick={() => openPanel({ kind: 'config', id: currentModel.id })}>
                  {configLabel(currentModel)}
                </button>}
                {showComposerBar && currentThinking && <row gap="xs" align="center">
                  <effort level={thinkingToEffort(String(currentThinking.currentValue))} />
                  <button size="sm" variant="quiet"
                    disabled={(!agent || disconnected || !!permission) && 'Wait until connected'}
                    title="Change thinking effort"
                    onClick={() => openPanel({ kind: 'config', id: currentThinking.id })}>
                    {configLabel(currentThinking)}
                  </button>
                </row>}
                {showComposerBar && currentMode && <button size="sm" variant="quiet" icon="shield"
                  disabled={(!agent || !!permission) && 'Wait until connected'}
                  title="Session mode (/permissions)"
                  onClick={() => openPanel({ kind: 'config', id: currentMode.id })}>
                  {configLabel(currentMode)}
                </button>}
              </row>
              <row gap="sm" align="center">
                {showComposerBar && contextUsage && <meter key="context" style="bar" size="sm"
                  value={contextUsage.percent / 100}
                  thresholds={{ warn: 0.75, bad: 0.9 }}
                  label={contextUsage.summary}
                  title={`Session context: ${metadata.usage?.used.toLocaleString()} / ${metadata.usage?.size.toLocaleString()} tokens (click for /usage)`}
                  hovercard={cachedHoverKv(
                    'bar-context',
                    `${metadata.usage?.used ?? ''}|${metadata.usage?.size ?? ''}|${metadata.usage?.cost?.amount ?? ''}|${metadata.usage?.cost?.currency ?? ''}|${metadata.tier?.name ?? ''}`,
                    () => [
                      { k: 'Context used', v: `${metadata.usage?.used.toLocaleString()} tokens` },
                      { k: 'Window', v: `${metadata.usage?.size.toLocaleString()} tokens` },
                      ...(metadata.usage?.cost ? [{ k: 'Session cost', v: `${metadata.usage.cost.amount} ${metadata.usage.cost.currency}` }] : []),
                      ...(metadata.tier ? [{ k: 'Subscription tier', v: metadata.tier.name }] : []),
                      { k: 'Action', v: 'Click to open /usage' },
                    ],
                  )}
                  onClick={openUsageModal} />}
                {showComposerBar && <button key="usage" size="sm" variant="quiet" icon={contextUsage ? undefined : 'context'}
                  disabled={(!!permission || authBusy) && 'Finish current prompt'}
                  title="Check quota & usage (/usage)"
                  hovercard={cachedHoverKv(
                    'bar-usage-btn',
                    `${metadata.usage?.used ?? ''}|${metadata.usage?.size ?? ''}|${metadata.usage?.cost?.amount ?? ''}|${metadata.usage?.cost?.currency ?? ''}|${metadata.tier?.name ?? ''}`,
                    () => [
                      ...(metadata.tier ? [{ k: 'Subscription tier', v: metadata.tier.name }] : []),
                      ...(contextUsage ? [{ k: 'Context used', v: `${metadata.usage?.used.toLocaleString()} / ${metadata.usage?.size.toLocaleString()} tokens` }] : []),
                      ...(metadata.usage?.cost ? [{ k: 'Session cost', v: `${metadata.usage.cost.amount} ${metadata.usage.cost.currency}` }] : []),
                      { k: 'Action', v: 'Click to inspect /usage quota' },
                    ],
                  )}
                  onClick={openUsageModal}>
                  {metadata.usage?.cost && metadata.usage.cost.amount > 0 ? `${metadata.usage.cost.amount.toFixed(4)} ${metadata.usage.cost.currency}` : 'Usage'}
                </button>}
                {busy ? <>
                  {hasDraftContent && <button size="sm" variant="default" icon="plus"
                    disabled={(!canQueue) && 'Wait until ready'}
                    onClick={send}>Queue</button>}
                  <button size="sm" variant="danger" icon="stop" keys={['esc']}
                    disabled={cancelling && 'Cancellation requested'}
                    onClick={stop}>{cancelling ? 'Stopping...' : 'Stop'}</button>
                </> : <button size="sm" variant={permission ? 'default' : 'primary'} icon="send" keys={['enter']}
                  disabled={(!canSend) && (permission ? 'Resolve approval first' : 'Type a message')}
                  onClick={send}>Send</button>}
              </row>
            </row>
          </col>
          <status key="bar" role="agy.dock.status" transparent>
            <seg key="state" priority={10}
              tone={busy || authBusy || agentConnecting || !!sessionOperation ? 'accent' : disconnected || phase.includes('failed') ? 'error' : agent ? 'success' : 'muted'}
              text={authBusy ? 'Signing in' : sessionOperation ?? phase}
              title={disconnected && !agentConnecting ? 'Click to reconnect agy ACP' : busy ? 'Click to inspect running task (/tasks)' : undefined}
              onClick={() => {
                if (disconnected && !agentConnecting && !authBusy) reconnectAgent();
                else if (busy && !permission && !authBusy) openPanel({ kind: 'tasks' });
              }} />
            {st.historyIndex !== undefined && <seg key="history" priority={6} icon="history" tone="accent"
              text={`History ${st.historyIndex + 1}/${promptHistory.length}`}
              title="Up/Down cycles sent prompts; type to keep editing" />}
            {!showComposerBar && <seg key="model" priority={9} icon="model"
              tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
              text={currentModel ? configLabel(currentModel) : 'Model'}
              hovercard={cachedHoverKv(
                'seg-model',
                `${currentModel ? configLabel(currentModel) : ''}|${currentModel?.currentValue ?? ''}`,
                () => [
                  { k: 'Model', v: currentModel ? configLabel(currentModel) : 'Not reported' },
                  ...(currentModel ? [{ k: 'Option ID', v: String(currentModel.currentValue) }] : []),
                  { k: 'Shortcut', v: 'Click or type /model' },
                ],
              )}
              onClick={() => {
                if (agent && !disconnected && !permission) {
                  openPanel(currentModel ? { kind: 'config', id: currentModel.id } : { kind: 'settings' });
                }
              }} />}
            {!showComposerBar && currentThinking && <seg key="thinking" priority={7} icon="thinking"
              tone={(!agent || disconnected || !!permission) ? 'muted' : undefined}
              text={configLabel(currentThinking)}
              hovercard={cachedHoverKv(
                'seg-thinking',
                configLabel(currentThinking),
                () => [
                  { k: 'Thinking level', v: configLabel(currentThinking) },
                  { k: 'Action', v: 'Click to change reasoning effort' },
                ],
              )}
              onClick={() => {
                if (agent && !disconnected && !permission) openPanel({ kind: 'config', id: currentThinking.id });
              }} />}
            {!showComposerBar && <seg key="mode" priority={6} icon="shield"
              tone={(!agent || !!permission) ? 'muted' : undefined}
              text={currentMode ? configLabel(currentMode) : 'Permissions'}
              hovercard={cachedHoverKv(
                'seg-mode',
                currentMode ? configLabel(currentMode) : '',
                () => [
                  { k: 'Mode', v: currentMode ? configLabel(currentMode) : 'Not reported' },
                  { k: 'Sandbox', v: '--sandbox requested (unverified)' },
                  { k: 'Shortcut', v: 'Click or type /permissions' },
                ],
              )}
              onClick={() => {
                if (agent && !permission) openPanel({ kind: 'permissions' });
              }} />}
            <seg key="sessions" priority={4} icon="history"
              tone={(!agent || disconnected || !!permission || busy || changingConfig || !!sessionOperation) ? 'muted' : undefined}
              text={sid ? sessionTitle(sid) : 'Sessions'}
              hovercard={cachedHoverKv(
                'seg-sessions',
                `${sid}|${sid ? sessionTitle(sid) : ''}`,
                () => [
                  { k: 'Conversation', v: sid ? sessionTitle(sid) : 'No active session' },
                  ...(sid ? [{ k: 'Session ID', v: sid }] : []),
                  { k: 'Shortcut', v: 'Click or type /sessions' },
                ],
              )}
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
              hovercard={cachedHoverKv(
                'seg-scope',
                `${options.agentName ?? ''}|${options.additionalDirectories?.length ?? 0}`,
                () => [
                  { k: 'Agent profile', v: options.agentName ?? 'Default' },
                  { k: 'Workspace roots', v: String(1 + (options.additionalDirectories?.length ?? 0)) },
                  { k: 'Shortcut', v: 'Click or type /agents' },
                ],
              )}
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
              text={metadata.tier && colsNow >= 96 ? metadata.tier.name : 'Account'}
              hovercard={cachedHoverKv(
                'seg-account',
                `${disconnected ? 1 : agent ? 2 : 0}|${metadata.tier?.name ?? ''}`,
                () => [
                  { k: 'ACP', v: disconnected ? 'Disconnected' : agent ? 'Connected' : 'Connecting' },
                  { k: 'Subscription tier', v: metadata.tier ? metadata.tier.name : 'Not reported' },
                  { k: 'Shortcut', v: 'Click or type /account' },
                ],
              )}
              onClick={() => { if (!permission && !authBusy) openPanel({ kind: 'account' }); }} />
            <seg key="quit" side="right" priority={9} icon="power" text="Quit"
              title="Quit frontend (Ctrl+Q)"
              onClick={quit} />
          </status>
          {layout.showKeyLegend && <text key="keys" role="agy.dock.keys" wrap="word">
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
        </col>
      </col>,
      layer: <col>
        {toastMessage && <toast key="toast" text={toastMessage.text} sub={toastMessage.sub} />}
        {renderPanel()}
      </col>,
    };
    rc.commitFrame(view, renderedEntries, replayCoordinator.isReplaying, busy);
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
    if (session.caps.features.includes('styles')) {
      surface.stylesheet('agy-composer', COMPOSER_LAYOUT_CSS);
    }
    renderController = new TernRenderController({
      session,
      surface,
      title: 'Antigravity · agy-tern',
      maxFps: userPrefs.maxFps,
      motion: userPrefs.motion,
      initialCols: process.stdout.columns || 120,
      initialRows: process.stdout.rows || 40,
    });
    void promptHistoryStore.load().then(saved => {
      if (quitting || !saved.length) return;
      const merged = [...saved];
      for (const item of promptHistory) {
        if (merged.at(-1) !== item) merged.push(item);
      }
      promptHistory.splice(0, promptHistory.length, ...merged.slice(-50));
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
    surface.focus(launch?.openAccount ? null : DOCK_DRAFT_ID);

    const startAgentConnection = (resumeId?: string): Promise<void> => {
      if (quitting || agentConnecting) return Promise.resolve();
      agentConnecting = true;
      disconnected = false;
      connectStartedAt = Date.now();
      connectionStage = 'spawning';
      phase = resumeId ? 'Reconnecting to Antigravity' : 'Connecting to Antigravity';
      render();
      return connectAgent({ ...options, signal }, {
        connectionStage(stage) {
          if (quitting) return;
          connectionStage = stage;
          render();
        },
        authentication(next) {
          if (!quitting) { authentication = next; authenticationKnown = true; render(); }
        },
        metadata(next) {
          if (!quitting) { metadata = next; commandSelection = 0; render(); }
        },
        sessionChanged(id) {
          const prevId = stateManager.activeSessionId;
          if (prevId && prevId !== id) {
            void persistActiveTranscript();
          }
          const switched = stateManager.switchSession(id, {
            freshConversation: prevId !== id && replayCoordinator.isReplaying && replayCoordinator.currentPhase !== 'idle',
          });
          if (prevId && prevId !== id && switched) {
            gitDiffCache.clear();
            cachedDiffCountConversation = undefined;
            cachedDiffsConversation = undefined;
            cachedSessionDiffs = [];
            renderController?.resetSessionTracking();
          }
          clearPermissions();
          clearElicitations();
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
          const route = replayCoordinator.onUpdate(notification.sessionId, update);
          if (route === 'shadow') {
            return;
          }
          const conv = stateManager.getConversation();
          if (!busy || update.sessionUpdate !== 'user_message_chunk') {
            conv.update(update, Date.now(), busy ? clockTime() : undefined);
          }
          if (route === 'replaying' && replayPlaceholderId) {
            conv.removeNotice(replayPlaceholderId);
            replayPlaceholderId = undefined;
          }
          const st = stateManager.getActive();
          if (busy && !replayCoordinator.isReplaying && userPrefs.autoPreviewMedia && !panel && !permissions.length) {
            if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
              const call = conv.getTool(update.toolCallId)?.call;
              if (call) {
                const imgPath = extractToolImagePaths(call, options.cwd).find(p => pathExists(p) && !st.previewedMedia.has(`path:${p}`));
                if (imgPath) {
                  st.previewedMedia.add(`path:${imgPath}`);
                  const label = formatPathLabel(imgPath, options.cwd);
                  openInspect(basename(label), { type: 'image-path', path: imgPath }, label);
                  return;
                }
                const inlineImg = extractToolInlineImages(call)[0];
                if (inlineImg) {
                  const imgKey = `tool-inline:${call.toolCallId}:${inlineImg.data.slice(0, 48)}`;
                  if (!st.previewedMedia.has(imgKey)) {
                    st.previewedMedia.add(imgKey);
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
              if (!st.previewedMedia.has(imgKey)) {
                st.previewedMedia.add(imgKey);
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
          if (panel?.kind !== 'followup' || panel.source !== 'elicitation') closePanel();
          const conv = stateManager.getConversation();
          conv.tool(prompt.request.toolCall);
          if (!prompt.request.options.some(option => option.kind === 'allow_once')) {
            const deny = prompt.request.options.find(option => option.kind === 'reject_once');
            conv.tool(prompt.request.toolCall).approved = 'denied';
            conv.notice(`${prompt.request.toolCall.title ?? prompt.request.toolCall.toolCallId}: no one-time allowance offered; request denied.`);
            prompt.answer(deny?.optionId ?? null);
          } else {
            permissions.push(prompt);
            if (userPrefs.notifyOnTurnComplete) {
              sendTerminalAttention('agy-tern', `Approval required: ${prompt.request.toolCall.title ?? 'tool call'}`);
            }
          }
          render();
        },
        elicitation(prompt) {
          if (quitting || authBusy || cancelling || disconnected || permissions.length > 0) {
            prompt.answer(null);
            return;
          }
          elicitations.push(prompt);
          if (elicitations.length === 1) {
            activateNextElicitation();
          }
          if (userPrefs.notifyOnTurnComplete) {
            sendTerminalAttention('agy-tern', `Follow-up question: ${prompt.request.message}`);
          }
          render();
        },
        elicitationComplete(notification) {
          if (quitting) return;
          const idx = elicitations.findIndex(item => 'elicitationId' in item.request && item.request.elicitationId === notification.elicitationId);
          if (idx >= 0) {
            const [done] = elicitations.splice(idx, 1);
            done?.answer({ action: 'accept' });
            if (idx === 0) activateNextElicitation();
            showToast('Browser action completed');
            render();
          }
        },
        diagnostic(text) {
          if (!quitting) { stateManager.getConversation().notice(text); render(); }
        },
        disconnected(message) {
          if (quitting) return;
          agent = undefined;
          agentConnecting = false;
          startupSyncingConfig = false;
          connectionStage = undefined;
          disconnected = true;
          phase = 'Disconnected';
          clearPermissions();
          clearElicitations();
          stateManager.getConversation().notice(message, true);
          process.exitCode = 1;
          render();
        },
      }).then(async connected => {
        if (quitting) { await connected.close(); return; }
        agent = connected;
        agentConnecting = false;
        process.exitCode = undefined;
        metadata = connected.metadata;
        if (stateManager.activeSessionId !== connected.sessionId) {
          stateManager.switchSession(connected.sessionId);
        }
        const targetId = resumeId ?? launch?.conversationId;
        const loadingExisting = Boolean((targetId && targetId !== connected.sessionId) || (!resumeId && launch?.continueLast));
        if (!resumeId && !loadingExisting) {
          void startConfigSync(connected, true, true);
        }
        if (quitting) return;
        if (targetId && targetId !== connected.sessionId) {
          try {
            if (connected.capabilities.loadSession) {
              const token = beginHistoryReplay(targetId, 'load');
              await connected.loadSession(targetId);
              settleHistoryReplay(token, targetId, undefined, 'load');
            } else if (connected.capabilities.resumeSession && connected.resumeSession) {
              const token = beginHistoryReplay(targetId, 'resume');
              await connected.resumeSession(targetId);
              settleHistoryReplay(token, targetId, undefined, 'resume');
            } else if (!resumeId) {
              stateManager.getConversation().notice(`Cannot open --conversation ${targetId}: session load/resume not advertised.`, true);
            }
          } catch (err) {
            clearReplayState();
            stateManager.getConversation().notice(`Failed to open conversation ${targetId}: ${err instanceof Error ? err.message : String(err)}`, true);
          }
          void startConfigSync(connected, !resumeId, true);
        } else if (!resumeId && launch?.continueLast && connected.capabilities.listSessions) {
          try {
            const list = await connected.listSessions();
            const sorted = [...list.sessions].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
            const latest = sorted[0];
            if (latest && latest.sessionId !== connected.sessionId) {
              if (connected.capabilities.loadSession) {
                const token = beginHistoryReplay(latest.sessionId, 'load');
                await connected.loadSession(latest.sessionId);
                settleHistoryReplay(token, latest.sessionId, undefined, 'load');
              } else if (connected.capabilities.resumeSession && connected.resumeSession) {
                const token = beginHistoryReplay(latest.sessionId, 'resume');
                await connected.resumeSession(latest.sessionId);
                settleHistoryReplay(token, latest.sessionId, undefined, 'resume');
              }
              void startConfigSync(connected, true, true);
            } else if (!latest) {
              stateManager.getConversation().notice('No previous conversation found in this workspace for --continue; started a new session.');
            }
          } catch (err) {
            clearReplayState();
            stateManager.getConversation().notice(`Failed to continue latest conversation: ${err instanceof Error ? err.message : String(err)}`, true);
          }
        }
        if (quitting) return;
        if (!startupSyncingConfig) connectionStage = undefined;
        phase = replayCoordinator.isReplaying ? 'Syncing history' : 'Ready';
        render();
        if (!replayCoordinator.isReplaying) surface?.scroll('main.conversation', 'end');
        if (!resumeId && connected.capabilities.listSessions && !listedSessions.length) {
          loadSessions(false, true, false);
        }
        if (resumeId) showToast('Reconnected to Antigravity');
        else {
          if (launch?.initialPrompt && !disconnected) submitPrompt(launch.initialPrompt);
          if (!options.executable || options.executable === 'agy') {
            void import('./updater')
              .then(m => m.checkForUpdatePassive())
              .then(res => {
                if (res && !quitting) {
                  updateStatus = { checking: false, latestTag: res.latestTag, updateAvailable: res.updateAvailable };
                  if (!panel && !toastMessage) {
                    showToast(`Update available: ${res.latestTag}`, 'Run `agy-tern update` to upgrade');
                  }
                }
              })
              .catch(() => {});
          }
        }
      }).catch(error => {
        if (quitting) return;
        agent = undefined;
        agentConnecting = false;
        startupSyncingConfig = false;
        connectionStage = undefined;
        disconnected = true;
        phase = 'Connection failed';
        clearPermissions();
        stateManager.getConversation().notice(error instanceof Error ? error.message : String(error), true);
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
        if (input.event.ev === 'error') {
          stateManager.getConversation().notice(`Tern: ${input.event.msg}`, true);
          render();
        } else {
          renderController.handleSessionEvent(input.event, render, process.stdout.rows || undefined);
        }
        continue;
      }
      renderController.noteVisibleActivity(render);
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
          const item = current.item;
          if (key.name === 'up') {
            surface.scroll('layer.panel.inspect-scroll', 'line-up');
          } else if (key.name === 'down') {
            surface.scroll('layer.panel.inspect-scroll', 'line-down');
          } else if (key.name === 'page_up') {
            surface.scroll('layer.panel.inspect-scroll', 'page-up');
          } else if (key.name === 'page_down') {
            surface.scroll('layer.panel.inspect-scroll', 'page-down');
          } else if (key.name === 'home') {
            surface.scroll('layer.panel.inspect-scroll', 'start');
          } else if (key.name === 'end') {
            surface.scroll('layer.panel.inspect-scroll', 'end');
          } else if (!key.ctrl && !key.meta && !key.alt && key.name === 'c') {
            const copyText = item.type === 'file' ? item.content
              : item.type === 'diff' ? item.hunks.flatMap(h => h.lines).join('\n')
              : item.type === 'dir' ? item.preview.entries.map(e => `${e.kind === 'dir' ? `${e.name}/` : e.name}${e.ignored ? ' [gitignored]' : ''}`).join('\n')
              : undefined;
            if (copyText !== undefined) {
              void copyToClipboard(copyText).then(copied => {
                if (!quitting) showToast(copied ? 'Copied to clipboard' : 'Clipboard utility unavailable', copied ? undefined : 'Install wl-copy or xclip to copy');
              });
            }
          } else if (!key.ctrl && !key.meta && !key.alt && key.name === 'l' && item.type === 'diff') {
            const next: DiffMode = userPrefs.diffMode === 'auto' ? 'unified' : userPrefs.diffMode === 'unified' ? 'split' : 'auto';
            updatePrefs({ diffMode: next });
          } else if (!key.ctrl && !key.meta && !key.alt && key.name === 'a') {
            const attachTarget = item.type === 'file' || item.type === 'diff' ? item.path : item.type === 'dir' ? item.preview.path : undefined;
            if (attachTarget && pathExists(resolve(options.cwd, attachTarget.replace(/\/+$/, '')))) {
              closePanel();
              attachFile(attachTarget);
            }
          } else if (!key.ctrl && !key.meta && !key.alt && key.name === 's' && (item.type === 'file' || item.type === 'diff')) {
            if (pathExists(resolve(options.cwd, item.path.replace(/\/+$/, '')))) {
              openSplit(item.path);
            }
          } else if (!key.ctrl && !key.meta && !key.alt && (key.name === 'u' || key.name === 'backspace') && item.type === 'dir') {
            const cleanDir = item.preview.path.replace(/\/+$/, '');
            const parentDir = cleanDir.includes('/')
              ? `${cleanDir.slice(0, cleanDir.lastIndexOf('/'))}/`
              : cleanDir && cleanDir !== '.'
                ? '.'
                : undefined;
            if (parentDir) {
              void listDirectoryEntriesPreview(options.cwd, parentDir).then(pv => {
                if (!quitting) openInspect(pv.path, { type: 'dir', preview: pv }, pv.path);
              }).catch(() => {});
            }
          }
          continue;
        }
        if (current.kind === 'followup') {
          if (key.name === 'page_up' || key.name === 'page_down' || key.name === 'home' || key.name === 'end') {
            surface.scroll('layer.panel.overlay-scroll',
              key.name === 'page_up' ? 'page-up'
                : key.name === 'page_down' ? 'page-down'
                : key.name === 'home' ? 'start' : 'end');
            continue;
          }
          if (key.name === 'enter' && !key.shift) {
            submitFollowUp();
            continue;
          }
          if (followUpState && followUpState.fields.length > 0 && (key.name === 'tab' || key.name === 'up' || key.name === 'down')) {
            const fields = followUpState.fields;
            const activeField = fields[followUpState.activeFieldIdx];
            if ((key.name === 'up' || key.name === 'down') && activeField?.kind === 'single-select' && activeField.options.length > 0) {
              const curVal = followUpState.answers[activeField.name];
              const curIdx = activeField.options.findIndex(o => o.value === curVal);
              const nextIdx = key.name === 'down'
                ? (curIdx + 1) % activeField.options.length
                : (curIdx <= 0 ? activeField.options.length - 1 : curIdx - 1);
              followUpState.answers[activeField.name] = activeField.options[nextIdx]!.value;
              followUpState.error = undefined;
              render();
              continue;
            }
            if ((key.name === 'up' || key.name === 'down') && activeField?.kind === 'boolean') {
              const cur = followUpState.answers[activeField.name];
              followUpState.answers[activeField.name] = cur === undefined ? true : !cur;
              followUpState.error = undefined;
              render();
              continue;
            }
            if (fields.length > 1) {
              const step = key.name === 'up' || (key.name === 'tab' && key.shift) ? -1 : 1;
              followUpState.activeFieldIdx = (followUpState.activeFieldIdx + fields.length + step) % fields.length;
              render();
              continue;
            }
          }
          continue;
        }
        if ((current.kind === 'report' || current.kind === 'account' || current.kind === 'account-switch' || current.kind === 'permissions') &&
          (key.name === 'page_up' || key.name === 'page_down' || key.name === 'home' || key.name === 'end')) {
          surface.scroll('layer.panel.overlay-scroll',
            key.name === 'page_up' ? 'page-up'
              : key.name === 'page_down' ? 'page-down'
              : key.name === 'home' ? 'start' : 'end');
          continue;
        }
        if (current.kind === 'settings') {
          const settingsView = buildSettingsViewData({
            userPrefs,
            metadata,
            modeOption: modeOption(),
            options,
            workspaceName,
            agent,
            disconnected,
            agentConnecting,
            busy,
            changingConfig,
            sessionOperation,
            updateStatus,
          });
          const step = stepSettingsKey(
            { page: prefsPage, focusRowId: prefsFocus, draft: panelDraft },
            key,
            settingsView.sections,
          );
          prefsPage = step.page;
          prefsFocus = step.focusRowId;
          panelDraft = step.draft;
          const effect = step.effect;
          if (effect) {
            if (effect.kind === 'prefs') {
              updatePrefs(effect.patch);
              continue;
            }
            if (effect.kind === 'config') {
              const opt = metadata.configOptions.find(candidate => candidate.id === effect.optionId);
              if (opt) changeConfig(opt, effect.value);
              continue;
            }
            if (effect.kind === 'open-config') {
              openPanel({ kind: 'config', id: effect.optionId });
              continue;
            }
            if (effect.kind === 'disabled') {
              showToast('Option locked', effect.reason);
              continue;
            }
            if (effect.kind === 'action') {
              if (effect.act === 'reset-prefs') {
                resetPrefs();
                continue;
              }
              if (effect.act === 'clear-remembered-model') {
                updatePrefs({ lastModel: undefined, lastThinking: undefined });
                showToast('Remembered model cleared', `Default for new sessions: ${DEFAULT_MODEL_ID} (${DEFAULT_THINKING_ID})`);
                continue;
              }
              if (effect.act === 'open-permissions') {
                openPanel({ kind: 'permissions' });
                continue;
              }
              if (effect.act === 'open-account') {
                openPanel({ kind: 'account' });
                continue;
              }
              if (effect.act === 'check-updates') {
                checkUpdatesManually();
                continue;
              }
            }
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
              stateManager.getActive().draft = { text: tpl.text, cursor: tpl.text.length };
              render();
              surface?.focus(DOCK_DRAFT_ID);
            };
          } else if (current.kind === 'find') {
            tabIds = ['all', 'message', 'tool', 'thought'];
            const activeConv = stateManager.getConversation();
            const matches = filterFindMatches(searchTranscriptCached(activeConv.entries, activeConv.revision, options.cwd, panelDraft.text), pickerTab);
            visibleIds = matches.map(m => m.id);
            activate = chosenId => {
              const match = matches.find(m => m.id === chosenId);
              if (match) inspectFindMatch(match);
            };
          } else if (current.kind === 'tasks') {
            const needle = panelDraft.text.trim().toLowerCase();
            const allTools = stateManager.getConversation().entries
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
            const sourceRows = pickerTab === 'workspace'
              ? listedSessions
              : (allListedSessions.length ? allListedSessions : listedSessions);
            const rows = new Map(sourceRows.map(row => [row.sessionId, row]));
            const sid = stateManager.activeSessionId;
            if (sid) rows.set(sid, sessionInfo.get(sid) ?? { sessionId: sid, cwd: options.cwd });
            tabIds = ['workspace', 'all', 'named'];
            visibleIds = filterSessionRows([...rows.values()], localNames, sid, sessionTitle, pickerTab, panelDraft.text, {
              currentCwd: options.cwd,
              previews: sessionPreviewCache,
            }).map(row => row.sessionId);
            activate = chosenId => {
              if (!changingConfig && !sessionOperation && !busy && !disconnected &&
                (chosenId === sid || agent?.capabilities.loadSession)) {
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
          const prevTab = pickerTab;
          const step = stepPickerKey({ tab: pickerTab, selected: pickerSelected, draft: panelDraft }, key, tabIds, visibleIds);
          pickerTab = step.tab;
          pickerSelected = step.selected;
          panelDraft = step.draft;
          if (current.kind === 'sessions' && pickerTab === 'all' && prevTab !== 'all' && agent?.capabilities.listSessions) {
            if (allSessionsPrefetchInFlight) {
              allSessionsLoading = true;
            } else if (!allListedSessions.length || Date.now() - allSessionsLoadedAt >= 15_000) {
              loadSessions(false, false, true);
              continue;
            } else {
              warmSessionSearchIndex(allListedSessions);
            }
          }
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
      if (key.alt && !key.ctrl && key.name === 'v') {
        attachClipboardImage();
        continue;
      }
      if (key.ctrl && !key.alt && !key.meta && (key.name === 'up' || key.name === 'down')) {
        jumpUserTurn(key.name === 'up' ? -1 : 1);
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
      const activeSt = stateManager.getActive();
      if (!key.ctrl && !key.alt && !key.meta && !key.shift && (key.name === 'up' || key.name === 'down')) {
        const dir = key.name === 'up' ? -1 : 1;
        const canStepHistory = dir === -1
          ? (activeSt.draft.text === '' || (activeSt.historyIndex !== undefined && isCursorOnFirstRow(activeSt.draft.text, activeSt.draft.cursor, wrapWidth)))
          : (activeSt.historyIndex !== undefined && isCursorOnLastRow(activeSt.draft.text, activeSt.draft.cursor, wrapWidth));
        if (canStepHistory && stepPromptHistory(dir)) {
          autocompleteDismissed = true;
          commandSelection = 0;
          fileSelection = 0;
          render();
          continue;
        }
      }
      const result = draftKey(activeSt.draft, key, { wrapWidth });
      recordUndo(activeSt.draft, result.draft);
      activeSt.draft = result.draft;
      autocompleteDismissed = false;
      commandSelection = 0;
      fileSelection = 0;
      if (result.send) send();
      else scheduleRender();
    }
  } catch (error) {
    if (!session) throw error;
    process.exitCode = 1;
    disconnected = true;
    busy = false;
    phase = 'Frontend failed';
    clearPermissions();
    stateManager.getConversation().notice(error instanceof Error ? error.message : String(error), true);
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
        replayCoordinator.dispose();
        renderController?.dispose();
        pathPresenceCache.clear();
      }
    }
  }
  return outcome;
}
