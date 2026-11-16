import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { connectAgent } from '../src/agent';
import type { AgentAuthentication, AgentEvents, AgentMetadata, AgentSession, PermissionPrompt } from '../src/contracts';

const fixture = fileURLToPath(new URL('./fixtures/agent.ts', import.meta.url));
const sessions: AgentSession[] = [];
const workspaces: string[] = [];

interface Inbox<T> {
  push(value: T): void;
  next(): Promise<T>;
}

interface Observer {
  events: AgentEvents;
  updates: Inbox<SessionNotification>;
  metadata: Inbox<AgentMetadata>;
  permissions: Inbox<PermissionPrompt>;
  diagnostics: Inbox<string>;
  disconnected: Inbox<string>;
  seenPermissions: PermissionPrompt[];
  seenUpdates: SessionNotification[];
  changedSessions: string[];
  seenMetadata: AgentMetadata[];
  seenAuthentication: AgentAuthentication[];
}

function inbox<T>(): Inbox<T> {
  const values: T[] = [];
  const readers: Array<(value: T) => void> = [];
  return {
    push(value: T): void {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    next(): Promise<T> {
      if (values.length) return Promise.resolve(values.shift()!);
      const pending = Promise.withResolvers<T>();
      readers.push(pending.resolve);
      return pending.promise;
    },
  };
}

function observer(): Observer {
  const updates = inbox<SessionNotification>();
  const metadata = inbox<AgentMetadata>();
  const permissions = inbox<PermissionPrompt>();
  const diagnostics = inbox<string>();
  const disconnected = inbox<string>();
  const seenPermissions: PermissionPrompt[] = [];
  const seenUpdates: SessionNotification[] = [];
  const changedSessions: string[] = [];
  const seenMetadata: AgentMetadata[] = [];
  const seenAuthentication: AgentAuthentication[] = [];
  const events: AgentEvents = {
    update(notification) {
      seenUpdates.push(notification);
      updates.push(notification);
    },
    sessionChanged: (sessionId) => changedSessions.push(sessionId),
    authentication: (value) => seenAuthentication.push(value),
    metadata(value) {
      seenMetadata.push(value);
      metadata.push(value);
    },
    permission(prompt) {
      seenPermissions.push(prompt);
      permissions.push(prompt);
    },
    diagnostic: diagnostics.push,
    disconnected: disconnected.push,
  };
  return { events, updates, metadata, permissions, diagnostics, disconnected, seenPermissions, seenMetadata, seenUpdates, changedSessions, seenAuthentication };
}


async function workspace(scenario = 'normal'): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `agy-tern-${scenario}-`));
  workspaces.push(cwd);
  return cwd;
}

async function open(observed: Observer, scenario = 'normal', signal?: AbortSignal): Promise<AgentSession> {
  const session = await connectAgent({ cwd: await workspace(scenario), executable: fixture, signal }, observed.events);
  sessions.push(session);
  return session;
}

async function nextText(observed: Observer): Promise<string> {
  while (true) {
    const notification = await observed.updates.next();
    const update = notification.update;
    if (update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'config_option_update' ||
      update.sessionUpdate === 'current_mode_update' || update.sessionUpdate === 'usage_update') {
      continue;
    }
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text') {
      throw new Error('Fixture sent an unexpected session update.');
    }
    return update.content.text;
  }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

describe('official ACP subprocess boundary', () => {
  test('advertises terminal auth separately from execution terminals and exposes only advertised terminal methods', async () => {
    const observed = observer();
    const session = await open(observed);
    expect(session.authentication.terminalMethods.map(({ id, args }) => ({ id, args }))).toEqual([
      { id: 'terminal-login', args: ['--login'] },
    ]);
    expect(session.authentication.logout).toBe(true);
    await session.prompt('inspect');
    expect(JSON.parse(await nextText(observed)).initialized.clientCapabilities).toMatchObject({
      auth: { terminal: true }, terminal: false,
    });
  });

  test('does not synthesize terminal login when the agent omits auth methods', async () => {
    const session = await open(observer(), 'missing-auth-methods');
    expect(session.authentication).toEqual({ terminalMethods: [], logout: true });
  });

  test('rejects unadvertised logout without sending an RPC or inventing a terminal method', async () => {
    const observed = observer();
    const session = await open(observed, 'unsupported-auth');
    expect(session.authentication).toEqual({ terminalMethods: [], logout: false });
    await expect(session.logout()).rejects.toThrow('does not support logout');
    await session.prompt('inspect');
    expect(JSON.parse(await nextText(observed)).logoutRequests).toBe(0);
  });

  test('logs out once, clears metadata, rejects all further session work and cancels stale approvals', async () => {
    const observed = observer();
    const session = await open(observed, 'logout-permission');
    await session.prompt('inspect');
    const { pid } = JSON.parse(await nextText(observed));
    const turn = session.prompt('permission');
    const permission = await observed.permissions.next();
    await expect(session.logout()).rejects.toThrow('prompt is already running');
    await session.cancel();
    expect(await turn).toBe('cancelled');
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ permissionOutcome: { outcome: 'cancelled' } });
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'cancelled' });
    await session.logout();
    permission.answer('allow-once');
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ logoutPermissionOutcome: { outcome: 'cancelled' } });
    process.kill(pid, 'SIGUSR1');
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ logoutPermissionOutcome: { outcome: 'cancelled' } });
    expect(observed.seenPermissions).toHaveLength(1);
    expect(session.sessionId).toBe('');
    expect(session.metadata).toEqual({ configOptions: [], availableCommands: [] });
    expect(observed.seenMetadata.at(-1)).toBe(session.metadata);
    for (const operation of [
      () => session.prompt('inspect'),
      () => session.setConfigOption('model', 'fixture-large'),
      () => session.newSession(),
      () => session.loadSession('fixture-planning'),
      () => session.listSessions(),
      () => session.cancel(),
      () => session.logout(),
    ]) {
      await expect(operation()).rejects.toThrow('logged out');
    }
    await session.close();
  });

  test('retains a usable session and its metadata when official logout is rejected', async () => {
    const observed = observer();
    const session = await open(observed, 'logout-rejected');
    const metadata = session.metadata;
    const eventCount = observed.seenMetadata.length;
    await expect(session.logout()).rejects.toThrow('fixture logout rejected');
    expect(session.sessionId).toBe('fixture-session');
    expect(session.metadata).toBe(metadata);
    expect(observed.seenMetadata).toHaveLength(eventCount);
    await session.setConfigOption('model', 'fixture-large');
    expect(await session.prompt('/model')).toBe('end_turn');
    expect(await nextText(observed)).toBe('Local fixture model: fixture-large');
    await session.newSession();
    await session.loadSession('fixture-planning');
    const updateCursor = observed.seenUpdates.length;
    expect(await session.prompt('/model')).toBe('end_turn');
    const reply = observed.seenUpdates.slice(updateCursor).flatMap(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []).join('');
    expect(reply).toBe('Local fixture model: fixture-large');
  });

  test('reserves the lifecycle while logout is pending and blocks overlapping operations', async () => {
    const observed = observer();
    const session = await open(observed, 'logout-wait');
    await session.prompt('inspect');
    const { pid } = JSON.parse(await nextText(observed));
    const metadata = session.metadata;
    const loggingOut = session.logout();
    expect(await observed.diagnostics.next()).toBe('logout-pending\n');
    expect(session.metadata).toBe(metadata);
    for (const operation of [
      () => session.prompt('inspect'),
      () => session.setConfigOption('model', 'fixture-large'),
      () => session.newSession(),
      () => session.loadSession('fixture-planning'),
      () => session.listSessions(),
      () => session.cancel(),
      () => session.logout(),
    ]) {
      await expect(operation()).rejects.toThrow('lifecycle operation is already running');
    }
    process.kill(pid, 'SIGUSR1');
    await loggingOut;
    expect(session.metadata).toEqual({ configOptions: [], availableCommands: [] });
  });

  test('abort settles a pending official logout and reaps its subprocess', async () => {
    const observed = observer();
    const controller = new AbortController();
    const session = await open(observed, 'logout-wait', controller.signal);
    await session.prompt('inspect');
    const { pid } = JSON.parse(await nextText(observed));
    const result = session.logout().then(() => undefined, (cause: unknown) => cause);
    expect(await observed.diagnostics.next()).toBe('logout-pending\n');
    controller.abort(new Error('stop logout'));
    expect(await result).toMatchObject({ message: 'stop logout' });
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  for (const scenario of ['SYNTHETIC-login', 'SYNTHETIC-switch']) {
    test(`${scenario} persists only synthetic auth state across official login and fresh transport`, async () => {
      const cwd = await workspace(scenario);
      const observed = observer();
      if (scenario === 'SYNTHETIC-login') {
        await expect(connectAgent({ cwd, executable: fixture }, observed.events)).rejects.toThrow('agy acp --login');
        expect(observed.seenAuthentication).toHaveLength(1);
      } else {
        const first = await connectAgent({ cwd, executable: fixture }, observed.events);
        sessions.push(first);
        await first.logout();
        await first.close();
        await expect(connectAgent({ cwd, executable: fixture }, observer().events)).rejects.toThrow('agy acp --login');
      }
      const login = Bun.spawn([fixture, 'acp', '--sandbox', '--login'], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      expect(await login.exited).toBe(0);
      expect(await new Response(login.stdout).text()).toContain('Synthetic terminal login complete.');
      const fresh = observer();
      const connected = await connectAgent({ cwd, executable: fixture }, fresh.events);
      sessions.push(connected);
      expect(await connected.prompt('/echo authenticated synthetic handoff')).toBe('end_turn');
      expect(await nextText(fresh)).toBe('Local fixture echo: authenticated synthetic handoff');
    });
  }

  test('filters every list page to normalized workspace paths without losing an empty page cursor', async () => {
    const observed = observer();
    const session = await open(observed, 'list-pages');
    expect(session.capabilities).toEqual({
      listSessions: true,
      loadSession: true,
      resumeSession: true,
      closeSession: true,
      additionalDirectories: true,
    });
    const first = await session.listSessions();
    expect(first.sessions).toEqual([]);
    expect(first.nextCursor).toBe('matching-page');
    const second = await session.listSessions(first.nextCursor!);
    expect(second.sessions.map((entry) => entry.sessionId)).toEqual(['fixture-planning', 'fixture-review']);
    expect(second.sessions[0]).toMatchObject({ title: 'Synthetic planning history', updatedAt: '2026-11-14T10:00:00Z' });
    expect(second.nextCursor).toBeUndefined();
    await session.prompt('inspect');
    const inspected = JSON.parse(await nextText(observed));
    expect(inspected.listed).toEqual([
      { cwd: inspected.cwd },
      { cwd: inspected.cwd, cursor: 'matching-page' },
    ]);
  });

  test('changes the advertised session mode through configuration without prompting', async () => {
    const observed = observer();
    const session = await open(observed);
    expect(session.metadata.configOptions.find((option) => option.id === 'mode')).toMatchObject({
      category: 'mode', currentValue: 'default',
    });
    const updateCount = observed.seenUpdates.length;
    await session.setConfigOption('mode', 'plan');
    expect(session.metadata.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
    expect(observed.seenUpdates).toHaveLength(updateCount);
    await session.setConfigOption('mode', 'default');
    expect(session.metadata.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe('default');
  });

  test('loads an empty saved session without inventing replayed transcript content', async () => {
    const observed = observer();
    const session = await open(observed);
    const start = observed.seenUpdates.length;
    await session.loadSession('fixture-review');
    expect(session.sessionId).toBe('fixture-review');
    expect(observed.seenUpdates.slice(start)).toEqual([{
      sessionId: 'fixture-review',
      update: { sessionUpdate: 'session_info_update', title: 'Synthetic empty review', updatedAt: '2026-11-13T09:00:00Z' },
    }]);
    expect(session.metadata).toEqual({ configOptions: [], availableCommands: [] });
  });

  test('buffers unknown startup ids and publishes only the created session after sessionChanged', async () => {
    const observed = observer();
    const update = observed.events.update;
    observed.events.update = (notification) => {
      expect(observed.changedSessions.at(-1)).toBe(notification.sessionId);
      update(notification);
    };
    const session = await open(observed, 'early-content');
    expect(session.sessionId).toBe('fixture-session');
    expect(observed.seenUpdates.every((notification) => notification.sessionId === session.sessionId)).toBe(true);
    expect(observed.seenUpdates.map((notification) => notification.update)).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Synthetic startup reply.' },
    });
  });

  test('stages replay when reloading the current id and preserves its latest configuration and history', async () => {
    const observed = observer();
    const session = await open(observed);
    await session.setConfigOption('model', 'fixture-large');
    await session.prompt('/echo remembered');
    const start = observed.seenUpdates.length;
    const changed = observed.events.sessionChanged!;
    const update = observed.events.update;
    const order: string[] = [];
    observed.events.sessionChanged = (sessionId) => {
      order.push('changed');
      changed(sessionId);
    };
    observed.events.update = (notification) => {
      order.push(notification.update.sessionUpdate);
      update(notification);
    };
    await session.loadSession(session.sessionId);
    expect(order[0]).toBe('changed');
    expect(session.metadata.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-large');
    expect(observed.seenUpdates.slice(start, start + 2)).toEqual([
      {
        sessionId: 'fixture-session',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/echo remembered' } },
      },
      {
        sessionId: 'fixture-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Local fixture echo: remembered' } },
      },
    ]);
  });

  test('announces the loaded session before replaying only its history and metadata', async () => {
    const observed = observer();
    const order: string[] = [];
    const changed = observed.events.sessionChanged!;
    const update = observed.events.update;
    observed.events.sessionChanged = (sessionId) => {
      order.push(`changed:${sessionId}`);
      changed(sessionId);
    };
    observed.events.update = (notification) => {
      order.push(`${notification.sessionId}:${notification.update.sessionUpdate}`);
      update(notification);
    };
    const session = await open(observed);
    order.length = 0;
    const start = observed.seenUpdates.length;
    await session.loadSession('fixture-planning');
    expect(session.sessionId).toBe('fixture-planning');
    expect(order).toEqual([
      'changed:fixture-planning',
      'fixture-planning:user_message_chunk',
      'fixture-planning:agent_message_chunk',
      'fixture-planning:available_commands_update',
      'fixture-planning:usage_update',
      'fixture-planning:session_info_update',
    ]);
    expect(observed.seenUpdates.slice(start).map((notification) => notification.update)).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Synthetic plan: inspect the workspace, then review the changes.' },
    });
    expect(session.metadata.configOptions.map((option) => option.id)).toEqual(['model']);
    expect(session.metadata.configOptions[0]?.currentValue).toBe('fixture-large');
    expect(session.metadata.availableCommands.map((command) => command.name)).toEqual(['echo']);
    expect(session.metadata.usage).toMatchObject({ used: 64, size: 4_096 });
    expect(observed.seenMetadata.at(-1)).toBe(session.metadata);
  });

  test('replaces all metadata on new and load without carrying commands, settings or usage across sessions', async () => {
    const observed = observer();
    const session = await open(observed);
    await session.loadSession('fixture-planning');
    const planning = session.metadata;
    const start = observed.seenUpdates.length;
    await session.newSession();
    expect(session.sessionId).toBe('fixture-session-2');
    expect(session.metadata).toEqual({ configOptions: [], availableCommands: [] });
    expect(session.metadata).not.toBe(planning);
    expect(observed.changedSessions.at(-1)).toBe('fixture-session-2');
    expect(observed.seenUpdates.slice(start)).toEqual([{
      sessionId: 'fixture-session-2',
      update: { sessionUpdate: 'session_info_update', title: 'Synthetic new session 2', updatedAt: '2026-11-15T12:00:00Z' },
    }]);
    await session.loadSession('fixture-planning');
    expect(session.metadata.usage?.used).toBe(64);
    await session.loadSession('fixture-review');
    expect(session.sessionId).toBe('fixture-review');
    expect(session.metadata).toEqual({ configOptions: [], availableCommands: [] });
    expect(planning.availableCommands.map((command) => command.name)).toEqual(['echo']);
    expect(planning.usage?.used).toBe(64);
  });

  test('retains the prior session and publishes no staged history or metadata after a rejected load', async () => {
    const observed = observer();
    const session = await open(observed);
    const initial = session.metadata;
    const updateCount = observed.seenUpdates.length;
    const metadataCount = observed.seenMetadata.length;
    const changedCount = observed.changedSessions.length;
    await expect(session.loadSession('fixture-rejected')).rejects.toThrow('fixture session load rejected');
    expect(session.sessionId).toBe('fixture-session');
    expect(session.metadata).toBe(initial);
    expect(observed.seenUpdates).toHaveLength(updateCount);
    expect(observed.seenMetadata).toHaveLength(metadataCount);
    expect(observed.changedSessions).toHaveLength(changedCount);
    expect(await session.prompt('/model')).toBe('end_turn');
    expect(await nextText(observed)).toBe('Local fixture model: fixture-small');
  });

  test('discards notifications for an uncommitted id when session creation fails', async () => {
    const observed = observer();
    const session = await open(observed, 'new-rejected');
    const initial = session.metadata;
    const updateCount = observed.seenUpdates.length;
    await expect(session.newSession()).rejects.toThrow('fixture session creation rejected');
    expect(session.sessionId).toBe('fixture-session');
    expect(session.metadata).toBe(initial);
    expect(observed.seenUpdates).toHaveLength(updateCount);
    expect(observed.changedSessions).toEqual(['fixture-session']);
    expect(observed.seenMetadata).toEqual([initial]);
    expect(await session.prompt('/model')).toBe('end_turn');
    expect(await nextText(observed)).toBe('Local fixture model: fixture-small');
  });

  test('rejects unadvertised list and load operations without sending either RPC', async () => {
    const observed = observer();
    const session = await open(observed, 'unsupported-sessions');
    expect(session.capabilities).toEqual({
      listSessions: false,
      loadSession: false,
      resumeSession: false,
      closeSession: false,
      additionalDirectories: false,
    });
    await expect(session.listSessions()).rejects.toThrow('does not support listing sessions');
    await expect(session.loadSession('fixture-planning')).rejects.toThrow('does not support loading sessions');
    await session.prompt('inspect');
    expect(JSON.parse(await nextText(observed)).lifecycleRequests).toEqual({ new: 1, list: 0, load: 0 });
  });

  test('filters foreign live text, tool and metadata updates', async () => {
    const observed = observer();
    const session = await open(observed);
    const initial = session.metadata;
    const start = observed.seenUpdates.length;
    await session.prompt('foreign-updates');
    expect(observed.seenUpdates.slice(start)).toEqual([{
      sessionId: 'fixture-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Current-session updates only.' } },
    }]);
    expect(session.metadata).toBe(initial);
  });

  for (const operation of ['new', 'load']) {
    test(`rejects prompt, config, cancel and another switch while session/${operation} is pending`, async () => {
      const observed = observer();
      const session = await open(observed, 'switch-wait');
      await session.prompt('inspect');
      const { pid } = JSON.parse(await nextText(observed));
      const initial = session.metadata;
      const switching = operation === 'new' ? session.newSession() : session.loadSession('fixture-planning');
      expect(await observed.diagnostics.next()).toBe('lifecycle-pending\n');
      expect(session.sessionId).toBe('fixture-session');
      expect(session.metadata).toBe(initial);
      await expect(session.logout()).rejects.toThrow('lifecycle operation is already running');
      await expect(session.prompt('/model')).rejects.toThrow('lifecycle operation is already running');
      await expect(session.setConfigOption('model', 'fixture-large')).rejects.toThrow('lifecycle operation is already running');
      await expect(session.cancel()).rejects.toThrow('lifecycle operation is already running');
      await expect(session.newSession()).rejects.toThrow('lifecycle operation is already running');
      await expect(session.loadSession('fixture-review')).rejects.toThrow('lifecycle operation is already running');
      process.kill(pid, 'SIGUSR1');
      await switching;
      expect(session.sessionId).toBe(operation === 'new' ? 'fixture-session-2' : 'fixture-planning');
    });

    test(`abort settles a pending session/${operation} without publishing staged updates`, async () => {
      const observed = observer();
      const controller = new AbortController();
      const session = await open(observed, 'switch-wait', controller.signal);
      const initial = session.metadata;
      const updateCount = observed.seenUpdates.length;
      const switching = (operation === 'new' ? session.newSession() : session.loadSession('fixture-planning')).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(await observed.diagnostics.next()).toBe('lifecycle-pending\n');
      controller.abort(new Error('stop lifecycle'));
      expect(await switching).toMatchObject({ message: 'stop lifecycle' });
      expect(session.sessionId).toBe('fixture-session');
      expect(session.metadata).toBe(initial);
      expect(observed.seenUpdates).toHaveLength(updateCount);
    });
  }

  test('cancels a permission arriving from the old session during a load instead of displaying it', async () => {
    const observed = observer();
    const session = await open(observed, 'load-permission');
    await session.loadSession('fixture-planning');
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ stalePermissionOutcome: { outcome: 'cancelled' } });
    expect(observed.seenPermissions).toEqual([]);
    expect(session.sessionId).toBe('fixture-planning');
    expect(await session.prompt('stale-permission')).toBe('cancelled');
    expect(observed.seenPermissions).toEqual([]);
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ permissionOutcome: { outcome: 'cancelled' } });
  });

  test('retains early commands and usage alongside initial configuration without reordering updates', async () => {
    const observed = observer();
    const order: string[] = [];
    const update = observed.events.update;
    const metadata = observed.events.metadata!;
    observed.events.update = (notification) => {
      order.push(notification.update.sessionUpdate);
      update(notification);
    };
    observed.events.metadata = (value) => {
      order.push('metadata');
      metadata(value);
    };
    const session = await open(observed);
    expect(order).toEqual(['available_commands_update', 'usage_update', 'metadata']);
    expect(await observed.metadata.next()).toBe(session.metadata);
    expect(session.metadata.availableCommands.map((command) => command.name)).toEqual([
      'help', 'model', 'usage', 'echo', 'fixture-status', 'fixture-refresh',
    ]);
    expect(session.metadata.availableCommands.find((command) => command.name === 'echo')?.input).toEqual({ hint: 'text to repeat' });
    expect(session.metadata.usage).toMatchObject({ used: 16, size: 4_096 });
    expect(session.metadata.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-small');
  });

  test('retains early config updates only for the created session', async () => {
    const session = await open(observer(), 'early-config');
    expect(session.metadata.configOptions.find((option) => option.id === 'reports')?.currentValue).toBe(true);
    expect(session.metadata.availableCommands).toHaveLength(6);
    expect(session.metadata.usage).toMatchObject({ used: 16, size: 4_096 });
  });

  test('accepts grouped leaf values and booleans, rejecting groups, wrong types and unknown settings', async () => {
    const observed = observer();
    const session = await open(observed);
    await expect(session.setConfigOption('unknown', 'fixture-small')).rejects.toThrow('Unknown');
    await expect(session.setConfigOption('model', 'fixture-family')).rejects.toThrow('Invalid value');
    await expect(session.setConfigOption('model', 'not-advertised')).rejects.toThrow('Invalid value');
    await expect(session.setConfigOption('model', true)).rejects.toThrow('Invalid value');
    await expect(session.setConfigOption('reports', 'true')).rejects.toThrow('Invalid value');
    expect(observed.seenMetadata).toHaveLength(1);
    const initial = session.metadata;
    await session.setConfigOption('model', 'fixture-large');
    expect(session.metadata.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-large');
    expect(session.metadata.configOptions.find((option) => option.id === 'thought_level')?.currentValue).toBe('high');
    expect(initial.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-small');
    await session.setConfigOption('reports', true);
    expect(session.metadata.configOptions.find((option) => option.id === 'reports')?.currentValue).toBe(true);
    expect(observed.seenMetadata.at(-1)).toBe(session.metadata);
  });

  test('keeps the selected model and metadata event history when a server rejects a valid selection', async () => {
    const observed = observer();
    const session = await open(observed);
    await session.setConfigOption('model', 'fixture-large');
    const selected = session.metadata;
    const eventCount = observed.seenMetadata.length;
    await expect(session.setConfigOption('model', 'fixture-rejected')).rejects.toThrow('fixture config selection rejected');
    expect(session.metadata).toBe(selected);
    expect(session.metadata.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-large');
    expect(observed.seenMetadata).toHaveLength(eventCount);
    expect(await session.prompt('/model')).toBe('end_turn');
    expect(await nextText(observed)).toBe('Local fixture model: fixture-large');
  });

  test('replaces live metadata and validates only the currently advertised settings and values', async () => {
    const observed = observer();
    const session = await open(observed);
    await observed.updates.next();
    await observed.updates.next();
    const initial = session.metadata;
    expect(await session.prompt('/fixture-refresh')).toBe('end_turn');
    for (const expected of ['config_option_update', 'available_commands_update', 'usage_update'] as const) {
      expect((await observed.updates.next()).update.sessionUpdate).toBe(expected);
    }
    expect(await nextText(observed)).toBe('Local fixture metadata refreshed.');
    expect(session.metadata.configOptions.map((option) => option.id)).toEqual(['model', 'reports']);
    expect(session.metadata.availableCommands.some((command) => command.name === 'fixture-refresh')).toBe(false);
    expect(session.metadata.usage).toMatchObject({ used: 42, size: 4_096, cost: { amount: 0.25, currency: 'fixture-credits' } });
    expect(initial.availableCommands).toHaveLength(6);
    expect(initial.usage?.used).toBe(16);
    expect(observed.seenMetadata).toHaveLength(4);
    expect(observed.seenMetadata.at(-1)).toBe(session.metadata);
    await expect(session.setConfigOption('thought_level', 'high')).rejects.toThrow('Unknown');
    await expect(session.setConfigOption('model', 'fixture-large')).rejects.toThrow('Invalid value');
    await session.setConfigOption('model', 'fixture-small');
  });


  test('rejects configuration changes during prompts and cancellation', async () => {
    const observed = observer();
    const session = await open(observed);
    const turn = session.prompt('pending');
    expect(await nextText(observed)).toBe('ready');
    await expect(session.setConfigOption('model', 'fixture-large')).rejects.toThrow('prompt is already running');
    await expect(session.newSession()).rejects.toThrow('prompt is already running');
    await expect(session.loadSession('fixture-planning')).rejects.toThrow('prompt is already running');
    await session.cancel();
    expect(await turn).toBe('cancelled');
    const cancellation = session.cancel();
    const loggingOut = session.logout();
    const setting = session.setConfigOption('model', 'fixture-large');
    await expect(setting).rejects.toThrow('cancellation is still in progress');
    await expect(loggingOut).rejects.toThrow('cancellation is still in progress');
    await cancellation;
    await session.setConfigOption('model', 'fixture-large');
  });

  test('keeps configuration unchanged while a mutation is pending and rejects overlapping operations', async () => {
    const observed = observer();
    const session = await open(observed, 'config-wait');
    await session.prompt('inspect');
    const { pid } = JSON.parse(await nextText(observed));
    const initial = session.metadata;
    const setting = session.setConfigOption('model', 'fixture-large');
    expect(await observed.diagnostics.next()).toBe('configuration-pending\n');
    expect(session.metadata).toBe(initial);
    await expect(session.setConfigOption('reports', true)).rejects.toThrow('configuration is still being changed');
    await expect(session.prompt('/model')).rejects.toThrow('configuration is still being changed');
    await expect(session.cancel()).rejects.toThrow('configuration is still being changed');
    await expect(session.newSession()).rejects.toThrow('configuration is still being changed');
    await expect(session.loadSession('fixture-planning')).rejects.toThrow('configuration is still being changed');
    await expect(session.logout()).rejects.toThrow('configuration is still being changed');
    process.kill(pid, 'SIGUSR1');
    await setting;
    expect(session.metadata.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('fixture-large');
    expect(await session.prompt('/model')).toBe('end_turn');
    expect(await nextText(observed)).toBe('Local fixture model: fixture-large');
  });

  test('cancels an unknown permission answer and ignores a later approval', async () => {
    const observed = observer();
    const session = await open(observed);
    const turn = session.prompt('permission');
    const permission = await observed.permissions.next();
    permission.answer('not-an-offered-option');
    permission.answer('allow-once');
    expect(await turn).toBe('cancelled');
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'cancelled' });
  });

  test('selects only an offered option and gives each permission a distinct id', async () => {
    const observed = observer();
    const session = await open(observed);
    const firstTurn = session.prompt('permission');
    const first = await observed.permissions.next();
    await expect(session.newSession()).rejects.toThrow('prompt is already running');
    await expect(session.loadSession('fixture-planning')).rejects.toThrow('prompt is already running');
    expect(observed.seenPermissions).toHaveLength(1);
    first.answer('allow-once');
    expect(await firstTurn).toBe('end_turn');
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    const secondTurn = session.prompt('permission');
    const second = await observed.permissions.next();
    expect(second.id).not.toBe(first.id);
    second.answer('reject-once');
    expect(await secondTurn).toBe('end_turn');
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'selected', optionId: 'reject-once' });
  });

  test('cancels pending and later permissions for a cancelled turn without approving', async () => {
    const observed = observer();
    const session = await open(observed);
    const turn = session.prompt('permission-twice');
    await observed.permissions.next();
    await session.cancel();
    expect(await turn).toBe('cancelled');
    expect(observed.seenPermissions).toHaveLength(1);
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'cancelled' });
    expect(JSON.parse(await nextText(observed))).toEqual({ outcome: 'cancelled' });
  });

  test('never presents a permission for another session', async () => {
    const observed = observer();
    const session = await open(observed);
    expect(await session.prompt('foreign-permission')).toBe('cancelled');
    expect(observed.seenPermissions).toHaveLength(0);
  });

  test('close is idempotent and sends a cancelled outcome before reaping the agent', async () => {
    const observed = observer();
    const session = await open(observed);
    const turn = session.prompt('permission');
    const permission = await observed.permissions.next();
    const closing = session.close();
    expect(session.close()).toBe(closing);
    permission.answer('allow-once');
    await closing;
    expect(await turn).toBe('cancelled');
    expect(JSON.parse(await observed.diagnostics.next())).toEqual({ permissionOutcome: { outcome: 'cancelled' } });
    await expect(session.prompt('inspect')).rejects.toThrow('closed');
  });

  test('rejects overlapping prompts, cancels the active RPC, then permits another turn', async () => {
    const observed = observer();
    const session = await open(observed);
    const turn = session.prompt('pending');
    expect(await nextText(observed)).toBe('ready');
    await expect(session.prompt('inspect')).rejects.toThrow('already running');
    await session.cancel();
    expect(await turn).toBe('cancelled');
    expect(await session.prompt('inspect')).toBe('end_turn');
  });

  test('rejects an RPC when the subprocess exits instead of leaving it pending', async () => {
    const observed = observer();
    const session = await open(observed);
    await expect(session.prompt('exit')).rejects.toThrow(/closed|exited|disconnect/i);
    expect(await observed.disconnected.next()).toMatch(/closed|exited|disconnect/i);
    await expect(session.prompt('inspect')).rejects.toThrow(/closed|exited|disconnect/i);
  });

  test('rejects a malformed prompt result and disconnects', async () => {
    const observed = observer();
    const session = await open(observed);
    await expect(session.prompt('malformed-result')).rejects.toThrow('stopReason');
    expect(await observed.disconnected.next()).toContain('stopReason');
  });

  for (const command of ['bad-json', 'unexpected-response']) {
    test(`${command} disconnects and rejects the pending RPC`, async () => {
      const observed = observer();
      const session = await open(observed);
      await expect(session.prompt(command)).rejects.toThrow('invalid JSON-RPC output');
      expect(await observed.disconnected.next()).toContain('invalid JSON-RPC output');
    });
  }

  test('surfaces RPC errors without preventing a subsequent prompt', async () => {
    const observed = observer();
    const session = await open(observed);
    await expect(session.prompt('rpc-error')).rejects.toThrow('fixture prompt failed');
    expect(await session.prompt('inspect')).toBe('end_turn');
  });

  test('forwards stderr as plain text', async () => {
    const observed = observer();
    const session = await open(observed);
    await session.prompt('stderr');
    expect(await observed.diagnostics.next()).toBe('fixture diagnostic\n');
  });

  test('explains official login when session creation requires authentication', async () => {
    const observed = observer();
    const order: string[] = [];
    const authentication = observed.events.authentication!;
    observed.events.authentication = (value) => {
      order.push('authentication');
      authentication(value);
    };
    observed.events.disconnected = (message) => {
      order.push('disconnected');
      observed.disconnected.push(message);
    };
    await expect(open(observed, 'auth')).rejects.toThrow('agy acp --login');
    expect(order).toEqual(['authentication', 'disconnected']);
    expect(observed.seenAuthentication[0]).toMatchObject({
      terminalMethods: [{ id: 'terminal-login', args: ['--login'] }], logout: true,
    });
    expect(observed.changedSessions).toEqual([]);
    expect(await observed.disconnected.next()).toContain('interactive `agy`');
  });

  test('explains official login when a prompt requires authentication', async () => {
    const observed = observer();
    const session = await open(observed);
    await expect(session.prompt('auth-error')).rejects.toThrow('agy acp --login');
  });

  test('cleans up an unsupported protocol version', async () => {
    await expect(open(observer(), 'version')).rejects.toThrow('Unsupported Antigravity ACP protocol version');
  });

  test('settles startup when the subprocess exits during session creation', async () => {
    await expect(open(observer(), 'startup-exit')).rejects.toThrow(/closed|exited|disconnect/i);
  });

  test('reports an unavailable official executable without hanging', async () => {
    const cwd = await workspace();
    await expect(connectAgent({ cwd, executable: join(cwd, 'not-installed-agy') }, observer().events))
      .rejects.toThrow('not found');
  });

  test('an already-aborted signal prevents launch', async () => {
    const cwd = await workspace();
    const signal = AbortSignal.abort(new Error('already stopped'));
    await expect(connectAgent({ cwd, executable: join(cwd, 'not-installed-agy'), signal }, observer().events))
      .rejects.toThrow('already stopped');
  });

  for (const [scenario, marker] of [
    ['init-wait', 'waiting-initialize\n'],
    ['new-wait', 'waiting-session-new\n'],
  ]) {
    test(`abort settles ${scenario} setup and reaps the subprocess`, async () => {
      const observed = observer();
      const controller = new AbortController();
      const result = open(observed, scenario, controller.signal).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(await observed.diagnostics.next()).toBe(marker);
      controller.abort(new Error('stop setup'));
      expect(await result).toMatchObject({ message: 'stop setup' });
    });
  }

  test('abort immediately rejects an active RPC and closes the session', async () => {
    const observed = observer();
    const controller = new AbortController();
    const session = await open(observed, 'normal', controller.signal);
    const result = session.prompt('pending').then(() => undefined, (cause: unknown) => cause);
    expect(await nextText(observed)).toBe('ready');
    controller.abort(new Error('stop active session'));
    expect(await result).toMatchObject({ message: 'stop active session' });
    await session.close();
    await expect(session.prompt('inspect')).rejects.toThrow('stop active session');
  });

  test('close escalates when the agent ignores EOF and SIGTERM and settles its pending RPC', async () => {
    const observed = observer();
    const session = await open(observed);
    const result = session.prompt('stubborn').then(() => undefined, (cause: unknown) => cause);
    const { pid } = JSON.parse(await nextText(observed));
    await session.close();
    expect(await result).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  test('exposes promptCapabilities.image, subscription tier metadata, and forwards image prompt blocks', async () => {
    const observed = observer();
    const session = await open(observed);
    expect(session.promptCapabilities).toEqual({ image: true, embeddedContext: true });
    expect(session.metadata.tier).toEqual({ name: 'Synthetic Pro', id: 'synthetic-pro' });
    expect(await session.prompt('describe screenshot', [
      { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ])).toBe('end_turn');
    expect(await nextText(observed)).toBe('Synthetic fixture reply (1 image: image/png): describe screenshot');
  });

  test('respects promptCapabilities.image = false without sending image blocks', async () => {
    const observed = observer();
    const session = await open(observed, 'no-images');
    expect(session.promptCapabilities).toEqual({ image: false, embeddedContext: false });
    await expect(session.prompt('text only', [
      { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ])).rejects.toThrow('does not advertise image prompt support');
    await expect(session.prompt('text only', undefined, [
      { uri: 'file:///tmp/a.ts', text: 'export {}' },
    ])).rejects.toThrow('does not advertise embedded context support');
  });

  test('supports resumeSession, closeSession, embeddedContext blocks, --add-dir, --agent, and current_mode_update', async () => {
    const cwd = await workspace();
    const extraDir = await mkdtemp(join(tmpdir(), 'agy-tern-extradir-'));
    workspaces.push(extraDir);
    const observed = observer();
    const session = await connectAgent({
      cwd,
      executable: fixture,
      additionalDirectories: [extraDir],
      agentName: 'architect',
    }, observed.events);
    sessions.push(session);

    await session.prompt('inspect');
    const inspected = JSON.parse(await nextText(observed));
    expect(inspected.argv).toEqual(['acp', '--sandbox', '--add-dir', extraDir, '--agent', 'architect']);
    expect(inspected.created.additionalDirectories).toEqual([extraDir]);

    expect(await session.prompt('use context', undefined, [
      { uri: `file://${join(cwd, 'README.md')}`, mimeType: 'text/plain', text: '# Hello' },
    ])).toBe('end_turn');
    expect(await nextText(observed)).toBe('Synthetic fixture reply (1 embedded resource): use context');

    await session.prompt('mode-notify');
    expect(await nextText(observed)).toBe('Mode updated via current_mode_update.');
    expect(session.metadata.configOptions.find(o => o.id === 'mode')?.currentValue).toBe('accept-edits');

    await expect(session.closeSession!(session.sessionId)).rejects.toThrow('Switch to another session');
    await session.resumeSession!('fixture-planning');
    expect(session.sessionId).toBe('fixture-planning');
    await session.closeSession!('fixture-review');
    const listed = await session.listSessions();
    expect(listed.sessions.some(s => s.sessionId === 'fixture-review')).toBe(false);
  });
});
