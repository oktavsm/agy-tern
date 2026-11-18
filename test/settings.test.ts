import { describe, expect, test } from 'bun:test';
import type { Key } from '@stencil-hq/tern';
import { DEFAULT_PREFS } from '../src/prefs';
import {
  buildSettingsViewData,
  extractChangeBoolean,
  getConfigLockReason,
  patchForLocalPrefChange,
  patchForPrefRowReset,
  stepSettingsKey,
  stripConfigPrefix,
  visibleSettingsRows,
} from '../src/settings-nav';

function key(name: string, opts: Partial<Key> = {}): Key {
  return {
    name,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...opts,
  };
}

describe('settings navigation and controls', () => {
  const sampleMetadata = {
    availableCommands: [],
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: 'gemini-4-hydrogen',
        options: [
          { value: 'gemini-4-hydrogen', name: 'Gemini 4' },
          { value: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
          { value: 'gpt-5', name: 'GPT-5' },
          { value: 'o3-pro', name: 'o3-pro' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select' as const,
        currentValue: 'code',
        options: [
          { value: 'code', name: 'Code' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ],
  };

  function makeView(prefs = { ...DEFAULT_PREFS }) {
    return buildSettingsViewData({
      userPrefs: prefs,
      metadata: sampleMetadata,
      modeOption: sampleMetadata.configOptions[1],
      options: { cwd: process.cwd() },
      workspaceName: 'agy-tern',
      agent: {} as never,
      disconnected: false,
      agentConnecting: false,
      busy: false,
      changingConfig: false,
      sessionOperation: undefined,
    });
  }

  test('produces unique row IDs across all sections even when ACP mode is populated', () => {
    const view = makeView({ ...DEFAULT_PREFS, toolDisplay: 'expanded', lastModel: 'gpt-5' });
    const ids = view.sections.flatMap(sec => sec.rows.map(row => row.id));
    expect(new Set(ids).size).toBe(ids.length);

    const appearanceMeta = view.pages.find(p => p.id === 'appearance');
    const sessionMeta = view.pages.find(p => p.id === 'session');
    expect(appearanceMeta?.changed).toBe(1);
    expect(sessionMeta?.changed).toBe(1);
  });

  test('extracts boolean switch changes from on, checked, or value fields', () => {
    expect(extractChangeBoolean({ on: true })).toBe(true);
    expect(extractChangeBoolean({ checked: false })).toBe(false);
    expect(extractChangeBoolean({ value: true })).toBe(true);
    expect(extractChangeBoolean({ value: 'auto' })).toBeUndefined();

    expect(patchForLocalPrefChange('thoughtExpanded', { on: true })).toEqual({ thoughtExpanded: true });
    expect(patchForLocalPrefChange('showTimestamps', { checked: false })).toEqual({ showTimestamps: false });
    expect(patchForLocalPrefChange('notifyOnTurnComplete', { on: false })).toEqual({ notifyOnTurnComplete: false });
    expect(patchForLocalPrefChange('composerLines', { value: '10' })).toEqual({ composerLines: 10 });
    expect(patchForLocalPrefChange('maxFps', { value: '60' })).toEqual({ maxFps: 60 });
    expect(patchForLocalPrefChange('motion', { value: 'reduced' })).toEqual({ motion: 'reduced' });
    expect(patchForPrefRowReset('diffMode')).toEqual({ diffMode: DEFAULT_PREFS.diffMode });
    expect(patchForPrefRowReset('clearRememberedModel')).toEqual({ lastModel: undefined, lastThinking: undefined });
  });

  test('navigates rows, steps segmented choices, toggles switches, and switches pages via keyboard', () => {
    const view = makeView();
    let state = { page: 'appearance', focusRowId: 'diffMode', draft: { text: '', cursor: 0 } };

    // Left/Right on choice steps option value immediately.
    const stepRight = stepSettingsKey(state, key('right'), view.sections);
    expect(stepRight.effect).toEqual({ kind: 'prefs', patch: { diffMode: 'unified' } });

    // Down twice moves from diffMode -> toolDisplay -> thoughtExpanded (switch).
    let step = stepSettingsKey(state, key('down'), view.sections);
    expect(step.focusRowId).toBe('toolDisplay');
    step = stepSettingsKey(step, key('down'), view.sections);
    expect(step.focusRowId).toBe('thoughtExpanded');

    // Enter toggles switch control.
    const toggleStep = stepSettingsKey(step, key('enter'), view.sections);
    expect(toggleStep.effect).toEqual({ kind: 'prefs', patch: { thoughtExpanded: true } });

    // Tab switches to Session & Model page and focuses first row (cfg-model).
    const tabStep = stepSettingsKey(toggleStep, key('tab'), view.sections, sampleMetadata.configOptions);
    expect(tabStep.page).toBe('session');
    expect(tabStep.focusRowId).toBe('cfg-model');
    expect(stripConfigPrefix('cfg-model')).toBe('model');
    expect(stripConfigPrefix('perm-mode')).toBe('mode');

    // Enter on Model row opens the dedicated picker; Right cycles inline when configOptions supplied.
    expect(stepSettingsKey(tabStep, key('enter'), view.sections, sampleMetadata.configOptions).effect).toEqual({
      kind: 'action',
      act: 'open-config:model',
    });
    expect(stepSettingsKey(tabStep, key('right'), view.sections, sampleMetadata.configOptions).effect).toEqual({
      kind: 'config',
      optionId: 'model',
      value: 'claude-4.5-sonnet',
    });

    // Moving down to Check for updates row on Session & Model page triggers check-updates action.
    const modeRow = stepSettingsKey(tabStep, key('down'), view.sections, sampleMetadata.configOptions);
    expect(modeRow.focusRowId).toBe('cfg-mode');
    const rememberRow = stepSettingsKey(modeRow, key('down'), view.sections, sampleMetadata.configOptions);
    expect(rememberRow.focusRowId).toBe('rememberModel');
    const clearRow = stepSettingsKey(rememberRow, key('down'), view.sections, sampleMetadata.configOptions);
    expect(clearRow.focusRowId).toBe('clearRememberedModel');
    const checkUpdatesRow = stepSettingsKey(clearRow, key('down'), view.sections, sampleMetadata.configOptions);
    expect(checkUpdatesRow.focusRowId).toBe('checkUpdates');
    expect(stepSettingsKey(checkUpdatesRow, key('enter'), view.sections, sampleMetadata.configOptions).effect).toEqual({
      kind: 'action',
      act: 'check-updates',
    });

    // Alt+3 jumps to Permissions & Sandbox; Left/Right on Mode edits perm-mode cleanly.
    const permStep = stepSettingsKey(tabStep, key('3', { alt: true, text: '3' }), view.sections, sampleMetadata.configOptions);
    expect(permStep.page).toBe('permissions');
    expect(permStep.focusRowId).toBe('perm-mode');
    expect(stepSettingsKey(permStep, key('right'), view.sections, sampleMetadata.configOptions).effect).toEqual({
      kind: 'config',
      optionId: 'mode',
      value: 'plan',
    });

    // Moving down to View details + Enter triggers open-permissions action.
    const detailsRow = stepSettingsKey(permStep, key('down'), view.sections);
    expect(detailsRow.focusRowId).toBe('sandbox-flag');
    expect(stepSettingsKey(detailsRow, key('enter'), view.sections).effect).toEqual({
      kind: 'action',
      act: 'open-permissions',
    });

    // Typing a query filters rows across pages and keeps focus on a matching row.
    const typed = stepSettingsKey(state, key('s', { text: 's' }), view.sections);
    const matches = visibleSettingsRows(view.sections, typed.page, typed.draft.text);
    expect(matches.some(entry => entry.row.id === typed.focusRowId)).toBe(true);
  });

  test('reports explicit lock reasons for busy, startup sync, disconnect, and pending approvals', () => {
    expect(getConfigLockReason({ agent: {}, disconnected: false })).toBeUndefined();
    expect(getConfigLockReason({ agent: {}, busy: true })).toContain('active turn');
    expect(getConfigLockReason({ agent: {}, changingConfig: true })).toContain('previous');
    expect(getConfigLockReason({ agent: {}, startupSyncingConfig: true })).toContain('startup');
    expect(getConfigLockReason({ agent: {}, disconnected: true })).toContain('disconnected');
    expect(getConfigLockReason({ agent: {}, authBusy: true })).toContain('sign-in');
    expect(getConfigLockReason({ agent: {}, hasPendingPermissions: true })).toContain('approval');
    expect(getConfigLockReason({ agent: undefined, agentConnecting: true })).toContain('Waiting');
  });
});
