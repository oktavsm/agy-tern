import type { SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { commandCategory, filterCommands, type Command } from './commands';
import { draftKey, type Draft } from './draft';
import type { AgentEntry, McpServerEntry, PluginEntry } from './extensions';
import type { PromptTemplate } from './templates';
import type { TranscriptSearchMatch } from './ui-format';

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

export function filterSessionRows(
  rows: readonly SessionInfo[],
  localNames: ReadonlyMap<string, string | undefined>,
  activeSessionId: string,
  titleOf: (id: string) => string,
  pickerTab: string,
  query: string,
): SessionInfo[] {
  const needle = query.trim().toLowerCase();
  return rows
    .filter(row => pickerTab !== 'named' || !!localNames.get(row.sessionId))
    .filter(row => `${titleOf(row.sessionId)} ${row.title ?? ''} ${row.sessionId}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.sessionId === activeSessionId) - Number(a.sessionId === activeSessionId) ||
      (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
}

export function filterTemplatesList(templates: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...templates];
  return templates.filter(tpl => `${tpl.name} ${tpl.text}`.toLowerCase().includes(needle));
}
