/** @jsxImportSource @stencil-hq/tern */
import { basename, resolve } from 'node:path';
import type { DiffHunk, EditEvent, JSX, PickerGroup, PickerItem, PrefsRow } from '@stencil-hq/tern';
import type { AuthMethodTerminal, SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { terminalLoginProblem, type AgentAuthentication, type AgentMetadata, type AgentOptions, type AgentSession } from './contracts';
import type { ToolStep, TranscriptEntry } from './model';
import { editDraft, type Draft } from './draft';
import { configLabel, configValues, commandCategory, filterCommands, modelOption, type Command } from './commands';
import type { AgentEntry, McpServerEntry, PluginEntry } from './extensions';
import type { OfficialReport } from './reports';
import { parseQuotaReport } from './reports';
import type { SessionPreview } from './history';
import type { QueuedPrompt } from './session-state';
import type { PromptTemplate } from './templates';
import { buildTurnOutline, filterTurnOutline } from './turn-outline';
import { formatAccountSnapshot } from './ui-session-helpers';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PREFS,
  DEFAULT_THINKING_ID,
  type ComposerLines,
  type DiffMode,
  type MotionPref,
  type ToolDisplay,
  type TranscriptDensity,
  type UserPrefs,
} from './prefs';
import { imageMimeType, type GitStatusEntry, type WorkspaceEntry } from './files';
import {
  buildTaskDetailText,
  buildUnifiedDiffHunks,
  extractToolImagePaths,
  extractToolInlineImages,
  extractToolLiveOutput,
  formatContextUsage,
  formatPathLabel,
  formatQuotaResetCountdown,
  formatQuotaResetDisplay,
  searchTranscript,
  searchTranscriptCached,
  selectSoonestQuotaReset,
  summarizeQuotaRows,
  summarizeToolCall,
  thinkingOption,
  type QuotaSummary,
  type ResponsiveLayout,
  type SessionDiffItem,
} from './ui-format';
import {
  matchLiveProcessToToolStep,
  matchToolStepToLiveProcess,
  type LiveProcessInfo,
} from './task-monitor';
import type { CommitEntry, CommitHeatmapGrid } from './git-history';
import {
  filterAgentsList,
  filterCommandsForTab,
  filterFindMatches,
  filterMcpServers,
  filterPluginsList,
  filterSessionRows,
  filterTemplatesList,
  groupSelectConfigOptions,
  sessionRowMatchesQuery,
} from './picker-nav';
import {
  cachedPathExists,
  ToolBody,
  type InspectTarget,
} from './transcript-view';
import {
  buildSettingsViewData,
  extractChangeBoolean,
  isPrefsPageId,
  patchForLocalPrefChange,
  patchForPrefRowReset,
  resolvePrefsFocusRow,
  stripConfigPrefix,
  type UpdateStatusState,
} from './settings-nav';
import type { FollowUpSessionState, QuestionAnswerValue } from './follow-up';

export type Panel =
  | { kind: 'commands' }
  | { kind: 'settings' }
  | { kind: 'config'; id: string }
  | { kind: 'report'; report: OfficialReport }
  | { kind: 'permissions' }
  | { kind: 'sessions' }
  | { kind: 'rename'; sessionId: string }
  | { kind: 'account' }
  | { kind: 'account-switch' }
  | { kind: 'changes' }
  | { kind: 'commits' }
  | { kind: 'find' }
  | { kind: 'turns' }
  | { kind: 'queue' }
  | { kind: 'tasks' }
  | { kind: 'task-inspect'; toolCallId?: string; pid?: number }
  | { kind: 'mcp' }
  | { kind: 'plugins' }
  | { kind: 'agents' }
  | { kind: 'templates' }
  | { kind: 'template-save' }
  | { kind: 'mcp-add' }
  | { kind: 'plugin-install' }
  | { kind: 'confirm'; title: string; detail: string; actionLabel: string; returnTo?: Panel; onConfirm(): void }
  | { kind: 'inspect'; title: string; subtitle?: string; item: InspectTarget }
  | { kind: 'keys' }
  | { kind: 'followup'; source: 'elicitation' | 'prompt'; title: string; message: string; urlMode?: { elicitationId: string; url: string } };

export interface Choice {
  label: string;
  detail: string;
  value?: string;
  disabled?: boolean;
  choose(): void;
}

export interface PanelRenderContext {
  panel: Panel;
  options: AgentOptions;
  workspaceName: string;
  rLayout: ResponsiveLayout;
  agent: AgentSession | undefined;
  metadata: AgentMetadata;
  authentication: AgentAuthentication;
  authenticationKnown: boolean;
  disconnected: boolean;
  agentConnecting: boolean;
  authBusy: boolean;
  busy: boolean;
  cancelling: boolean;
  changingConfig: boolean;
  startupSyncingConfig?: boolean;
  hasPendingPermissions?: boolean;
  extLoading: boolean;
  reportLoading: boolean;
  reportText: string;
  sessionsLoading: boolean;
  allSessionsLoading?: boolean;
  sessionOperation: string | undefined;
  activeSessionId: string;
  previousSessionId: string | undefined;
  listedSessions: readonly SessionInfo[];
  allListedSessions?: readonly SessionInfo[];
  nextSessionsCursor: string | undefined;
  allNextSessionsCursor?: string;
  sessionInfo: ReadonlyMap<string, SessionInfo>;
  localNames: ReadonlyMap<string, string | undefined>;
  sessionPreviews: ReadonlyMap<string, SessionPreview | null>;
  sessionSearchTexts?: ReadonlyMap<string, string>;
  sessionIndexing?: { done: number; total: number };
  mcpServers: readonly McpServerEntry[];
  pluginsList: readonly PluginEntry[];
  agentsList: readonly AgentEntry[];
  templatesList: readonly PromptTemplate[];
  gitChanges: readonly GitStatusEntry[];
  gitDiffCache: ReadonlyMap<string, { status: 'loading' | 'ready'; hunks: DiffHunk[]; error?: string }>;
  entries: readonly TranscriptEntry[];
  entriesRevision?: number;
  draftText: string;
  panelDraft: Draft;
  panelSelection: number;
  pickerTab: string;
  pickerSelected: string;
  prefsPage: string;
  prefsFocus?: string;
  updateStatus?: UpdateStatusState;
  usageTab: string;
  panelError: string;
  userPrefs: UserPrefs;
  commands: readonly Command[];
  sessionDiffs: readonly SessionDiffItem[];
  choices: readonly Choice[];
  loginMethod: AuthMethodTerminal | undefined;
  modeOption: SessionConfigOption | undefined;
  sessionTitle(id: string): string;
  pathExists?(targetPath: string): boolean;
  blobForImage(key: string, data: string, mimeType: string): string | undefined;
  onRender(): void;
  onFocus(target: string | null): void;
  onEditPanelDraft(event: EditEvent): void;
  onSetPickerTab(tab: string, clearSelected?: boolean): void;
  onSetPickerSelected(item: string): void;
  onSetPrefsPage(page: string): void;
  onSetPrefsFocus?(rowId: string): void;
  onSetUsageTab(tab: string): void;
  onOpenPanel(next: Panel): void;
  onClosePanel(): void;
  onUpdatePrefs(patch: Partial<UserPrefs>): void;
  onResetPrefs(): void;
  onCheckUpdates?(): void;
  onShowToast(text: string, sub?: string): void;
  onChangeConfig(option: SessionConfigOption, value: string | boolean): void;
  onChooseCommand(command: Command, args?: string, completeOnly?: boolean): void;
  onOpenConversation(id: string, mode?: 'load' | 'resume'): void;
  onNewConversation(): void;
  onLoadSessions(append?: boolean, allWorkspaces?: boolean): void;
  onCloseSavedSession(id: string): void;
  onRequestSessionPreview(id: string): void;
  onLoadExtensions(kind: 'mcp' | 'plugins' | 'agents'): void;
  onToggleMcp(name: string, enable: boolean): void;
  onRemoveMcp(name: string): void;
  onTogglePlugin(name: string, enable: boolean): void;
  onValidatePlugin(plugin: PluginEntry): void;
  onUninstallPlugin(name: string): void;
  onRemoveTemplate(name: string): void;
  onSetDraft(draft: Draft): void;
  onRefreshGitChanges(): void;
  onLoadGitDiffPreview(entry: GitStatusEntry): void;
  onInspectGitFile(filePath: string): void;
  onOpenInspect(title: string, target: InspectTarget, subtitle?: string): void;
  onOpenSplit(filePath: string, line?: number): void;
  onAttachFile(target: string | WorkspaceEntry): void;
  onInspectFindMatch(match: ReturnType<typeof searchTranscript>[number]): void;
  onJumpToEntry(entry: TranscriptEntry): void;
  onInspectDirPath(dirPath: string): void;
  onCopy(text: string): void;
  onStopTurn(): void;
  onLoadReport(report: OfficialReport): void;
  onOpenFollowUp?(title: string, message: string, fields: unknown): void;
  followUp?: FollowUpSessionState;
  onUpdateFollowUp?(updater: (state: FollowUpSessionState) => void): void;
  onSubmitFollowUp?(): void;
  onDeclineFollowUp?(): void;
  onCancelFollowUp?(): void;
  pinnedTurnIds?: ReadonlySet<string>;
  queuedPrompts?: readonly QueuedPrompt[];
  canSendQueueHead?: boolean;
  gitMutationBusy?: boolean;
  onJumpToTurn?(entryId: string, turnNumber: number): void;
  onTogglePinTurn?(entryId: string): void;
  onReusePrompt?(text: string): void;
  onMoveQueued?(fromIdx: number, toIdx: number): void;
  onPullQueued?(idx: number): void;
  onDropQueued?(idx: number): void;
  onSendQueuedHead?(): void;
  onStageGitPath?(filePath: string): void;
  onUnstageGitPath?(filePath: string): void;
  onDiscardGitPath?(filePath: string, status: string): void;
  liveProcesses?: readonly LiveProcessInfo[];
  onRefreshLiveProcesses?(): void;
  onKillProcess?(proc: LiveProcessInfo, force?: boolean): void;
  onInspectLiveTask?(target: { toolCallId?: string; pid?: number }): void;
  commitHistory?: CommitHeatmapGrid;
  commitHistoryLoading?: boolean;
  gitBranch?: string;
  onRefreshCommits?(): void;
  onInspectCommit?(commit: CommitEntry): void;
}

function renderPrefsPanel(ctx: PanelRenderContext): JSX.Element {
  const { metadata } = ctx;
  const activePage = isPrefsPageId(ctx.prefsPage) ? ctx.prefsPage : 'appearance';
  const viewData = buildSettingsViewData({
    userPrefs: ctx.userPrefs,
    metadata,
    modeOption: ctx.modeOption,
    options: ctx.options,
    workspaceName: ctx.workspaceName,
    agent: ctx.agent,
    disconnected: ctx.disconnected,
    agentConnecting: ctx.agentConnecting,
    busy: ctx.busy,
    changingConfig: ctx.changingConfig,
    startupSyncingConfig: ctx.startupSyncingConfig,
    authBusy: ctx.authBusy,
    hasPendingPermissions: ctx.hasPendingPermissions,
    sessionOperation: ctx.sessionOperation,
    updateStatus: ctx.updateStatus,
  });
  const focusedRow = resolvePrefsFocusRow(viewData.sections, activePage, ctx.prefsFocus, ctx.panelDraft.text);

  const handlePageEvent = (candidate: unknown): boolean => {
    if (typeof candidate === 'string' && isPrefsPageId(candidate)) {
      ctx.onSetPrefsPage(candidate);
      return true;
    }
    return false;
  };

  const handleRowReset = (rowId: unknown): void => {
    if (typeof rowId !== 'string') return;
    if (rowId === 'clearRememberedModel') {
      ctx.onUpdatePrefs({ lastModel: undefined, lastThinking: undefined });
      ctx.onShowToast('Remembered model cleared', `Default for new sessions: ${DEFAULT_MODEL_ID} (${DEFAULT_THINKING_ID})`);
      return;
    }
    const patch = patchForPrefRowReset(rowId);
    if (patch) {
      ctx.onUpdatePrefs(patch);
      ctx.onShowToast('Setting restored to default');
    }
  };

  return <prefs key="prefs" title="agy-tern settings" page={activePage}
    lead={viewData.leadByPage[activePage]} query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    focus={focusedRow}
    pages={viewData.pages}
    sections={viewData.sections}
    onSelect={event => {
      if (isPrefsPageId(event.item)) ctx.onSetPrefsPage(event.item);
    }}
    onAction={{
      close: ctx.onClosePanel,
      page: event => {
        if (!handlePageEvent(event.value)) handlePageEvent(event.item);
      },
      nav: event => {
        if (!handlePageEvent(event.value)) handlePageEvent(event.item);
      },
      tab: event => {
        if (!handlePageEvent(event.value)) handlePageEvent(event.item);
      },
      reset: event => handleRowReset(event.item ?? event.value),
      'reset-row': event => handleRowReset(event.item ?? event.value),
      'reset-all': ctx.onResetPrefs,
      'reset-prefs': ctx.onResetPrefs,
      'clear-remembered-model': () => handleRowReset('clearRememberedModel'),
      'check-updates': () => ctx.onCheckUpdates?.(),
      'open-permissions': () => ctx.onOpenPanel({ kind: 'permissions' }),
      'open-account': () => ctx.onOpenPanel({ kind: 'account' }),
      ...Object.fromEntries(metadata.configOptions.map(opt => [
        `open-config:${opt.id}`,
        () => ctx.onOpenPanel({ kind: 'config', id: opt.id }),
      ])),
    }}
    onChange={event => {
      const key = event.item ?? event.name;
      if ((!key || key === 'page' || event.name === 'page') && handlePageEvent(event.value)) {
        return;
      }
      if (!key) return;
      ctx.onSetPrefsFocus?.(key);

      const localPatch = patchForLocalPrefChange(key, event);
      if (localPatch) {
        ctx.onUpdatePrefs(localPatch);
        return;
      }

      const configId = stripConfigPrefix(key);
      if (configId) {
        const option = metadata.configOptions.find(candidate => candidate.id === configId);
        if (!option) return;
        const val = typeof event.value === 'string' ? event.value : extractChangeBoolean(event);
        if (val !== undefined) ctx.onChangeConfig(option, val);
      }
    }} />;
}

function renderSelectConfigPicker(ctx: PanelRenderContext, option: Extract<SessionConfigOption, { type: 'select' }>): JSX.Element {
  const query = ctx.panelDraft.text.trim().toLowerCase();
  const groups = groupSelectConfigOptions(option);
  const visibleGroups = groups
    .filter(group => ctx.pickerTab === 'all' || group.id === ctx.pickerTab)
    .map(group => ({
      ...group,
      options: group.options.filter(val =>
        `${val.name} ${val.value} ${val.description ?? ''}`.toLowerCase().includes(query)),
    }))
    .filter(group => group.options.length > 0);
  const flat = visibleGroups.flatMap(group => group.options.map(val => ({ group, val })));
  const selectedId = flat.some(entry => entry.val.value === ctx.pickerSelected)
    ? ctx.pickerSelected
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

  return <picker key="picker" size={ctx.rLayout.panelSize} title={option.name} icon={option.category === 'model' || option.id === 'model' ? 'model' : 'settings'}
    subtitle={option.description ?? 'Options supplied by the active agy ACP session'}
    placeholder={`Search ${option.name.toLowerCase()}...`}
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={tabs} tab={tabs ? ctx.pickerTab : undefined}
    order={order} items={items} selected={selectedId} current={[option.currentValue]}
    state={ctx.changingConfig ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.changingConfig ? `Applying ${option.name} through agy...` : ctx.panelError || (ctx.busy ? 'Wait for the active turn before changing this option.' : undefined)}
    empty="No matching options supplied by this agy session."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'apply', label: `Use ${option.name.toLowerCase()}`, primary: true, keys: ['enter'],
        disabled: (!highlighted || ctx.busy || ctx.changingConfig || ctx.disconnected) ? true : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={event => ctx.onChangeConfig(option, event.item)}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, false);
      },
      apply: () => {
        if (highlighted) ctx.onChangeConfig(option, highlighted.val.value);
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

function renderSessionsPicker(ctx: PanelRenderContext): JSX.Element {
  const workspaceMap = new Map(ctx.listedSessions.map(row => [row.sessionId, row]));
  const allMap = new Map((ctx.allListedSessions?.length ? ctx.allListedSessions : ctx.listedSessions).map(row => [row.sessionId, row]));
  if (ctx.activeSessionId) {
    const activeRow = ctx.sessionInfo.get(ctx.activeSessionId) ?? { sessionId: ctx.activeSessionId, cwd: ctx.options.cwd };
    workspaceMap.set(ctx.activeSessionId, activeRow);
    allMap.set(ctx.activeSessionId, activeRow);
  }
  const workspaceRows = [...workspaceMap.values()];
  const allRows = [...allMap.values()];
  const namedRows = allRows.filter(row => !!ctx.localNames.get(row.sessionId));
  const activeTab = ctx.pickerTab === 'all' || ctx.pickerTab === 'named' ? ctx.pickerTab : 'workspace';
  const sourceRows = activeTab === 'workspace' ? workspaceRows : allRows;
  const filterOpts = {
    currentCwd: ctx.options.cwd,
    previews: ctx.sessionPreviews,
    searchTexts: ctx.sessionSearchTexts,
  };
  const filtered = filterSessionRows(sourceRows, ctx.localNames, ctx.activeSessionId, ctx.sessionTitle, activeTab, ctx.panelDraft.text, filterOpts);
  const selectedId = filtered.some(row => row.sessionId === ctx.pickerSelected)
    ? ctx.pickerSelected
    : filtered[0]?.sessionId ?? '';
  const highlighted = filtered.find(row => row.sessionId === selectedId);
  const highlightedPreview = highlighted ? ctx.sessionPreviews.get(highlighted.sessionId) : undefined;
  if (highlighted && highlightedPreview === undefined) {
    const idToLoad = highlighted.sessionId;
    queueMicrotask(() => ctx.onRequestSessionPreview(idToLoad));
  }
  const needle = ctx.panelDraft.text.trim();
  const normalizedCwd = resolve(ctx.options.cwd);
  const items: PickerItem[] = filtered.map(row => {
    const matchInfo = needle
      ? sessionRowMatchesQuery(row, ctx.localNames, ctx.sessionTitle, needle, filterOpts)
      : { matched: true, chatOnlyMatch: false };
    const rowCwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : undefined;
    const isOtherWorkspace = Boolean(rowCwd && resolve(rowCwd) !== normalizedCwd);
    const folderLabel = rowCwd ? (basename(rowCwd) || rowCwd) : 'Unknown folder';
    const badges = [
      ...(row.sessionId === ctx.activeSessionId ? [{ text: 'Current', tone: 'success' as const }] : []),
      ...(ctx.previousSessionId && row.sessionId === ctx.previousSessionId ? [{ text: 'Previous', tone: 'info' as const }] : []),
      ...(ctx.localNames.get(row.sessionId) ? [{ text: 'Local name', tone: 'accent' as const }] : []),
      ...(matchInfo.chatOnlyMatch ? [{ text: 'Chat match', tone: 'info' as const }] : []),
    ];
    return {
      id: row.sessionId,
      label: ctx.sessionTitle(row.sessionId),
      detail: `${isOtherWorkspace ? `${folderLabel} · ` : ''}${row.updatedAt ?? 'No timestamp'} · ${row.sessionId.slice(0, 12)}`,
      badges: badges.length ? badges : undefined,
      disabled: row.sessionId !== ctx.activeSessionId && !ctx.agent?.capabilities.loadSession
        ? 'agy does not advertise loading previous sessions' : undefined,
      node: 'pv',
    };
  });
  const cannotSwitch = ctx.busy || ctx.changingConfig || !!ctx.sessionOperation || ctx.disconnected;
  const isAllTab = activeTab === 'all';
  const tabLoading = isAllTab ? Boolean(ctx.allSessionsLoading || ctx.sessionsLoading) : ctx.sessionsLoading;
  const activeCursor = isAllTab ? (ctx.allNextSessionsCursor ?? ctx.nextSessionsCursor) : ctx.nextSessionsCursor;
  const idxStatus = ctx.sessionIndexing && ctx.sessionIndexing.done < ctx.sessionIndexing.total
    ? `Indexing chat messages (${ctx.sessionIndexing.done}/${ctx.sessionIndexing.total})...`
    : undefined;
  const pv = highlightedPreview;
  const highlightedWorkspaceDiffers = Boolean(highlighted?.cwd && resolve(highlighted.cwd) !== normalizedCwd);
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Conversations" icon="history"
    subtitle={isAllTab
      ? `All workspaces (reported by agy)`
      : `${ctx.workspaceName} only (use All workspaces for other folders)`}
    placeholder="Search title, folder, ID, or chat..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'workspace', label: 'This folder', count: workspaceRows.length },
      { id: 'all', label: 'All workspaces', count: allRows.length },
      { id: 'named', label: 'Local named', count: namedRows.length },
    ]}
    tab={activeTab}
    order={filtered.map(row => row.sessionId)}
    items={items} selected={selectedId}
    current={ctx.activeSessionId ? [ctx.activeSessionId] : undefined}
    state={ctx.sessionOperation || tabLoading ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.sessionOperation
      ?? (tabLoading
        ? (isAllTab ? `Syncing conversations across all workspaces from agy (${allRows.length} loaded)...` : `Syncing workspace conversations from agy (${workspaceRows.length} loaded)...`)
        : ctx.panelError || idxStatus || (!ctx.agent?.capabilities.listSessions ? 'agy does not advertise session listing.' : undefined))}
    empty="No saved conversations matched your filter."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'new', label: 'New', disabled: cannotSwitch ? (true as const) : undefined },
      { id: 'rename', label: 'Rename', disabled: (cannotSwitch || !ctx.activeSessionId) ? (true as const) : undefined },
      ...(ctx.agent?.capabilities.listSessions ? [{ id: 'refresh', label: 'Refresh', disabled: cannotSwitch ? (true as const) : undefined }] : []),
      ...(activeCursor ? [{ id: 'more', label: 'Load older', disabled: cannotSwitch ? (true as const) : undefined }] : []),
      ...(ctx.agent?.capabilities.resumeSession ? [{ id: 'resume', label: 'Fast resume',
        disabled: (cannotSwitch || !highlighted || highlighted.sessionId === ctx.activeSessionId) ? (true as const) : undefined }] : []),
      ...(ctx.agent?.capabilities.closeSession ? [{ id: 'closeSession', label: 'Close session',
        disabled: (cannotSwitch || !highlighted || highlighted.sessionId === ctx.activeSessionId) ? (true as const) : undefined }] : []),
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'open', label: 'Open', primary: true, keys: ['enter'],
        disabled: (cannotSwitch || !highlighted || (highlighted.sessionId !== ctx.activeSessionId && !ctx.agent?.capabilities.loadSession)) ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={event => {
      if (!cannotSwitch) ctx.onOpenConversation(event.item);
    }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, false);
      },
      new: ctx.onNewConversation,
      rename: () => ctx.onOpenPanel({ kind: 'rename', sessionId: ctx.activeSessionId }),
      refresh: () => ctx.onLoadSessions(false, isAllTab),
      more: () => ctx.onLoadSessions(true, isAllTab),
      resume: () => {
        if (highlighted && !cannotSwitch) ctx.onOpenConversation(highlighted.sessionId, 'resume');
      },
      closeSession: () => {
        if (highlighted && !cannotSwitch && highlighted.sessionId !== ctx.activeSessionId) ctx.onCloseSavedSession(highlighted.sessionId);
      },
      open: () => {
        if (highlighted && !cannotSwitch) ctx.onOpenConversation(highlighted.sessionId, 'load');
      },
    }}>
    {highlighted && <col key="pv" gap="xs">
      <kv items={[
        { k: 'Title', v: ctx.sessionTitle(highlighted.sessionId) },
        { k: 'Session ID', v: highlighted.sessionId },
        {
          k: 'Origin workspace',
          v: highlighted.cwd
            ? (highlightedWorkspaceDiffers ? `${highlighted.cwd} (loads into current workspace)` : highlighted.cwd)
            : 'Not reported by agy',
        },
        { k: 'Updated', v: highlighted.updatedAt ?? 'Not reported' },
        { k: 'Label source', v: ctx.localNames.get(highlighted.sessionId) ? 'Local agy-tern label' : 'Reported by agy' },
        ...(pv ? [
          { k: 'Local history', v: `${pv.messageCount} message(s), ${pv.toolCount} tool(s) (${pv.source === 'cache' ? 'snapshot' : 'brain log'})` },
          ...(pv.lastUser ? [{ k: 'Last user', v: pv.lastUser }] : []),
          ...(pv.lastAgent ? [{ k: 'Last reply', v: pv.lastAgent }] : []),
        ] : pv === null
          ? [{ k: 'Local history', v: 'No local snapshot or brain log found yet' }]
          : [{ k: 'Local history', v: 'Checking local log...' }]),
      ]} />
    </col>}
  </picker>;
}

function renderChangesPicker(ctx: PanelRenderContext): JSX.Element {
  const query = ctx.panelDraft.text.trim().toLowerCase();
  const filteredEdits = ctx.sessionDiffs.filter(item => item.path.toLowerCase().includes(query));
  const allGit = ctx.gitChanges.filter(item => `${item.status} ${item.path}`.toLowerCase().includes(query));
  const modifiedGit = allGit.filter(item => item.status !== '?');
  const untrackedGit = allGit.filter(item => item.status === '?');
  const tab = ctx.pickerTab === 'git' || ctx.pickerTab === 'untracked' ? ctx.pickerTab : 'edits';
  const filteredGit = tab === 'untracked' ? untrackedGit : modifiedGit;
  const usingGit = tab !== 'edits';
  const order = usingGit ? filteredGit.map(item => `git:${item.path}`) : filteredEdits.map(item => item.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlightedEdit = usingGit ? undefined : filteredEdits.find(item => item.id === selectedId);
  const highlightedGit = usingGit ? filteredGit.find(item => `git:${item.path}` === selectedId) : undefined;
  const highlightedGitDiff = highlightedGit
    ? [...ctx.sessionDiffs].reverse().find(item => item.path === highlightedGit.path)
    : undefined;
  if (highlightedGit && !highlightedGitDiff) {
    const entryToLoad = highlightedGit;
    queueMicrotask(() => ctx.onLoadGitDiffPreview(entryToLoad));
  }
  const cachedGitDiff = highlightedGit ? ctx.gitDiffCache.get(highlightedGit.path) : undefined;
  const highlightedPath = highlightedEdit?.path ?? highlightedGit?.path;
  const activeDiffText = (() => {
    const targetEdit = highlightedEdit ?? highlightedGitDiff;
    if (targetEdit) {
      if (targetEdit.hunks.length) return targetEdit.hunks.flatMap(h => h.lines).join('\n');
      if (targetEdit.newFileText !== undefined) return targetEdit.newFileText;
    }
    if (cachedGitDiff?.hunks.length) return cachedGitDiff.hunks.flatMap(h => h.lines).join('\n');
    return undefined;
  })();

  const items: PickerItem[] = usingGit
    ? filteredGit.map(entry => ({
      id: `git:${entry.path}`,
      label: basename(entry.path),
      detail: entry.path,
      badges: [
        ...(entry.staged ? [{ text: 'Staged', tone: 'success' as const }] : []),
        {
          text: entry.status,
          tone: entry.status === 'D' ? 'error' as const : entry.status === '?' || entry.status === 'A' ? 'success' as const : 'accent' as const,
        },
      ],
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

  const canStage = !!highlightedGit && (!highlightedGit.staged || !!highlightedGit.unstaged || highlightedGit.status === '?') && !!ctx.onStageGitPath && !ctx.gitMutationBusy;
  const canUnstage = !!highlightedGit && !!highlightedGit.staged && !!ctx.onUnstageGitPath && !ctx.gitMutationBusy;
  const canDiscard = !!highlightedGit && !!ctx.onDiscardGitPath && !ctx.gitMutationBusy;

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Changes" icon="diff"
    subtitle="Session edits, modified tracked files, and untracked paths"
    placeholder="Filter modified paths..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'edits', label: 'Session edits', count: ctx.sessionDiffs.length },
      { id: 'git', label: 'Modified', count: ctx.gitChanges.filter(item => item.status !== '?').length },
      { id: 'untracked', label: 'Untracked', count: ctx.gitChanges.filter(item => item.status === '?').length },
    ]}
    tab={tab}
    order={order} items={items} selected={selectedId}
    state="ready"
    empty={tab === 'untracked'
      ? 'No untracked files matching filter.'
      : usingGit
        ? 'No tracked git changes matching filter.'
        : 'No file edits recorded in this conversation yet.'}
    preview={highlightedPath ? 'below' : 'none'}
    actions={[
      { id: 'refresh', label: 'Refresh' },
      { id: 'commits', label: 'Commit map' },
      ...(usingGit ? [
        ...(canUnstage ? [{ id: 'unstage', label: 'Unstage' }] : []),
        ...(canStage ? [{ id: 'stage', label: 'Stage' }] : []),
        { id: 'discard', label: 'Discard', disabled: !canDiscard ? (true as const) : undefined },
      ] : []),
      { id: 'copy-diff', label: activeDiffText ? 'Copy diff' : 'Copy path', disabled: !highlightedPath ? (true as const) : undefined },
      { id: 'inspect', label: 'Fullscreen', disabled: !highlightedPath ? (true as const) : undefined },
      { id: 'split', label: 'Tern split',
        disabled: !highlightedPath || !(ctx.pathExists ?? cachedPathExists)(resolve(ctx.options.cwd, highlightedPath)) ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'attach', label: 'Attach to draft', primary: true, keys: ['enter'],
        disabled: !highlightedPath ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => {
      if (highlightedPath) { ctx.onClosePanel(); ctx.onAttachFile(highlightedPath); }
    }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      refresh: ctx.onRefreshGitChanges,
      commits: () => ctx.onOpenPanel({ kind: 'commits' }),
      stage: () => {
        if (highlightedGit && ctx.onStageGitPath) ctx.onStageGitPath(highlightedGit.path);
      },
      unstage: () => {
        if (highlightedGit && ctx.onUnstageGitPath) ctx.onUnstageGitPath(highlightedGit.path);
      },
      discard: () => {
        if (!highlightedGit || !ctx.onDiscardGitPath) return;
        const target = highlightedGit;
        ctx.onOpenPanel({
          kind: 'confirm',
          title: target.status === '?' ? 'Delete untracked file?' : 'Discard git changes?',
          detail: target.status === '?'
            ? `Permanently deletes untracked path "${target.path}" from workspace.`
            : `Reverts working-tree modifications in "${target.path}" to HEAD.`,
          actionLabel: target.status === '?' ? 'Delete file' : 'Discard changes',
          returnTo: { kind: 'changes' },
          onConfirm: () => ctx.onDiscardGitPath?.(target.path, target.status),
        });
      },
      'copy-diff': () => {
        if (activeDiffText) ctx.onCopy(activeDiffText);
        else if (highlightedPath) ctx.onCopy(highlightedPath);
      },
      split: () => {
        const line = highlightedEdit?.hunks[0]?.newStart ?? cachedGitDiff?.hunks[0]?.newStart;
        if (highlightedPath) ctx.onOpenSplit(highlightedPath, line);
      },
      inspect: () => {
        const targetEdit = highlightedEdit ?? highlightedGitDiff;
        if (targetEdit) {
          if (targetEdit.newFileText !== undefined) {
            ctx.onOpenInspect(basename(targetEdit.path), { type: 'file', path: targetEdit.path, content: targetEdit.newFileText }, targetEdit.path);
          } else {
            ctx.onOpenInspect(basename(targetEdit.path), { type: 'diff', path: targetEdit.path, hunks: targetEdit.hunks }, targetEdit.path);
          }
        } else if (highlightedGit && cachedGitDiff?.hunks.length) {
          ctx.onOpenInspect(basename(highlightedGit.path), { type: 'diff', path: highlightedGit.path, hunks: cachedGitDiff.hunks }, highlightedGit.path);
        } else if (highlightedGit) {
          ctx.onInspectGitFile(highlightedGit.path);
        }
      },
      attach: () => {
        if (highlightedPath) { ctx.onClosePanel(); ctx.onAttachFile(highlightedPath); }
      },
    }}>
    {highlightedEdit && (highlightedEdit.newFileText !== undefined
      ? <code key="pv" numbers path={highlightedEdit.path}>{highlightedEdit.newFileText}</code>
      : highlightedEdit.hunks.length
        ? <diff key="pv" mode={ctx.userPrefs.diffMode} path={highlightedEdit.path} hunks={highlightedEdit.hunks} />
        : <kv key="pv" items={[{ k: 'File', v: highlightedEdit.path }, { k: 'Status', v: 'No line delta recorded' }]} />)}
    {!highlightedEdit && highlightedGit && (highlightedGitDiff
      ? (highlightedGitDiff.newFileText !== undefined
        ? <code key="pv" numbers path={highlightedGitDiff.path}>{highlightedGitDiff.newFileText}</code>
        : <diff key="pv" mode={ctx.userPrefs.diffMode} path={highlightedGitDiff.path} hunks={highlightedGitDiff.hunks} />)
      : cachedGitDiff?.status === 'loading'
        ? <spinner key="pv" label={`Reading git diff for ${highlightedGit.path}`} />
        : cachedGitDiff?.hunks.length
          ? <diff key="pv" mode={ctx.userPrefs.diffMode} path={highlightedGit.path} hunks={cachedGitDiff.hunks} />
          : <kv key="pv" items={[
            { k: 'Path', v: highlightedGit.path },
            { k: 'Git status', v: highlightedGit.status },
            { k: 'Diff', v: 'No text diff (untracked or binary)' },
          ]} />)}
  </picker>;
}

function renderFindPicker(ctx: PanelRenderContext): JSX.Element {
  const checkPathExists = ctx.pathExists ?? cachedPathExists;
  const matches = searchTranscriptCached(ctx.entries, ctx.entriesRevision ?? ctx.entries.length, ctx.options.cwd, ctx.panelDraft.text);
  const tabs = [
    { id: 'all', label: 'All', count: matches.length },
    { id: 'message', label: 'Messages', count: matches.filter(m => m.kind === 'message').length },
    { id: 'tool', label: 'Tools & Diffs', count: matches.filter(m => m.kind === 'tool').length },
    { id: 'thought', label: 'Thoughts', count: matches.filter(m => m.kind === 'thought').length },
  ];
  const filtered = filterFindMatches(matches, ctx.pickerTab);
  const order = filtered.map(m => m.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = filtered.find(m => m.id === selectedId);
  const items: PickerItem[] = filtered.map(m => ({
    id: m.id,
    label: m.label,
    detail: m.detail,
    badges: [{ text: m.kind.toUpperCase(), tone: m.kind === 'tool' ? 'info' as const : m.kind === 'plan' ? 'accent' as const : 'neutral' as const }],
    node: 'pv',
  }));
  const hlImgPath = highlighted?.entry.type === 'tool'
    ? extractToolImagePaths(highlighted.entry.call, ctx.options.cwd).find(checkPathExists)
    : undefined;

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Find" icon="slash"
    subtitle="Search transcript entries"
    placeholder="Type keywords to filter transcript..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={tabs}
    tab={ctx.pickerTab}
    order={order} items={items} selected={selectedId}
    state="ready"
    empty={ctx.entries.length ? 'No transcript entries match your search.' : 'Transcript is empty.'}
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'copy', label: 'Copy', disabled: !highlighted ? (true as const) : undefined },
      { id: 'jump', label: 'Jump to chat', disabled: !highlighted ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'inspect', label: 'Inspect', primary: true, keys: ['enter'],
        disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (highlighted) ctx.onInspectFindMatch(highlighted); }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      copy: () => {
        if (highlighted) ctx.onCopy(highlighted.preview || highlighted.detail);
      },
      jump: () => {
        if (highlighted) ctx.onJumpToEntry(highlighted.entry);
      },
      inspect: () => { if (highlighted) ctx.onInspectFindMatch(highlighted); },
    }}>
    {highlighted && <col key="pv" gap="xs">
      <text><span s="muted">{highlighted.detail}</span></text>
      {hlImgPath && <col align="center"><media path={hlImgPath} /></col>}
      <md>{(highlighted.preview || highlighted.detail).slice(0, 1200)}</md>
    </col>}
  </picker>;
}

function renderTurnsPicker(ctx: PanelRenderContext): JSX.Element {
  const allTurns = buildTurnOutline(ctx.entries, ctx.pinnedTurnIds);
  const tab = ctx.pickerTab === 'pinned' ? 'pinned' : 'all';
  const filtered = filterTurnOutline(allTurns, tab, ctx.panelDraft.text);
  const order = filtered.map(item => item.entryId);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = filtered.find(item => item.entryId === selectedId);
  const pinnedCount = allTurns.filter(item => item.pinned).length;

  const items: PickerItem[] = filtered.map(item => ({
    id: item.entryId,
    label: `#${item.turnNumber} ${item.promptPreview}`,
    detail: item.replyPreview ?? 'Awaiting or no text reply',
    badges: [
      ...(item.pinned ? [{ text: 'Pinned', tone: 'accent' as const }] : []),
      ...(item.toolCount ? [{ text: `${item.toolCount} tools`, tone: 'info' as const }] : []),
      ...(item.hasError ? [{ text: 'Error', tone: 'error' as const }] : []),
    ],
    node: 'pv',
  }));

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Turn outline" icon="history"
    subtitle="Jump to any prompt turn, filter pinned turns, or reuse a prompt"
    placeholder="Filter turns by #N, prompt, or reply..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'all', label: 'All turns', count: allTurns.length },
      { id: 'pinned', label: 'Pinned', count: pinnedCount },
    ]}
    tab={tab}
    order={order} items={items} selected={selectedId}
    state="ready"
    empty={tab === 'pinned' ? 'No pinned turns yet.' : 'No prompt turns in this conversation yet.'}
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'pin', label: highlighted?.pinned ? 'Unpin' : 'Pin turn', disabled: !highlighted ? (true as const) : undefined },
      { id: 'reuse', label: 'Reuse prompt', disabled: !highlighted ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'jump', label: 'Jump to turn', primary: true, keys: ['enter'], disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => {
      if (highlighted) ctx.onJumpToTurn?.(highlighted.entryId, highlighted.turnNumber);
    }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      pin: () => {
        if (highlighted) ctx.onTogglePinTurn?.(highlighted.entryId);
      },
      reuse: () => {
        if (highlighted) {
          ctx.onClosePanel();
          ctx.onReusePrompt?.(highlighted.promptText);
        }
      },
      jump: () => {
        if (highlighted) ctx.onJumpToTurn?.(highlighted.entryId, highlighted.turnNumber);
      },
    }}>
    {highlighted && <col key="pv" gap="xs">
      <kv items={[
        { k: 'Turn', v: `#${highlighted.turnNumber}${highlighted.pinned ? ' [Pinned]' : ''}${highlighted.time ? ` · ${highlighted.time}` : ''}` },
        { k: 'Activity', v: `${highlighted.toolCount} tool(s), ${highlighted.thoughtCount} thought(s)${highlighted.hasError ? ', error notice' : ''}` },
      ]} />
      <md>{highlighted.promptText.slice(0, 900)}</md>
      {highlighted.replyPreview && <text wrap="word"><span s="muted">Reply: {highlighted.replyPreview}</span></text>}
    </col>}
  </picker>;
}

function renderQueuePicker(ctx: PanelRenderContext): JSX.Element {
  const queue = ctx.queuedPrompts ?? [];
  const query = ctx.panelDraft.text.trim().toLowerCase();
  const indexed = queue.map((item, idx) => ({ item, idx }));
  const filtered = query
    ? indexed.filter(({ item, idx }) => `#${idx + 1} ${item.text} ${item.files.join(' ')} ${item.dirs.join(' ')}`.toLowerCase().includes(query))
    : indexed;
  const order = filtered.map(({ item }) => item.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlightedEntry = filtered.find(({ item }) => item.id === selectedId);
  const highlightedIdx = highlightedEntry?.idx ?? -1;
  const highlighted = highlightedEntry?.item;

  const items: PickerItem[] = filtered.map(({ item, idx }) => {
    const snippet = item.text.trim().replace(/\s+/g, ' ').slice(0, 64) || '(attachments only)';
    return {
      id: item.id,
      label: `#${idx + 1} ${snippet}`,
      detail: `${item.files.length} file(s), ${item.dirs.length} dir(s), ${item.images.length} image(s)`,
      badges: idx === 0 ? [{ text: 'Next', tone: 'accent' as const }] : undefined,
      node: 'pv',
    };
  });

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Prompt queue" icon="edit"
    subtitle="Reorder, edit in draft, or remove queued follow-up prompts"
    placeholder="Filter queued prompts..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    order={order} items={items} selected={selectedId}
    state="ready"
    empty="No prompts queued. Press Enter while busy to queue a follow-up prompt."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      ...(ctx.canSendQueueHead && queue.length > 0 ? [{ id: 'send', label: 'Send #1' }] : []),
      { id: 'up', label: 'Move up', disabled: highlightedIdx <= 0 ? (true as const) : undefined },
      { id: 'down', label: 'Move down', disabled: highlightedIdx < 0 || highlightedIdx >= queue.length - 1 ? (true as const) : undefined },
      { id: 'drop', label: 'Drop', disabled: highlightedIdx < 0 ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'edit', label: 'Edit in draft', primary: true, keys: ['enter'], disabled: highlightedIdx < 0 ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => {
      if (highlightedIdx >= 0) ctx.onPullQueued?.(highlightedIdx);
    }}
    onAction={{
      close: ctx.onClosePanel,
      send: () => ctx.onSendQueuedHead?.(),
      up: () => {
        if (highlightedIdx > 0 && highlighted) {
          ctx.onMoveQueued?.(highlightedIdx, highlightedIdx - 1);
          ctx.onSetPickerSelected(highlighted.id);
        }
      },
      down: () => {
        if (highlightedIdx >= 0 && highlightedIdx < queue.length - 1 && highlighted) {
          ctx.onMoveQueued?.(highlightedIdx, highlightedIdx + 1);
          ctx.onSetPickerSelected(highlighted.id);
        }
      },
      drop: () => {
        if (highlightedIdx >= 0) ctx.onDropQueued?.(highlightedIdx);
      },
      edit: () => {
        if (highlightedIdx >= 0) ctx.onPullQueued?.(highlightedIdx);
      },
    }}>
    {highlighted && <col key="pv" gap="xs">
      <kv items={[
        { k: 'Position', v: `#${highlightedIdx + 1} of ${queue.length}` },
        { k: 'Attachments', v: `${highlighted.files.length} file(s), ${highlighted.dirs.length} dir(s), ${highlighted.images.length} image(s)` },
      ]} />
      <md>{highlighted.text.slice(0, 900) || '(attachments only)'}</md>
    </col>}
  </picker>;
}

function renderInspectOverlay(ctx: PanelRenderContext, p: Extract<Panel, { kind: 'inspect' }>): JSX.Element {
  const item = p.item;
  const isMedia = item.type === 'image-path' || item.type === 'image-blob';
  const isDir = item.type === 'dir';
  const overlaySize = isMedia ? ctx.rLayout.panelSize : ctx.rLayout.inspectSize;
  const bodyMaxH = ctx.rLayout.inspectBodyMaxH;
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
    end={<button keys={['esc']} variant="quiet" onClick={ctx.onClosePanel}>Close</button>}
    foot={<row gap="xs" justify="between" align="center" wrap>
      <text><span s="muted">{item.type === 'file' && item.truncated ? 'Preview truncated at 64 KB · '
        : isDir && item.preview.truncated ? `Showing ${item.preview.entries.length} of ${item.preview.totalCount} entries · ` : ''}Up/Down/PgUp/PgDn scroll · c copy · s split · a attach · Esc close</span></text>
      <row gap="xs">
        {parentInspectDir && <button size="sm" icon="back" onClick={() => ctx.onInspectDirPath(parentInspectDir)}>Up</button>}
        {item.type === 'diff' && <button size="sm" onClick={() => {
          const next: DiffMode = ctx.userPrefs.diffMode === 'auto' ? 'unified' : ctx.userPrefs.diffMode === 'unified' ? 'split' : 'auto';
          ctx.onUpdatePrefs({ diffMode: next });
        }}>Layout: {ctx.userPrefs.diffMode}</button>}
        {copyText !== undefined && <button size="sm" icon="copy" onClick={() => ctx.onCopy(copyText)}>Copy</button>}
        {attachablePath && !isMedia && (ctx.pathExists ?? cachedPathExists)(resolve(ctx.options.cwd, attachablePath.replace(/\/+$/, ''))) && <>
          {!isDir && <button size="sm" icon="split" onClick={() => ctx.onOpenSplit(attachablePath)}>Tern split</button>}
          <button size="sm" variant="primary" onClick={() => {
            ctx.onClosePanel();
            ctx.onAttachFile(attachablePath);
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
      ? <scroll key="inspect-scroll" bar="always" max={{ h: bodyMaxH }}><diff mode={ctx.userPrefs.diffMode} path={item.path} hunks={item.hunks} /></scroll>
      : <text><span s="muted">No diff hunks recorded.</span></text>)}
    {item.type === 'file' && <scroll key="inspect-scroll" bar="always" max={{ h: bodyMaxH }}>
      <code numbers path={item.path}>{item.content}</code>
    </scroll>}
    {isDir && <scroll key="inspect-scroll" bar="always" max={{ h: bodyMaxH }}>
      <col gap="xs">
        <kv items={[
          { k: 'Directory', v: item.preview.path },
          { k: 'Items', v: String(item.preview.totalCount) },
        ]} />
        <list max={{ lines: ctx.rLayout.dirListMaxLines }} empty="Directory is empty.">
          {item.preview.entries.map(entry => <item key={entry.path}
            icon={entry.kind === 'dir' ? 'folder' : imageMimeType(entry.name) ? 'file-image' : 'file'}
            label={entry.kind === 'dir' ? `${entry.name}/` : entry.name}
            detail={entry.ignored ? `${entry.path} [gitignored]` : entry.path}
            value={entry.ignored ? 'gitignored' : entry.kind === 'dir' ? 'Dir' : 'File'}
            onClick={() => {
              if (entry.kind === 'dir') ctx.onInspectDirPath(entry.path);
              else {
                ctx.onClosePanel();
                ctx.onAttachFile(entry.path);
              }
            }} />)}
        </list>
      </col>
    </scroll>}
  </overlay>;
}

function renderCommandsPicker(ctx: PanelRenderContext): JSX.Element {
  const all = filterCommands(ctx.commands, ctx.panelDraft.text);
  const tabs = [
    { id: 'all', label: 'All', count: all.length },
    { id: 'frontend', label: 'Frontend', count: all.filter(c => commandCategory(c) === 'frontend').length },
    { id: 'workflow', label: 'Workflows', count: all.filter(c => commandCategory(c) === 'workflow').length },
    { id: 'skill', label: 'Skills', count: all.filter(c => commandCategory(c) === 'skill').length },
  ];
  const filtered = filterCommandsForTab(ctx.commands, ctx.pickerTab, ctx.panelDraft.text);
  const order = filtered.map(c => c.name);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
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
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Commands & skills" icon="slash"
    subtitle="Frontend, workflows, and skills"
    placeholder="Filter commands by name or description..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={tabs} tab={ctx.pickerTab} order={order} items={items} selected={selectedId}
    state="ready"
    empty="No commands match your filter."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'fill', label: 'Fill draft', disabled: !highlighted ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'run', label: highlighted?.local ? 'Open' : highlighted?.hint ? 'Prepare' : 'Send', primary: true, keys: ['enter'],
        disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (highlighted) ctx.onChooseCommand(highlighted); }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      fill: () => { if (highlighted) ctx.onChooseCommand(highlighted, '', true); },
      run: () => { if (highlighted) ctx.onChooseCommand(highlighted); },
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

function renderMcpPicker(ctx: PanelRenderContext): JSX.Element {
  const visible = filterMcpServers(ctx.mcpServers, 'all', ctx.panelDraft.text);
  const filtered = filterMcpServers(ctx.mcpServers, ctx.pickerTab, ctx.panelDraft.text);
  const order = filtered.map(s => s.name);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
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
  const canToggle = !!highlighted && !ctx.extLoading;
  const targetEnabled = highlighted?.status !== 'enabled';
  return <picker key="picker" size={ctx.rLayout.panelSize} title="MCP servers" icon="settings"
    subtitle="Configured via agy mcp CLI"
    placeholder="Filter MCP servers..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'all', label: 'All', count: visible.length },
      { id: 'enabled', label: 'Enabled', count: visible.filter(s => s.status === 'enabled').length },
      { id: 'disabled', label: 'Disabled', count: visible.filter(s => s.status !== 'enabled').length },
    ]}
    tab={ctx.pickerTab} order={order} items={items} selected={selectedId}
    state={ctx.extLoading ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.extLoading ? 'Querying official `agy mcp`...' : (ctx.panelError || undefined)}
    empty="No MCP servers configured."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'refresh', label: 'Refresh', disabled: ctx.extLoading ? (true as const) : undefined },
      { id: 'add', label: 'Add', disabled: ctx.extLoading ? (true as const) : undefined },
      { id: 'remove', label: 'Remove', disabled: !canToggle ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'toggle', label: highlighted ? (targetEnabled ? 'Enable' : 'Disable') : 'Toggle', primary: true, keys: ['enter'],
        disabled: !canToggle ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (canToggle && highlighted) ctx.onToggleMcp(highlighted.name, targetEnabled); }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      refresh: () => ctx.onLoadExtensions('mcp'),
      add: () => ctx.onOpenPanel({ kind: 'mcp-add' }),
      remove: () => {
        if (!canToggle || !highlighted) return;
        ctx.onOpenPanel({
          kind: 'confirm',
          title: `Remove MCP server "${highlighted.name}"?`,
          detail: `Runs \`agy mcp remove ${highlighted.name}\` via official CLI.`,
          actionLabel: 'Remove MCP server',
          returnTo: { kind: 'mcp' },
          onConfirm: () => ctx.onRemoveMcp(highlighted.name),
        });
      },
      toggle: () => { if (canToggle && highlighted) ctx.onToggleMcp(highlighted.name, targetEnabled); },
    }}>
    {highlighted && <kv key="pv" items={[
      { k: 'Server', v: highlighted.name },
      { k: 'Transport', v: highlighted.type },
      { k: 'Status', v: highlighted.status },
      { k: 'Command / URL', v: highlighted.target || 'Not reported' },
    ]} />}
  </picker>;
}

function renderPluginsPicker(ctx: PanelRenderContext): JSX.Element {
  const visible = filterPluginsList(ctx.pluginsList, 'all', ctx.panelDraft.text);
  const filtered = filterPluginsList(ctx.pluginsList, ctx.pickerTab, ctx.panelDraft.text);
  const order = filtered.map(p => p.name);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
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
  const canToggle = !!highlighted && !ctx.extLoading;
  const targetEnabled = !(highlighted?.enabled ?? false);
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Plugins & skills" icon="compass"
    subtitle="Installed Antigravity plugins via official `agy plugin list --json`"
    placeholder="Filter plugins or skill names..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'all', label: 'All', count: visible.length },
      { id: 'enabled', label: 'Enabled', count: visible.filter(p => p.enabled).length },
      { id: 'disabled', label: 'Disabled', count: visible.filter(p => !p.enabled).length },
    ]}
    tab={ctx.pickerTab} order={order} items={items} selected={selectedId}
    state={ctx.extLoading ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.extLoading ? 'Reading installed plugins...' : (ctx.panelError || undefined)}
    empty="No plugins match your filter."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'refresh', label: 'Refresh', disabled: ctx.extLoading ? (true as const) : undefined },
      ...(highlighted?.enabled && highlighted.skills.length ? [{ id: 'useSkill', label: `Use /${highlighted.skills[0]}`, disabled: ctx.extLoading ? (true as const) : undefined }] : []),
      { id: 'validate', label: 'Validate', disabled: !highlighted?.path || ctx.extLoading ? (true as const) : undefined },
      { id: 'install', label: 'Install', disabled: ctx.extLoading ? (true as const) : undefined },
      { id: 'uninstall', label: 'Uninstall', disabled: !canToggle ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'toggle', label: highlighted ? (targetEnabled ? 'Enable' : 'Disable') : 'Toggle', primary: true, keys: ['enter'],
        disabled: !canToggle ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (canToggle && highlighted) ctx.onTogglePlugin(highlighted.name, targetEnabled); }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, true);
      },
      refresh: () => ctx.onLoadExtensions('plugins'),
      useSkill: () => {
        const skillName = highlighted?.skills[0];
        if (!skillName) return;
        ctx.onClosePanel();
        ctx.onSetDraft({ text: `/${skillName} `, cursor: skillName.length + 2 });
        ctx.onFocus('dock.draft');
      },
      validate: () => { if (highlighted && !ctx.extLoading) ctx.onValidatePlugin(highlighted); },
      install: () => ctx.onOpenPanel({ kind: 'plugin-install' }),
      uninstall: () => {
        if (!canToggle || !highlighted) return;
        ctx.onOpenPanel({
          kind: 'confirm',
          title: `Uninstall plugin "${highlighted.name}"?`,
          detail: `Runs \`agy plugin uninstall ${highlighted.name}\` via official CLI.`,
          actionLabel: 'Uninstall plugin',
          returnTo: { kind: 'plugins' },
          onConfirm: () => ctx.onUninstallPlugin(highlighted.name),
        });
      },
      toggle: () => { if (canToggle && highlighted) ctx.onTogglePlugin(highlighted.name, targetEnabled); },
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

function renderAgentsPicker(ctx: PanelRenderContext): JSX.Element {
  const extraDirs = ctx.options.additionalDirectories ?? [];
  const filtered = filterAgentsList(ctx.agentsList, ctx.panelDraft.text);
  const order = filtered.map(a => a.name);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = filtered.find(a => a.name === selectedId);
  const items: PickerItem[] = filtered.map(a => ({
    id: a.name,
    label: a.name,
    detail: a.detail || 'Custom agy agent',
    badges: ctx.options.agentName === a.name ? [{ text: 'Active', tone: 'success' as const }] : undefined,
    node: 'pv',
  }));
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Agents & workspace scope" icon="tern"
    subtitle={`Active profile: ${ctx.options.agentName ?? 'Default'} · Workspace roots: ${1 + extraDirs.length}`}
    placeholder="Filter agents..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[{ id: 'all', label: 'Configured agents', count: filtered.length }]}
    tab="all" order={order} items={items} selected={selectedId}
    state={ctx.extLoading ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.extLoading ? 'Checking `agy agent`...' : (ctx.panelError || undefined)}
    empty="No custom agents reported by `agy agent`. Launch with `--agent <name>` or `--add-dir <dir>` to customize scope."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'refresh', label: 'Refresh', disabled: ctx.extLoading ? (true as const) : undefined },
      { id: 'close', label: 'Close', primary: true, keys: ['esc'] },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onAction={{
      close: ctx.onClosePanel,
      refresh: () => ctx.onLoadExtensions('agents'),
    }}>
    {highlighted && <kv key="pv" items={[
      { k: 'Agent', v: highlighted.name },
      { k: 'Details', v: highlighted.detail || 'Configured in official agy CLI' },
      { k: 'Launch flag', v: `agy-tern --agent ${highlighted.name}` },
      ...(extraDirs.length ? [{ k: 'Extra roots (--add-dir)', v: extraDirs.join(', ') }] : []),
    ]} />}
  </picker>;
}

function renderTemplatesPicker(ctx: PanelRenderContext): JSX.Element {
  const filtered = filterTemplatesList(ctx.templatesList, ctx.panelDraft.text);
  const order = filtered.map(tpl => tpl.name);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = filtered.find(tpl => tpl.name === selectedId);
  const items: PickerItem[] = filtered.map(tpl => ({
    id: tpl.name,
    label: tpl.name,
    detail: tpl.text.replace(/\s+/g, ' ').slice(0, 72),
    node: 'pv',
  }));
  const insertTemplate = (tpl: PromptTemplate): void => {
    ctx.onClosePanel();
    ctx.onSetDraft({ text: tpl.text, cursor: tpl.text.length });
    ctx.onFocus('dock.draft');
  };
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Workspace prompt templates" icon="edit"
    subtitle={`Saved locally per workspace (${ctx.workspaceName})`}
    placeholder="Filter templates..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[{ id: 'all', label: 'Templates', count: filtered.length }]}
    tab="all" order={order} items={items} selected={selectedId}
    state={ctx.extLoading ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.panelError || undefined}
    empty="No workspace prompt templates saved yet. Draft a prompt first, then click Save draft."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'save', label: 'Save draft', disabled: !ctx.draftText.trim() || ctx.extLoading ? (true as const) : undefined },
      { id: 'delete', label: 'Delete', disabled: !highlighted || ctx.extLoading ? (true as const) : undefined },
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'insert', label: 'Insert into draft', primary: true, keys: ['enter'],
        disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (highlighted) insertTemplate(highlighted); }}
    onAction={{
      close: ctx.onClosePanel,
      save: () => ctx.onOpenPanel({ kind: 'template-save' }),
      delete: () => {
        if (!highlighted) return;
        ctx.onOpenPanel({
          kind: 'confirm',
          title: `Delete template "${highlighted.name}"?`,
          detail: 'Removes this saved prompt snippet from local workspace storage.',
          actionLabel: 'Delete template',
          returnTo: { kind: 'templates' },
          onConfirm: () => ctx.onRemoveTemplate(highlighted.name),
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

function renderTasksPicker(ctx: PanelRenderContext): JSX.Element {
  const query = ctx.panelDraft.text.trim().toLowerCase();
  const liveProcs = ctx.liveProcesses ?? [];
  const allTools = ctx.entries
    .filter((entry): entry is ToolStep => entry.type === 'tool')
    .slice()
    .reverse();
  const runningTools = allTools.filter(step => step.call.status === 'in_progress' || step.call.status === 'pending');
  const finishedCount = allTools.length - runningTools.length;
  const tab = ctx.pickerTab === 'live' || ctx.pickerTab === 'running' || ctx.pickerTab === 'done' ? ctx.pickerTab : 'all';

  type TaskRow =
    | { id: string; kind: 'proc'; proc: LiveProcessInfo; matchedStep?: ToolStep }
    | { id: string; kind: 'tool'; step: ToolStep; summary: ReturnType<typeof summarizeToolCall>; matchedProc?: LiveProcessInfo; isRunning: boolean };

  const procRows: TaskRow[] = liveProcs
    .filter(proc => !query || `pid ${proc.pid} ${proc.summary} ${proc.commandLine} ${proc.stat}`.toLowerCase().includes(query))
    .map(proc => ({
      id: `proc:${proc.pid}`,
      kind: 'proc',
      proc,
      matchedStep: matchLiveProcessToToolStep(proc, allTools, ctx.options.cwd),
    }));

  const matchedProcToolIds = new Set(procRows.flatMap(row => (row.kind === 'proc' && row.matchedStep ? [row.matchedStep.id] : [])));
  const toolRows: TaskRow[] = allTools
    .filter(step => {
      const summary = summarizeToolCall(step.call, ctx.options.cwd);
      const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
      if (tab === 'live' && (!isRunning || matchedProcToolIds.has(step.id))) return false;
      if (tab === 'running' && !isRunning) return false;
      if (tab === 'done' && isRunning) return false;
      if (!query) return true;
      return `${summary.title} ${summary.target ?? ''} ${step.call.toolCallId}`.toLowerCase().includes(query);
    })
    .map(step => ({
      id: step.id,
      kind: 'tool',
      step,
      summary: summarizeToolCall(step.call, ctx.options.cwd),
      matchedProc: matchToolStepToLiveProcess(step, liveProcs, ctx.options.cwd),
      isRunning: step.call.status === 'in_progress' || step.call.status === 'pending',
    }));

  const combinedRows: TaskRow[] = tab === 'live'
    ? [...procRows, ...toolRows]
    : tab === 'all'
      ? [...procRows, ...toolRows]
      : toolRows;

  const order = combinedRows.map(row => row.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = combinedRows.find(row => row.id === selectedId);
  const now = Date.now();

  const openLiveOutput = (row: TaskRow | undefined): void => {
    if (!row) return;
    if (row.kind === 'proc') {
      const target = { pid: row.proc.pid, ...(row.matchedStep ? { toolCallId: row.matchedStep.call.toolCallId } : {}) };
      if (ctx.onInspectLiveTask) ctx.onInspectLiveTask(target);
      else ctx.onOpenPanel({ kind: 'task-inspect', ...target });
      return;
    }
    const target = { toolCallId: row.step.call.toolCallId, ...(row.matchedProc ? { pid: row.matchedProc.pid } : {}) };
    if (ctx.onInspectLiveTask) ctx.onInspectLiveTask(target);
    else ctx.onOpenPanel({ kind: 'task-inspect', ...target });
  };

  const selectedProc = highlighted
    ? (highlighted.kind === 'proc' ? highlighted.proc : highlighted.matchedProc)
    : undefined;

  const requestKillSelected = (proc: LiveProcessInfo | undefined): void => {
    if (!proc || !ctx.onKillProcess) return;
    ctx.onOpenPanel({
      kind: 'confirm',
      title: `Kill child process PID ${proc.pid}?`,
      detail: `Sends SIGTERM to "${proc.summary}" (elapsed ${proc.elapsed}).`,
      actionLabel: 'Kill process',
      returnTo: { kind: 'tasks' },
      onConfirm: () => ctx.onKillProcess?.(proc, false),
    });
  };

  const items: PickerItem[] = combinedRows.map(row => {
    if (row.kind === 'proc') {
      return {
        id: row.id,
        label: row.proc.summary,
        detail: `PID ${row.proc.pid} · elapsed ${row.proc.elapsed} · stat ${row.proc.stat}`,
        badges: [
          { text: `LIVE PID ${row.proc.pid}`, tone: 'accent' as const },
          ...(row.matchedStep ? [{ text: 'Output linked', tone: 'info' as const }] : []),
        ],
        node: 'pv',
      };
    }
    const elapsedMs = row.isRunning && row.step.startedAt !== undefined
      ? Math.max(0, now - row.step.startedAt)
      : row.step.startedAt !== undefined && row.step.endedAt !== undefined
        ? Math.max(0, row.step.endedAt - row.step.startedAt)
        : undefined;
    const elapsedLabel = elapsedMs !== undefined ? `${(elapsedMs / 1000).toFixed(1)}s` : '';
    return {
      id: row.id,
      label: row.summary.title,
      detail: [row.summary.target, elapsedLabel, row.matchedProc ? `PID ${row.matchedProc.pid}` : undefined].filter(Boolean).join(' · ') || row.step.call.toolCallId,
      badges: [
        {
          text: row.isRunning ? 'Running' : row.step.call.status === 'failed' ? 'Failed' : 'Done',
          tone: row.isRunning ? 'accent' as const : row.step.call.status === 'failed' ? 'error' as const : 'success' as const,
        },
        ...(row.matchedProc ? [{ text: `PID ${row.matchedProc.pid}`, tone: 'info' as const }] : []),
        ...(row.summary.exit !== undefined ? [{ text: `exit ${row.summary.exit}`, tone: row.summary.exit === 0 ? ('neutral' as const) : ('error' as const) }] : []),
      ],
      node: 'pv',
    };
  });

  const liveTabCount = procRows.length + runningTools.filter(step => !matchedProcToolIds.has(step.id)).length;
  const pvStep = highlighted?.kind === 'tool' ? highlighted.step : highlighted?.matchedStep;
  const pvSummary = pvStep ? summarizeToolCall(pvStep.call, ctx.options.cwd) : undefined;

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Tasks & live processes" icon="timer"
    subtitle={liveProcs.length || runningTools.length
      ? `${liveProcs.length} live child process(es) · ${runningTools.length} active tool(s) · Enter views live output`
      : `${allTools.length} tool call(s) recorded in this session`}
    placeholder="Filter processes, commands, or tool steps..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} onEdit={ctx.onEditPanelDraft}
    tabs={[
      { id: 'all', label: 'All', count: liveProcs.length + allTools.length },
      { id: 'live', label: 'Live', count: liveTabCount },
      { id: 'running', label: 'Running tools', count: runningTools.length },
      { id: 'done', label: 'Finished', count: finishedCount },
    ]}
    tab={tab}
    order={order}
    items={items} selected={selectedId}
    state="ready"
    empty={tab === 'live'
      ? 'No live child processes or active tools running under this agy session.'
      : tab === 'running'
        ? 'No tool tasks are currently running.'
        : 'No tool activity recorded in this conversation yet.'}
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'refresh', label: 'Refresh' },
      ...(ctx.onKillProcess ? [{ id: 'kill', label: selectedProc ? `Kill PID ${selectedProc.pid}` : 'Kill process', disabled: !selectedProc ? (true as const) : undefined }] : []),
      ...(ctx.busy ? [{ id: 'stopTurn', label: ctx.cancelling ? 'Stopping...' : 'Stop active turn', disabled: ctx.cancelling ? (true as const) : undefined }] : []),
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'inspect', label: 'Live output', primary: true, keys: ['enter'], disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => openLiveOutput(highlighted)}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, false);
      },
      refresh: () => ctx.onRefreshLiveProcesses?.(),
      kill: () => requestKillSelected(selectedProc),
      stopTurn: ctx.onStopTurn,
      inspect: () => openLiveOutput(highlighted),
    }}>
    {highlighted && <col key="pv" gap="xs">
      {selectedProc && <kv items={[
        { k: 'Process', v: `PID ${selectedProc.pid} (PPID ${selectedProc.ppid}) · ${selectedProc.stat} · ${selectedProc.elapsed}` },
        { k: 'Command', v: selectedProc.commandLine },
      ]} />}
      {pvStep && pvSummary && <ToolBody call={pvStep.call} cwd={ctx.options.cwd} showRawInput={pvSummary.showRawInput}
        fullCommand={pvSummary.fullCommand} diffMode={ctx.userPrefs.diffMode}
        pathExists={ctx.pathExists} getBlob={ctx.blobForImage} onInspect={ctx.onOpenInspect} onOpenSplit={ctx.onOpenSplit}
        onCopy={ctx.onCopy} />}
    </col>}
  </picker>;
}

function renderTaskInspectOverlay(
  ctx: PanelRenderContext,
  p: Extract<Panel, { kind: 'task-inspect' }>,
): JSX.Element {
  const tools = ctx.entries.filter((entry): entry is ToolStep => entry.type === 'tool');
  const liveProcs = ctx.liveProcesses ?? [];
  const liveProcByPid = p.pid !== undefined ? liveProcs.find(item => item.pid === p.pid) : undefined;
  const step = p.toolCallId
    ? tools.find(entry => entry.call.toolCallId === p.toolCallId)
    : (liveProcByPid ? matchLiveProcessToToolStep(liveProcByPid, tools, ctx.options.cwd) : undefined);
  const liveProc = liveProcByPid ?? (step ? matchToolStepToLiveProcess(step, liveProcs, ctx.options.cwd) : undefined);

  const stepRunning = !!step && (step.call.status === 'in_progress' || step.call.status === 'pending');
  const isLive = !!liveProc || stepRunning;
  const summary = step ? summarizeToolCall(step.call, ctx.options.cwd, { includeDiffStats: false }) : undefined;
  const title = summary?.title ?? liveProc?.summary ?? 'Live task output';
  const liveOutputText = step
    ? (extractToolLiveOutput(step) ?? '')
    : '';
  const detailText = step
    ? buildTaskDetailText(step, ctx.options.cwd, liveProc)
    : liveProc
      ? `PID: ${liveProc.pid}\nPPID: ${liveProc.ppid}\nState: ${liveProc.stat}\nElapsed: ${liveProc.elapsed}\nCommand:\n${liveProc.commandLine}`
      : 'This task or process is no longer active.';

  return <overlay key="panel" head={title} modal size={ctx.rLayout.inspectSize}
    icon="timer"
    meta={liveProc
      ? `LIVE PID ${liveProc.pid} · ${liveProc.elapsed}`
      : stepRunning
        ? 'Running · Live output'
        : step?.call.status ?? 'Finished'}
    end={<button keys={['esc']} variant="quiet" onClick={() => ctx.onOpenPanel({ kind: 'tasks' })}>Back</button>}
    foot={<row gap="xs" justify="between" align="center" wrap>
      <text><span s="muted">Up/Down/PgUp/PgDn scroll · c copy · k kill process · Esc back to /tasks</span></text>
      <row gap="xs">
        {ctx.onRefreshLiveProcesses && <button size="sm" variant="quiet" onClick={ctx.onRefreshLiveProcesses}>Refresh</button>}
        <button size="sm" variant="quiet" icon="copy" onClick={() => ctx.onCopy(liveOutputText || detailText)}>Copy output</button>
        {liveProc && ctx.onKillProcess && <>
          <button size="sm" variant="danger" icon="stop" onClick={() => ctx.onOpenPanel({
            kind: 'confirm',
            title: `Kill child process PID ${liveProc.pid}?`,
            detail: `Sends SIGTERM to "${liveProc.summary}".`,
            actionLabel: 'Kill process',
            returnTo: p,
            onConfirm: () => ctx.onKillProcess?.(liveProc, false),
          })}>Kill PID {liveProc.pid}</button>
          <button size="sm" variant="danger" onClick={() => ctx.onKillProcess?.(liveProc, true)}>Force SIGKILL</button>
        </>}
        {!liveProc && ctx.busy && <button size="sm" variant="danger" icon="stop" disabled={ctx.cancelling && 'Stopping'} onClick={ctx.onStopTurn}>
          {ctx.cancelling ? 'Stopping...' : 'Stop turn'}
        </button>}
      </row>
    </row>}>
    <scroll key="inspect-scroll" bar="always" stick={isLive ? 'end' : undefined} max={{ h: ctx.rLayout.inspectBodyMaxH }}>
      <col gap="sm">
        <kv items={[
          ...(summary?.target ? [{ k: 'Command / Target', v: summary.fullCommand ?? summary.target }] : []),
          ...(liveProc ? [{ k: 'Live process', v: `PID ${liveProc.pid} (stat ${liveProc.stat}, elapsed ${liveProc.elapsed})` }] : []),
          ...(step ? [{ k: 'ACP status', v: step.call.status ?? 'unknown' }] : []),
        ]} />
        {isLive && <row gap="xs" align="center">
          <spinner style="starburst" />
          <text><span s="accent">{liveOutputText ? 'Streaming live output...' : 'Process running; waiting for output chunks...'}</span></text>
        </row>}
        {liveOutputText
          ? <code wrap>{liveOutputText}</code>
          : <code wrap>{detailText}</code>}
      </col>
    </scroll>
  </overlay>;
}

function renderFollowUpOverlay(
  ctx: PanelRenderContext,
  p: Extract<Panel, { kind: 'followup' }>,
): JSX.Element {
  const closeAction = ctx.onCancelFollowUp ?? ctx.onClosePanel;
  if (p.urlMode) {
    return <overlay key="panel" anchor="center" modal size={ctx.rLayout.panelSize}
      head={p.title}
      icon="info"
      end={<button keys={['esc']} variant="quiet" onClick={closeAction}>Cancel</button>}
      foot={<row gap="xs" justify="between" align="center" wrap>
        <text><span s="muted">Open the link in your browser, then select Done.</span></text>
        <row gap="xs">
          <button size="sm" variant="quiet" icon="copy" onClick={() => ctx.onCopy(p.urlMode!.url)}>Copy URL</button>
          {ctx.onDeclineFollowUp && <button size="sm" variant="quiet" onClick={ctx.onDeclineFollowUp}>Decline</button>}
          <button size="sm" variant="primary" onClick={() => ctx.onSubmitFollowUp?.()}>Done</button>
        </row>
      </row>}>
      <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
        <col gap="sm">
          {p.message && <text wrap="word">{p.message}</text>}
          <kv items={[{ k: 'URL', v: p.urlMode.url }]} />
        </col>
      </scroll>
    </overlay>;
  }

  const st = ctx.followUp;
  const fields = st?.fields ?? [];
  const updateAnswer = (fieldName: string, value: QuestionAnswerValue, fieldIdx: number): void => {
    ctx.onUpdateFollowUp?.(draft => {
      draft.activeFieldIdx = fieldIdx;
      draft.answers[fieldName] = value;
      draft.customDrafts[fieldName] = '';
      draft.error = undefined;
    });
    ctx.onFocus(null);
  };
  const toggleMultiOption = (fieldName: string, optionValue: string, fieldIdx: number): void => {
    ctx.onUpdateFollowUp?.(draft => {
      draft.activeFieldIdx = fieldIdx;
      const prev = Array.isArray(draft.answers[fieldName]) ? [...(draft.answers[fieldName] as string[])] : [];
      const existingIdx = prev.indexOf(optionValue);
      if (existingIdx >= 0) prev.splice(existingIdx, 1);
      else prev.push(optionValue);
      draft.answers[fieldName] = prev;
      draft.error = undefined;
    });
    ctx.onFocus(null);
  };
  const applyInputEdit = (
    draft: FollowUpSessionState,
    cursorKey: string,
    prevText: string,
    event: EditEvent,
  ): string => {
    const cur = draft.draftCursors?.[cursorKey];
    const next = editDraft(
      { text: prevText, cursor: cur?.cursor ?? prevText.length, anchor: cur?.anchor },
      event,
    );
    draft.draftCursors = {
      ...(draft.draftCursors ?? {}),
      [cursorKey]: { cursor: next.cursor, ...(next.anchor !== undefined ? { anchor: next.anchor } : {}) },
    };
    return next.text;
  };

  return <overlay key="panel" anchor="center" modal size={ctx.rLayout.panelSize}
    head={st?.title || p.title}
    icon="help"
    meta={p.source === 'elicitation' ? 'Agent waiting for your response' : 'Reply via next prompt'}
    end={<button keys={['esc']} variant="quiet" onClick={closeAction}>Cancel</button>}
    foot={<row gap="xs" justify="between" align="center" wrap>
      <text><span s="muted">Tab switch · Up/Down choose · Space toggle · Enter submit · Esc cancel</span></text>
      <row gap="xs">
        {p.source === 'elicitation' && ctx.onDeclineFollowUp && (
          <button size="sm" variant="quiet" onClick={ctx.onDeclineFollowUp}>Decline</button>
        )}
        <button size="sm" variant="quiet" onClick={closeAction}>Cancel</button>
        <button size="sm" variant="primary" icon="send" onClick={() => ctx.onSubmitFollowUp?.()}>
          {p.source === 'elicitation' ? 'Submit response' : 'Send answers'}
        </button>
      </row>
    </row>}>
    <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
      <col key="form" gap="md">
        {(st?.message || p.message) && <text wrap="word">{st?.message || p.message}</text>}
        {fields.map((field, idx) => {
          const val = st?.answers[field.name];
          const isActive = st?.activeFieldIdx === idx;
          return <col key={`field-${field.name}`} gap="xs">
            <text wrap="word">
              <span s="strong">{`${fields.length > 1 ? `${idx + 1}. ` : ''}${field.label}`}</span>
              {field.required ? <span s="warning"> *</span> : ''}
              {isActive && fields.length > 1 ? <span s="muted"> (active)</span> : ''}
            </text>
            {field.description && <text wrap="word"><span s="muted">{field.description}</span></text>}
            {field.kind === 'single-select' && <col gap="xs">
              {field.options.map((opt, optIdx) => {
                const chosen = val === opt.value;
                return <button key={`opt-${optIdx}`} size="sm" variant={chosen ? 'primary' : 'default'}
                  icon={chosen ? 'check' : undefined}
                  title={opt.description ?? opt.label}
                  onClick={() => updateAnswer(field.name, opt.value, idx)}>
                  {opt.description ? `${opt.label} - ${opt.description}` : opt.label}
                </button>;
              })}
              {field.allowCustom && <input key={`custom-${field.name}`}
                aria={`Custom answer for ${field.label}`}
                text={st?.customDrafts[field.name] ?? ''}
                cursor={st?.draftCursors?.[`custom:${field.name}`]?.cursor ?? (st?.customDrafts[field.name] ?? '').length}
                anchor={st?.draftCursors?.[`custom:${field.name}`]?.anchor}
                placeholder="Or type a custom answer..."
                onFocus={event => {
                  ctx.onUpdateFollowUp?.(draft => { draft.activeFieldIdx = idx; });
                  ctx.onFocus(event.id);
                }}
                onEdit={event => ctx.onUpdateFollowUp?.(draft => {
                  draft.activeFieldIdx = idx;
                  draft.answers[field.name] = '';
                  draft.customDrafts[field.name] = applyInputEdit(
                    draft,
                    `custom:${field.name}`,
                    draft.customDrafts[field.name] ?? '',
                    event,
                  );
                  draft.error = undefined;
                })} />}
            </col>}
            {field.kind === 'multi-select' && <col gap="xs">
              {field.options.map((opt, optIdx) => {
                const checked = Array.isArray(val) && val.includes(opt.value);
                const optCursor = st?.optionCursors?.[field.name] ?? 0;
                const focusedOpt = isActive && optIdx === optCursor;
                return <button key={`mopt-${optIdx}`} size="sm"
                  variant={checked ? 'primary' : focusedOpt ? 'default' : 'quiet'}
                  icon={checked ? 'check' : undefined}
                  title={opt.description ?? opt.label}
                  onClick={() => toggleMultiOption(field.name, opt.value, idx)}>
                  {`${focusedOpt ? '> ' : ''}${checked ? '[x]' : '[ ]'} ${opt.label}${opt.description ? ` - ${opt.description}` : ''}`}
                </button>;
              })}
            </col>}
            {field.kind === 'boolean' && <row gap="xs">
              <button size="sm" variant={val === true ? 'primary' : 'default'} icon={val === true ? 'check' : undefined}
                onClick={() => updateAnswer(field.name, true, idx)}>Yes</button>
              <button size="sm" variant={val === false ? 'primary' : 'default'} icon={val === false ? 'check' : undefined}
                onClick={() => updateAnswer(field.name, false, idx)}>No</button>
            </row>}
            {(field.kind === 'text' || field.kind === 'number' || field.kind === 'integer') && (
              <input key={`input-${field.name}`}
                aria={field.label}
                text={typeof val === 'string' ? val : ''}
                cursor={st?.draftCursors?.[`answer:${field.name}`]?.cursor ?? (typeof val === 'string' ? val.length : 0)}
                anchor={st?.draftCursors?.[`answer:${field.name}`]?.anchor}
                placeholder={field.kind === 'text' ? 'Type your answer...' : `Enter ${field.kind}...`}
                onFocus={event => {
                  ctx.onUpdateFollowUp?.(draft => { draft.activeFieldIdx = idx; });
                  ctx.onFocus(event.id);
                }}
                onEdit={event => ctx.onUpdateFollowUp?.(draft => {
                  draft.activeFieldIdx = idx;
                  const prevText = typeof draft.answers[field.name] === 'string' ? (draft.answers[field.name] as string) : '';
                  draft.answers[field.name] = applyInputEdit(draft, `answer:${field.name}`, prevText, event);
                  draft.error = undefined;
                })} />
            )}
          </col>;
        })}
        {p.source === 'prompt' && <col gap="xs">
          <text><span s="muted">Additional note (optional)</span></text>
          <input key="free-note"
            aria="Additional note"
            text={st?.freeNote ?? ''}
            cursor={st?.draftCursors?.['free-note']?.cursor ?? (st?.freeNote ?? '').length}
            anchor={st?.draftCursors?.['free-note']?.anchor}
            placeholder="Add extra clarification if needed..."
            onFocus={event => ctx.onFocus(event.id)}
            onEdit={event => ctx.onUpdateFollowUp?.(draft => {
              draft.freeNote = applyInputEdit(draft, 'free-note', draft.freeNote, event);
            })} />
        </col>}
        {st?.error && <text wrap="word"><span s="error">{st.error}</span></text>}
      </col>
    </scroll>
  </overlay>;
}

function formatConfigDetail(option: SessionConfigOption | undefined, fallback: string): string {
  if (!option) return fallback;
  const label = configLabel(option);
  const raw = String(option.currentValue);
  return raw && raw !== label ? `${label} (${raw})` : label;
}

function renderQuotaTable(quotaSummary: QuotaSummary, rowPrefix: string): JSX.Element {
  return <table cols={[
    { id: 'group', head: 'Model group', grow: 1, priority: 4 },
    { id: 'limit', head: 'Limit', priority: 2 },
    { id: 'meter', head: 'Quota bar', priority: 3 },
    { id: 'remaining', head: 'Left', align: 'end', mono: true, priority: 4 },
    { id: 'reset', head: 'Reset', mono: true, priority: 4 },
  ]} rows={quotaSummary.rows.map((row, index) => ({
    id: `${rowPrefix}-${index}`,
    cells: {
      group: row.group,
      limit: row.limit,
      meter: { meter: {
        value: row.fraction,
        tone: row.fraction <= 0.15 ? 'error' : row.fraction <= 0.35 ? 'warning' : 'success',
      } },
      remaining: row.remaining,
      reset: formatQuotaResetDisplay(row.reset),
    },
    title: `${row.group}: ${row.limit}, ${row.remaining} remaining, resets ${formatQuotaResetDisplay(row.reset)}`,
  }))} />;
}

/** Render the detailed account, active session, context window, and quota table view inside /usage. */
function renderUsageDetails(
  ctx: PanelRenderContext,
  quotaSummary: QuotaSummary | undefined,
  contextUsage: ReturnType<typeof formatContextUsage>,
): JSX.Element {
  const tier = ctx.metadata.tier;
  const tierLabel = tier
    ? (tier.id && tier.id !== tier.name ? `${tier.name} (${tier.id})` : tier.name)
    : 'Not reported by ACP';
  const connectionState = ctx.disconnected
    ? 'Disconnected'
    : ctx.agent
      ? 'Connected'
      : ctx.agentConnecting
        ? 'Connecting'
        : 'Idle';
  const method = ctx.loginMethod;
  const authMethodLabel = method
    ? `${method.name} (${method.id})`
    : ctx.authenticationKnown
      ? 'Terminal sign-in not advertised'
      : 'Waiting for ACP auth metadata';
  const capabilityList = ctx.agent ? [
    ...(ctx.agent.promptCapabilities?.image ? ['image'] : []),
    ...(ctx.agent.promptCapabilities?.embeddedContext ? ['embeddedContext'] : []),
    ...(ctx.agent.capabilities.listSessions ? ['sessions'] : []),
    ...(ctx.agent.capabilities.loadSession ? ['load'] : []),
    ...(ctx.agent.capabilities.resumeSession ? ['resume'] : []),
    ...(ctx.agent.capabilities.closeSession ? ['close'] : []),
    ...(ctx.agent.capabilities.additionalDirectories ? ['add-dir'] : []),
    ...(ctx.agent.capabilities.appendSystemPrompt ? ['systemPrompt'] : []),
  ] : [];
  const modelOpt = modelOption(ctx.metadata.configOptions);
  const thinkingOpt = thinkingOption(ctx.metadata.configOptions);
  const usage = ctx.metadata.usage;
  const remainingTokens = usage ? Math.max(0, usage.size - usage.used) : undefined;

  return <col gap="md">
    <section head="Account & connection">
      <kv items={[
        { k: 'Subscription tier', v: tierLabel },
        ...(tier?.upgradeUri ? [{ k: 'Upgrade URL', v: tier.upgradeUri }] : []),
        { k: 'Account identity', v: 'Official agy shared auth (email not exposed by ACP)' },
        { k: 'Sign-in method', v: authMethodLabel },
        { k: 'ACP runtime', v: `${ctx.options.executable ?? 'agy'} acp --sandbox (${connectionState})` },
      ]} />
    </section>
    <section head="Active session & runtime">
      <kv items={[
        { k: 'Conversation', v: ctx.activeSessionId ? `${ctx.sessionTitle(ctx.activeSessionId)} (${ctx.activeSessionId})` : 'No active session' },
        { k: 'Model', v: formatConfigDetail(modelOpt, 'Not reported') },
        { k: 'Thinking effort', v: formatConfigDetail(thinkingOpt, 'Default') },
        { k: 'Session mode', v: formatConfigDetail(ctx.modeOption, 'Default') },
        {
          k: 'Workspace',
          v: ctx.options.additionalDirectories?.length
            ? `${ctx.options.cwd} (+${ctx.options.additionalDirectories.length} --add-dir)`
            : ctx.options.cwd,
        },
        { k: 'Capabilities', v: capabilityList.join(', ') || (ctx.agent ? 'Minimal ACP profile' : 'Unavailable') },
      ]} />
    </section>
    <section head="Context & quota breakdown">
      <col gap="sm">
        {usage && contextUsage ? <>
          <meter style="bar" size="sm"
            value={contextUsage.percent / 100}
            thresholds={{ warn: 0.75, bad: 0.9 }}
            label={`Session context: ${contextUsage.summary}`} />
          <kv items={[
            { k: 'Used tokens', v: usage.used.toLocaleString() },
            { k: 'Remaining tokens', v: (remainingTokens ?? 0).toLocaleString() },
            { k: 'Context window', v: usage.size.toLocaleString() },
            ...(usage.cost ? [{ k: 'Session cost', v: `${usage.cost.amount} ${usage.cost.currency}` }] : []),
          ]} />
        </> : <text><span s="muted">No session-context token usage has been reported by ACP yet.</span></text>}
        {quotaSummary ? renderQuotaTable(quotaSummary, 'detail') : ctx.reportText && <md>{ctx.reportText}</md>}
      </col>
    </section>
  </col>;
}

function renderKeysOverlay(ctx: PanelRenderContext): JSX.Element {
  return <overlay key="panel" head="Keyboard shortcuts" icon="key" modal size={ctx.rLayout.panelSize}
    meta="All composer, modal, and transcript controls"
    end={<button keys={['esc']} variant="quiet" onClick={ctx.onClosePanel}>Close</button>}>
    <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
      <col gap="md">
        <section head="Composer & Attachments">
          <kv items={[
            { k: 'Enter', v: 'Send message or queue while busy (Shift+Enter inserts newline)' },
            { k: '/', v: 'Open slash command autocomplete; Tab completes command' },
            { k: '@', v: 'Attach files or dirs inline (Up/Down navigate list, Enter/Tab insert)' },
            { k: 'Alt+V', v: 'Paste clipboard screenshot/image inline + chip preview' },
            { k: 'Ctrl+Z / Ctrl+Y', v: 'Undo / redo draft edits' },
            { k: 'Up / Down', v: 'Step sent prompt history on first/last row (or navigate popups)' },
          ]} />
        </section>
        <section head="Navigation & Quick Panels">
          <kv items={[
            { k: 'Ctrl+K', v: 'Open Commands & Quick Switcher palette' },
            { k: 'Ctrl+Tab / Alt+1..6', v: 'Cycle or jump between open session tabs' },
            { k: 'Ctrl+Up / Ctrl+Down', v: 'Jump to previous / next user turn in transcript' },
            { k: '/turns · /queue', v: 'Open Turn Outline Navigator or Prompt Queue Manager' },
            { k: 'PageUp / PageDown', v: 'Scroll conversation or active modal overlay' },
            { k: 'Esc', v: 'Step back from sub-panel, dismiss popup, or cancel active turn' },
            { k: 'Ctrl+C / Ctrl+Q', v: 'Quit agy-tern safely and close ACP session' },
          ]} />
        </section>
        <section head="Approvals & Follow-up Modals">
          <kv items={[
            { k: 'Tab / Shift+Tab', v: 'Cycle approval choices or follow-up form fields' },
            { k: 'Ctrl+Y / Ctrl+N', v: 'Allow once / Deny once on active permission request' },
            { k: 'Up / Down & Space', v: 'Navigate options and toggle multi-select items' },
            { k: 'Enter (in modal)', v: 'Submit follow-up response or apply selected choice' },
          ]} />
        </section>
      </col>
    </scroll>
  </overlay>;
}

function renderCommitsOverlay(ctx: PanelRenderContext): JSX.Element {
  const grid = ctx.commitHistory;
  const branchText = ctx.gitBranch ? `Branch ${ctx.gitBranch}` : ctx.workspaceName;
  const recentCommits = grid?.commits.slice(0, 30) ?? [];

  return <overlay key="panel" head="Commit history & activity" icon="branch" modal size={ctx.rLayout.panelSize}
    meta={grid ? `${branchText} · Last ${grid.weeks} weeks` : branchText}
    end={<button keys={['esc']} variant="quiet" onClick={ctx.onClosePanel}>Close</button>}
    foot={<row gap="xs" justify="between" align="center" wrap>
      <text><span s="muted">Up/Down/PgUp/PgDn scroll · r refresh · Click commit to inspect diff</span></text>
      <row gap="xs">
        <button size="sm" variant="quiet" onClick={() => ctx.onOpenPanel({ kind: 'changes' })}>Working tree (/changes)</button>
        {ctx.onRefreshCommits && <button size="sm" variant="primary" disabled={ctx.commitHistoryLoading && 'Loading'}
          onClick={ctx.onRefreshCommits}>Refresh</button>}
      </row>
    </row>}>
    <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
      <col gap="md">
        {ctx.commitHistoryLoading && <spinner label="Reading git commit history" />}
        {grid && <>
          <stats items={[
            {
              label: `Commits (${grid.weeks}w)`,
              value: String(grid.totalCommits),
              sub: `${grid.activeDays} active day(s)`,
              tone: grid.totalCommits > 0 ? 'success' : 'muted',
            },
            {
              label: 'Current streak',
              value: `${grid.currentStreak}d`,
              sub: `Longest: ${grid.longestStreak}d`,
              tone: grid.currentStreak > 0 ? 'accent' : 'neutral',
            },
            {
              label: 'Peak day',
              value: grid.busiestDate ? `${grid.busiestDate.count}` : '0',
              sub: grid.busiestDate ? grid.busiestDate.date : 'No commits in range',
              tone: grid.busiestDate ? 'info' : 'muted',
            },
          ]} />
          <section head="Contribution heatmap">
            <col gap="xs">
              <chart kind="heatmap" size="md" token="success"
                rows={grid.rows}
                cols={grid.cols}
                cells={grid.cells}
                tips={grid.tips}
                summary={`${grid.totalCommits} commits across ${grid.weeks} weeks (${grid.activeDays} active days)`} />
              <text><span s="muted">Squares darken with commit count per day (0 to {grid.maxDailyCommits || 1}); hover any day for date count.</span></text>
            </col>
          </section>
          <section head="Recent commits">
            {recentCommits.length > 0 ? <list max={{ lines: Math.max(5, ctx.rLayout.modalListMaxLines) }}>
              {recentCommits.map(commit => <item key={commit.hash}
                icon="commit"
                label={commit.subject}
                detail={`${commit.shortHash} · ${commit.date} (${commit.relativeTime}) · ${commit.author}`}
                value="Inspect"
                onClick={() => ctx.onInspectCommit?.(commit)} />)}
            </list> : <text><span s="muted">No commits found in this workspace or git repository is uninitialized.</span></text>}
          </section>
        </>}
      </col>
    </scroll>
  </overlay>;
}

/** Render the active modal picker, prefs window, report overlay, or inspector dialog. */
export function renderActivePanel(ctx: PanelRenderContext): JSX.Element {
  const currentPanel = ctx.panel;
  if (currentPanel.kind === 'settings') return renderPrefsPanel(ctx);
  if (currentPanel.kind === 'followup') return renderFollowUpOverlay(ctx, currentPanel);
  if (currentPanel.kind === 'keys') return renderKeysOverlay(ctx);
  if (currentPanel.kind === 'commits') return renderCommitsOverlay(ctx);
  const config = currentPanel.kind === 'config' ? ctx.metadata.configOptions.find(option => option.id === currentPanel.id) : undefined;
  if (currentPanel.kind === 'config' && config?.type === 'select') return renderSelectConfigPicker(ctx, config);
  if (currentPanel.kind === 'commands') return renderCommandsPicker(ctx);
  if (currentPanel.kind === 'mcp') return renderMcpPicker(ctx);
  if (currentPanel.kind === 'plugins') return renderPluginsPicker(ctx);
  if (currentPanel.kind === 'agents') return renderAgentsPicker(ctx);
  if (currentPanel.kind === 'templates') return renderTemplatesPicker(ctx);
  if (currentPanel.kind === 'sessions') return renderSessionsPicker(ctx);
  if (currentPanel.kind === 'changes') return renderChangesPicker(ctx);
  if (currentPanel.kind === 'find') return renderFindPicker(ctx);
  if (currentPanel.kind === 'turns') return renderTurnsPicker(ctx);
  if (currentPanel.kind === 'queue') return renderQueuePicker(ctx);
  if (currentPanel.kind === 'tasks') return renderTasksPicker(ctx);
  if (currentPanel.kind === 'task-inspect') return renderTaskInspectOverlay(ctx, currentPanel);
  if (currentPanel.kind === 'inspect') return renderInspectOverlay(ctx, currentPanel);

  const mode = ctx.modeOption;
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
  const selected = Math.min(ctx.panelSelection, Math.max(0, ctx.choices.length - 1));
  const quotas = currentPanel.kind === 'report' && currentPanel.report === 'usage' ? parseQuotaReport(ctx.reportText) : undefined;
  const quotaSummary = summarizeQuotaRows(quotas);
  const contextUsage = formatContextUsage(ctx.metadata.usage);
  const method = ctx.loginMethod;
  const loginProblem = method ? terminalLoginProblem(method) : undefined;

  return <overlay key="panel" head={title} modal size={ctx.rLayout.panelSize}
    icon={currentPanel.kind === 'report' ? 'context' : currentPanel.kind === 'permissions' ? 'shield' :
      currentPanel.kind === 'account' || currentPanel.kind === 'account-switch' ? 'user' : 'slash'}
    end={<button keys={['esc']} variant="quiet" disabled={ctx.authBusy} onClick={ctx.onClosePanel}>Close</button>}>
    {currentPanel.kind === 'report' ? <>
      <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
        {currentPanel.report === 'usage' ? <col gap="md">
          <tabs variant="segmented" active={ctx.usageTab}
            items={[
              { id: 'overview', label: 'Overview' },
              { id: 'details', label: 'Details' },
              { id: 'raw', label: 'Raw report' },
            ]}
            onSelect={event => ctx.onSetUsageTab(String(event.item || 'overview'))}
            onActivate={event => ctx.onSetUsageTab(String(event.item || 'overview'))}
            onChange={event => ctx.onSetUsageTab(String(event.value ?? event.item ?? 'overview'))} />
          {ctx.reportLoading && <spinner label="Reading official /usage report" />}
          {ctx.usageTab === 'overview' && <>
            {(contextUsage || quotaSummary) && <row gap="lg" align="center" wrap>
              {contextUsage && <meter style="ring" size="md"
                value={contextUsage.percent / 100}
                thresholds={{ warn: 0.75, bad: 0.9 }}
                label={`${contextUsage.percent}%`}
                total="Context" />}
              {quotaSummary && <meter style="ring" size="md"
                value={quotaSummary.tightest.fraction}
                label={quotaSummary.tightest.remaining}
                total={quotaSummary.tightest.group} />}
            </row>}
            {(() => {
              const soonestReset = quotaSummary ? selectSoonestQuotaReset(quotaSummary) : undefined;
              const tightestReset = quotaSummary ? formatQuotaResetCountdown(quotaSummary.tightest.reset) : undefined;
              return <stats items={[
                {
                  label: 'Tightest quota',
                  value: quotaSummary ? quotaSummary.tightest.remaining : (ctx.reportLoading ? 'Loading' : 'Unavailable'),
                  sub: quotaSummary
                    ? `${quotaSummary.tightest.group} · resets ${tightestReset ?? quotaSummary.tightest.reset}${ctx.metadata.tier ? ` · ${ctx.metadata.tier.name}` : ''}`
                    : (ctx.metadata.tier ? `${ctx.metadata.tier.name} · Official CLI /usage` : 'From official CLI /usage'),
                  tone: quotaSummary
                    ? (quotaSummary.tightest.fraction <= 0.15 ? 'error' : quotaSummary.tightest.fraction <= 0.35 ? 'warning' : 'success')
                    : 'muted',
                },
                {
                  label: 'Next reset',
                  value: soonestReset
                    ? (soonestReset.countdown ?? soonestReset.row.reset)
                    : (ctx.reportLoading ? 'Loading' : 'Unavailable'),
                  sub: soonestReset
                    ? `${soonestReset.row.reset} · ${soonestReset.row.group}`
                    : 'Parsed from /usage',
                  tone: soonestReset ? 'info' : 'muted',
                },
                {
                  label: 'Session context',
                  value: contextUsage ? `${contextUsage.percent}%` : 'Not reported',
                  sub: contextUsage ? `${contextUsage.usedLabel} / ${contextUsage.sizeLabel} tokens` : 'Waiting for ACP usage_update',
                  tone: contextUsage ? 'info' : 'muted',
                },
              ]} />;
            })()}
            {quotaSummary ? renderQuotaTable(quotaSummary, 'quota') : ctx.reportText && <md>{ctx.reportText}</md>}
          </>}
          {ctx.usageTab === 'details' && renderUsageDetails(ctx, quotaSummary, contextUsage)}
          {ctx.usageTab === 'raw' && (ctx.reportText
            ? <code wrap>{ctx.reportText}</code>
            : <text><span s="muted">No raw report output captured yet.</span></text>)}
        </col> : <col gap="xs">
          {ctx.reportLoading && <spinner label={`Reading official /${currentPanel.report} report`} />}
          {ctx.reportText && <md>{ctx.reportText}</md>}
        </col>}
      </scroll>
      {ctx.panelError && <text wrap="word"><span s="error">{ctx.panelError}</span></text>}
      <button keys={['enter']} on={ctx.panelSelection % 2 === 0} disabled={ctx.reportLoading && 'Report is loading'}
        onClick={() => ctx.onLoadReport(currentPanel.report)}>Refresh report</button>
      <text wrap="word">Up/Down/PgUp/PgDn scroll. Tab selects Refresh or Close. Enter activates; Esc returns to the conversation.</text>
    </> : <>
      {currentPanel.kind === 'account' && <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
        <col gap="xs">
          {(() => {
            const snapshot = formatAccountSnapshot(ctx.metadata, ctx.reportText);
            return <kv items={[
              { k: 'ACP connection', v: ctx.disconnected ? 'Disconnected' : ctx.agent ? 'Connected; model access not guaranteed' : 'Connecting' },
              { k: 'Subscription tier', v: ctx.metadata.tier ? ctx.metadata.tier.name : 'Not reported by ACP' },
              ...(snapshot ? [{ k: 'Cached snapshot', v: snapshot }] : []),
              { k: 'Account identity', v: 'Not exposed by this ACP connection' },
              { k: 'Credential owner', v: 'Official agy shared authentication' },
            ]} />;
          })()}
          <text wrap="word">Sign in through agy’s interactive flow. This frontend stores no accounts or tokens. Switching requires signing in again, not selecting a saved-account pool. Login reconnects a fresh session and keeps your unsent draft.</text>
          {!ctx.authenticationKnown && <text wrap="word">{ctx.disconnected ? 'No login descriptor received. Use the official CLI terminal login from your shell.' : 'Waiting for agy to advertise sign-in options.'}</text>}
          {ctx.authenticationKnown && !method && <text>agy did not advertise terminal sign-in support.</text>}
          {loginProblem && <text wrap="word"><span s="error">{loginProblem}</span></text>}
          {method && !loginProblem && <code wrap>{JSON.stringify([ctx.options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
          {(ctx.busy || ctx.changingConfig || ctx.sessionOperation) && <text>Wait for the active operation before signing in or changing accounts.</text>}
        </col>
      </scroll>}
      {currentPanel.kind === 'account-switch' && <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
        <col gap="xs">
          <text wrap="word">This signs out first. Antigravity shares credentials across CLI, App and IDE extensions, so they may also lose their login. If login is cancelled, the old credentials are not restored.</text>
          <text wrap="word">Choose your other account in the official login flow. Afterwards this frontend starts a fresh session and keeps only your unsent draft. It does not replay the failed prompt or automatically transfer the old conversation.</text>
          {method && <code wrap>{JSON.stringify([ctx.options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
        </col>
      </scroll>}
      {currentPanel.kind === 'permissions' && <scroll key="overlay-scroll" bar="always" max={{ h: ctx.rLayout.inspectBodyMaxH }}>
        <col gap="xs">
          <kv items={[
            { k: 'Session mode', v: mode ? configLabel(mode) : 'Not reported by agy' },
            { k: 'Agent profile', v: ctx.options.agentName ?? 'Default' },
            { k: 'Workspace roots', v: ctx.options.additionalDirectories?.length ? `${ctx.options.cwd} (+${ctx.options.additionalDirectories.length} --add-dir)` : ctx.options.cwd },
            { k: 'Sandbox flag', v: '--sandbox requested' },
            { k: 'OS containment', v: 'Not reported through ACP; not verified' },
            { k: 'ACP capabilities', v: [
              ...(ctx.agent?.promptCapabilities?.image ? ['image'] : []),
              ...(ctx.agent?.promptCapabilities?.embeddedContext ? ['embeddedContext'] : []),
              ...(ctx.agent?.capabilities.loadSession ? ['load'] : []),
              ...(ctx.agent?.capabilities.resumeSession ? ['resume'] : []),
              ...(ctx.agent?.capabilities.closeSession ? ['close'] : []),
              ...(ctx.agent?.capabilities.additionalDirectories ? ['add-dir'] : []),
            ].join(', ') || 'Connecting...' },
            { k: 'Effective allow/deny rules', v: 'Owned by agy; not reported through ACP' },
            { k: 'Frontend approvals', v: 'One-time allow or deny only; never automatic' },
          ]} />
          <text wrap="word">Existing agy rules can run tools without another prompt. Plan mode does not prove read-only access.</text>
          <text wrap="word">No permission bypass flag is enabled. This frontend does not provide filesystem or terminal RPC.</text>
        </col>
      </scroll>}
      {currentPanel.kind === 'rename' && <text wrap="word">Local to agy-tern; does not rename the conversation in Antigravity. Up to 160 characters. Leave empty to use agy’s title.</text>}
      {currentPanel.kind === 'template-save' && <text wrap="word">Enter a short template name (e.g. review-diff). Saved locally per workspace in your XDG state directory.</text>}
      {currentPanel.kind === 'mcp-add' && <text wrap="word">Syntax: [--type stdio|http] &lt;name&gt; &lt;commandOrUrl&gt; [args...]. Executed via `agy mcp add`.</text>}
      {currentPanel.kind === 'plugin-install' && <text wrap="word">Enter a local plugin directory path or `plugin@marketplace` identifier. Executed via `agy plugin install`.</text>}
      {currentPanel.kind === 'confirm' && <text wrap="word">{currentPanel.detail}</text>}
      {currentPanel.kind !== 'permissions' && currentPanel.kind !== 'account' && currentPanel.kind !== 'account-switch' && currentPanel.kind !== 'confirm' && <input key="query"
        aria={currentPanel.kind === 'rename' ? 'Local conversation name' : currentPanel.kind === 'template-save' ? 'Template name'
          : currentPanel.kind === 'mcp-add' ? 'MCP server command' : currentPanel.kind === 'plugin-install' ? 'Plugin target'
          : `Filter ${title.toLowerCase()}`}
        text={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor} anchor={ctx.panelDraft.anchor}
        placeholder={currentPanel.kind === 'rename' ? 'Conversation name (local)'
          : currentPanel.kind === 'template-save' ? 'e.g. audit-security'
          : currentPanel.kind === 'mcp-add' ? 'e.g. --type stdio github npx -y @modelcontextprotocol/server-github'
          : currentPanel.kind === 'plugin-install' ? 'e.g. /path/to/plugin or my-plugin@official'
          : `Filter ${title.toLowerCase()}`}
        onFocus={() => ctx.onFocus('layer.panel.query')}
        onEdit={ctx.onEditPanelDraft} />}
      {ctx.panelError && <text wrap="word"><span s="error">{ctx.panelError}</span></text>}
      <list key="choices" selected={`layer.panel.choices.row-${selected}`} max={{ lines: ctx.rLayout.modalListMaxLines }}
        empty="No matching choices.">
        {ctx.choices.map((choice, index) => <item key={`row-${index}`} label={choice.label} detail={choice.detail}
          value={choice.value} title={`${choice.label}: ${choice.detail}`}
          disabled={choice.disabled || ctx.authBusy || ctx.changingConfig || !!ctx.sessionOperation || (currentPanel.kind === 'config' && ctx.busy) ||
            (currentPanel.kind === 'rename' && ctx.busy)}
          onClick={choice.choose} />)}
      </list>
      {ctx.extLoading && <spinner label="Running official agy CLI command" />}
      {ctx.changingConfig && <spinner label="Applying the session option through agy" />}
      {ctx.sessionOperation && <spinner label={ctx.sessionOperation} />}
      {ctx.authBusy && <spinner label="Preparing official login; signing out if confirmed" />}
      {currentPanel.kind === 'config' && ctx.busy && <text>Wait for the active turn before changing this option.</text>}
      {currentPanel.kind === 'rename' && ctx.busy && <text>Wait for the active turn before changing conversation names.</text>}
      <text wrap="word">Up/Down or Tab selects; Enter chooses; Esc closes. Hover a row for its full description.</text>
    </>}
  </overlay>;
}
