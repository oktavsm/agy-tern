import { resolve } from 'node:path';
import type { SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { commandCategory, filterCommands, type Command } from './commands';
import { draftKey, type Draft } from './draft';
import type { AgentEntry, McpServerEntry, PluginEntry } from './extensions';
import type { GitStatusEntry } from './files';
import type { SessionPreview } from './history';
import type { ToolStep, TranscriptEntry } from './model';
import type { PromptTemplate } from './templates';
import {
  searchTranscriptCached,
  summarizeToolCall,
  type SessionDiffItem,
  type TranscriptSearchMatch,
} from './ui-format';

export interface PickerKeyInput {
  name: string;
  text?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface PickerStepResult {
  tab: string;
  selected: string;
  draft: Draft;
  activateId?: string;
}

/** Handle Tab, Up/Down, Enter, and filter typing uniformly across all Tern `<picker>` panels. */
export function stepPickerKey(
  state: { tab: string; selected: string; draft: Draft },
  key: PickerKeyInput,
  tabIds: readonly string[],
  visibleIds: readonly string[],
): PickerStepResult {
  if (key.name === 'tab' && tabIds.length > 1) {
    const idx = Math.max(0, tabIds.indexOf(state.tab));
    const nextTab = tabIds[(idx + (key.shift ? tabIds.length - 1 : 1)) % tabIds.length]!;
    return { tab: nextTab, selected: '', draft: state.draft };
  }
  if ((key.name === 'up' || key.name === 'down') && visibleIds.length) {
    const idx = Math.max(0, visibleIds.indexOf(state.selected));
    const nextSelected = visibleIds[(idx + (key.name === 'up' ? visibleIds.length - 1 : 1)) % visibleIds.length]!;
    return { tab: state.tab, selected: nextSelected, draft: state.draft };
  }
  if (key.name === 'enter' && !key.shift && visibleIds.length) {
    const activateId = visibleIds.includes(state.selected) ? state.selected : visibleIds[0]!;
    return { tab: state.tab, selected: state.selected, draft: state.draft, activateId };
  }
  return {
    tab: state.tab,
    selected: '',
    draft: draftKey(state.draft, { ctrl: false, meta: false, alt: false, shift: false, ...key }).draft,
  };
}

export function groupSelectConfigOptions(option: Extract<SessionConfigOption, { type: 'select' }>): Array<{
  id: string;
  label: string;
  options: Array<{ value: string; name: string; description?: string | null }>;
}> {
  const groups: Array<{
    id: string;
    label: string;
    options: Array<{ value: string; name: string; description?: string | null }>;
  }> = [];
  for (const entry of option.options) {
    if ('group' in entry) {
      groups.push({ id: entry.group, label: entry.name, options: [...entry.options] });
    } else {
      const ungrouped = groups.find(group => group.id === 'options');
      if (ungrouped) ungrouped.options.push(entry);
      else groups.push({ id: 'options', label: option.name, options: [entry] });
    }
  }
  return groups;
}

export function filterCommandsForTab(commands: readonly Command[], pickerTab: string, query: string): Command[] {
  const base = filterCommands(commands, query);
  return pickerTab === 'all' ? base : base.filter(cmd => commandCategory(cmd) === pickerTab);
}

export function filterMcpServers(servers: readonly McpServerEntry[], pickerTab: string, query: string): McpServerEntry[] {
  const needle = query.trim().toLowerCase();
  return servers
    .filter(s => `${s.name} ${s.type} ${s.target}`.toLowerCase().includes(needle))
    .filter(s => pickerTab === 'all' || (pickerTab === 'enabled' ? s.status === 'enabled' : s.status !== 'enabled'));
}

export function filterPluginsList(plugins: readonly PluginEntry[], pickerTab: string, query: string): PluginEntry[] {
  const needle = query.trim().toLowerCase();
  return plugins
    .filter(p => `${p.name} ${p.source ?? ''} ${p.skills.join(' ')} ${p.rules.join(' ')}`.toLowerCase().includes(needle))
    .filter(p => pickerTab === 'all' || (pickerTab === 'enabled' ? p.enabled : !p.enabled));
}

export function filterAgentsList(agents: readonly AgentEntry[], query: string): AgentEntry[] {
  const needle = query.trim().toLowerCase();
  return agents.filter(a => `${a.name} ${a.detail}`.toLowerCase().includes(needle));
}

export function filterFindMatches(matches: readonly TranscriptSearchMatch[], pickerTab: string): TranscriptSearchMatch[] {
  return pickerTab === 'all' ? [...matches] : matches.filter(m => m.kind === pickerTab);
}

export interface SessionFilterOptions {
  currentCwd?: string;
  searchTexts?: ReadonlyMap<string, string>;
  previews?: ReadonlyMap<string, SessionPreview | null>;
}

/** Match a session row against metadata (`title`, `localName`, `id`, `cwd`) and cached chat message text. */
export function sessionRowMatchesQuery(
  row: SessionInfo,
  localNames: ReadonlyMap<string, string | undefined>,
  titleOf: (id: string) => string,
  query: string,
  filterOpts?: SessionFilterOptions,
): { matched: boolean; chatOnlyMatch: boolean } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { matched: true, chatOnlyMatch: false };
  const metaHaystack = `${titleOf(row.sessionId)} ${row.title ?? ''} ${row.sessionId} ${row.cwd ?? ''}`.toLowerCase();
  if (metaHaystack.includes(needle)) return { matched: true, chatOnlyMatch: false };
  const pv = filterOpts?.previews?.get(row.sessionId);
  const pvText = pv ? `${pv.lastUser ?? ''} ${pv.lastAgent ?? ''} ${pv.searchText ?? ''}`.toLowerCase() : '';
  const extraSearch = filterOpts?.searchTexts?.get(row.sessionId) ?? '';
  if (pvText.includes(needle) || extraSearch.toLowerCase().includes(needle)) {
    return { matched: true, chatOnlyMatch: true };
  }
  return { matched: false, chatOnlyMatch: false };
}

export function filterSessionRows(
  rows: readonly SessionInfo[],
  localNames: ReadonlyMap<string, string | undefined>,
  activeSessionId: string,
  titleOf: (id: string) => string,
  pickerTab: string,
  query: string,
  filterOpts?: SessionFilterOptions,
): SessionInfo[] {
  const cleanCwd = filterOpts?.currentCwd ? resolve(filterOpts.currentCwd) : undefined;
  return rows
    .filter(row => {
      if (pickerTab === 'named') return !!localNames.get(row.sessionId);
      if (pickerTab === 'workspace' && cleanCwd) {
        return row.sessionId === activeSessionId || (typeof row.cwd === 'string' && resolve(row.cwd) === cleanCwd);
      }
      return true;
    })
    .filter(row => sessionRowMatchesQuery(row, localNames, titleOf, query, filterOpts).matched)
    .sort((a, b) => Number(b.sessionId === activeSessionId) - Number(a.sessionId === activeSessionId) ||
      (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
}

export function filterTemplatesList(templates: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...templates];
  return templates.filter(tpl => `${tpl.name} ${tpl.text}`.toLowerCase().includes(needle));
}

export interface PickerTabSpec {
  id: string;
  label: string;
  count: number;
}

export type PickerModel =
  | {
    kind: 'commands';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly Command[];
  }
  | {
    kind: 'mcp';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly McpServerEntry[];
  }
  | {
    kind: 'plugins';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly PluginEntry[];
  }
  | {
    kind: 'agents';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly AgentEntry[];
  }
  | {
    kind: 'templates';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly PromptTemplate[];
  }
  | {
    kind: 'find';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    filtered: readonly TranscriptSearchMatch[];
  }
  | {
    kind: 'tasks';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    allToolsCount: number;
    runningCount: number;
    filtered: readonly ToolStep[];
  }
  | {
    kind: 'changes';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    usingGit: boolean;
    filteredEdits: readonly SessionDiffItem[];
    filteredGit: readonly GitStatusEntry[];
  }
  | {
    kind: 'sessions';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[];
    visibleIds: readonly string[];
    selectedId: string;
    allRowsCount: number;
    namedRowsCount: number;
    filtered: readonly SessionInfo[];
  }
  | {
    kind: 'config';
    tabIds: readonly string[];
    tabs: readonly PickerTabSpec[] | undefined;
    visibleIds: readonly string[];
    selectedId: string;
    groups: ReturnType<typeof groupSelectConfigOptions>;
    visibleGroups: ReturnType<typeof groupSelectConfigOptions>;
    flat: ReadonlyArray<{
      group: ReturnType<typeof groupSelectConfigOptions>[number];
      val: ReturnType<typeof groupSelectConfigOptions>[number]['options'][number];
    }>;
  };

export type PickerPanelInput =
  | { kind: 'commands' }
  | { kind: 'mcp' }
  | { kind: 'plugins' }
  | { kind: 'agents' }
  | { kind: 'templates' }
  | { kind: 'find' }
  | { kind: 'tasks' }
  | { kind: 'changes' }
  | { kind: 'sessions' }
  | { kind: 'config'; option: Extract<SessionConfigOption, { type: 'select' }> };

export interface PickerModelInput {
  panel: PickerPanelInput;
  cwd: string;
  query: string;
  pickerTab: string;
  pickerSelected: string;
  commands: readonly Command[];
  mcpServers: readonly McpServerEntry[];
  pluginsList: readonly PluginEntry[];
  agentsList: readonly AgentEntry[];
  templatesList: readonly PromptTemplate[];
  entries: readonly TranscriptEntry[];
  entriesRevision: number;
  sessionDiffs: readonly SessionDiffItem[];
  gitChanges: readonly GitStatusEntry[];
  listedSessions: readonly SessionInfo[];
  allListedSessions?: readonly SessionInfo[];
  activeSessionId: string;
  sessionInfo: ReadonlyMap<string, SessionInfo>;
  localNames: ReadonlyMap<string, string | undefined>;
  sessionPreviews?: ReadonlyMap<string, SessionPreview | null>;
  sessionSearchTexts?: ReadonlyMap<string, string>;
  sessionTitle: (id: string) => string;
}

function pickSelectedId(visibleIds: readonly string[], requested: string): string {
  return visibleIds.includes(requested) ? requested : (visibleIds[0] ?? '');
}

/** Build a unified PickerModel shared by keyboard stepping (`stepPickerKey`) and modal rendering (`panels.tsx`). */
export function buildPickerModel(input: PickerModelInput): PickerModel {
  const { panel, cwd, query, pickerTab, pickerSelected } = input;
  switch (panel.kind) {
    case 'commands': {
      const all = filterCommands(input.commands, query);
      const tabIds = ['all', 'frontend', 'workflow', 'skill'] as const;
      const tabs: PickerTabSpec[] = [
        { id: 'all', label: 'All', count: all.length },
        { id: 'frontend', label: 'Frontend', count: all.filter(c => commandCategory(c) === 'frontend').length },
        { id: 'workflow', label: 'Workflows', count: all.filter(c => commandCategory(c) === 'workflow').length },
        { id: 'skill', label: 'Skills', count: all.filter(c => commandCategory(c) === 'skill').length },
      ];
      const filtered = pickerTab === 'all' ? all : all.filter(c => commandCategory(c) === pickerTab);
      const visibleIds = filtered.map(c => c.name);
      return {
        kind: 'commands',
        tabIds,
        tabs,
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'mcp': {
      const visible = filterMcpServers(input.mcpServers, 'all', query);
      const filtered = pickerTab === 'all'
        ? visible
        : visible.filter(s => (pickerTab === 'enabled' ? s.status === 'enabled' : s.status !== 'enabled'));
      const tabIds = ['all', 'enabled', 'disabled'] as const;
      const tabs: PickerTabSpec[] = [
        { id: 'all', label: 'All', count: visible.length },
        { id: 'enabled', label: 'Enabled', count: visible.filter(s => s.status === 'enabled').length },
        { id: 'disabled', label: 'Disabled', count: visible.filter(s => s.status !== 'enabled').length },
      ];
      const visibleIds = filtered.map(s => s.name);
      return {
        kind: 'mcp',
        tabIds,
        tabs,
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'plugins': {
      const visible = filterPluginsList(input.pluginsList, 'all', query);
      const filtered = pickerTab === 'all'
        ? visible
        : visible.filter(p => (pickerTab === 'enabled' ? p.enabled : !p.enabled));
      const tabIds = ['all', 'enabled', 'disabled'] as const;
      const tabs: PickerTabSpec[] = [
        { id: 'all', label: 'All', count: visible.length },
        { id: 'enabled', label: 'Enabled', count: visible.filter(p => p.enabled).length },
        { id: 'disabled', label: 'Disabled', count: visible.filter(p => !p.enabled).length },
      ];
      const visibleIds = filtered.map(p => p.name);
      return {
        kind: 'plugins',
        tabIds,
        tabs,
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'agents': {
      const filtered = filterAgentsList(input.agentsList, query);
      const visibleIds = filtered.map(a => a.name);
      return {
        kind: 'agents',
        tabIds: ['all'],
        tabs: [{ id: 'all', label: 'Configured agents', count: filtered.length }],
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'templates': {
      const filtered = filterTemplatesList(input.templatesList, query);
      const visibleIds = filtered.map(t => t.name);
      return {
        kind: 'templates',
        tabIds: ['all'],
        tabs: [{ id: 'all', label: 'Templates', count: filtered.length }],
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'find': {
      const matches = searchTranscriptCached(input.entries, input.entriesRevision, cwd, query);
      const tabIds = ['all', 'message', 'tool', 'thought'] as const;
      const tabs: PickerTabSpec[] = [
        { id: 'all', label: 'All', count: matches.length },
        { id: 'message', label: 'Messages', count: matches.filter(m => m.kind === 'message').length },
        { id: 'tool', label: 'Tools & Diffs', count: matches.filter(m => m.kind === 'tool').length },
        { id: 'thought', label: 'Thoughts', count: matches.filter(m => m.kind === 'thought').length },
      ];
      const filtered = filterFindMatches(matches, pickerTab);
      const visibleIds = filtered.map(m => m.id);
      return {
        kind: 'find',
        tabIds,
        tabs,
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        filtered,
      };
    }
    case 'tasks': {
      const needle = query.trim().toLowerCase();
      const allTools: ToolStep[] = [];
      let runningCount = 0;
      for (let i = input.entries.length - 1; i >= 0; i--) {
        const entry = input.entries[i]!;
        if (entry.type !== 'tool') continue;
        allTools.push(entry);
        if (entry.call.status === 'in_progress' || entry.call.status === 'pending') runningCount++;
      }
      const filtered = allTools.filter(step => {
        const isRunning = step.call.status === 'in_progress' || step.call.status === 'pending';
        if (pickerTab === 'running' && !isRunning) return false;
        if (pickerTab === 'done' && isRunning) return false;
        if (!needle) return true;
        const summary = summarizeToolCall(step.call, cwd, { includeDiffStats: false });
        return `${summary.title} ${summary.target ?? ''} ${step.call.toolCallId}`.toLowerCase().includes(needle);
      });
      const visibleIds = filtered.map(s => s.id);
      return {
        kind: 'tasks',
        tabIds: ['all', 'running', 'done'],
        tabs: [
          { id: 'all', label: 'All', count: allTools.length },
          { id: 'running', label: 'Running', count: runningCount },
          { id: 'done', label: 'Finished', count: allTools.length - runningCount },
        ],
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        allToolsCount: allTools.length,
        runningCount,
        filtered,
      };
    }
    case 'changes': {
      const needle = query.trim().toLowerCase();
      const filteredEdits = input.sessionDiffs.filter(item => item.path.toLowerCase().includes(needle));
      const filteredGit = input.gitChanges.filter(item => `${item.status} ${item.path}`.toLowerCase().includes(needle));
      const usingGit = pickerTab === 'git';
      const visibleIds = usingGit ? filteredGit.map(item => `git:${item.path}`) : filteredEdits.map(item => item.id);
      return {
        kind: 'changes',
        tabIds: ['edits', 'git'],
        tabs: [
          { id: 'edits', label: 'Session edits', count: input.sessionDiffs.length },
          { id: 'git', label: 'Git status', count: input.gitChanges.length },
        ],
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        usingGit,
        filteredEdits,
        filteredGit,
      };
    }
    case 'sessions': {
      const workspaceRows = new Map(input.listedSessions.map(row => [row.sessionId, row]));
      const allRowsMap = new Map((input.allListedSessions?.length ? input.allListedSessions : input.listedSessions).map(row => [row.sessionId, row]));
      if (input.activeSessionId) {
        const activeRow = input.sessionInfo.get(input.activeSessionId) ?? { sessionId: input.activeSessionId, cwd };
        workspaceRows.set(input.activeSessionId, activeRow);
        allRowsMap.set(input.activeSessionId, activeRow);
      }
      const sourceRows = pickerTab === 'workspace' ? [...workspaceRows.values()] : [...allRowsMap.values()];
      const namedRowsCount = [...allRowsMap.values()].filter(row => !!input.localNames.get(row.sessionId)).length;
      const filtered = filterSessionRows(
        sourceRows,
        input.localNames,
        input.activeSessionId,
        input.sessionTitle,
        pickerTab,
        query,
        {
          currentCwd: cwd,
          previews: input.sessionPreviews,
          searchTexts: input.sessionSearchTexts,
        },
      );
      const visibleIds = filtered.map(row => row.sessionId);
      return {
        kind: 'sessions',
        tabIds: ['workspace', 'all', 'named'],
        tabs: [
          { id: 'workspace', label: 'This folder', count: workspaceRows.size },
          { id: 'all', label: 'All workspaces', count: allRowsMap.size },
          { id: 'named', label: 'Local named', count: namedRowsCount },
        ],
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        allRowsCount: allRowsMap.size,
        namedRowsCount,
        filtered,
      };
    }
    case 'config': {
      const needle = query.trim().toLowerCase();
      const groups = groupSelectConfigOptions(panel.option);
      const visibleGroups = groups
        .filter(group => pickerTab === 'all' || group.id === pickerTab)
        .map(group => ({
          ...group,
          options: group.options.filter(val =>
            `${val.name} ${val.value} ${val.description ?? ''}`.toLowerCase().includes(needle)),
        }))
        .filter(group => group.options.length > 0);
      const flat = visibleGroups.flatMap(group => group.options.map(val => ({ group, val })));
      const visibleIds = flat.map(entry => entry.val.value);
      const totalCount = groups.reduce((sum, group) => sum + group.options.length, 0);
      const tabs: PickerTabSpec[] | undefined = groups.length > 1
        ? [
          { id: 'all', label: 'All', count: totalCount },
          ...groups.map(group => ({ id: group.id, label: group.label, count: group.options.length })),
        ]
        : undefined;
      const tabIds = groups.length > 1 ? ['all', ...groups.map(g => g.id)] : [];
      return {
        kind: 'config',
        tabIds,
        tabs,
        visibleIds,
        selectedId: pickSelectedId(visibleIds, pickerSelected),
        groups,
        visibleGroups,
        flat,
      };
    }
  }
}
