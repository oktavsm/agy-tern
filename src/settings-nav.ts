import type { Key, PrefsControl, PrefsRow } from '@stencil-hq/tern';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AgentMetadata, AgentOptions, AgentSession } from './contracts';
import { configLabel, configValues } from './commands';
import { draftKey, type Draft } from './draft';
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
import pkg from '../package.json';

export const PREFS_PAGES = [
  { id: 'appearance', label: 'Appearance & UI', icon: 'appearance' as const },
  { id: 'session', label: 'Session & Model', icon: 'model' as const },
  { id: 'permissions', label: 'Permissions & Sandbox', icon: 'shield' as const },
  { id: 'keys', label: 'Keybindings', icon: 'keyboard' as const },
] as const;

export type PrefsPageId = (typeof PREFS_PAGES)[number]['id'];

export interface SettingsSectionData {
  readonly id: string;
  readonly title: string;
  readonly page: PrefsPageId;
  readonly rows: readonly PrefsRow[];
}

export interface SettingsPageMeta {
  readonly id: PrefsPageId;
  readonly label: string;
  readonly icon: 'appearance' | 'model' | 'shield' | 'keyboard';
  readonly changed?: number;
}

export interface UpdateStatusState {
  readonly checking: boolean;
  readonly latestTag?: string;
  readonly updateAvailable?: boolean;
  readonly error?: string;
}

export interface SettingsViewInput {
  userPrefs: UserPrefs;
  metadata: AgentMetadata;
  modeOption: SessionConfigOption | undefined;
  options: AgentOptions;
  workspaceName: string;
  agent: AgentSession | undefined;
  disconnected: boolean;
  agentConnecting: boolean;
  busy: boolean;
  changingConfig: boolean;
  startupSyncingConfig?: boolean;
  authBusy?: boolean;
  hasPendingPermissions?: boolean;
  sessionOperation: string | undefined;
  updateStatus?: UpdateStatusState;
}

export interface SettingsViewData {
  pages: readonly SettingsPageMeta[];
  leadByPage: Record<PrefsPageId, string>;
  sections: readonly SettingsSectionData[];
}

export function isPrefsPageId(value: string): value is PrefsPageId {
  return PREFS_PAGES.some(page => page.id === value);
}

/** Normalize boolean change payloads across Tern `on`, `checked`, and `value` fields. */
export function extractChangeBoolean(event: {
  readonly on?: unknown;
  readonly checked?: unknown;
  readonly value?: unknown;
}): boolean | undefined {
  if (typeof event.on === 'boolean') return event.on;
  if (typeof event.checked === 'boolean') return event.checked;
  if (typeof event.value === 'boolean') return event.value;
  return undefined;
}

export function stripConfigPrefix(rowId: string): string | undefined {
  if (rowId.startsWith('cfg-') || rowId.startsWith('cfg:')) return rowId.slice(4);
  if (rowId.startsWith('perm-') || rowId.startsWith('perm:')) return rowId.slice(5);
  return undefined;
}

/** Return a clear user-facing reason when ACP config changes are temporarily blocked, or undefined when ready. */
export function getConfigLockReason(input: {
  agent?: unknown;
  disconnected?: boolean;
  agentConnecting?: boolean;
  busy?: boolean;
  changingConfig?: boolean;
  startupSyncingConfig?: boolean;
  sessionOperation?: string;
  authBusy?: boolean;
  hasPendingPermissions?: boolean;
}): string | undefined {
  if (input.authBusy) return 'Finish the active sign-in flow first';
  if (input.hasPendingPermissions) return 'Resolve the pending tool approval first';
  if (input.disconnected) return 'Session disconnected; reconnect to Antigravity first';
  if (!input.agent) return input.agentConnecting ? 'Waiting for Antigravity connection...' : 'Antigravity session is not ready yet';
  if (input.busy) return 'Wait for the active turn to finish';
  if (input.sessionOperation) return `Wait until "${input.sessionOperation}" finishes`;
  if (input.changingConfig) return 'Applying previous session option change...';
  if (input.startupSyncingConfig) return 'Syncing startup model defaults...';
  return undefined;
}

const LEAD_BY_PAGE: Record<PrefsPageId, string> = {
  appearance: 'Transcript rendering, diff layout, and composer settings saved locally for agy-tern.',
  session: 'Dynamic session options supplied by agy over ACP and remembered model defaults.',
  permissions: 'Session mode reported by agy, sandbox launch flags, and account access.',
  keys: 'Keyboard shortcuts for the native composer, transcript navigation, and modals.',
};

export function buildSettingsViewData(input: SettingsViewInput): SettingsViewData {
  const { userPrefs, metadata, modeOption: mode } = input;
  const lockReason = getConfigLockReason(input);

  const sessionRows: PrefsRow[] = metadata.configOptions.map(option => {
    const values = option.type === 'select' ? configValues(option) : [];
    const currentText = configLabel(option);
    const usePickerAction = option.type === 'select' && (values.length > 3 || option.category === 'model' || option.id === 'model');
    const baseHint = option.description ?? (usePickerAction
      ? `Current: ${currentText} · Click or Enter to choose from ${values.length} options`
      : option.id);
    return {
      id: `cfg-${option.id}`,
      label: option.name,
      hint: lockReason ? `${baseHint} (${lockReason})` : baseHint,
      disabled: usePickerAction ? undefined : lockReason,
      control: option.type === 'boolean'
        ? { k: 'switch', on: Boolean(option.currentValue) }
        : usePickerAction
          ? { k: 'action', act: `open-config:${option.id}`, label: currentText || 'Choose...' }
          : {
            k: 'choice',
            value: option.currentValue,
            style: 'segmented',
            options: values.map(entry => ({
              value: entry.value,
              label: entry.name,
              detail: entry.description ?? undefined,
            })),
          },
    };
  });

  const emptySessionHint = input.agentConnecting
    ? 'Waiting for agy ACP session initialization...'
    : input.disconnected
      ? 'Session is disconnected; reconnect to configure live ACP options.'
      : 'Connected agy agent did not expose runtime configOptions.';

  const hasSavedModelChoice = Boolean(userPrefs.lastModel || userPrefs.lastThinking);

  const sections: SettingsSectionData[] = [
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
          hint: 'Keep reasoning expanded after turns finish (live thinking expands while running)',
          changed: userPrefs.thoughtExpanded !== DEFAULT_PREFS.thoughtExpanded,
          defaultLabel: DEFAULT_PREFS.thoughtExpanded ? 'On' : 'Off',
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
          defaultLabel: DEFAULT_PREFS.showTimestamps ? 'On' : 'Off',
          control: { k: 'switch', on: userPrefs.showTimestamps },
        },
        {
          id: 'autoPreviewMedia',
          label: 'Auto-open modal popup for images during turns',
          hint: 'Default off: screenshots and images display inline; click any image to open its modal preview',
          changed: userPrefs.autoPreviewMedia !== DEFAULT_PREFS.autoPreviewMedia,
          defaultLabel: DEFAULT_PREFS.autoPreviewMedia ? 'On' : 'Off',
          control: { k: 'switch', on: userPrefs.autoPreviewMedia },
        },
        {
          id: 'notifyOnTurnComplete',
          label: 'Terminal attention notifications',
          hint: 'Notify terminal when long turns (>= 8s) finish or approvals await',
          changed: userPrefs.notifyOnTurnComplete !== DEFAULT_PREFS.notifyOnTurnComplete,
          defaultLabel: DEFAULT_PREFS.notifyOnTurnComplete ? 'On' : 'Off',
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
          defaultLabel: `${DEFAULT_PREFS.composerLines} lines`,
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
          id: 'maxFps',
          label: 'Streaming frame cap',
          hint: 'Lower FPS saves CPU and battery on mid-low laptops during long agent streams',
          changed: userPrefs.maxFps !== DEFAULT_PREFS.maxFps,
          defaultLabel: `${DEFAULT_PREFS.maxFps} FPS`,
          control: {
            k: 'choice',
            value: String(userPrefs.maxFps),
            style: 'segmented',
            options: [
              { value: '15', label: '15 FPS' },
              { value: '25', label: '25 FPS' },
              { value: '40', label: '40 FPS' },
              { value: '60', label: '60 FPS' },
            ],
          },
        },
        {
          id: 'motion',
          label: 'Animation & shimmer motion',
          hint: 'Auto follows terminal reduced-motion signals; Reduced freezes shimmer/spinner cadence',
          changed: userPrefs.motion !== DEFAULT_PREFS.motion,
          defaultLabel: DEFAULT_PREFS.motion,
          control: {
            k: 'choice',
            value: userPrefs.motion,
            style: 'segmented',
            options: [
              { value: 'auto', label: 'Auto' },
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
            ],
          },
        },
        {
          id: 'showKeyLegend',
          label: 'Show shortcut legend below dock',
          hint: 'Approval shortcuts still appear automatically while a permission prompt is active',
          changed: userPrefs.showKeyLegend !== DEFAULT_PREFS.showKeyLegend,
          defaultLabel: DEFAULT_PREFS.showKeyLegend ? 'On' : 'Off',
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
        hint: emptySessionHint,
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
          defaultLabel: DEFAULT_PREFS.rememberModel ? 'On' : 'Off',
          control: { k: 'switch', on: userPrefs.rememberModel },
        },
        {
          id: 'clearRememberedModel',
          label: 'Reset remembered model choice',
          hint: hasSavedModelChoice
            ? `Saved: ${userPrefs.lastModel ?? DEFAULT_MODEL_ID} · ${userPrefs.lastThinking ?? DEFAULT_THINKING_ID}`
            : `Using built-in default (${DEFAULT_MODEL_ID} · ${DEFAULT_THINKING_ID})`,
          changed: hasSavedModelChoice,
          disabled: hasSavedModelChoice ? undefined : 'Already using built-in default',
          control: { k: 'action', act: 'clear-remembered-model', label: 'Use default' },
        },
      ],
    },
    {
      id: 'frontend-updates',
      title: 'Frontend & Updates',
      page: 'session',
      rows: [
        {
          id: 'checkUpdates',
          label: `agy-tern v${pkg.version}`,
          hint: input.updateStatus?.checking
            ? 'Checking GitHub Releases for a newer version...'
            : input.updateStatus?.error
              ? `Update check failed: ${input.updateStatus.error}`
              : input.updateStatus?.updateAvailable && input.updateStatus.latestTag
                ? `Update available: ${input.updateStatus.latestTag}. Run \`agy-tern update\` in your shell to upgrade.`
                : input.updateStatus?.latestTag
                  ? `Up to date with latest release (${input.updateStatus.latestTag}).`
                  : 'Check GitHub Releases or run `agy-tern update` from your terminal',
          disabled: input.updateStatus?.checking ? 'Checking GitHub Releases...' : undefined,
          control: {
            k: 'action',
            act: 'check-updates',
            label: input.updateStatus?.checking ? 'Checking...' : 'Check for updates',
          },
        },
      ],
    },
    {
      id: 'perms-summary',
      title: 'Sandbox & Mode',
      page: 'permissions',
      rows: [
        ...(mode && mode.type === 'select' ? [{
          id: `perm-${mode.id}`,
          label: mode.name,
          hint: 'Session mode supplied by agy; Plan mode does not verify read-only OS enforcement',
          disabled: lockReason,
          control: {
            k: 'choice' as const,
            value: mode.currentValue,
            style: 'segmented' as const,
            options: configValues(mode).map(entry => ({ value: entry.value, label: entry.name })),
          },
        }] : [{
          id: 'perm-mode-status',
          label: 'Session mode',
          hint: input.agentConnecting
            ? 'Waiting for agy ACP session mode metadata...'
            : 'Current agy session did not advertise a selectable mode option',
        }]),
        {
          id: 'sandbox-flag',
          label: 'Sandbox status (--sandbox)',
          hint: `Launched ${input.options.executable ?? 'agy'} acp --sandbox in ${input.workspaceName}; OS containment and rules are enforced by agy`,
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
        { id: 'k-settings-nav', label: 'Settings navigation (pages / rows / values / apply)', control: { k: 'keys', keys: [['tab'], ['up'], ['down'], ['left'], ['right'], ['enter']] } },
        { id: 'k-stop', label: 'Stop turn / Close modal', control: { k: 'keys', keys: [['esc']] } },
        { id: 'k-scroll', label: 'Scroll conversation', control: { k: 'keys', keys: [['page_up'], ['page_down']] } },
        { id: 'k-inspect', label: 'Inspect modal scroll & actions', control: { k: 'keys', keys: [['page_up'], ['page_down'], ['c'], ['s'], ['a']] } },
        { id: 'k-allow', label: 'Allow / Deny tool once', control: { k: 'keys', keys: [['ctrl', 'y'], ['ctrl', 'n']] } },
        { id: 'k-quit', label: 'Quit frontend', control: { k: 'keys', keys: [['ctrl', 'q']] } },
      ],
    },
  ];

  const changedByPage = new Map<PrefsPageId, number>();
  for (const sec of sections) {
    const count = sec.rows.filter(row => row.changed).length;
    if (count > 0) changedByPage.set(sec.page, (changedByPage.get(sec.page) ?? 0) + count);
  }
  const pages: SettingsPageMeta[] = PREFS_PAGES.map(page => ({
    id: page.id,
    label: page.label,
    icon: page.icon,
    ...(changedByPage.get(page.id) ? { changed: changedByPage.get(page.id) } : {}),
  }));

  return { pages, leadByPage: LEAD_BY_PAGE, sections };
}

/** Return visible rows for either the active page (when query is empty) or cross-page search results. */
export function visibleSettingsRows(
  sections: readonly SettingsSectionData[],
  currentPage: string,
  query: string,
): Array<{ section: SettingsSectionData; row: PrefsRow }> {
  const needle = query.trim().toLowerCase();
  const out: Array<{ section: SettingsSectionData; row: PrefsRow }> = [];
  for (const section of sections) {
    if (!needle && section.page !== currentPage) continue;
    for (const row of section.rows) {
      if (needle) {
        const haystack = `${row.label ?? ''} ${row.hint ?? ''} ${section.title} ${row.id}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      out.push({ section, row });
    }
  }
  return out;
}

export function resolvePrefsFocusRow(
  sections: readonly SettingsSectionData[],
  currentPage: string,
  currentFocus: string | undefined,
  query: string,
): string | undefined {
  const rows = visibleSettingsRows(sections, currentPage, query);
  if (!rows.length) return undefined;
  if (currentFocus && rows.some(entry => entry.row.id === currentFocus)) return currentFocus;
  return rows[0]?.row.id;
}

const VALID_DIFF_MODES = new Set<DiffMode>(['auto', 'unified', 'split']);
const VALID_TOOL_DISPLAYS = new Set<ToolDisplay>(['compact', 'expanded']);
const VALID_DENSITIES = new Set<TranscriptDensity>(['comfortable', 'compact']);
const VALID_MOTIONS = new Set<MotionPref>(['auto', 'full', 'reduced']);
const BOOLEAN_PREF_KEYS = new Set<keyof UserPrefs>([
  'thoughtExpanded',
  'showTimestamps',
  'autoPreviewMedia',
  'notifyOnTurnComplete',
  'rememberModel',
  'showKeyLegend',
]);

/** Convert a local preference row update into a validated Partial<UserPrefs> patch. */
export function patchForLocalPrefChange(
  rowId: string,
  event: { readonly on?: unknown; readonly checked?: unknown; readonly value?: unknown },
): Partial<UserPrefs> | undefined {
  if (rowId === 'diffMode' && typeof event.value === 'string' && VALID_DIFF_MODES.has(event.value as DiffMode)) {
    return { diffMode: event.value as DiffMode };
  }
  if (rowId === 'toolDisplay' && typeof event.value === 'string' && VALID_TOOL_DISPLAYS.has(event.value as ToolDisplay)) {
    return { toolDisplay: event.value as ToolDisplay };
  }
  if (rowId === 'transcriptDensity' && typeof event.value === 'string' && VALID_DENSITIES.has(event.value as TranscriptDensity)) {
    return { transcriptDensity: event.value as TranscriptDensity };
  }
  if (rowId === 'motion' && typeof event.value === 'string' && VALID_MOTIONS.has(event.value as MotionPref)) {
    return { motion: event.value as MotionPref };
  }
  if (rowId === 'composerLines') {
    const n = Number(event.value);
    if (n === 4 || n === 6 || n === 10) return { composerLines: n as ComposerLines };
    return undefined;
  }
  if (rowId === 'maxFps') {
    const fps = Number(event.value);
    if (Number.isFinite(fps) && fps >= 5 && fps <= 60) return { maxFps: Math.round(fps) };
    return undefined;
  }
  if (BOOLEAN_PREF_KEYS.has(rowId as keyof UserPrefs)) {
    const boolVal = extractChangeBoolean(event);
    if (boolVal !== undefined) return { [rowId]: boolVal } as Partial<UserPrefs>;
  }
  return undefined;
}

/** Resolve a row-level "Reset" click to its default preference patch. */
export function patchForPrefRowReset(rowId: string): Partial<UserPrefs> | undefined {
  if (rowId === 'clearRememberedModel') {
    return { lastModel: undefined, lastThinking: undefined };
  }
  if (rowId in DEFAULT_PREFS) {
    return { [rowId]: DEFAULT_PREFS[rowId as keyof typeof DEFAULT_PREFS] } as Partial<UserPrefs>;
  }
  return undefined;
}

export type SettingsKeyEffect =
  | { readonly kind: 'prefs'; readonly patch: Partial<UserPrefs> }
  | { readonly kind: 'config'; readonly optionId: string; readonly value: string | boolean }
  | { readonly kind: 'open-config'; readonly optionId: string }
  | { readonly kind: 'action'; readonly act: string }
  | { readonly kind: 'disabled'; readonly reason: string };

export interface SettingsKeyStep {
  readonly page: PrefsPageId;
  readonly focusRowId: string | undefined;
  readonly draft: Draft;
  readonly effect?: SettingsKeyEffect;
}

function stepControlForRow(
  row: PrefsRow,
  direction: 1 | -1,
  preferOpenMenu: boolean,
  configOptions?: readonly SessionConfigOption[],
): SettingsKeyEffect | undefined {
  const control: PrefsControl | undefined = row.control;
  if (!control) return undefined;
  if (row.disabled) return { kind: 'disabled', reason: row.disabled };

  const configId = stripConfigPrefix(row.id);

  if (control.k === 'action') {
    if (!preferOpenMenu && control.act?.startsWith('open-config:') && configOptions) {
      const targetId = control.act.slice('open-config:'.length);
      const opt = configOptions.find(candidate => candidate.id === targetId);
      if (opt?.type === 'select') {
        const vals = configValues(opt);
        if (vals.length > 0) {
          const curIdx = Math.max(0, vals.findIndex(v => v.value === opt.currentValue));
          const nextOpt = vals[(curIdx + vals.length + direction) % vals.length];
          if (nextOpt) return { kind: 'config', optionId: opt.id, value: nextOpt.value };
        }
      }
    }
    return control.act ? { kind: 'action', act: control.act } : undefined;
  }
  if (control.k === 'switch') {
    const nextVal = preferOpenMenu ? !control.on : direction === 1;
    if (nextVal === Boolean(control.on)) return undefined;
    if (configId) return { kind: 'config', optionId: configId, value: nextVal };
    const patch = patchForLocalPrefChange(row.id, { on: nextVal });
    return patch ? { kind: 'prefs', patch } : undefined;
  }
  if (control.k === 'choice') {
    const options = control.options ?? [];
    if (preferOpenMenu && control.style === 'menu' && configId) {
      return { kind: 'open-config', optionId: configId };
    }
    if (!options.length) return undefined;
    const currentIndex = Math.max(0, options.findIndex(opt => opt.value === control.value));
    const nextOption = options[(currentIndex + options.length + direction) % options.length];
    if (!nextOption) return undefined;
    if (configId) return { kind: 'config', optionId: configId, value: nextOption.value };
    const patch = patchForLocalPrefChange(row.id, { value: nextOption.value });
    return patch ? { kind: 'prefs', patch } : undefined;
  }
  return undefined;
}

/** Step keyboard navigation, page tabs, and inline controls inside the `/settings` `<prefs>` panel. */
export function stepSettingsKey(
  state: { page: string; focusRowId?: string; draft: Draft },
  key: Key,
  sections: readonly SettingsSectionData[],
  configOptions?: readonly SessionConfigOption[],
): SettingsKeyStep {
  const currentPage: PrefsPageId = isPrefsPageId(state.page) ? state.page : 'appearance';
  const rows = visibleSettingsRows(sections, currentPage, state.draft.text);
  const currentFocus = resolvePrefsFocusRow(sections, currentPage, state.focusRowId, state.draft.text);
  const currentIdx = Math.max(0, rows.findIndex(entry => entry.row.id === currentFocus));
  const activeEntry = rows[currentIdx];

  // Page switching via Tab / Shift+Tab or Alt+1..4.
  if (key.name === 'tab' && !key.ctrl && !key.meta && !key.alt) {
    const pageIdx = PREFS_PAGES.findIndex(p => p.id === currentPage);
    const nextPage = PREFS_PAGES[(pageIdx + (key.shift ? PREFS_PAGES.length - 1 : 1)) % PREFS_PAGES.length]!.id;
    const nextFocus = resolvePrefsFocusRow(sections, nextPage, undefined, '');
    return { page: nextPage, focusRowId: nextFocus, draft: { text: '', cursor: 0 } };
  }
  if (key.alt && !key.ctrl && !key.meta && key.text && /^[1-4]$/.test(key.text)) {
    const nextPage = PREFS_PAGES[Number(key.text) - 1]!.id;
    const nextFocus = resolvePrefsFocusRow(sections, nextPage, undefined, '');
    return { page: nextPage, focusRowId: nextFocus, draft: { text: '', cursor: 0 } };
  }

  // Row focus movement via Up / Down / Home / End / PageUp / PageDown.
  if (!key.ctrl && !key.meta && !key.alt) {
    if (key.name === 'up' || key.name === 'down') {
      if (!rows.length) return { page: currentPage, focusRowId: undefined, draft: state.draft };
      const nextIdx = (currentIdx + rows.length + (key.name === 'up' ? -1 : 1)) % rows.length;
      return { page: currentPage, focusRowId: rows[nextIdx]?.row.id, draft: state.draft };
    }
    if (key.name === 'home' || key.name === 'end') {
      if (!rows.length) return { page: currentPage, focusRowId: undefined, draft: state.draft };
      const target = key.name === 'home' ? rows[0] : rows[rows.length - 1];
      return { page: currentPage, focusRowId: target?.row.id, draft: state.draft };
    }
    if (key.name === 'page_up' || key.name === 'page_down') {
      if (!rows.length) return { page: currentPage, focusRowId: undefined, draft: state.draft };
      const delta = key.name === 'page_up' ? -5 : 5;
      const nextIdx = Math.max(0, Math.min(rows.length - 1, currentIdx + delta));
      return { page: currentPage, focusRowId: rows[nextIdx]?.row.id, draft: state.draft };
    }
    if (key.name === 'left' || key.name === 'right') {
      const dir: -1 | 1 = key.name === 'left' ? -1 : 1;
      const isInlineConfigAction = activeEntry?.row.control?.k === 'action' &&
        activeEntry.row.control.act?.startsWith('open-config:');
      if (activeEntry?.row.control && activeEntry.row.control.k !== 'keys' &&
        (activeEntry.row.control.k !== 'action' || isInlineConfigAction)) {
        const effect = stepControlForRow(activeEntry.row, dir, false, configOptions);
        return { page: currentPage, focusRowId: currentFocus, draft: state.draft, effect };
      }
      if (!state.draft.text) {
        const pageIdx = PREFS_PAGES.findIndex(p => p.id === currentPage);
        const nextPage = PREFS_PAGES[(pageIdx + PREFS_PAGES.length + dir) % PREFS_PAGES.length]!.id;
        return {
          page: nextPage,
          focusRowId: resolvePrefsFocusRow(sections, nextPage, undefined, ''),
          draft: state.draft,
        };
      }
    }
    if ((key.name === 'enter' && !key.shift) || ((key.name === 'space' || key.text === ' ') && state.draft.text === '')) {
      if (activeEntry) {
        const effect = stepControlForRow(activeEntry.row, 1, true, configOptions);
        return { page: currentPage, focusRowId: currentFocus, draft: state.draft, effect };
      }
      return { page: currentPage, focusRowId: currentFocus, draft: state.draft };
    }
  }

  const nextDraft = draftKey(state.draft, key).draft;
  return {
    page: currentPage,
    focusRowId: resolvePrefsFocusRow(sections, currentPage, currentFocus, nextDraft.text),
    draft: nextDraft,
  };
}
