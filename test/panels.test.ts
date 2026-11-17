import { describe, expect, test } from 'bun:test';
import { DEFAULT_PREFS } from '../src/prefs';
import { computeResponsiveLayout } from '../src/ui-format';
import { renderActivePanel, type Panel, type PanelRenderContext } from '../src/panels';
import { cachedPathExists } from '../src/transcript-view';

function baseContext(panel: Panel): PanelRenderContext {
  return {
    panel,
    options: { cwd: process.cwd(), executable: 'agy' },
    workspaceName: 'agy-tern',
    rLayout: computeResponsiveLayout(120, 40, {
      userComposerLines: 4,
      userShowKeyLegend: true,
      hasPermission: false,
      hasSuggestionsOrAt: false,
      queuedCount: 0,
      hasAttachments: false,
      hasImageAttachments: false,
      hasHud: false,
    }),
    agent: undefined,
    metadata: {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-4-hydrogen',
          options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }],
        },
      ],
      availableCommands: [],
    },
    authentication: { terminalMethods: [], logout: false },
    authenticationKnown: true,
    disconnected: false,
    agentConnecting: false,
    authBusy: false,
    busy: false,
    cancelling: false,
    changingConfig: false,
    extLoading: false,
    reportLoading: false,
    reportText: '',
    sessionsLoading: false,
    sessionOperation: undefined,
    activeSessionId: 'sess-1',
    previousSessionId: undefined,
    listedSessions: [{ sessionId: 'sess-1', cwd: process.cwd(), title: 'Demo session' }],
    nextSessionsCursor: undefined,
    sessionInfo: new Map([['sess-1', { sessionId: 'sess-1', cwd: process.cwd(), title: 'Demo session' }]]),
    localNames: new Map(),
    sessionPreviews: new Map([
      ['sess-1', {
        source: 'cache',
        entryCount: 4,
        messageCount: 2,
        toolCount: 1,
        lastUser: 'Audit performance',
        lastAgent: 'Done auditing.',
        truncated: false,
      }],
    ]),
    mcpServers: [],
    pluginsList: [],
    agentsList: [],
    templatesList: [],
    gitChanges: [],
    gitDiffCache: new Map(),
    entries: [
      { type: 'message', id: 'entry-1', role: 'user', text: 'Audit performance' },
      {
        type: 'tool',
        id: 'entry-2',
        call: { toolCallId: 't1', name: 'bash', kind: 'execute', title: 'bun test', status: 'completed' },
      },
    ],
    draftText: '',
    panelDraft: { text: '', cursor: 0 },
    panelSelection: 0,
    pickerTab: 'all',
    pickerSelected: '',
    prefsPage: 'appearance',
    usageTab: 'overview',
    panelError: '',
    userPrefs: { ...DEFAULT_PREFS },
    commands: [{ name: 'sessions', local: 'sessions', description: 'Browse sessions' }],
    sessionDiffs: [],
    choices: [],
    loginMethod: undefined,
    modeOption: undefined,
    sessionTitle: id => id,
    blobForImage: () => undefined,
    onRender: () => {},
    onFocus: () => {},
    onEditPanelDraft: () => {},
    onSetPickerTab: () => {},
    onSetPickerSelected: () => {},
    onSetPrefsPage: () => {},
    onSetUsageTab: () => {},
    onOpenPanel: () => {},
    onClosePanel: () => {},
    onUpdatePrefs: () => {},
    onResetPrefs: () => {},
    onShowToast: () => {},
    onChangeConfig: () => {},
    onChooseCommand: () => {},
    onOpenConversation: () => {},
    onNewConversation: () => {},
    onLoadSessions: () => {},
    onCloseSavedSession: () => {},
    onRequestSessionPreview: () => {},
    onLoadExtensions: () => {},
    onToggleMcp: () => {},
    onRemoveMcp: () => {},
    onTogglePlugin: () => {},
    onValidatePlugin: () => {},
    onUninstallPlugin: () => {},
    onRemoveTemplate: () => {},
    onSetDraft: () => {},
    onRefreshGitChanges: () => {},
    onLoadGitDiffPreview: () => {},
    onInspectGitFile: () => {},
    onOpenInspect: () => {},
    onOpenSplit: () => {},
    onAttachFile: () => {},
    onInspectFindMatch: () => {},
    onJumpToEntry: () => {},
    onInspectDirPath: () => {},
    onCopy: () => {},
    onStopTurn: () => {},
    onLoadReport: () => {},
  };
}

describe('panel renderers & transcript view helpers', () => {
  test('renderActivePanel builds valid Tern elements across major modal panels', () => {
    const panels: Panel[] = [
      { kind: 'settings' },
      { kind: 'sessions' },
      { kind: 'commands' },
      { kind: 'tasks' },
      { kind: 'find' },
      { kind: 'changes' },
      { kind: 'report', report: 'usage' },
      { kind: 'inspect', title: 'snippet.ts', item: { type: 'file', path: 'snippet.ts', content: 'export const x = 1;' } },
    ];
    for (const panel of panels) {
      const node = renderActivePanel(baseContext(panel)) as { k?: string; t?: unknown };
      expect(node).toBeTruthy();
      expect(typeof node).toBe('object');
    }

    const sessionsText = JSON.stringify(renderActivePanel(baseContext({ kind: 'sessions' })));
    expect(sessionsText).toContain('Audit performance');
    expect(sessionsText).toContain('Done auditing.');
    expect(sessionsText).toContain('2 message(s), 1 tool(s) (snapshot)');
  });

  test('cachedPathExists caches file presence cleanly without throwing on invalid paths', () => {
    expect(cachedPathExists('package.json')).toBe(true);
    expect(cachedPathExists('package.json')).toBe(true);
    expect(cachedPathExists('definitely-missing-agy-tern-path-12345')).toBe(false);
    expect(cachedPathExists('\0invalid')).toBe(false);
  });
});
