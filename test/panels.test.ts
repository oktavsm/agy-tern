import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { DEFAULT_PREFS } from '../src/prefs';
import type { ToolStep } from '../src/model';
import { computeResponsiveLayout } from '../src/ui-format';
import { renderActivePanel, type Panel, type PanelRenderContext } from '../src/panels';
import { cachedPathExists, Entry, type EntryCallbacks } from '../src/transcript-view';

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

  test('tool entries expose clickable modal, file, copy, and split actions for every task kind', () => {
    const inspectedFiles: Array<{ path: string; line?: number }> = [];
    const inspectedTargets: Array<{ title: string; kind: string; subtitle?: string }> = [];
    const copiedTexts: string[] = [];
    const splitTargets: Array<{ path: string; line?: number }> = [];
    const runCommands: string[] = [];

    const callbacks: EntryCallbacks = {
      cwd: process.cwd(),
      working: false,
      now: 1_000,
      agentStatus: 'success',
      prefs: DEFAULT_PREFS,
      thoughtFoldOverrides: new Map(),
      toolFoldOverrides: new Map(),
      canRetry: false,
      canReconnect: false,
      canSwitchAccount: false,
      pathExists: target => target === resolve(process.cwd(), 'package.json'),
      getBlob: () => undefined,
      onInspect(title, target, subtitle) {
        inspectedTargets.push({ title, kind: target.type, subtitle });
      },
      onInspectFile(filePath, line) {
        inspectedFiles.push({ path: filePath, line });
      },
      onToggleThought: () => {},
      onToggleTool: () => {},
      onRetry: () => {},
      onReconnect: () => {},
      onSwitchModel: () => {},
      onSwitchAccount: () => {},
      onOpenAccount: () => {},
      onOpenChanges: () => {},
      onOpenSplit(path, line) {
        splitTargets.push({ path, line });
      },
      onRunCommand(command) {
        runCommands.push(command);
      },
      onAttachPath: () => {},
      onExport: () => {},
      onCopy(text) {
        copiedTexts.push(text);
      },
      onResend: () => {},
    };

    const readStep: ToolStep = {
      id: 'tool-read-1',
      type: 'tool',
      startedAt: 500,
      endedAt: 650,
      call: {
        toolCallId: 'tool-read-1',
        kind: 'read',
        title: 'Read package.json',
        status: 'completed',
        locations: [{ path: 'package.json', line: 12 }],
      },
    };
    const readNode = Entry({ entry: readStep, continued: false, streaming: false, recent: true, callbacks }) as unknown as {
      props: {
        tools?: Array<{ id: string; label?: string }>;
      };
      handlers: {
        onAction?: Record<string, (ev: unknown) => void>;
        onToggle?: (ev: { collapsed?: boolean }) => void;
      };
    };
    expect(readNode.props.tools?.map(t => t.id)).toEqual(['view-file', 'split', 'toggle']);

    // Clicking a plain read task opens the file contents modal directly.
    readNode.handlers.onToggle?.({ collapsed: false });
    expect(inspectedFiles).toEqual([{ path: resolve(process.cwd(), 'package.json'), line: 12 }]);

    readNode.handlers.onAction?.split?.({});
    expect(splitTargets).toEqual([{ path: resolve(process.cwd(), 'package.json'), line: 12 }]);

    const cmdCallbacks: EntryCallbacks = {
      ...callbacks,
      toolFoldOverrides: new Map([['tool-cmd-1', false]]),
    };
    const cmdStep: ToolStep = {
      id: 'tool-cmd-1',
      type: 'tool',
      startedAt: 700,
      endedAt: 900,
      call: {
        toolCallId: 'tool-cmd-1',
        kind: 'execute',
        title: 'Run tests',
        status: 'completed',
        rawInput: { command: 'bun test' },
        rawOutput: '179 pass',
      },
    };
    const cmdNode = Entry({ entry: cmdStep, continued: false, streaming: false, recent: true, callbacks: cmdCallbacks }) as unknown as {
      props: {
        tools?: Array<{ id: string; label?: string }>;
      };
      handlers: {
        onAction?: Record<string, (ev: unknown) => void>;
      };
    };
    expect(cmdNode.props.tools?.map(t => t.id)).toEqual(['inspect', 'copy-output']);
    cmdNode.handlers.onAction?.inspect?.({});
    expect(inspectedTargets.at(-1)?.kind).toBe('file');
    cmdNode.handlers.onAction?.['copy-output']?.({});
    expect(copiedTexts).toEqual(['179 pass']);

    const cmdJson = JSON.stringify(cmdNode);
    expect(cmdJson).toContain('Inspect output');
    expect(cmdJson).toContain('Copy output');
    expect(cmdJson).toContain('Run in split');
    expect(cmdJson).toContain('Inspect details');
    expect(runCommands.length).toBe(0);
  });

  test('/usage details tab renders account, runtime session, context breakdown, and quota table', () => {
    const emptyDetailsCtx = baseContext({ kind: 'report', report: 'usage' });
    emptyDetailsCtx.usageTab = 'details';
    const emptyJson = JSON.stringify(renderActivePanel(emptyDetailsCtx));
    expect(emptyJson).toContain('Account & connection');
    expect(emptyJson).toContain('Active session & runtime');
    expect(emptyJson).toContain('Context & quota breakdown');
    expect(emptyJson).toContain('Official agy shared auth (email not exposed by ACP)');
    expect(emptyJson).toContain('Gemini 4 Hydrogen (gemini-4-hydrogen)');
    expect(emptyJson).toContain('No session-context token usage has been reported by ACP yet.');

    const fullDetailsCtx = baseContext({ kind: 'report', report: 'usage' });
    fullDetailsCtx.usageTab = 'details';
    fullDetailsCtx.agent = {
      sessionId: 'sess-1',
      metadata: fullDetailsCtx.metadata,
      authentication: { terminalMethods: [{ id: 'login', name: 'Browser OAuth', args: ['--login'] }], logout: true },
      capabilities: {
        listSessions: true,
        loadSession: true,
        resumeSession: true,
        closeSession: false,
        additionalDirectories: true,
        appendSystemPrompt: true,
      },
      promptCapabilities: { image: true, embeddedContext: true },
      listSessions: async () => ({ sessions: [] }),
      newSession: async () => {},
      loadSession: async () => {},
      setConfigOption: async () => {},
      prompt: async () => 'end_turn',
      cancel: async () => {},
      logout: async () => {},
      close: async () => {},
    };
    fullDetailsCtx.loginMethod = { id: 'login', name: 'Browser OAuth', args: ['--login'] };
    fullDetailsCtx.metadata = {
      ...fullDetailsCtx.metadata,
      tier: { name: 'Google AI Pro', id: 'ai-pro', upgradeUri: 'https://one.google.com' },
      usage: { used: 2_000, size: 100_000, cost: { amount: 0.12, currency: 'USD' } },
      configOptions: [
        ...fullDetailsCtx.metadata.configOptions,
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'high', name: 'High' }],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    };
    fullDetailsCtx.modeOption = fullDetailsCtx.metadata.configOptions[2];
    fullDetailsCtx.reportText = [
      'Gemini 3 Pro\t100 req\t82%\t3h 12m',
      'Claude / GPT\t50 req\t24%\t1h 05m',
    ].join('\n');

    const fullJson = JSON.stringify(renderActivePanel(fullDetailsCtx));
    expect(fullJson).toContain('Google AI Pro (ai-pro)');
    expect(fullJson).toContain('https://one.google.com');
    expect(fullJson).toContain('Browser OAuth (login)');
    expect(fullJson).toContain('agy acp --sandbox (Connected)');
    expect(fullJson).toContain('Thinking effort');
    expect(fullJson).toContain('High (high)');
    expect(fullJson).toContain('98,000');
    expect(fullJson).toContain('100,000');
    expect(fullJson).toContain('0.12 USD');
    expect(fullJson).toContain('Quota bar');
    expect(fullJson).toContain('Gemini 3 Pro');
  });

  test('/sessions picker surfaces loading state despite active session and supports All workspaces + chat match', () => {
    const loadingCtx = baseContext({ kind: 'sessions' });
    loadingCtx.sessionsLoading = true;
    loadingCtx.pickerTab = 'workspace';
    const loadingNode = renderActivePanel(loadingCtx) as unknown as {
      props: { state?: string; message?: string; tabs?: Array<{ id: string; label: string }> };
    };
    expect(loadingNode.props.state).toBe('loading');
    expect(loadingNode.props.message).toContain('Syncing workspace conversations');
    expect(loadingNode.props.tabs?.map(t => t.id)).toEqual(['workspace', 'all', 'named']);

    const allCtx = baseContext({ kind: 'sessions' });
    allCtx.pickerTab = 'all';
    allCtx.panelDraft = { text: 'oauth rotation', cursor: 14 };
    allCtx.allListedSessions = [
      { sessionId: 'sess-1', cwd: process.cwd(), title: 'Demo session' },
      { sessionId: 'other-1', cwd: '/tmp/another-repo', title: 'Security follow-up', updatedAt: '2026-11-17T12:00:00Z' },
    ];
    allCtx.sessionTitle = id => allCtx.allListedSessions?.find(s => s.sessionId === id)?.title ?? id;
    allCtx.sessionPreviews = new Map([
      ['other-1', {
        source: 'brain',
        entryCount: 6,
        messageCount: 4,
        toolCount: 2,
        lastUser: 'Audit OAuth rotation logic',
        lastAgent: 'Updated refresh token window.',
        searchText: 'audit oauth rotation logic updated refresh token window',
        truncated: false,
      }],
    ]);
    const allJson = JSON.stringify(renderActivePanel(allCtx));
    expect(allJson).toContain('Security follow-up');
    expect(allJson).toContain('another-repo');
    expect(allJson).toContain('Chat match');
    expect(allJson).toContain('/tmp/another-repo (loads into current workspace)');
  });
});
