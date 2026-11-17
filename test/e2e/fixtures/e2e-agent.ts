#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AuthMethod,
  type AvailableCommand,
  type InitializeRequest,
  type ListSessionsRequest,
  type NewSessionRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type UsageUpdate,
} from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const cwd = process.cwd();

const scenarioTokens = new Set(
  (process.env.AGY_E2E_SCENARIO ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean),
);

function hasScenario(token: string): boolean {
  return scenarioTokens.has(token);
}

function logMeta(entry: Record<string, unknown>): void {
  const logPath = process.env.AGY_E2E_META_LOG;
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function extractSystemPrompt(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return null;
  const antigravity = (meta as Record<string, unknown>).antigravity;
  if (!antigravity || typeof antigravity !== 'object') return null;
  return (antigravity as Record<string, unknown>).systemPrompt ?? null;
}

interface ExtState {
  mcp: Array<{ name: string; type: string; status: string; target: string }>;
  plugins: Array<{
    name: string;
    enabled: boolean;
    version: string;
    source: string;
    path: string;
    skills: string[];
    rules: string[];
  }>;
}

function defaultExtState(): ExtState {
  return {
    mcp: [
      { name: 'fetch', type: 'stdio', status: 'enabled', target: 'uvx mcp-server-fetch' },
      { name: 'playwright', type: 'stdio', status: 'enabled', target: 'npx -y @playwright/mcp@latest' },
      { name: 'browser-alt', type: 'stdio', status: 'disabled', target: 'npx -y @synthetic/browser-alt' },
    ],
    plugins: [
      {
        name: 'antislop',
        enabled: true,
        version: '3.2.4',
        source: 'antigravity',
        path: '/fixture/plugins/antislop',
        skills: ['antislop', 'antislop-ui', 'antislop-code'],
        rules: ['antislop.md'],
      },
      {
        name: 'ux-ui-agent-skills',
        enabled: true,
        version: '2.10.0',
        source: 'claude-code',
        path: '/fixture/plugins/ux-ui',
        skills: ['design-screen', 'a11y-audit', 'design-tokens'],
        rules: ['AGENTS.md'],
      },
      {
        name: 'android-cli-plugin',
        enabled: false,
        version: '1.0.0',
        source: 'antigravity',
        path: '/fixture/plugins/android',
        skills: ['android-cli'],
        rules: [],
      },
    ],
  };
}

function loadExtState(): ExtState {
  const statePath = process.env.AGY_E2E_EXT_STATE;
  if (!statePath || !existsSync(statePath)) return defaultExtState();
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as ExtState;
  } catch {
    return defaultExtState();
  }
}

function saveExtState(state: ExtState): void {
  const statePath = process.env.AGY_E2E_EXT_STATE;
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

// Strict CLI subcommand routing precedence:
// 1. help acp
if (argv[0] === 'help' && argv[1] === 'acp') {
  logMeta({ event: 'cli_help_acp', argv, cwd });
  if (hasScenario('doctor-fail')) {
    console.error('acp help unavailable');
    process.exit(1);
  }
  console.log('Usage: agy acp [--stdio] [--sandbox] [--add-dir DIR] [--agent NAME]');
  process.exit(0);
}

// 2. --version
if (argv.includes('--version')) {
  logMeta({ event: 'cli_version', argv });
  console.log('e2e-agy 1.0.0');
  process.exit(0);
}

// 3. --login
if (argv.includes('--login')) {
  const authMode = (process.env.AGY_E2E_AUTH_MODE ?? 'success').toLowerCase();
  logMeta({ event: 'login', argv, authMode, cwd });

  const delegateModes = ['ignore-signals', 'cancel-exit-zero', 'descendants', 'nonzero'];
  if (
    process.env.AGY_E2E_AUTH_DELEGATE === '1' ||
    delegateModes.some(token => authMode.includes(token))
  ) {
    const authBin = join(dirname(fileURLToPath(import.meta.url)), 'e2e-auth.ts');
    const child = spawn(process.execPath, [authBin, ...argv], {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      },
    );
    if (result.signal) {
      process.kill(process.pid, result.signal);
    }
    process.exit(result.code ?? 1);
  }

  if (authMode.includes('wait')) {
    process.once('SIGINT', () => process.exit(130));
    process.stdin.resume();
    console.log('SYNTHETIC_LOGIN_WAIT: Ctrl+C cancels this fake login; no real account is accessed.');
    await Promise.withResolvers<void>().promise;
  }
  if (authMode.includes('fail')) {
    console.error('Synthetic login failure; no real account was accessed.');
    process.exit(Number(process.env.AGY_E2E_AUTH_EXIT ?? '17'));
  }

  const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
  if (markerPath) {
    mkdirSync(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, 'SYNTHETIC e2e login marker\n');
  }
  console.log('Synthetic terminal login complete. No real account was accessed.');
  process.exit(0);
}

// 4. --print (must come before --sandbox because --print invokes with --sandbox)
if (argv.includes('--print')) {
  const command = argv[argv.indexOf('--print') + 1] ?? '';
  logMeta({ event: 'cli_print', command, argv });
  if (hasScenario('report-error')) {
    process.stderr.write('Synthetic CLI report error\n');
    process.exit(12);
  }
  if (command === '/usage') {
    console.log('Synthetic account quota\tWeekly limit\t75%\t2026-11-21T00:00:00Z');
  } else if (command === '/credits') {
    console.log('## Synthetic account credits\n\nLocal fixture balance: 10 fixture-credits.');
  } else if (command === '/changelog') {
    console.log('## Synthetic release notes\n\nLocal fixture command panels.');
  } else {
    process.exit(2);
  }
  process.exit(0);
}

// 5. mcp
if (argv[0] === 'mcp') {
  logMeta({ event: 'cli_mcp', argv });
  if (hasScenario('ext-error')) {
    console.error('Synthetic mcp error');
    process.exit(1);
  }
  const sub = argv[1];
  const state = loadExtState();
  if (sub === 'list') {
    console.log('NAME        TYPE   STATUS    COMMAND/URL');
    for (const item of state.mcp) {
      console.log(`${item.name.padEnd(11)} ${item.type.padEnd(6)} ${item.status.padEnd(9)} ${item.target}`);
    }
    process.exit(0);
  }
  if (sub === 'add') {
    const typeIdx = argv.indexOf('--type');
    const type = typeIdx >= 0 ? (argv[typeIdx + 1] ?? 'stdio') : 'stdio';
    const sepIdx = argv.indexOf('--');
    const nameIdx = typeIdx >= 0 ? typeIdx + 2 : 2;
    const name = argv[nameIdx] ?? 'custom-mcp';
    const target = sepIdx >= 0 ? argv.slice(sepIdx + 1).join(' ') : 'custom-cmd';
    state.mcp.push({ name, type, status: 'enabled', target });
    saveExtState(state);
    process.exit(0);
  }
  if (sub === 'remove') {
    const name = argv[2];
    state.mcp = state.mcp.filter(item => item.name !== name);
    saveExtState(state);
    process.exit(0);
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = argv[2];
    const nextStatus = sub === 'enable' ? 'enabled' : 'disabled';
    for (const item of state.mcp) {
      if (item.name === name) item.status = nextStatus;
    }
    saveExtState(state);
    process.exit(0);
  }
  process.exit(0);
}

// 6. plugin
if (argv[0] === 'plugin') {
  logMeta({ event: 'cli_plugin', argv });
  if (hasScenario('ext-error')) {
    console.error('Synthetic plugin error');
    process.exit(1);
  }
  const sub = argv[1];
  const state = loadExtState();
  if (sub === 'list') {
    console.log(JSON.stringify(state.plugins));
    process.exit(0);
  }
  if (sub === 'validate') {
    console.log(
      JSON.stringify({
        dir: argv[2] ?? '/fixture/plugins/antislop',
        manifest: '.claude-plugin/plugin.json',
        name: 'antislop',
        components: { skills: 3, rules: 1 },
        findings: [
          {
            severity: 'info',
            file: 'SKILL.md',
            message: 'Synthetic validation passed with 1 informational note.',
          },
        ],
      }),
    );
    process.exit(0);
  }
  if (sub === 'install') {
    const target = argv[2] ?? 'custom-plugin';
    state.plugins.push({
      name: target,
      enabled: true,
      version: '1.0.0',
      source: 'local',
      path: `/fixture/plugins/${target}`,
      skills: [],
      rules: [],
    });
    saveExtState(state);
    process.exit(0);
  }
  if (sub === 'uninstall') {
    const name = argv[2];
    state.plugins = state.plugins.filter(p => p.name !== name);
    saveExtState(state);
    process.exit(0);
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = argv[2];
    const enabled = sub === 'enable';
    for (const p of state.plugins) {
      if (p.name === name) p.enabled = enabled;
    }
    saveExtState(state);
    process.exit(0);
  }
  process.exit(0);
}

// 7. agent
if (argv[0] === 'agent') {
  logMeta({ event: 'cli_agent', argv });
  console.log('NAME       DESCRIPTION');
  console.log('reviewer   Strict synthetic code & diff auditor');
  console.log('explorer   Fast codebase search specialist');
  process.exit(0);
}

// 8. --sandbox fallback (no 'acp' subcommand)
if (argv[0] !== 'acp') {
  logMeta({ event: 'fallback_sandbox', argv, cwd });
  console.log(`E2E_SANDBOX_FALLBACK ${JSON.stringify({ argv, cwd })}`);
  if (hasScenario('fallback-wait')) {
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
    await Promise.withResolvers<void>().promise;
  }
  process.exit(Number(process.env.AGY_E2E_FALLBACK_EXIT ?? '0'));
}

// 9. ACP server mode (`argv[0] === 'acp'`)
logMeta({ event: 'cli_acp', argv, cwd });

let sessionId = 'e2e-session-active';
let previousSessionId = '';
let newRequests = 0;
let loadRequests = 0;
const listed: ListSessionsRequest[] = [];
const allCreated: NewSessionRequest[] = [];
const prompts: Array<{ sessionId: string; prompt: unknown; _meta: unknown }> = [];
let logoutRequests = 0;
let initialized: InitializeRequest | undefined;
let created: NewSessionRequest | undefined;
let waitingPrompt: PromiseWithResolvers<PromptResponse> | undefined;
let activeTurnCancelled = false;
let cancelSleep: (() => void) | undefined;

function parseJsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  return JSON.parse(raw) as T;
}

const defaultConfigOptions: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fixture-small',
    options: [
      {
        group: 'fixture-family',
        name: 'Local fixture models',
        options: [
          { value: 'fixture-small', name: 'Small synthetic model' },
          { value: 'fixture-large', name: 'Large synthetic model' },
          { value: 'fixture-rejected', name: 'Rejected synthetic model' },
        ],
      },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    name: 'Session mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  { id: 'reports', name: 'Synthetic reports', type: 'boolean', currentValue: false },
];

let configOptions: SessionConfigOption[] =
  parseJsonEnv<SessionConfigOption[]>('AGY_E2E_CONFIG_OVERRIDE') ?? defaultConfigOptions;

const defaultAvailableCommands: AvailableCommand[] = [
  { name: 'help', description: 'List local fixture commands' },
  { name: 'model', description: 'Show the selected synthetic model' },
  { name: 'usage', description: 'Show synthetic context usage, not account quota' },
  { name: 'echo', description: 'Repeat local fixture input', input: { hint: 'text to repeat' } },
  { name: 'fixture-status', description: 'Show the local fixture configuration' },
  { name: 'fixture-refresh', description: 'Replace synthetic metadata for local protocol tests' },
];

let availableCommands: AvailableCommand[] =
  parseJsonEnv<AvailableCommand[]>('AGY_E2E_COMMANDS_OVERRIDE') ?? defaultAvailableCommands;

let usage: UsageUpdate | undefined = {
  used: 16,
  size: 4_096,
  cost: { amount: 0, currency: 'fixture-credits' },
};

const tierMeta =
  parseJsonEnv<{ name: string; id?: string; upgradeUri?: string }>('AGY_E2E_TIER') ?? {
    name: 'Synthetic Pro',
    id: 'synthetic-pro',
  };

interface FixtureSession {
  info: SessionInfo;
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  usage?: UsageUpdate;
  history: SessionNotification[];
}

function syntheticHistory(id: string, user: string, reply: string): SessionNotification[] {
  return [
    { sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: user } } },
    { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
  ];
}

const storedSessions = new Map<string, FixtureSession>();
const initialSessionsCount = Math.max(0, Number(process.env.AGY_E2E_SESSIONS_COUNT ?? '2') || 0);
for (let i = 1; i <= initialSessionsCount; i += 1) {
  const id = `e2e-session-${i}`;
  const day = String(Math.max(1, 20 - i)).padStart(2, '0');
  storedSessions.set(id, {
    info: {
      sessionId: id,
      cwd,
      title: `Synthetic session ${i}`,
      updatedAt: `2026-11-${day}T10:00:00Z`,
    },
    configOptions: configOptions
      .filter(option => option.id === 'model')
      .map(option => (option.type === 'select' ? { ...option, currentValue: 'fixture-large' } : option)),
    availableCommands: [{ name: 'echo', description: 'Repeat local fixture input', input: { hint: 'text to repeat' } }],
    usage: { used: 64 * i, size: 4_096 },
    history: i === 2 && initialSessionsCount === 2
      ? []
      : syntheticHistory(id, `Prompt for session ${i}.`, `Reply from session ${i}.`),
  });
}

function rememberCurrentSession(): void {
  const current = storedSessions.get(sessionId);
  if (!current) return;
  current.configOptions = configOptions;
  current.availableCommands = availableCommands;
  current.usage = usage;
}

async function waitForSwitch(): Promise<void> {
  if (!hasScenario('switch-wait')) return;
  const released = Promise.withResolvers<void>();
  process.once('SIGUSR1', () => released.resolve());
  process.stderr.write('lifecycle-pending\n');
  await released.promise;
}

async function sleepAbortable(ms: number): Promise<void> {
  if (ms <= 0 || activeTurnCancelled) return;
  await new Promise<void>(resolveSleep => {
    const timer = setTimeout(() => {
      if (cancelSleep === wake) cancelSleep = undefined;
      resolveSleep();
    }, ms);
    const wake = (): void => {
      clearTimeout(timer);
      if (cancelSleep === wake) cancelSleep = undefined;
      resolveSleep();
    };
    cancelSleep = wake;
  });
}

const authMethods: AuthMethod[] = hasScenario('unsupported-auth')
  ? [{ id: 'fixture-protocol-login', name: 'Synthetic protocol login' }]
  : [
      { id: 'terminal-login', name: 'Log in from the terminal', type: 'terminal', args: ['--login'] },
      { id: 'fixture-protocol-login', name: 'Synthetic protocol login' },
    ];

const capsOverride = parseJsonEnv<{
  protocolVersion?: number;
  authMethods?: AuthMethod[];
  agentCapabilities?: Record<string, unknown>;
}>('AGY_E2E_CAPS_OVERRIDE');

const connection = agent({ name: 'e2e-protocol-fixture' })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    initialized = params;
    logMeta({
      event: 'initialize',
      params,
      clientCapabilities: params.clientCapabilities ?? null,
      _meta: params._meta ?? null,
      systemPrompt: extractSystemPrompt(params._meta),
    });

    if (hasScenario('init-wait')) {
      process.stderr.write('waiting-initialize\n');
      await Promise.withResolvers<void>().promise;
    }

    const baseCaps = {
      ...(hasScenario('unsupported-sessions')
        ? {}
        : {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {}, close: {}, additionalDirectories: {} },
          }),
      ...(hasScenario('unsupported-auth') ? {} : { auth: { logout: {} } }),
      promptCapabilities: hasScenario('no-images')
        ? { image: false, embeddedContext: false }
        : { image: true, embeddedContext: true },
    };

    return {
      protocolVersion:
        capsOverride?.protocolVersion ??
        (hasScenario('bad-version') ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION),
      authMethods:
        capsOverride?.authMethods !== undefined
          ? capsOverride.authMethods
          : hasScenario('missing-auth-methods')
            ? undefined
            : authMethods,
      agentCapabilities: capsOverride?.agentCapabilities
        ? { ...baseCaps, ...capsOverride.agentCapabilities }
        : baseCaps,
      agentInfo: { name: 'e2e-protocol-fixture', version: '1.0.0' },
    };
  })
  .onRequest(methods.agent.logout, async ({ client }) => {
    logoutRequests += 1;
    logMeta({ event: 'logout', count: logoutRequests });
    if (hasScenario('logout-rejected')) {
      throw new RequestError(-32010, 'fixture logout rejected');
    }
    if (hasScenario('logout-wait')) {
      const released = Promise.withResolvers<void>();
      process.once('SIGUSR1', () => released.resolve());
      process.stderr.write('logout-pending\n');
      await released.promise;
    }
    const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
    if (markerPath) {
      await rm(markerPath, { force: true });
    }
    if (hasScenario('logout-permission')) {
      const requestPermission = async (): Promise<void> => {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: 'logout-stale-tool', title: 'Synthetic stale logout tool', kind: 'execute' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        });
        process.stderr.write(`${JSON.stringify({ logoutPermissionOutcome: response.outcome })}\n`);
      };
      await requestPermission();
      process.once('SIGUSR1', () => {
        void requestPermission();
      });
    }
    return {};
  })
  .onRequest(methods.agent.session.new, async ({ params, client }) => {
    created = params;
    allCreated.push(params);
    newRequests += 1;
    logMeta({
      event: 'session/new',
      params,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? null,
      _meta: params._meta ?? null,
      systemPrompt: extractSystemPrompt(params._meta),
    });

    const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
    if (hasScenario('auth-required') && (!markerPath || !existsSync(markerPath))) {
      throw RequestError.authRequired();
    }
    if (hasScenario('startup-exit')) {
      process.exit(Number(process.env.AGY_E2E_EXIT_CODE ?? '24'));
    }
    if (hasScenario('new-wait')) {
      process.stderr.write('waiting-session-new\n');
      await Promise.withResolvers<void>().promise;
    }

    if (newRequests > 1) {
      await waitForSwitch();
      const targetId = `e2e-session-new-${newRequests}`;
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Foreign new-session update.' },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: targetId,
        update: {
          sessionUpdate: 'session_info_update',
          title: `Synthetic new session ${newRequests}`,
          updatedAt: '2026-11-15T12:00:00Z',
        },
      });
      if (hasScenario('new-rejected')) {
        await client.notify(methods.client.session.update, {
          sessionId: targetId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Uncommitted new-session text.' },
          },
        });
        throw new RequestError(-32010, 'fixture session creation rejected');
      }
      rememberCurrentSession();
      previousSessionId = sessionId;
      sessionId = targetId;
      configOptions = [];
      availableCommands = [];
      usage = undefined;
      storedSessions.set(sessionId, {
        info: {
          sessionId,
          cwd: params.cwd,
          title: `Synthetic new session ${newRequests}`,
          updatedAt: '2026-11-15T12:00:00Z',
        },
        configOptions,
        availableCommands,
        history: [],
      });
      return { sessionId };
    }

    storedSessions.set(sessionId, {
      info: {
        sessionId,
        cwd: params.cwd,
        title: 'Synthetic current session',
        updatedAt: '2026-11-15T11:00:00Z',
      },
      configOptions,
      availableCommands,
      usage,
      history: [],
    });

    const initialConfig = configOptions;
    await client.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands },
    });
    if (usage) {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'usage_update', ...usage },
      });
    }
    if (hasScenario('early-content')) {
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Foreign startup text.' },
        },
      });
      for (const notification of syntheticHistory(
        sessionId,
        'Synthetic startup history.',
        'Synthetic startup reply.',
      )) {
        await client.notify(methods.client.session.update, notification);
      }
    }
    if (hasScenario('early-config')) {
      configOptions = configOptions.map(option =>
        option.id === 'reports' && option.type === 'boolean'
          ? { ...option, currentValue: true }
          : option,
      );
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'usage_update', used: 999, size: 999 },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      });
    }

    return {
      sessionId,
      configOptions: initialConfig,
      _meta: { antigravity: { tier: tierMeta } },
    };
  })
  .onRequest(methods.agent.session.list, ({ params }) => {
    listed.push(params);
    const foreign = {
      sessionId: 'foreign-workspace',
      cwd: join(cwd, 'nested'),
      title: 'Foreign workspace session',
    };

    if (hasScenario('list-pages')) {
      const firstTwo = [...storedSessions.values()].slice(0, 2);
      if (params.cursor === undefined) {
        const res = { sessions: [foreign], nextCursor: 'matching-page' };
        logMeta({
          event: 'session/list',
          cursor: params.cursor ?? null,
          returnedIds: res.sessions.map(s => s.sessionId),
          nextCursor: res.nextCursor ?? null,
        });
        return res;
      }
      if (params.cursor !== 'matching-page') {
        throw new RequestError(-32602, 'fixture cursor not found');
      }
      const sessions = [
        ...(firstTwo[0] ? [{ ...firstTwo[0].info, cwd: `${cwd}/nested/..` }] : []),
        ...(firstTwo[1] ? [firstTwo[1].info] : []),
        foreign,
      ];
      logMeta({
        event: 'session/list',
        cursor: params.cursor,
        returnedIds: sessions.map(s => s.sessionId),
        nextCursor: null,
      });
      return { sessions };
    }

    const pageSize = Math.max(1, Number(process.env.AGY_E2E_SESSIONS_PAGE_SIZE ?? '2') || 2);
    const entries = [...storedSessions.values()].map(entry => entry.info);
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RequestError(-32602, 'fixture cursor not found');
    }
    const page = entries.slice(offset, offset + pageSize);
    const sessions =
      process.env.AGY_E2E_FOREIGN_SESSIONS === '1' && offset === 0 ? [foreign, ...page] : page;
    const nextCursor = offset + pageSize < entries.length ? String(offset + pageSize) : undefined;
    logMeta({
      event: 'session/list',
      cursor: params.cursor ?? null,
      returnedIds: sessions.map(s => s.sessionId),
      nextCursor: nextCursor ?? null,
    });
    return { sessions, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    loadRequests += 1;
    logMeta({
      event: 'session/load',
      sessionId: params.sessionId,
      cwd: params.cwd,
      _meta: params._meta ?? null,
      systemPrompt: extractSystemPrompt(params._meta),
    });
    await waitForSwitch();
    if (params.sessionId === 'fixture-rejected') {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Uncommitted load text.' },
        },
      });
      throw new RequestError(-32010, 'fixture session load rejected');
    }
    rememberCurrentSession();
    const target = storedSessions.get(params.sessionId);
    if (!target || params.cwd !== cwd) {
      throw new RequestError(-32602, 'fixture session not found');
    }
    await client.notify(methods.client.session.update, {
      sessionId: 'another-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Foreign replay text.' },
      },
    });
    for (const notification of target.history) {
      await client.notify(methods.client.session.update, notification);
    }
    if (target.availableCommands.length) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: target.availableCommands },
      });
    }
    if (target.usage) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'usage_update', ...target.usage },
      });
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title: target.info.title,
        updatedAt: target.info.updatedAt,
      },
    });
    if (hasScenario('load-permission')) {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'stale-load-tool', title: 'Synthetic stale-session tool', kind: 'execute' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      });
      process.stderr.write(`${JSON.stringify({ stalePermissionOutcome: response.outcome })}\n`);
    }
    previousSessionId = sessionId;
    sessionId = params.sessionId;
    configOptions = target.configOptions;
    availableCommands = target.availableCommands;
    usage = target.usage;
    return {
      configOptions,
      _meta: { antigravity: { tier: tierMeta } },
    };
  })
  .onRequest(methods.agent.session.resume, async ({ params }) => {
    logMeta({
      event: 'session/resume',
      sessionId: params.sessionId,
      cwd: params.cwd,
      _meta: params._meta ?? null,
      systemPrompt: extractSystemPrompt(params._meta),
    });
    rememberCurrentSession();
    const target = storedSessions.get(params.sessionId);
    if (!target || params.cwd !== cwd) {
      throw new RequestError(-32602, 'fixture session not found');
    }
    previousSessionId = sessionId;
    sessionId = params.sessionId;
    configOptions = target.configOptions;
    availableCommands = target.availableCommands;
    usage = target.usage;
    return { configOptions };
  })
  .onRequest(methods.agent.session.close, async ({ params }) => {
    logMeta({ event: 'session/close', sessionId: params.sessionId });
    if (!storedSessions.has(params.sessionId)) {
      throw new RequestError(-32602, 'fixture session not found');
    }
    storedSessions.delete(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    logMeta({
      event: 'session/set_config_option',
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    const option = configOptions.find(candidate => candidate.id === params.configId);
    if (!option || params.sessionId !== sessionId) {
      throw new RequestError(-32602, 'fixture config option not found');
    }
    if (params.value === 'fixture-rejected') {
      throw new RequestError(-32010, 'fixture config selection rejected');
    }
    let updated: SessionConfigOption;
    if (option.type === 'boolean' && typeof params.value === 'boolean' && 'type' in params && params.type === 'boolean') {
      updated = { ...option, currentValue: params.value };
    } else if (
      option.type === 'select' &&
      typeof params.value === 'string' &&
      option.options.some(entry =>
        'options' in entry
          ? entry.options.some(candidate => candidate.value === params.value)
          : entry.value === params.value,
      )
    ) {
      updated = { ...option, currentValue: params.value };
    } else {
      throw new RequestError(-32602, 'fixture config value is invalid');
    }

    if (hasScenario('config-wait')) {
      const released = Promise.withResolvers<void>();
      process.once('SIGUSR1', () => released.resolve());
      process.stderr.write('configuration-pending\n');
      await released.promise;
    }

    configOptions = configOptions.map(candidate => {
      if (candidate.id === params.configId) return updated;
      if (
        params.configId === 'model' &&
        params.value === 'fixture-large' &&
        candidate.id === 'thought_level' &&
        candidate.type === 'select'
      ) {
        return { ...candidate, currentValue: 'high' };
      }
      return candidate;
    });
    return { configOptions };
  })
  .onNotification(methods.agent.session.cancel, params => {
    activeTurnCancelled = true;
    cancelSleep?.();
    waitingPrompt?.resolve({ stopReason: 'cancelled' });
    logMeta({ event: 'session/cancel', sessionId });
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client, requestId }) => {
    if (params.sessionId !== sessionId) {
      throw new RequestError(-32602, 'fixture prompt session not found');
    }
    activeTurnCancelled = false;
    prompts.push({ sessionId: params.sessionId, prompt: params.prompt, _meta: params._meta ?? null });
    logMeta({
      event: 'session/prompt',
      sessionId: params.sessionId,
      prompt: params.prompt,
      _meta: params._meta ?? null,
      systemPrompt: extractSystemPrompt(params._meta),
    });

    const first = params.prompt[0];
    const command = first?.type === 'text' ? first.text : '';
    const images = params.prompt.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image');
    const resources = params.prompt.filter(
      (b): b is Extract<typeof b, { type: 'resource' }> => b.type === 'resource',
    );
    const current = storedSessions.get(sessionId);

    if (first?.type === 'text') {
      current?.history.push({
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: first.text } },
      });
      if (current) current.info = { ...current.info, updatedAt: '2026-11-15T12:30:00Z' };
    }

    const text = async (value: string): Promise<void> => {
      const notification: SessionNotification = {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
      };
      current?.history.push(notification);
      await client.notify(methods.client.session.update, notification);
    };

    const notify = (update: SessionNotification['update']): Promise<void> =>
      client.notify(methods.client.session.update, { sessionId, update });

    if (command === 'inspect') {
      await text(
        JSON.stringify({
          argv,
          cwd,
          pid: process.pid,
          initialized,
          created,
          allCreated,
          listed,
          prompts,
          logoutRequests,
          lifecycleRequests: { new: newRequests, list: listed.length, load: loadRequests },
          systemPromptMeta: {
            initialize: extractSystemPrompt(initialized?._meta),
            sessionNew: extractSystemPrompt(created?._meta),
            prompt: extractSystemPrompt(params._meta),
          },
        }),
      );
    } else if (command === 'stream' || command === 'demo-stream') {
      const thoughtCount = Math.max(0, Number(process.env.AGY_E2E_THOUGHT_CHUNKS ?? '3') || 0);
      const streamCount = Math.max(1, Number(process.env.AGY_E2E_STREAM_CHUNKS ?? '10') || 10);
      const delayMs = Math.max(0, Number(process.env.AGY_E2E_STREAM_DELAY_MS ?? '0') || 0);

      for (let i = 1; i <= thoughtCount && !activeTurnCancelled; i += 1) {
        await notify({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `Thought step ${i}/${thoughtCount}. ` },
        });
        await sleepAbortable(delayMs);
      }
      for (let i = 1; i <= streamCount && !activeTurnCancelled; i += 1) {
        await text(`Stream chunk ${i}/${streamCount}. `);
        await sleepAbortable(delayMs);
      }
      return { stopReason: activeTurnCancelled ? 'cancelled' : 'end_turn' };
    } else if (command === '/help') {
      await text(`Local fixture commands: ${availableCommands.map(entry => `/${entry.name}`).join(', ')}`);
    } else if (command === '/model') {
      await text(`Local fixture model: ${configOptions.find(option => option.id === 'model')?.currentValue}`);
    } else if (command === '/usage') {
      usage = { size: 4_096, ...usage, used: 32 };
      await notify({ sessionUpdate: 'usage_update', ...usage });
      await text('Local fixture context: 32/4096 tokens (synthetic, not account quota).');
    } else if (command.startsWith('/echo ')) {
      await text(`Local fixture echo: ${command.slice('/echo '.length)}`);
    } else if (command === '/fixture-status') {
      await text(
        `Local fixture configuration: ${configOptions.map(option => `${option.id}=${option.currentValue}`).join(', ')}`,
      );
    } else if (command === '/fixture-refresh') {
      configOptions = configOptions
        .filter(option => option.id !== 'thought_level' && option.id !== 'mode')
        .map(option =>
          option.type === 'select'
            ? {
                ...option,
                currentValue: 'fixture-small',
                options: [{ value: 'fixture-small', name: 'Small synthetic model' }],
              }
            : option,
        );
      availableCommands = availableCommands.filter(entry => entry.name !== 'fixture-refresh');
      usage = { used: 42, size: 4_096, cost: { amount: 0.25, currency: 'fixture-credits' } };
      await notify({ sessionUpdate: 'config_option_update', configOptions });
      await notify({ sessionUpdate: 'available_commands_update', availableCommands });
      await notify({ sessionUpdate: 'usage_update', ...usage });
      await text('Local fixture metadata refreshed.');
    } else if (command === 'foreign-updates') {
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Foreign live text.' },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'foreign-tool',
          title: 'Foreign tool',
          kind: 'execute',
          status: 'in_progress',
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      });
      await text('Current-session updates only.');
    } else if (command === 'permission-rich') {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: 'e2e-perm-rich',
          kind: 'edit',
          name: 'edit_file',
          title: 'Modify protected config',
          locations: [{ path: join(cwd, 'config.json'), line: 4 }],
          content: [
            {
              type: 'diff',
              path: join(cwd, 'config.json'),
              oldText: '{"safe":true}\n',
              newText: '{"safe":false}\n',
            },
          ],
          rawInput: { path: join(cwd, 'config.json') },
        },
        options: [
          { optionId: 'srv-allow-1', name: 'Allow once (srv)', kind: 'allow_once' },
          { optionId: 'srv-always-1', name: 'Always allow (must be filtered)', kind: 'allow_always' },
          { optionId: 'srv-deny-1', name: 'Reject once (srv)', kind: 'reject_once' },
        ],
      });
      logMeta({
        event: 'permission_outcome',
        sessionId,
        toolCallId: 'e2e-perm-rich',
        outcome: response.outcome,
      });
      await text(JSON.stringify(response.outcome));
      if (response.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    } else if (command === 'permission-deny-only') {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: 'e2e-perm-deny-only', title: 'Deny-only tool', kind: 'execute' },
        options: [{ optionId: 'srv-deny-only', name: 'Reject only', kind: 'reject_once' }],
      });
      logMeta({
        event: 'permission_outcome',
        sessionId,
        toolCallId: 'e2e-perm-deny-only',
        outcome: response.outcome,
      });
      await text(JSON.stringify(response.outcome));
      if (response.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    } else if (
      command === 'permission' ||
      command === 'permission-twice' ||
      command === 'foreign-permission' ||
      command === 'stale-permission'
    ) {
      const count = command === 'permission-twice' ? 2 : 1;
      let stopReason: PromptResponse['stopReason'] = 'end_turn';
      for (let index = 0; index < count; index += 1) {
        const targetSessionId =
          command === 'foreign-permission'
            ? 'another-session'
            : command === 'stale-permission'
              ? previousSessionId
              : sessionId;
        const toolCallId = `fixture-tool-${index}`;
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId: targetSessionId,
          toolCall: { toolCallId, title: 'Run a local tool', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
          ],
        });
        logMeta({
          event: 'permission_outcome',
          sessionId: targetSessionId,
          toolCallId,
          outcome: response.outcome,
        });
        process.stderr.write(`${JSON.stringify({ permissionOutcome: response.outcome })}\n`);
        await text(JSON.stringify(response.outcome));
        if (response.outcome.outcome === 'cancelled') stopReason = 'cancelled';
      }
      return { stopReason };
    } else if (command === 'pending') {
      waitingPrompt = Promise.withResolvers<PromptResponse>();
      await text('ready');
      return waitingPrompt.promise;
    } else if (command === 'stubborn') {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 60_000);
      await text(JSON.stringify({ pid: process.pid }));
      return Promise.withResolvers<PromptResponse>().promise;
    } else if (command === 'exit') {
      process.exit(23);
    } else if (command === 'malformed-result') {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, result: {} })}\n`);
      return Promise.withResolvers<PromptResponse>().promise;
    } else if (command === 'bad-json') {
      process.stdout.write('{broken-json\n');
      return Promise.withResolvers<PromptResponse>().promise;
    } else if (command === 'unexpected-response') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 'unmatched', result: { stopReason: 'end_turn' } })}\n`,
      );
      return Promise.withResolvers<PromptResponse>().promise;
    } else if (command === 'rpc-error') {
      throw new RequestError(-32010, 'fixture prompt failed');
    } else if (command === 'auth-error') {
      throw RequestError.authRequired();
    } else if (command === 'stderr') {
      process.stderr.write('\u001b[31mfixture diagnostic\u001b[0m\n');
    } else if (command === 'mode-notify') {
      await notify({ sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' });
      await text('Mode updated via current_mode_update.');
    } else if (command === 'demo-rich') {
      await notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting workspace files before editing.' },
      });
      await notify({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect project configuration', priority: 'high', status: 'completed' },
          { content: 'Update UI diff renderer', priority: 'high', status: 'in_progress' },
          { content: 'Run unit tests', priority: 'medium', status: 'pending' },
        ],
      });
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-read',
        name: 'read_file',
        kind: 'read',
        title: 'Read 1 file',
        status: 'completed',
        locations: [{ path: join(cwd, 'package.json'), line: 1 }],
        rawInput: { path: join(cwd, 'package.json') },
      });
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-edit',
        name: 'edit_file',
        kind: 'edit',
        title: 'Edit ui.tsx',
        status: 'completed',
        locations: [{ path: join(cwd, 'src/ui.tsx'), line: 45 }],
        content: [
          {
            type: 'diff',
            path: join(cwd, 'src/ui.tsx'),
            oldText: 'function renderLegacy() {\n  return "plain";\n}\n',
            newText: 'function renderNative() {\n  return "tern-diff";\n}\n',
          },
        ],
      });
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-bash',
        name: 'execute',
        kind: 'execute',
        title: 'Run tests',
        status: 'completed',
        rawInput: { command: 'bun test' },
        rawOutput: { exitCode: 0, stdout: '125 pass\n0 fail' },
      });
      await notify({ sessionUpdate: 'usage_update', used: 1960, size: 4096 });
      await text('Updated `src/ui.tsx` with native diff rendering and verified tests pass.');
    } else if (command === 'demo-multi-loc') {
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'e2e-multi-loc',
        kind: 'search',
        name: 'grep_search',
        title: 'Search references',
        status: 'completed',
        locations: [
          { path: join(cwd, 'src/a.ts'), line: 10 },
          { path: join(cwd, 'src/b.ts'), line: 25 },
        ],
        rawInput: { query: 'connectAgent' },
      });
      await notify({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource_link',
          uri: `file://${join(cwd, 'README.md')}`,
          name: 'README.md',
          title: 'Project README',
          mimeType: 'text/markdown',
        },
      });
      await text('Found 2 matching locations and linked README.md.');
    } else if (command === 'demo-resource-link') {
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'e2e-res-link',
        kind: 'read',
        name: 'read_file',
        title: 'Inspect manifest resource',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'resource_link',
              uri: `file://${join(cwd, 'package.json')}`,
              name: 'package.json',
              title: 'Package manifest',
              mimeType: 'application/json',
            },
          },
        ],
      });
      await notify({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource_link',
          uri: `file://${join(cwd, 'package.json')}`,
          name: 'package.json',
          title: 'Package manifest',
          mimeType: 'application/json',
        },
      });
      await text('Attached resource link for package.json.');
    } else if (command === 'demo-large-diff') {
      const lineCount = 420;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (let i = 1; i <= lineCount; i += 1) {
        oldLines.push(`export const line_${i} = "old_value_${String(i).padStart(4, '0')}";`);
        newLines.push(
          i % 10 === 0
            ? `export const line_${i} = "new_value_${String(i).padStart(4, '0')}";`
            : `export const line_${i} = "old_value_${String(i).padStart(4, '0')}";`,
        );
      }
      const oldText = `${oldLines.join('\n')}\n`;
      const newText = `${newLines.join('\n')}\n`;
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'e2e-large-diff',
        kind: 'edit',
        name: 'edit_file',
        title: 'Large refactor diff',
        status: 'completed',
        locations: [{ path: join(cwd, 'big.ts'), line: 1 }],
        content: [{ type: 'diff', path: join(cwd, 'big.ts'), oldText, newText }],
      });
      await text(`Generated large diff (${oldText.length + newText.length} bytes).`);
    } else if (command === 'demo-tool-error') {
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'e2e-err-1',
        kind: 'execute',
        name: 'run_command',
        title: 'Failing command',
        status: 'in_progress',
        rawInput: { command: 'false' },
      });
      await notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e2e-err-1',
        status: 'failed',
        rawOutput: { exitCode: 1, stderr: 'Synthetic command failed with exit 1.\n' },
      });
      await text('Tool execution failed cleanly.');
    } else if (command === 'demo-compact') {
      await notify({
        sessionUpdate: 'compaction_update',
        compactionId: 'cmp-1',
        status: 'in_progress',
      });
      await notify({
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'cmp-1',
        content: { type: 'text', text: 'Summarized earlier turns.' },
      });
      await notify({
        sessionUpdate: 'compaction_update',
        compactionId: 'cmp-1',
        status: 'completed',
      });
      await notify({
        sessionUpdate: 'notice',
        severity: 'info',
        title: 'Context trimmed cleanly',
        description: 'Older turns summarized.',
      });
      await text('Compaction completed.');
    } else if (command === 'demo-compact-fail') {
      await notify({
        sessionUpdate: 'compaction_update',
        compactionId: 'cmp-err',
        status: 'failed',
        error: 'Compaction budget exceeded',
      });
      await notify({
        sessionUpdate: 'notice',
        severity: 'error',
        title: 'Compaction failed',
        description: 'Retry or start a new session.',
      });
      await text('Compaction failed.');
    } else if (command === 'demo-usage' || command.startsWith('usage:')) {
      let used = 3200;
      let size = 4096;
      if (command.startsWith('usage:')) {
        const [uStr, sStr] = command.slice('usage:'.length).split('/');
        const u = Number(uStr);
        const s = Number(sStr);
        if (Number.isFinite(u) && u >= 0) used = u;
        if (Number.isFinite(s) && s > 0) size = s;
      }
      usage = { used, size, cost: { amount: 0, currency: 'fixture-credits' } };
      await notify({ sessionUpdate: 'usage_update', used, size });
      await text(`Updated context usage to ${used}/${size}.`);
    } else if (command.startsWith('demo-media')) {
      const target = command.slice('demo-media'.length).trim() || 'docs/screenshots/serve/phase5-home-rich.png';
      const resolved = resolve(cwd, target);
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-shot-read',
        name: 'read_file',
        kind: 'read',
        title: 'Inspect live screenshot',
        status: 'completed',
        locations: [{ path: resolved }],
        rawInput: { path: resolved },
      });
      await text(`Inspected screenshot at \`${target}\` with centered live preview.`);
    } else if (command === 'demo-code') {
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-bash-1',
        name: 'run_command',
        kind: 'execute',
        title: 'Run typecheck',
        status: 'completed',
        rawInput: { command: 'bun run typecheck' },
        rawOutput: { exitCode: 0, stdout: '$ tsc --noEmit\nAll checks passed.\n' },
      });
      await text(
        [
          'Verify the workspace checks directly:',
          '',
          '```bash',
          'bun run typecheck && bun test',
          '```',
          '',
          'Example configuration helper:',
          '',
          '```ts',
          'export const ready = true;',
          '```',
        ].join('\n'),
      );
    } else if (images.length > 0 && resources.length > 0) {
      await text(`Synthetic fixture reply (${images.length} image, ${resources.length} resource): ${command}`);
    } else if (resources.length > 0) {
      await text(`Synthetic fixture reply (${resources.length} embedded resource): ${command}`);
    } else if (images.length > 0) {
      await text(
        `Synthetic fixture reply (${images.length} image: ${images.map(item => item.mimeType).join(',')}): ${command}`,
      );
    } else {
      await text(`Synthetic fixture reply: ${command}`);
    }

    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await connection.closed;
