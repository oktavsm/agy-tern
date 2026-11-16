#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AvailableCommand,
  type AuthMethod,
  type InitializeRequest,
  type ListSessionsRequest,
  type NewSessionRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionNotification,
  type UsageUpdate,
} from '@agentclientprotocol/sdk';

let sessionId = 'fixture-session';
let previousSessionId = '';
let newRequests = 0;
let loadRequests = 0;
const listed: ListSessionsRequest[] = [];
let logoutRequests = 0;
const scenario = basename(process.cwd());
const syntheticLogin = scenario.startsWith('agy-tern-SYNTHETIC-login-');
const syntheticSwitch = scenario.startsWith('agy-tern-SYNTHETIC-switch-');
const syntheticWorkspace = (syntheticLogin || syntheticSwitch) && dirname(process.cwd()) === resolve(tmpdir());
const loginMarker = join(process.cwd(), '.SYNTHETIC-fixture-login');
const logoutMarker = join(process.cwd(), '.SYNTHETIC-fixture-logout');
let initialized: InitializeRequest | undefined;
let created: NewSessionRequest | undefined;
let waitingPrompt: PromiseWithResolvers<PromptResponse> | undefined;

if (process.argv.includes('--login')) {
  if (syntheticWorkspace && (scenario.startsWith('agy-tern-SYNTHETIC-login-wait-') || scenario.startsWith('agy-tern-SYNTHETIC-switch-wait-'))) {
    process.once('SIGINT', () => process.exit(130));
    process.stdin.resume();
    console.log('SYNTHETIC_LOGIN_WAIT: Ctrl+C cancels this fake login; no real account is accessed.');
    await Promise.withResolvers<void>().promise;
  }
  if (syntheticWorkspace && scenario.startsWith('agy-tern-SYNTHETIC-login-fail-')) {
    console.error('Synthetic login failure; no real account was accessed.');
    process.exit(17);
  }
  if (syntheticWorkspace) await writeFile(loginMarker, 'SYNTHETIC fixture login only\n');
  console.log('Synthetic terminal login complete. No real account was accessed.');
  process.exit(0);
}

if (process.argv.includes('--print')) {
  const command = process.argv[process.argv.indexOf('--print') + 1];
  if (scenario.startsWith('agy-tern-report-error-')) {
    process.stderr.write('Synthetic CLI report error\\n');
    process.exit(12);
  }
  if (command === '/usage') console.log('Synthetic account quota\tWeekly limit\t75%\t2026-11-21T00:00:00Z');
  else if (command === '/credits') console.log('## Synthetic account credits\\n\\nLocal fixture balance: 10 fixture-credits.');
  else if (command === '/changelog') console.log('## Synthetic release notes\\n\\nLocal fixture command panels.');
  else process.exit(2);
  process.exit(0);
}

if (process.argv[2] === 'mcp' && process.argv[3] === 'list') {
  console.log('NAME        TYPE   STATUS    COMMAND/URL');
  console.log('fetch       stdio  enabled   uvx mcp-server-fetch');
  console.log('playwright  stdio  enabled   npx -y @playwright/mcp@latest');
  console.log('browser-alt  stdio     disabled  npx -y @synthetic/browser-alt');
  process.exit(0);
}
if (process.argv[2] === 'mcp' && (process.argv[3] === 'add' || process.argv[3] === 'remove' || process.argv[3] === 'enable' || process.argv[3] === 'disable')) {
  process.exit(0);
}
if (process.argv[2] === 'plugin' && process.argv[3] === 'list') {
  console.log(JSON.stringify([
    { name: 'antislop', enabled: true, version: '3.2.4', source: 'antigravity', path: '/fixture/plugins/antislop', skills: ['antislop', 'antislop-ui', 'antislop-code'], rules: ['antislop.md'] },
    { name: 'ux-ui-agent-skills', enabled: true, version: '2.10.0', source: 'claude-code', path: '/fixture/plugins/ux-ui', skills: ['design-screen', 'a11y-audit', 'design-tokens'], rules: ['AGENTS.md'] },
    { name: 'android-cli-plugin', enabled: false, version: '1.0.0', source: 'antigravity', path: '/fixture/plugins/android', skills: ['android-cli'], rules: [] },
  ]));
  process.exit(0);
}
if (process.argv[2] === 'plugin' && process.argv[3] === 'validate') {
  console.log(JSON.stringify({
    dir: process.argv[4] ?? '/fixture/plugins/antislop',
    manifest: '.claude-plugin/plugin.json',
    name: 'antislop',
    components: { skills: 3, rules: 1 },
    findings: [
      { severity: 'info', file: 'SKILL.md', message: 'Synthetic validation passed with 1 informational note.' },
    ],
  }));
  process.exit(0);
}
if (process.argv[2] === 'plugin' && (process.argv[3] === 'install' || process.argv[3] === 'uninstall' || process.argv[3] === 'enable' || process.argv[3] === 'disable')) {
  process.exit(0);
}
if (process.argv[2] === 'agent') {
  console.log('NAME       DESCRIPTION');
  console.log('reviewer   Strict synthetic code & diff auditor');
  console.log('explorer   Fast codebase search specialist');
  process.exit(0);
}
// Synthetic metadata for local protocol tests, not captured account or server data.
let configOptions: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fixture-small',
    options: [{
      group: 'fixture-family',
      name: 'Local fixture models',
      options: [
        { value: 'fixture-small', name: 'Small synthetic model' },
        { value: 'fixture-large', name: 'Large synthetic model' },
        { value: 'fixture-rejected', name: 'Rejected synthetic model' },
      ],
    }],
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
let availableCommands: AvailableCommand[] = [
  { name: 'help', description: 'List local fixture commands' },
  { name: 'model', description: 'Show the selected synthetic model' },
  { name: 'usage', description: 'Show synthetic context usage, not account quota' },
  { name: 'echo', description: 'Repeat local fixture input', input: { hint: 'text to repeat' } },
  { name: 'fixture-status', description: 'Show the local fixture configuration' },
  { name: 'fixture-refresh', description: 'Replace synthetic metadata for local protocol tests' },
];
let usage: UsageUpdate | undefined = { used: 16, size: 4_096, cost: { amount: 0, currency: 'fixture-credits' } };

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

const storedSessions = new Map<string, FixtureSession>([
  ['fixture-planning', {
    info: { sessionId: 'fixture-planning', cwd: process.cwd(), title: 'Synthetic planning history', updatedAt: '2026-11-14T10:00:00Z' },
    configOptions: configOptions.filter((option) => option.id === 'model').map((option) => option.type === 'select'
      ? { ...option, currentValue: 'fixture-large' }
      : option),
    availableCommands: [{ name: 'echo', description: 'Repeat local fixture input', input: { hint: 'text to repeat' } }],
    usage: { used: 64, size: 4_096 },
    history: syntheticHistory('fixture-planning', 'Plan a synthetic workspace review.', 'Synthetic plan: inspect the workspace, then review the changes.'),
  }],
  ['fixture-review', {
    info: { sessionId: 'fixture-review', cwd: process.cwd(), title: 'Synthetic empty review', updatedAt: '2026-11-13T09:00:00Z' },
    configOptions: [],
    availableCommands: [],
    history: [],
  }],
]);

function rememberCurrentSession(): void {
  const current = storedSessions.get(sessionId);
  if (!current) return;
  current.configOptions = configOptions;
  current.availableCommands = availableCommands;
  current.usage = usage;
}

async function waitForSwitch(): Promise<void> {
  if (!scenario.startsWith('agy-tern-switch-wait-')) return;
  const released = Promise.withResolvers<void>();
  process.once('SIGUSR1', () => released.resolve());
  process.stderr.write('lifecycle-pending\n');
  await released.promise;
}

const authMethods: AuthMethod[] = scenario.startsWith('agy-tern-unsupported-auth-')
  ? [{ id: 'fixture-protocol-login', name: 'Synthetic protocol login' }]
  : [
    { id: 'terminal-login', name: 'Log in from the terminal', type: 'terminal', args: ['--login'] },
    { id: 'fixture-protocol-login', name: 'Synthetic protocol login' },
  ];

const connection = agent({ name: 'local-protocol-fixture' })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    initialized = params;
    if (scenario.startsWith('agy-tern-init-wait-')) {
      process.stderr.write('waiting-initialize\n');
      await Promise.withResolvers<void>().promise;
    }
    return {
      protocolVersion: scenario.startsWith('agy-tern-version-') ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
      authMethods: scenario.startsWith('agy-tern-missing-auth-methods-') ? undefined : authMethods,
      agentCapabilities: {
        ...(scenario.startsWith('agy-tern-unsupported-sessions-') ? {} : {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {}, additionalDirectories: {} },
        }),
        ...(scenario.startsWith('agy-tern-unsupported-auth-') ? {} : { auth: { logout: {} } }),
        promptCapabilities: scenario.startsWith('agy-tern-no-images-')
          ? { image: false, embeddedContext: false }
          : { image: true, embeddedContext: true },
      },
      agentInfo: { name: 'local-protocol-fixture', version: '1' },
    };
  })
  .onRequest(methods.agent.logout, async ({ client }) => {
    logoutRequests++;
    if (scenario.startsWith('agy-tern-logout-rejected-')) throw new RequestError(-32010, 'fixture logout rejected');
    if (scenario.startsWith('agy-tern-logout-wait-')) {
      const released = Promise.withResolvers<void>();
      process.once('SIGUSR1', () => released.resolve());
      process.stderr.write('logout-pending\n');
      await released.promise;
    }
    if (syntheticWorkspace) {
      await rm(loginMarker, { force: true });
      await writeFile(logoutMarker, 'SYNTHETIC fixture logout only\n');
    }
    if (scenario.startsWith('agy-tern-logout-permission-')) {
      const requestPermission = async (): Promise<void> => {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: 'logout-stale-tool', title: 'Synthetic stale logout tool', kind: 'execute' },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        });
        process.stderr.write(`${JSON.stringify({ logoutPermissionOutcome: response.outcome })}\n`);
      };
      await requestPermission();
      process.once('SIGUSR1', () => { void requestPermission(); });
    }
    return {};
  })
  .onRequest(methods.agent.session.new, async ({ params, client }) => {
    created = params;
    newRequests++;
    if (scenario.startsWith('agy-tern-auth-') || (
      syntheticWorkspace && !existsSync(loginMarker) && (syntheticLogin || existsSync(logoutMarker))
    )) throw RequestError.authRequired();
    if (scenario.startsWith('agy-tern-startup-exit-')) process.exit(24);
    if (scenario.startsWith('agy-tern-new-wait-')) {
      process.stderr.write('waiting-session-new\n');
      await Promise.withResolvers<void>().promise;
    }
    if (newRequests > 1) {
      await waitForSwitch();
      const targetId = `fixture-session-${newRequests}`;
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign new-session update.' } },
      });
      await client.notify(methods.client.session.update, {
        sessionId: targetId,
        update: { sessionUpdate: 'session_info_update', title: `Synthetic new session ${newRequests}`, updatedAt: '2026-11-15T12:00:00Z' },
      });
      if (scenario.startsWith('agy-tern-new-rejected-')) {
        await client.notify(methods.client.session.update, {
          sessionId: targetId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Uncommitted new-session text.' } },
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
        info: { sessionId, cwd: params.cwd, title: `Synthetic new session ${newRequests}`, updatedAt: '2026-11-15T12:00:00Z' },
        configOptions, availableCommands, history: [],
      });
      return { sessionId };
    }
    storedSessions.set(sessionId, {
      info: { sessionId, cwd: params.cwd, title: 'Synthetic current session', updatedAt: '2026-11-15T11:00:00Z' },
      configOptions, availableCommands, usage, history: [],
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
    if (scenario.startsWith('agy-tern-early-content-')) {
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign startup text.' } },
      });
      for (const notification of syntheticHistory(sessionId, 'Synthetic startup history.', 'Synthetic startup reply.')) {
        await client.notify(methods.client.session.update, notification);
      }
    }
    if (scenario.startsWith('agy-tern-early-config-')) {
      configOptions = configOptions.map((option) => option.id === 'reports' && option.type === 'boolean'
        ? { ...option, currentValue: true }
        : option);
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
      _meta: { antigravity: { tier: { name: 'Synthetic Pro', id: 'synthetic-pro' } } },
    };
  })
  .onRequest(methods.agent.session.list, ({ params }) => {
    listed.push(params);
    const foreign = { sessionId: 'foreign-workspace', cwd: join(process.cwd(), 'nested'), title: 'Synthetic other workspace' };
    if (scenario.startsWith('agy-tern-list-pages-')) {
      if (params.cursor === undefined) return { sessions: [foreign], nextCursor: 'matching-page' };
      if (params.cursor !== 'matching-page') throw new RequestError(-32602, 'fixture cursor not found');
      return {
        sessions: [
          { ...storedSessions.get('fixture-planning')!.info, cwd: `${process.cwd()}/nested/..` },
          storedSessions.get('fixture-review')!.info,
          foreign,
        ],
      };
    }
    const entries = [...storedSessions.values()].map((entry) => entry.info);
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RequestError(-32602, 'fixture cursor not found');
    const page = entries.slice(offset, offset + 2);
    return { sessions: page, ...(offset + 2 < entries.length ? { nextCursor: String(offset + 2) } : {}) };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    loadRequests++;
    await waitForSwitch();
    if (params.sessionId === 'fixture-rejected') {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Uncommitted load text.' } },
      });
      throw new RequestError(-32010, 'fixture session load rejected');
    }
    rememberCurrentSession();
    const target = storedSessions.get(params.sessionId);
    if (!target || params.cwd !== process.cwd()) throw new RequestError(-32602, 'fixture session not found');
    await client.notify(methods.client.session.update, {
      sessionId: 'another-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign replay text.' } },
    });
    for (const notification of target.history) await client.notify(methods.client.session.update, notification);
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
      update: { sessionUpdate: 'session_info_update', title: target.info.title, updatedAt: target.info.updatedAt },
    });
    if (scenario.startsWith('agy-tern-load-permission-')) {
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
      ...(params.sessionId === 'fixture-planning' ? { _meta: { antigravity: { tier: { name: 'Synthetic Pro', id: 'synthetic-pro' } } } } : {}),
    };
  })
  .onRequest(methods.agent.session.resume, async ({ params }) => {
    rememberCurrentSession();
    const target = storedSessions.get(params.sessionId);
    if (!target || params.cwd !== process.cwd()) throw new RequestError(-32602, 'fixture session not found');
    previousSessionId = sessionId;
    sessionId = params.sessionId;
    configOptions = target.configOptions;
    availableCommands = target.availableCommands;
    usage = target.usage;
    return { configOptions };
  })
  .onRequest(methods.agent.session.close, async ({ params }) => {
    if (!storedSessions.has(params.sessionId)) throw new RequestError(-32602, 'fixture session not found');
    storedSessions.delete(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const option = configOptions.find((candidate) => candidate.id === params.configId);
    if (!option || params.sessionId !== sessionId) throw new RequestError(-32602, 'fixture config option not found');
    if (params.value === 'fixture-rejected') throw new RequestError(-32010, 'fixture config selection rejected');
    let updated: SessionConfigOption;
    if (option.type === 'boolean' && typeof params.value === 'boolean' && 'type' in params && params.type === 'boolean') {
      updated = { ...option, currentValue: params.value };
    } else if (option.type === 'select' && typeof params.value === 'string' && option.options.some((entry) => (
      'options' in entry
        ? entry.options.some((candidate) => candidate.value === params.value)
        : entry.value === params.value
    ))) {
      updated = { ...option, currentValue: params.value };
    } else {
      throw new RequestError(-32602, 'fixture config value is invalid');
    }
    if (scenario.startsWith('agy-tern-config-wait-')) {
      const released = Promise.withResolvers<void>();
      process.once('SIGUSR1', () => released.resolve());
      process.stderr.write('configuration-pending\n');
      await released.promise;
    }
    configOptions = configOptions.map((candidate) => {
      if (candidate.id === params.configId) return updated;
      if (params.configId === 'model' && params.value === 'fixture-large' && candidate.id === 'thought_level' && candidate.type === 'select') {
        return { ...candidate, currentValue: 'high' };
      }
      return candidate;
    });
    return { configOptions };
  })
  .onNotification(methods.agent.session.cancel, () => {
    waitingPrompt?.resolve({ stopReason: 'cancelled' });
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client, requestId }) => {
    const first = params.prompt[0];
    if (params.sessionId !== sessionId) throw new RequestError(-32602, 'fixture prompt session not found');
    const command = first?.type === 'text' ? first.text : '';
    const images = params.prompt.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image');
    const resources = params.prompt.filter((block): block is Extract<typeof block, { type: 'resource' }> => block.type === 'resource');
    const current = storedSessions.get(sessionId);
    if (first?.type === 'text') {
      current?.history.push({
        sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: first.text } },
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
    if (command === 'inspect') {
      await text(JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        pid: process.pid,
        initialized,
        created,
        listed,
        logoutRequests,
        lifecycleRequests: { new: newRequests, list: listed.length, load: loadRequests },
      }));
    } else if (command === '/help') {
      await text(`Local fixture commands: ${availableCommands.map((entry) => `/${entry.name}`).join(', ')}`);
    } else if (command === '/model') {
      await text(`Local fixture model: ${configOptions.find((option) => option.id === 'model')?.currentValue}`);
    } else if (command === '/usage') {
      usage = { size: 4_096, ...usage, used: 32 };
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'usage_update', ...usage },
      });
      await text('Local fixture context: 32/4096 tokens (synthetic, not account quota).');
    } else if (command.startsWith('/echo ')) {
      await text(`Local fixture echo: ${command.slice('/echo '.length)}`);
    } else if (command === '/fixture-status') {
      await text(`Local fixture configuration: ${configOptions.map((option) => `${option.id}=${option.currentValue}`).join(', ')}`);
    } else if (command === '/fixture-refresh') {
      configOptions = configOptions.filter((option) => option.id !== 'thought_level' && option.id !== 'mode').map((option) => option.type === 'select'
        ? { ...option, currentValue: 'fixture-small', options: [{ value: 'fixture-small', name: 'Small synthetic model' }] }
        : option);
      availableCommands = availableCommands.filter((entry) => entry.name !== 'fixture-refresh');
      usage = { used: 42, size: 4_096, cost: { amount: 0.25, currency: 'fixture-credits' } };
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'usage_update', ...usage },
      });
      await text('Local fixture metadata refreshed.');
    } else if (command === 'foreign-updates') {
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign live text.' } },
      });
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'tool_call', toolCallId: 'foreign-tool', title: 'Foreign tool', kind: 'execute', status: 'in_progress' },
      });
      await client.notify(methods.client.session.update, {
        sessionId: 'another-session',
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      });
      await text('Current-session updates only.');
    } else if (command === 'permission' || command === 'permission-twice' || command === 'foreign-permission' || command === 'stale-permission') {
      const count = command === 'permission-twice' ? 2 : 1;
      let stopReason: PromptResponse['stopReason'] = 'end_turn';
      for (let index = 0; index < count; index++) {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId: command === 'foreign-permission' ? 'another-session' : command === 'stale-permission' ? previousSessionId : sessionId,
          toolCall: { toolCallId: `fixture-tool-${index}`, title: 'Run a local tool', kind: 'execute' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
          ],
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
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'unmatched', result: { stopReason: 'end_turn' } })}\n`);
      return Promise.withResolvers<PromptResponse>().promise;
    } else if (command === 'rpc-error') {
      throw new RequestError(-32010, 'fixture prompt failed');
    } else if (command === 'auth-error') {
      throw RequestError.authRequired();
    } else if (command === 'stderr') {
      process.stderr.write('\u001b[31mfixture diagnostic\u001b[0m\n');
    } else if (command === 'demo-rich') {
      const notify = (update: SessionNotification['update']) => client.notify(methods.client.session.update, { sessionId, update });
      await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting workspace files before editing.' } });
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
        locations: [{ path: join(process.cwd(), 'package.json'), line: 1 }],
        rawInput: { path: join(process.cwd(), 'package.json') },
      });
      await notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'demo-edit',
        name: 'edit_file',
        kind: 'edit',
        title: 'Edit ui.tsx',
        status: 'completed',
        locations: [{ path: join(process.cwd(), 'src/ui.tsx'), line: 45 }],
        content: [{
          type: 'diff',
          path: join(process.cwd(), 'src/ui.tsx'),
          oldText: 'function renderLegacy() {\n  return "plain";\n}\n',
          newText: 'function renderNative() {\n  return "tern-diff";\n}\n',
        }],
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
      await notify({
        sessionUpdate: 'usage_update',
        used: 1960,
        size: 4096,
      });
      await text('Updated `src/ui.tsx` with native diff rendering and verified tests pass.');
    } else if (command.startsWith('demo-media')) {
      const target = command.slice('demo-media'.length).trim() || 'docs/screenshots/serve/phase5-home-rich.png';
      const resolved = resolve(process.cwd(), target);
      const notify = (update: SessionNotification['update']) => client.notify(methods.client.session.update, { sessionId, update });
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
    } else if (command === 'demo-slow') {
      await new Promise(done => setTimeout(done, 1_500));
      await text('Slow synthetic turn finished cleanly.');
    } else if (command === 'mode-notify') {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' },
      });
      await text('Mode updated via current_mode_update.');
    } else if (command === 'demo-compact') {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'in_progress' },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'Summarized prior tool calls and diff state.' } },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed' },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'notice', severity: 'info', title: 'Context trimmed cleanly' },
      });
      await text('Compaction completed.');
    } else if (command === 'demo-code') {
      const notify = (update: SessionNotification['update']) => client.notify(methods.client.session.update, { sessionId, update });
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
      await text([
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
      ].join('\n'));
    } else if (images.length > 0 && resources.length > 0) {
      await text(`Synthetic fixture reply (${images.length} image, ${resources.length} resource): ${command}`);
    } else if (resources.length > 0) {
      await text(`Synthetic fixture reply (${resources.length} embedded resource): ${command}`);
    } else if (images.length > 0) {
      await text(`Synthetic fixture reply (${images.length} image: ${images.map((item) => item.mimeType).join(',')}): ${command}`);
    } else {
      await text(`Synthetic fixture reply: ${command}`);
    }
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await connection.closed;
