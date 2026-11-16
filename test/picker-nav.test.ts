import { describe, expect, test } from 'bun:test';
import {
  filterCommandsForTab,
  filterMcpServers,
  filterPluginsList,
  filterSessionRows,
  stepPickerKey,
} from '../src/picker-nav';

describe('picker navigation and filters', () => {
  test('cycles tabs, wraps selection up/down, activates highlighted item, and updates filter query', () => {
    const base = { tab: 'all', selected: 'two', draft: { text: '', cursor: 0 } };
    const nextTab = stepPickerKey(base, { name: 'tab' }, ['all', 'enabled', 'disabled'], ['one', 'two']);
    expect(nextTab).toEqual({ tab: 'enabled', selected: '', draft: { text: '', cursor: 0 } });

    const prevTab = stepPickerKey(base, { name: 'tab', shift: true }, ['all', 'enabled', 'disabled'], ['one', 'two']);
    expect(prevTab.tab).toBe('disabled');

    const wrappedUp = stepPickerKey({ ...base, selected: 'one' }, { name: 'up' }, ['all'], ['one', 'two', 'three']);
    expect(wrappedUp.selected).toBe('three');

    const movedDown = stepPickerKey({ ...base, selected: 'two' }, { name: 'down' }, ['all'], ['one', 'two', 'three']);
    expect(movedDown.selected).toBe('three');

    const activated = stepPickerKey(base, { name: 'enter' }, ['all'], ['one', 'two', 'three']);
    expect(activated.activateId).toBe('two');

    const fallbackActivate = stepPickerKey({ ...base, selected: 'stale' }, { name: 'enter' }, ['all'], ['one', 'two']);
    expect(fallbackActivate.activateId).toBe('one');

    const typed = stepPickerKey(base, { name: 'a', text: 'a' }, ['all'], ['one']);
    expect(typed.draft.text).toBe('a');
    expect(typed.selected).toBe('');
  });

  test('filters commands, MCP servers, plugins, and sessions consistently', () => {
    expect(filterCommandsForTab([
      { name: 'mcp', local: 'mcp', description: 'MCP' },
      { name: 'goal', description: 'Goal workflow' },
      { name: 'antislop', description: 'Anti slop skill' },
    ], 'workflow', '').map(c => c.name)).toEqual(['goal']);

    expect(filterMcpServers([
      { name: 'fetch', type: 'stdio', status: 'enabled', target: 'uvx mcp-server-fetch' },
      { name: 'old', type: 'stdio', status: 'disabled', target: 'npx old' },
    ], 'disabled', 'old').map(s => s.name)).toEqual(['old']);

    expect(filterPluginsList([
      { name: 'antislop', enabled: true, path: '/p', skills: ['antislop-ui'], rules: [] },
      { name: 'android', enabled: false, path: '/a', skills: ['android-cli'], rules: [] },
    ], 'enabled', 'antislop-ui').map(p => p.name)).toEqual(['antislop']);

    const sessions = filterSessionRows([
      { sessionId: 's1', cwd: '/repo', title: 'Old', updatedAt: '2026-11-15T10:00:00Z' },
      { sessionId: 's2', cwd: '/repo', title: 'Active', updatedAt: '2026-11-14T10:00:00Z' },
      { sessionId: 's3', cwd: '/repo', title: 'Named', updatedAt: '2026-11-16T10:00:00Z' },
    ], new Map([['s3', 'Custom']]), 's2', id => (id === 's3' ? 'Custom' : id), 'all', '');
    expect(sessions.map(s => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });
});
