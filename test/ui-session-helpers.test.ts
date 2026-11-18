import { describe, expect, test } from 'bun:test';
import {
  cycleOpenSessionTab,
  formatAccountSnapshot,
  recordOpenSessionTab,
  removeOpenSessionTab,
} from '../src/ui-session-helpers';

describe('ui-session-helpers', () => {
  test('manages bounded open session tabs and cycles cleanly', () => {
    let tabs: string[] = [];
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) {
      tabs = recordOpenSessionTab(tabs, id, 6);
    }
    expect(tabs).toEqual(['s2', 's3', 's4', 's5', 's6', 's7']);
    expect(recordOpenSessionTab(tabs, 's4', 6)).toEqual(tabs);
    expect(cycleOpenSessionTab(tabs, 's7', 1)).toBe('s2');
    expect(cycleOpenSessionTab(tabs, 's2', -1)).toBe('s7');
    expect(removeOpenSessionTab(tabs, 's4')).toEqual(['s2', 's3', 's5', 's6', 's7']);
  });

  test('formats cached account tier and quota snapshot cleanly without fabricating fields', () => {
    const report = [
      'Gemini Flash\t1000\t85%\t2h',
      'Gemini Pro\t100\t22%\t4h',
    ].join('\n');
    expect(formatAccountSnapshot({ configOptions: [], availableCommands: [], tier: { name: 'Google AI Pro' } }, report))
      .toBe('Tier: Google AI Pro | Tightest quota: 22% (Gemini Pro)');
    expect(formatAccountSnapshot({ configOptions: [], availableCommands: [] }, '')).toBeUndefined();
  });
});
