/** @jsxImportSource @stencil-hq/tern */
import { basename, resolve } from 'node:path';
import type { DiffHunk, EditEvent, JSX, PickerGroup, PickerItem, PrefsRow } from '@stencil-hq/tern';
import type { AuthMethodTerminal, SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import type { AgentAuthentication, AgentMetadata, AgentOptions, AgentSession } from './contracts';
import type { ToolStep, TranscriptEntry } from './model';
import type { Draft } from './draft';
import { configLabel, configValues, commandCategory, filterCommands, type Command } from './commands';
import type { AgentEntry, McpServerEntry, PluginEntry } from './extensions';
import type { OfficialReport } from './reports';
import { parseQuotaReport } from './reports';
import type { SessionPreview } from './history';
import type { PromptTemplate } from './templates';
import { terminalLoginProblem } from './auth';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PREFS,
  DEFAULT_THINKING_ID,
  type ComposerLines,
  type DiffMode,
  type ToolDisplay,
  type TranscriptDensity,
  type UserPrefs,
} from './prefs';
import { imageMimeType, type GitStatusEntry, type WorkspaceEntry } from './files';
import {
  buildUnifiedDiffHunks,
  extractToolImagePaths,
  extractToolInlineImages,
  formatContextUsage,
  formatPathLabel,
  searchTranscript,
  summarizeQuotaRows,
  summarizeToolCall,
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
} from './picker-nav';
import {
  cachedPathExists,
  ToolBody,
  type InspectTarget,
} from './transcript-view';

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
  | { kind: 'find' }
  | { kind: 'tasks' }
  | { kind: 'mcp' }
  | { kind: 'plugins' }
  | { kind: 'agents' }
  | { kind: 'templates' }
  | { kind: 'template-save' }
  | { kind: 'mcp-add' }
  | { kind: 'plugin-install' }
  | { kind: 'confirm'; title: string; detail: string; actionLabel: string; returnTo?: Panel; onConfirm(): void }
  | { kind: 'inspect'; title: string; subtitle?: string; item: InspectTarget };

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
  extLoading: boolean;
  reportLoading: boolean;
  reportText: string;
  sessionsLoading: boolean;
  sessionOperation: string | undefined;
  activeSessionId: string;
  previousSessionId: string | undefined;
  listedSessions: readonly SessionInfo[];
  nextSessionsCursor: string | undefined;
  sessionInfo: ReadonlyMap<string, SessionInfo>;
  localNames: ReadonlyMap<string, string | undefined>;
  sessionPreviews: ReadonlyMap<string, SessionPreview | null>;
  mcpServers: readonly McpServerEntry[];
  pluginsList: readonly PluginEntry[];
  agentsList: readonly AgentEntry[];
  templatesList: readonly PromptTemplate[];
  gitChanges: readonly GitStatusEntry[];
  gitDiffCache: ReadonlyMap<string, { status: 'loading' | 'ready'; hunks: DiffHunk[]; error?: string }>;
  entries: readonly TranscriptEntry[];
  draftText: string;
  panelDraft: Draft;
  panelSelection: number;
  pickerTab: string;
  pickerSelected: string;
  prefsPage: string;
  usageTab: string;
  panelError: string;
  userPrefs: UserPrefs;
  commands: readonly Command[];
  sessionDiffs: readonly SessionDiffItem[];
  choices: readonly Choice[];
  loginMethod: AuthMethodTerminal | undefined;
  modeOption: SessionConfigOption | undefined;
  sessionTitle(id: string): string;
  blobForImage(key: string, data: string, mimeType: string): string | undefined;
  onRender(): void;
  onFocus(target: string | null): void;
  onEditPanelDraft(event: EditEvent): void;
  onSetPickerTab(tab: string, clearSelected?: boolean): void;
  onSetPickerSelected(item: string): void;
  onSetPrefsPage(page: string): void;
  onSetUsageTab(tab: string): void;
  onOpenPanel(next: Panel): void;
  onClosePanel(): void;
  onUpdatePrefs(patch: Partial<UserPrefs>): void;
  onResetPrefs(): void;
  onShowToast(text: string, sub?: string): void;
  onChangeConfig(option: SessionConfigOption, value: string | boolean): void;
  onChooseCommand(command: Command, args?: string, completeOnly?: boolean): void;
  onOpenConversation(id: string, mode?: 'load' | 'resume'): void;
  onNewConversation(): void;
  onLoadSessions(append?: boolean): void;
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
}

function renderPrefsPanel(ctx: PanelRenderContext): JSX.Element {
  const { userPrefs, metadata, modeOption: mode } = ctx;
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
    keys: 'Keyboard shortcuts for the native composer, transcript navigation, and one-time approvals.',
  };
  const lockReason = ctx.busy || ctx.changingConfig || !!ctx.sessionOperation || ctx.disconnected || !ctx.agent
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
  return <prefs key="prefs" title="agy-tern settings" page={ctx.prefsPage}
    lead={leadByPage[ctx.prefsPage]} query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
          { id: 'k-turns', label: 'Jump between user turns in transcript', control: { k: 'keys', keys: [['ctrl', 'up'], ['ctrl', 'down']] } },
          { id: 'k-kill', label: 'Delete word / line start / line end', control: { k: 'keys', keys: [['ctrl', 'w'], ['ctrl', 'u'], ['ctrl', 'k']] } },
          { id: 'k-undo', label: 'Undo composer edit', control: { k: 'keys', keys: [['ctrl', 'z']] } },
          { id: 'k-slash', label: 'Slash commands', control: { k: 'keys', keys: [['/']] } },
          { id: 'k-at', label: 'Attach file/dir/image (or paste image path)', control: { k: 'keys', keys: [['@']] } },
          { id: 'k-paste-img', label: 'Attach screenshot from system clipboard', control: { k: 'keys', keys: [['alt', 'v']] } },
          { id: 'k-stop', label: 'Stop turn / Close modal', control: { k: 'keys', keys: [['esc']] } },
          { id: 'k-scroll', label: 'Scroll conversation', control: { k: 'keys', keys: [['page_up'], ['page_down']] } },
          { id: 'k-allow', label: 'Allow / Deny tool once', control: { k: 'keys', keys: [['ctrl', 'y'], ['ctrl', 'n']] } },
          { id: 'k-quit', label: 'Quit frontend', control: { k: 'keys', keys: [['ctrl', 'q']] } },
        ],
      },
    ]}
    onAction={{
      close: ctx.onClosePanel,
      page: event => {
        if (typeof event.value === 'string') ctx.onSetPrefsPage(event.value);
      },
      'reset-prefs': ctx.onResetPrefs,
      'clear-remembered-model': () => {
        ctx.onUpdatePrefs({ lastModel: undefined, lastThinking: undefined });
        ctx.onShowToast('Remembered model cleared', `Default for new sessions: ${DEFAULT_MODEL_ID} (${DEFAULT_THINKING_ID})`);
      },
      'open-permissions': () => ctx.onOpenPanel({ kind: 'permissions' }),
      'open-account': () => ctx.onOpenPanel({ kind: 'account' }),
    }}
    onChange={event => {
      const key = event.item;
      if (!key) return;
      if (key === 'diffMode' && (event.value === 'auto' || event.value === 'unified' || event.value === 'split')) {
        ctx.onUpdatePrefs({ diffMode: event.value as DiffMode });
      } else if (key === 'toolDisplay' && (event.value === 'compact' || event.value === 'expanded')) {
        ctx.onUpdatePrefs({ toolDisplay: event.value as ToolDisplay });
      } else if (key === 'thoughtExpanded' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ thoughtExpanded: event.value });
      } else if (key === 'transcriptDensity' && (event.value === 'comfortable' || event.value === 'compact')) {
        ctx.onUpdatePrefs({ transcriptDensity: event.value as TranscriptDensity });
      } else if (key === 'showTimestamps' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ showTimestamps: event.value });
      } else if (key === 'autoPreviewMedia' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ autoPreviewMedia: event.value });
      } else if (key === 'notifyOnTurnComplete' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ notifyOnTurnComplete: event.value });
      } else if (key === 'rememberModel' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ rememberModel: event.value });
      } else if (key === 'showKeyLegend' && typeof event.value === 'boolean') {
        ctx.onUpdatePrefs({ showKeyLegend: event.value });
      } else if (key === 'composerLines') {
        const n = Number(event.value);
        if (n === 4 || n === 6 || n === 10) ctx.onUpdatePrefs({ composerLines: n as ComposerLines });
      } else if (key.startsWith('cfg:')) {
        const configId = key.slice(4);
        const option = metadata.configOptions.find(candidate => candidate.id === configId);
        if (option && (typeof event.value === 'string' || typeof event.value === 'boolean')) {
          ctx.onChangeConfig(option, event.value);
        }
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
    onActivate={event => {
      if (!ctx.busy && !ctx.changingConfig && !ctx.disconnected) ctx.onChangeConfig(option, event.item);
    }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, false);
      },
      apply: () => {
        if (highlighted && !ctx.busy && !ctx.changingConfig && !ctx.disconnected) ctx.onChangeConfig(option, highlighted.val.value);
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
  const rows = new Map(ctx.listedSessions.map(row => [row.sessionId, row]));
  if (ctx.activeSessionId) rows.set(ctx.activeSessionId, ctx.sessionInfo.get(ctx.activeSessionId) ?? { sessionId: ctx.activeSessionId, cwd: ctx.options.cwd });
  const allRows = [...rows.values()];
  const namedRows = allRows.filter(row => !!ctx.localNames.get(row.sessionId));
  const filtered = filterSessionRows(allRows, ctx.localNames, ctx.activeSessionId, ctx.sessionTitle, ctx.pickerTab, ctx.panelDraft.text);
  const selectedId = filtered.some(row => row.sessionId === ctx.pickerSelected)
    ? ctx.pickerSelected
    : filtered[0]?.sessionId ?? '';
  const highlighted = filtered.find(row => row.sessionId === selectedId);
  const highlightedPreview = highlighted ? ctx.sessionPreviews.get(highlighted.sessionId) : undefined;
  if (highlighted && highlightedPreview === undefined) {
    ctx.onRequestSessionPreview(highlighted.sessionId);
  }
  const items: PickerItem[] = filtered.map(row => {
    const badges = [
      ...(row.sessionId === ctx.activeSessionId ? [{ text: 'Current', tone: 'success' as const }] : []),
      ...(ctx.previousSessionId && row.sessionId === ctx.previousSessionId ? [{ text: 'Previous', tone: 'info' as const }] : []),
      ...(ctx.localNames.get(row.sessionId) ? [{ text: 'Local name', tone: 'accent' as const }] : []),
    ];
    return {
      id: row.sessionId,
      label: ctx.sessionTitle(row.sessionId),
      detail: `${row.updatedAt ?? 'No timestamp'} · ${row.sessionId.slice(0, 12)}`,
      badges: badges.length ? badges : undefined,
      disabled: row.sessionId !== ctx.activeSessionId && !ctx.agent?.capabilities.loadSession
        ? 'agy does not advertise loading previous sessions' : undefined,
      node: 'pv',
    };
  });
  const cannotSwitch = ctx.busy || ctx.changingConfig || !!ctx.sessionOperation || ctx.disconnected;
  const pv = highlightedPreview;
  return <picker key="picker" size={ctx.rLayout.panelSize} title="Workspace conversations" icon="history"
    subtitle={`Filtered by cwd reported by agy (${ctx.options.cwd}); original workspace is not verified.`}
    placeholder="Search conversations by title, local name, or ID..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
    tabs={[
      { id: 'all', label: 'All', count: allRows.length },
      { id: 'named', label: 'Local named', count: namedRows.length },
    ]}
    tab={ctx.pickerTab}
    order={filtered.map(row => row.sessionId)}
    items={items} selected={selectedId}
    current={ctx.activeSessionId ? [ctx.activeSessionId] : undefined}
    state={ctx.sessionOperation || (ctx.sessionsLoading && !allRows.length) ? 'loading' : ctx.panelError ? 'error' : 'ready'}
    message={ctx.sessionOperation ?? (ctx.sessionsLoading ? 'Syncing conversations from agy...' : ctx.panelError || (!ctx.agent?.capabilities.listSessions ? 'agy does not advertise session listing.' : undefined))}
    empty="No saved conversations matched your filter."
    preview={highlighted ? 'below' : 'none'}
    actions={[
      { id: 'new', label: 'New', disabled: cannotSwitch ? (true as const) : undefined },
      { id: 'rename', label: 'Rename', disabled: (cannotSwitch || !ctx.activeSessionId) ? (true as const) : undefined },
      ...(ctx.agent?.capabilities.listSessions ? [{ id: 'refresh', label: 'Refresh', disabled: cannotSwitch ? (true as const) : undefined }] : []),
      ...(ctx.nextSessionsCursor ? [{ id: 'more', label: 'Load older', disabled: cannotSwitch ? (true as const) : undefined }] : []),
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
      refresh: () => ctx.onLoadSessions(),
      more: () => ctx.onLoadSessions(true),
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
  const filteredGit = ctx.gitChanges.filter(item => `${item.status} ${item.path}`.toLowerCase().includes(query));
  const usingGit = ctx.pickerTab === 'git';
  const order = usingGit ? filteredGit.map(item => `git:${item.path}`) : filteredEdits.map(item => item.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlightedEdit = usingGit ? undefined : filteredEdits.find(item => item.id === selectedId);
  const highlightedGit = usingGit ? filteredGit.find(item => `git:${item.path}` === selectedId) : undefined;
  const highlightedGitDiff = highlightedGit
    ? [...ctx.sessionDiffs].reverse().find(item => item.path === highlightedGit.path)
    : undefined;
  if (highlightedGit && !highlightedGitDiff) {
    ctx.onLoadGitDiffPreview(highlightedGit);
  }
  const cachedGitDiff = highlightedGit ? ctx.gitDiffCache.get(highlightedGit.path) : undefined;
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

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Changes" icon="diff"
    subtitle="Session edits and git status"
    placeholder="Filter modified paths..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
    tabs={[
      { id: 'edits', label: 'Session edits', count: ctx.sessionDiffs.length },
      { id: 'git', label: 'Git status', count: ctx.gitChanges.length },
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
        disabled: !highlightedPath || !cachedPathExists(resolve(ctx.options.cwd, highlightedPath)) ? (true as const) : undefined },
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
  const matches = searchTranscript(ctx.entries, ctx.options.cwd, ctx.panelDraft.text);
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
    ? extractToolImagePaths(highlighted.entry.call, ctx.options.cwd).find(p => cachedPathExists(p))
    : undefined;

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Find" icon="slash"
    subtitle="Search transcript entries"
    placeholder="Type keywords to filter transcript..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
        : isDir && item.preview.truncated ? `Showing ${item.preview.entries.length} of ${item.preview.totalCount} entries · ` : ''}Esc closes without cancelling</span></text>
      <row gap="xs">
        {parentInspectDir && <button size="sm" icon="back" onClick={() => ctx.onInspectDirPath(parentInspectDir)}>Up</button>}
        {item.type === 'diff' && <button size="sm" onClick={() => {
          const next: DiffMode = ctx.userPrefs.diffMode === 'auto' ? 'unified' : ctx.userPrefs.diffMode === 'unified' ? 'split' : 'auto';
          ctx.onUpdatePrefs({ diffMode: next });
        }}>Layout: {ctx.userPrefs.diffMode}</button>}
        {copyText !== undefined && <button size="sm" icon="copy" onClick={() => ctx.onCopy(copyText)}>Copy</button>}
        {attachablePath && !isMedia && cachedPathExists(resolve(ctx.options.cwd, attachablePath.replace(/\/+$/, ''))) && <>
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
      ? <scroll max={{ h: bodyMaxH }}><diff mode={ctx.userPrefs.diffMode} path={item.path} hunks={item.hunks} /></scroll>
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
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
  const allTools = ctx.entries
    .filter((entry): entry is ToolStep => entry.type === 'tool')
    .slice()
    .reverse();
  const filtered = allTools.filter(step => {
    const summary = summarizeToolCall(step.call, ctx.options.cwd);
    const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
    if (ctx.pickerTab === 'running' && !isRunning) return false;
    if (ctx.pickerTab === 'done' && isRunning) return false;
    if (!query) return true;
    return `${summary.title} ${summary.target ?? ''} ${step.call.toolCallId}`.toLowerCase().includes(query);
  });
  const order = filtered.map(step => step.id);
  const selectedId = order.includes(ctx.pickerSelected) ? ctx.pickerSelected : (order[0] ?? '');
  const highlighted = filtered.find(step => step.id === selectedId);
  const highlightedSummary = highlighted ? summarizeToolCall(highlighted.call, ctx.options.cwd) : undefined;
  const now = Date.now();
  const runningCount = allTools.filter(step => step.call.status === 'in_progress' || step.call.status === 'pending').length;

  const inspectTaskStep = (step: ToolStep): void => {
    const s = summarizeToolCall(step.call, ctx.options.cwd);
    const detailText = [
      `Tool: ${s.title}`,
      ...(s.target ? [`Target: ${s.target}`] : []),
      ...(s.fullCommand ? [`Command:\n${s.fullCommand}`] : []),
      ...(step.call.rawInput !== undefined ? [`Input:\n${JSON.stringify(step.call.rawInput, null, 2)}`] : []),
      ...(step.call.rawOutput !== undefined ? [`Output:\n${typeof step.call.rawOutput === 'string' ? step.call.rawOutput : JSON.stringify(step.call.rawOutput, null, 2)}`] : []),
    ].join('\n\n');
    ctx.onOpenInspect(s.title, { type: 'file', path: 'task.log', content: detailText }, s.target);
  };

  const items: PickerItem[] = filtered.map(step => {
    const summary = summarizeToolCall(step.call, ctx.options.cwd);
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

  return <picker key="picker" size={ctx.rLayout.panelSize} title="Tasks & tool activity" icon="timer"
    subtitle={ctx.busy || runningCount ? `${runningCount} active tool(s) in current turn · Stop cancels the active ACP turn` : `${allTools.length} tool call(s) recorded in this session`}
    placeholder="Filter tasks by tool, command, or path..."
    query={ctx.panelDraft.text} cursor={ctx.panelDraft.cursor}
    tabs={[
      { id: 'all', label: 'All', count: allTools.length },
      { id: 'running', label: 'Running', count: runningCount },
      { id: 'done', label: 'Finished', count: allTools.length - runningCount },
    ]}
    tab={ctx.pickerTab}
    order={order}
    items={items} selected={selectedId}
    state="ready"
    empty={ctx.pickerTab === 'running' ? 'No tool tasks are currently running.' : 'No tool activity recorded in this conversation yet.'}
    preview={highlighted ? 'below' : 'none'}
    actions={[
      ...(ctx.busy ? [{ id: 'stopTurn', label: ctx.cancelling ? 'Stopping...' : 'Stop active turn', keys: ['esc'], disabled: ctx.cancelling ? (true as const) : undefined }] : []),
      { id: 'close', label: 'Close', keys: ['esc'] },
      { id: 'inspect', label: 'Inspect details', primary: true, keys: ['enter'], disabled: !highlighted ? (true as const) : undefined },
    ]}
    onSelect={event => ctx.onSetPickerSelected(event.item)}
    onActivate={() => { if (highlighted) inspectTaskStep(highlighted); }}
    onAction={{
      close: ctx.onClosePanel,
      tab: event => {
        if (typeof event.value === 'string') ctx.onSetPickerTab(event.value, false);
      },
      stopTurn: ctx.onStopTurn,
      inspect: () => { if (highlighted) inspectTaskStep(highlighted); },
    }}>
    {highlighted && highlightedSummary && <ToolBody call={highlighted.call} cwd={ctx.options.cwd} showRawInput={highlightedSummary.showRawInput}
      fullCommand={highlightedSummary.fullCommand} diffMode={ctx.userPrefs.diffMode}
      getBlob={ctx.blobForImage} onInspect={ctx.onOpenInspect} onOpenSplit={ctx.onOpenSplit}
      onCopy={ctx.onCopy} />}
  </picker>;
}

/** Render the active modal picker, prefs window, report overlay, or inspector dialog. */
export function renderActivePanel(ctx: PanelRenderContext): JSX.Element {
  const currentPanel = ctx.panel;
  if (currentPanel.kind === 'settings') return renderPrefsPanel(ctx);
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
  if (currentPanel.kind === 'tasks') return renderTasksPicker(ctx);
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
      {currentPanel.report === 'usage' ? <col gap="md">
        <tabs variant="segmented" active={ctx.usageTab}
          items={[
            { id: 'overview', label: 'Overview' },
            { id: 'details', label: 'Details' },
            { id: 'raw', label: 'Raw report' },
          ]}
          onChange={event => ctx.onSetUsageTab(String(event.value ?? 'overview'))} />
        {ctx.reportLoading && <spinner label="Reading official /usage report" />}
        {ctx.usageTab === 'overview' && <>
          <stats items={[
            {
              label: 'Tightest quota',
              value: quotaSummary ? quotaSummary.tightest.remaining : (ctx.reportLoading ? 'Loading' : 'Unavailable'),
              sub: quotaSummary
                ? `${quotaSummary.tightest.group} · ${quotaSummary.tightest.limit}${ctx.metadata.tier ? ` · ${ctx.metadata.tier.name}` : ''}`
                : (ctx.metadata.tier ? `${ctx.metadata.tier.name} · Official CLI /usage` : 'From official CLI /usage'),
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
          }))} /> : ctx.reportText && <md>{ctx.reportText}</md>}
        </>}
        {ctx.usageTab === 'details' && <>
          {(ctx.metadata.tier || ctx.metadata.usage) ? <kv items={[
            ...(ctx.metadata.tier ? [{ k: 'Subscription tier', v: ctx.metadata.tier.name }] : []),
            ...(ctx.metadata.usage ? [
              { k: 'Session context tokens', v: ctx.metadata.usage.used.toLocaleString() },
              { k: 'Context window', v: ctx.metadata.usage.size.toLocaleString() },
              ...(ctx.metadata.usage.cost ? [{ k: 'Session cost', v: `${ctx.metadata.usage.cost.amount} ${ctx.metadata.usage.cost.currency}` }] : []),
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
          }))} /> : ctx.reportText && <md>{ctx.reportText}</md>}
        </>}
        {ctx.usageTab === 'raw' && (ctx.reportText
          ? <code wrap>{ctx.reportText}</code>
          : <text><span s="muted">No raw report output captured yet.</span></text>)}
      </col> : <>
        {ctx.reportLoading && <spinner label={`Reading official /${currentPanel.report} report`} />}
        {ctx.reportText && <md>{ctx.reportText}</md>}
      </>}
      {ctx.panelError && <text wrap="word"><span s="error">{ctx.panelError}</span></text>}
      <button keys={['enter']} on={ctx.panelSelection % 2 === 0} disabled={ctx.reportLoading && 'Report is loading'}
        onClick={() => ctx.onLoadReport(currentPanel.report)}>Refresh report</button>
      <text wrap="word">Tab selects Refresh or Close. Enter activates; Esc returns to the conversation.</text>
    </> : <>
      {currentPanel.kind === 'account' && <>
        <kv items={[
          { k: 'ACP connection', v: ctx.disconnected ? 'Disconnected' : ctx.agent ? 'Connected; model access not guaranteed' : 'Connecting' },
          { k: 'Subscription tier', v: ctx.metadata.tier ? ctx.metadata.tier.name : 'Not reported by ACP' },
          { k: 'Account identity', v: 'Not exposed by this ACP connection' },
          { k: 'Credential owner', v: 'Official agy shared authentication' },
        ]} />
        <text wrap="word">Sign in through agy’s interactive flow. This frontend stores no accounts or tokens. Switching requires signing in again, not selecting a saved-account pool. Login reconnects a fresh session and keeps your unsent draft.</text>
        {!ctx.authenticationKnown && <text wrap="word">{ctx.disconnected ? 'No login descriptor received. Use the official CLI terminal login from your shell.' : 'Waiting for agy to advertise sign-in options.'}</text>}
        {ctx.authenticationKnown && !method && <text>agy did not advertise terminal sign-in support.</text>}
        {loginProblem && <text wrap="word"><span s="error">{loginProblem}</span></text>}
        {method && !loginProblem && <code wrap>{JSON.stringify([ctx.options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
        {(ctx.busy || ctx.changingConfig || ctx.sessionOperation) && <text>Wait for the active operation before signing in or changing accounts.</text>}
      </>}
      {currentPanel.kind === 'account-switch' && <>
        <text wrap="word">This signs out first. Antigravity shares credentials across CLI, App and IDE extensions, so they may also lose their login. If login is cancelled, the old credentials are not restored.</text>
        <text wrap="word">Choose your other account in the official login flow. Afterwards this frontend starts a fresh session and keeps only your unsent draft. It does not replay the failed prompt or automatically transfer the old conversation.</text>
        {method && <code wrap>{JSON.stringify([ctx.options.executable ?? 'agy', 'acp', '--sandbox', ...(method.args ?? [])])}</code>}
      </>}
      {currentPanel.kind === 'permissions' && <>
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
