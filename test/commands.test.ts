import { expect, test } from 'bun:test';
import { commandCatalog, commandCategory, commandQuery, configLabel, configValues, filterCommands, modelOption, resolveCommand } from '../src/commands';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

const models: SessionConfigOption = {
  id: 'provider-model', name: 'Model', category: 'model', type: 'select', currentValue: 'fast',
  options: [{ group: 'available', name: 'Available models', options: [
    { value: 'fast', name: 'Fast model' }, { value: 'deep', name: 'Deep model' },
  ] }],
};

test('a remote command cannot replace the local model selector or duplicate its row', () => {
  const commands = commandCatalog([
    { name: 'model', description: 'server model command' },
    { name: '/review', description: 'Review changes', input: { hint: 'scope' } },
  ]);
  expect(filterCommands(commands, 'model').filter(command => command.name === 'model')).toMatchObject([
    { name: 'model', local: 'model' },
  ]);
  expect(resolveCommand('/review src/', commands)).toMatchObject({ command: { name: 'review', hint: 'scope' }, args: 'src/' });
});

test('resolves the longest advertised command and preserves its argument text', () => {
  const commands = commandCatalog([
    { name: 'team', description: 'Team' }, { name: 'team board', description: 'Board' },
  ]);
  expect(resolveCommand('/team board inspect\nthese files', commands)).toMatchObject({ command: { name: 'team board' }, args: 'inspect\nthese files' });
  expect(resolveCommand('/unknown task', commands)).toBeUndefined();
  expect(resolveCommand('/teamwork task', commands)).toBeUndefined();
});

test('does not turn embedded commands or pasted multiline content into an autocomplete query', () => {
  expect(commandQuery('/mod')).toBe('mod');
  expect(commandQuery('/')).toBe('');
  expect(commandQuery('explain /model')).toBeUndefined();
  expect(commandQuery('/review files')).toBeUndefined();
  expect(commandQuery('/model\ntext')).toBeUndefined();
});

test('supports grouped values and semantic model IDs without assuming model names', () => {
  expect(modelOption([models])?.id).toBe('provider-model');
  expect(configValues(models).map(option => option.value)).toEqual(['fast', 'deep']);
  expect(configLabel(models)).toBe('Fast model');
  expect(configValues({ id: 'flag', name: 'Flag', type: 'boolean', currentValue: true })).toEqual([]);
});

test('session aliases and local naming never become model prompts', () => {
  const commands = commandCatalog([
    { name: 'resume', description: 'A server command must not bypass the native session picker' },
    { name: 'rename', description: 'A server command must not rename behind the local label UI' },
  ]);
  expect(resolveCommand('/resume', commands)?.command.local).toBe('sessions');
  expect(resolveCommand('/switch', commands)?.command.local).toBe('sessions');
  expect(resolveCommand('/conversation', commands)?.command.local).toBe('sessions');
  expect(resolveCommand('/rename Release checklist', commands)).toMatchObject({
    command: { local: 'rename' }, args: 'Release checklist',
  });
  expect(resolveCommand('/resumeworthy', commands)).toBeUndefined();
});

test('authentication commands stay local even when the agent advertises the same names', () => {
  const commands = commandCatalog([
    { name: 'login', description: 'Remote login command' },
    { name: 'account', description: 'Remote account command' },
  ]);
  expect(resolveCommand('/login', commands)?.command.local).toBe('login');
  expect(resolveCommand('/account', commands)?.command.local).toBe('account');
  expect(resolveCommand('/switch-account', commands)?.command.local).toBe('switch-account');
  expect(resolveCommand('/reauth', commands)?.command.local).toBe('switch-account');
  expect(resolveCommand('/changes', commands)?.command.local).toBe('changes');
  expect(resolveCommand('/diff', commands)?.command.local).toBe('changes');
  expect(resolveCommand('/export docs/out.md', commands)).toMatchObject({ command: { local: 'export' }, args: 'docs/out.md' });
  expect(resolveCommand('/export docs/out.json', commands)).toMatchObject({ command: { local: 'export' }, args: 'docs/out.json' });
  expect(resolveCommand('/templates', commands)?.command.local).toBe('templates');
  expect(resolveCommand('/snippets review', commands)).toMatchObject({ command: { local: 'templates' }, args: 'review' });
  expect(resolveCommand('/expand', commands)?.command.local).toBe('expand');
  expect(resolveCommand('/collapse', commands)?.command.local).toBe('collapse');
  expect(resolveCommand('/find auth flow', commands)).toMatchObject({ command: { local: 'find' }, args: 'auth flow' });
  expect(resolveCommand('/search token', commands)).toMatchObject({ command: { local: 'find' }, args: 'token' });
  expect(resolveCommand('/mcp', commands)?.command.local).toBe('mcp');
  expect(resolveCommand('/plugins', commands)?.command.local).toBe('plugins');
  expect(resolveCommand('/skills', commands)?.command.local).toBe('plugins');
  expect(resolveCommand('/agents', commands)?.command.local).toBe('agents');
  expect(resolveCommand('/agent', commands)?.command.local).toBe('agents');
  expect(resolveCommand('/paste-image', commands)?.command.local).toBe('paste-image');
  expect(resolveCommand('/clip', commands)?.command.local).toBe('paste-image');
  expect(resolveCommand('/switch', commands)?.command.local).toBe('sessions');
  expect(filterCommands(commands, 'account')[0]?.name).toBe('account');

  const catalogWithAgy = commandCatalog([
    { name: 'goal', description: 'Run goal' },
    { name: 'a11y-audit', description: 'Audit a11y' },
  ]);
  expect(commandCategory(catalogWithAgy.find(c => c.name === 'mcp')!)).toBe('frontend');
  expect(commandCategory(catalogWithAgy.find(c => c.name === 'goal')!)).toBe('workflow');
  expect(commandCategory(catalogWithAgy.find(c => c.name === 'a11y-audit')!)).toBe('skill');
});
