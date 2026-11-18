import type { AvailableCommand, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

export type LocalCommand = 'help' | 'keys' | 'update' | 'model' | 'settings' | 'usage' | 'credits' | 'changelog' | 'permissions' | 'sessions' | 'turns' | 'queue' | 'new' | 'rename' | 'account' | 'switch-account' | 'login' | 'changes' | 'find' | 'tasks' | 'paste-image' | 'export' | 'expand' | 'collapse' | 'mcp' | 'plugins' | 'agents' | 'templates' | 'exit';
export type CommandCategory = 'frontend' | 'workflow' | 'skill';

const CORE_WORKFLOWS = new Set([
  'goal', 'compact', 'schedule', 'browser', 'plan', 'grill-me', 'teamwork', 'learn', 'boost', 'review', 'init', 'clear',
]);
export interface Command {
  name: string;
  description: string;
  local?: LocalCommand;
  hint?: string;
}

const LOCAL: readonly Command[] = [
  { name: 'model', local: 'model', description: 'Choose a model offered by this agy session' },
  { name: 'usage', local: 'usage', description: 'View session usage and the official account quota command' },
  { name: 'account', local: 'account', description: 'Sign in, switch accounts through official login, or check quota' },
  { name: 'switch-account', local: 'switch-account', description: 'Confirm logout and switch account via official login' },
  { name: 'login', local: 'login', description: 'Open official sign-in options, including while disconnected' },
  { name: 'changes', local: 'changes', description: 'Review session file edits and git working tree status' },
  { name: 'tasks', local: 'tasks', description: 'Inspect running tools and cancel active turn tasks' },
  { name: 'paste-image', local: 'paste-image', description: 'Attach a screenshot or image directly from system clipboard' },
  { name: 'find', local: 'find', description: 'Search messages, tools, thoughts, and diffs in this conversation', hint: 'query' },
  { name: 'turns', local: 'turns', description: 'Browse conversation turns, jump to any prompt, or view pinned turns', hint: 'query' },
  { name: 'queue', local: 'queue', description: 'Inspect, reorder, edit, or drop queued follow-up prompts' },
  { name: 'export', local: 'export', description: 'Save current conversation transcript to Markdown or JSON in workspace', hint: 'file.md|json' },
  { name: 'templates', local: 'templates', description: 'Save, browse, and insert reusable prompt templates for this workspace' },
  { name: 'expand', local: 'expand', description: 'Expand all thought and tool cards in the conversation' },
  { name: 'collapse', local: 'collapse', description: 'Collapse all thought and tool cards in the conversation' },
  { name: 'mcp', local: 'mcp', description: 'Inspect and toggle official agy MCP servers' },
  { name: 'plugins', local: 'plugins', description: 'Browse and toggle installed plugins and skills' },
  { name: 'agents', local: 'agents', description: 'Inspect configured agents and active workspace roots' },
  { name: 'settings', local: 'settings', description: 'Change model, reasoning and other session options' },
  { name: 'permissions', local: 'permissions', description: 'Inspect mode, approval policy and sandbox visibility' },
  { name: 'sessions', local: 'sessions', description: 'Browse and resume conversations in this workspace' },
  { name: 'new', local: 'new', description: 'Start a separate conversation through official ACP' },
  { name: 'rename', local: 'rename', description: 'Set a local name for this conversation' },
  { name: 'credits', local: 'credits', description: 'Read the official CLI account credits report' },
  { name: 'changelog', local: 'changelog', description: 'Read the official CLI release notes' },
  { name: 'update', local: 'update', description: 'Check for or install the latest agy-tern GitHub release' },
  { name: 'keys', local: 'keys', description: 'Browse keyboard shortcuts and composer controls' },
  { name: 'help', local: 'help', description: 'Browse all commands available in this session' },
  { name: 'exit', local: 'exit', description: 'Close this frontend and its agy session' },
];
const ALIASES: Readonly<Record<string, string>> = {
  quota: 'usage', config: 'settings', preferences: 'settings', prefs: 'settings', quit: 'exit', commands: 'help', palette: 'help', shortcuts: 'keys', hotkeys: 'keys', upgrade: 'update', resume: 'sessions', conversation: 'sessions', switch: 'sessions', reauth: 'switch-account', diff: 'changes', search: 'find', outline: 'turns', jump: 'turns', queued: 'queue', skills: 'plugins', agent: 'agents', snippets: 'templates', running: 'tasks', ps: 'tasks', clip: 'paste-image',
};
const ALIAS_PATTERN = new RegExp(`^\\/(${Object.keys(ALIASES).join('|')})(?=\\s|$)`);

export function commandCategory(command: Command): CommandCategory {
  if (command.local) return 'frontend';
  return CORE_WORKFLOWS.has(command.name.toLowerCase()) ? 'workflow' : 'skill';
}

export function commandCatalog(advertised: readonly AvailableCommand[]): Command[] {
  const commands = new Map(LOCAL.map(command => [command.name, command]));
  for (const command of advertised) {
    const name = command.name.replace(/^\//, '');
    if (!commands.has(name)) commands.set(name, {
      name, description: command.description, hint: command.input?.hint,
    });
  }
  return [...commands.values()];
}

export function commandQuery(text: string): string | undefined {
  return /^\/[^\s]*$/.test(text) ? text.slice(1) : undefined;
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const needle = query.toLowerCase().replace(/^\//, '');
  if (!needle) return [...commands];
  const scored: Array<{ command: Command; rank: number; index: number }> = [];
  for (const [index, command] of commands.entries()) {
    const name = command.name.toLowerCase();
    const desc = command.description.toLowerCase();
    const rank = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : desc.includes(needle) ? 3 : -1;
    if (rank >= 0) scored.push({ command, rank, index });
  }
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map(entry => entry.command);
}

export function resolveCommand(text: string, commands: readonly Command[]): { command: Command; args: string } | undefined {
  const input = text.trim().replace(ALIAS_PATTERN, (_match, name: string) =>
    `/${ALIASES[name]}`);
  let matched: Command | undefined;
  for (const command of commands) {
    const prefix = `/${command.name}`;
    if ((input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\n`)) &&
      (!matched || command.name.length > matched.name.length)) matched = command;
  }
  return matched ? { command: matched, args: input.slice(matched.name.length + 1).trim() } : undefined;
}

export function configValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap(entry => 'group' in entry ? entry.options : [entry]);
}

export function modelOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find(option => option.category === 'model') ?? options.find(option => option.id === 'model');
}

export function configLabel(option: SessionConfigOption): string {
  return option.type === 'boolean' ? (option.currentValue ? 'On' : 'Off') :
    configValues(option).find(value => value.value === option.currentValue)?.name ?? option.currentValue;
}
