import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  client,
  methods,
  DEFAULT_MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationResponse,
  type RequestPermissionResponse,
  type ListSessionsResponse,
  type SendRequestOptions,
  type SessionConfigOption,
  type Stream,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import type { AccountTier, AgentAuthentication, AgentEvents, AgentMetadata, AgentOptions, AgentSession, ElicitationPrompt, ImageAttachment, ResourceAttachment } from './contracts';

const STARTUP_TIMEOUT_MS = 30_000;
const CANCEL_WRITE_TIMEOUT_MS = 1_000;
const SESSION_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 500;
const TERMINATE_TIMEOUT_MS = 1_000;
const AUTH_HELP = 'Authenticate with the official CLI using `agy acp --login` or interactive `agy`, then try again.';

interface PendingSession {
  targetId?: string;
  updates: SessionNotification[];
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function explainError(cause: unknown, stderr = ''): Error {
  const error = asError(cause);
  if (error.message.includes(AUTH_HELP)) return error;
  if (
    (error instanceof RequestError && error.code === -32000) ||
    /auth(?:entication)?|not (?:logged|signed) in|log[ -]?in|unauthori[sz]ed|invalid_grant|expired.*token/i.test(
      `${error.message}\n${stderr}`,
    )
  ) {
    return new Error(
      `${error.message}\n${AUTH_HELP}`,
      { cause: error },
    );
  }
  return error;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(message)), milliseconds);
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

// The SDK's NDJSON helper recovers from bad JSON. Here a corrupt local peer must
// disconnect instead, so an outstanding prompt cannot be left waiting forever.
function processStream(input: Readable, output: Writable): Stream {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pendingIds = new Set<unknown>();
  let cancelled = false;
  return {
    writable: new WritableStream<AnyMessage>({
      write(message) {
        if ('method' in message && 'id' in message) pendingIds.add(message.id);
        const flushed = Promise.withResolvers<void>();
        output.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) flushed.reject(error);
          else flushed.resolve();
        });
        return flushed.promise;
      },
    }),
    readable: new ReadableStream<AnyMessage>({
      async start(controller) {
        try {
          for await (const line of lines) {
            if (cancelled) return;
            if (!line.trim()) continue;
            if (Buffer.byteLength(line) > DEFAULT_MAX_MESSAGE_BYTES) {
              throw new Error('ACP message exceeds the SDK message-size limit.');
            }
            const message: unknown = JSON.parse(line);
            if (
              typeof message !== 'object' || message === null || Array.isArray(message) ||
              !('jsonrpc' in message) || message.jsonrpc !== '2.0'
            ) {
              throw new Error('Invalid ACP JSON-RPC envelope.');
            }
            if (
              'id' in message && message.id !== null && typeof message.id !== 'string' &&
              (typeof message.id !== 'number' || !Number.isFinite(message.id))
            ) {
              throw new Error('Invalid ACP JSON-RPC request id.');
            }
            if ('method' in message) {
              if (typeof message.method !== 'string') throw new Error('Invalid ACP method.');
            } else if (!('id' in message) || !pendingIds.delete(message.id)) {
              throw new Error('ACP response does not match a pending request.');
            } else if (('result' in message) === ('error' in message)) {
              throw new Error('ACP response must contain exactly one result or error.');
            }
            controller.enqueue(message as AnyMessage);
          }
          if (!cancelled) controller.close();
        } catch (cause) {
          if (!cancelled) {
            controller.error(new Error('Antigravity ACP sent invalid JSON-RPC output.', { cause }));
          }
        } finally {
          lines.close();
        }
      },
      cancel() {
        cancelled = true;
        lines.close();
        input.destroy();
      },
    }),
  };
}

export async function connectAgent(options: AgentOptions, events: AgentEvents): Promise<AgentSession> {
  const cwd = resolve(options.cwd);
  const extraDirs = (options.additionalDirectories ?? []).map(dir => resolve(cwd, dir));
  const executable = options.executable ?? 'agy';
  if (options.signal?.aborted) throw asError(options.signal.reason);
  const processGroup = process.platform !== 'win32';
  const acpArgs = [
    'acp',
    '--sandbox',
    ...extraDirs.flatMap(dir => ['--add-dir', dir]),
    ...(options.agentName ? ['--agent', options.agentName] : []),
  ];
  const child = spawn(executable, acpArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: processGroup,
  });
  const ended = Promise.withResolvers<void>();
  const permissions = new Map<string, (optionId: string | null) => void>();
  const elicitations = new Map<string, (response: CreateElicitationResponse | null) => void>();
  let connection: ClientConnection | undefined;
  let sessionId = '';
  let exited = false;
  let closing = false;
  let loggedOut = false;
  let closePromise: Promise<void> | undefined;
  let failure: Error | undefined;
  let activePrompt: Promise<string> | undefined;
  let turnCancelled = false;
  let cancellation: Promise<void> | undefined;
  let configMutation: Promise<void> | undefined;
  let lifecycleMutation: Promise<void> | undefined;
  const startupSession: PendingSession = { updates: [] };
  let pendingSession: PendingSession | undefined = startupSession;
  let capabilities: AgentSession['capabilities'] = {
    listSessions: false,
    loadSession: false,
    resumeSession: false,
    closeSession: false,
    additionalDirectories: false,
    appendSystemPrompt: false,
  };
  let promptCapabilities: NonNullable<AgentSession['promptCapabilities']> = Object.freeze({
    image: false,
    embeddedContext: false,
  });
  let authentication: AgentAuthentication = { terminalMethods: [], logout: false };
  let metadata: AgentMetadata = { configOptions: [], availableCommands: [] };
  let stderrTail = '';

  function cancelPermissions(): void {
    for (const answer of permissions.values()) answer(null);
  }

  function cancelElicitations(): void {
    for (const answer of elicitations.values()) answer(null);
  }

  function diagnostic(text: string): void {
    try {
      events.diagnostic(text);
    } catch (error) {
      disconnect(error);
    }
  }

  function disconnect(cause: unknown): void {
    if (failure || closing) return;
    failure = explainError(cause, stderrTail);
    cancelPermissions();
    cancelElicitations();
    connection?.close(failure);
    try {
      events.disconnected(failure.message);
    } catch (error) {
      diagnostic(`Antigravity disconnect handler failed: ${asError(error).message}\n`);
    } finally {
      void close().catch((error: unknown) => diagnostic(`${asError(error).message}\n`));
    }
  }

  function assertOpen(): void {
    if (failure) throw failure;
    if (loggedOut) throw new Error('Antigravity ACP is logged out. Log in and open a fresh connection.');
    if (closing || !connection || connection.signal.aborted) {
      throw new Error('Antigravity ACP session is closed.');
    }
  }

  function publishMetadata(changes: Partial<AgentMetadata>): void {
    metadata = { ...metadata, ...changes };
    events.metadata?.(metadata);
  }

  function metadataChanges({ update }: SessionNotification, currentConfig = metadata.configOptions): Partial<AgentMetadata> | undefined {
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        return { availableCommands: update.availableCommands };
      case 'config_option_update':
        return { configOptions: update.configOptions };
      case 'current_mode_update': {
        const idx = currentConfig.findIndex(option =>
          option.type === 'select' && (option.category === 'mode' || option.id === 'mode'));
        if (idx < 0) return undefined;
        const nextOptions = [...currentConfig];
        nextOptions[idx] = { ...nextOptions[idx]!, currentValue: update.currentModeId } as SessionConfigOption;
        return { configOptions: nextOptions };
      }
      case 'usage_update':
        return { usage: update };
      default:
        return undefined;
    }
  }

  function receiveUpdate(notification: SessionNotification): void {
    if (closing || failure || loggedOut) return;
    if (pendingSession) {
      if (!pendingSession.targetId || notification.sessionId === pendingSession.targetId) {
        pendingSession.updates.push(notification);
      }
      return;
    }
    if (notification.sessionId !== sessionId) return;
    events.update(notification);
    const changes = metadataChanges(notification);
    if (changes) publishMetadata(changes);
  }

  function supportsSystemPromptAppend(agentCapabilities: unknown): boolean {
    if (typeof agentCapabilities !== 'object' || agentCapabilities === null) return false;
    const meta = (agentCapabilities as Record<string, unknown>)._meta;
    if (typeof meta !== 'object' || meta === null) return false;
    const antigravity = (meta as Record<string, unknown>).antigravity;
    if (typeof antigravity !== 'object' || antigravity === null) return false;
    const systemPrompt = (antigravity as Record<string, unknown>).systemPrompt;
    if (typeof systemPrompt !== 'object' || systemPrompt === null) return false;
    return (systemPrompt as Record<string, unknown>).append === true;
  }

  function parseTier(meta: unknown): AccountTier | undefined {
    if (typeof meta !== 'object' || meta === null || !('antigravity' in meta)) return undefined;
    const antigravity = (meta as Record<string, unknown>).antigravity;
    if (typeof antigravity !== 'object' || antigravity === null || !('tier' in antigravity)) return undefined;
    const tier = (antigravity as Record<string, unknown>).tier;
    if (typeof tier !== 'object' || tier === null || !('name' in tier) || typeof (tier as Record<string, unknown>).name !== 'string') return undefined;
    const rec = tier as Record<string, unknown>;
    return {
      name: rec.name as string,
      ...(typeof rec.id === 'string' ? { id: rec.id } : {}),
      ...(typeof rec.upgradeUri === 'string' ? { upgradeUri: rec.upgradeUri } : {}),
    };
  }

  function commitSession(targetId: string, configOptions: SessionConfigOption[], staged: PendingSession, tier?: AccountTier): void {
    assertOpen();
    const updates = staged.updates.filter((notification) => notification.sessionId === targetId);
    let nextMetadata: AgentMetadata = { configOptions, availableCommands: [], ...(tier ? { tier } : {}) };
    for (const notification of updates) {
      const changes = metadataChanges(notification, nextMetadata.configOptions);
      if (changes) nextMetadata = { ...nextMetadata, ...changes };
    }
    sessionId = targetId;
    metadata = nextMetadata;
    pendingSession = undefined;
    turnCancelled = false;
    events.sessionChanged?.(sessionId);
    for (const notification of updates) events.update(notification);
    events.metadata?.(metadata);
  }

  function signalChild(signal: NodeJS.Signals): void {
    if (child.pid === undefined || (!processGroup && exited)) return;
    try {
      if (processGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  async function waitForExit(milliseconds: number): Promise<boolean> {
    const deadline = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => deadline.resolve(false), milliseconds);
    try {
      return await Promise.race([ended.promise.then(() => true), deadline.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendCancel(): Promise<void> {
    if (!connection || connection.signal.aborted || !sessionId || loggedOut) return;
    await bounded(
      connection.agent.notify(methods.agent.session.cancel, { sessionId }),
      CANCEL_WRITE_TIMEOUT_MS,
      'Antigravity ACP did not accept the cancellation notification within 1 second.',
    );
  }

  async function shutdown(): Promise<void> {
    try {
      if (connection && !connection.signal.aborted) {
        try {
          await sendCancel();
          // Let permission responses and a cooperative prompt finish before closing stdio.
          if (activePrompt) {
            await bounded(activePrompt.catch(() => undefined), SHUTDOWN_GRACE_MS, 'Prompt shutdown grace elapsed.');
          }
        } catch {
          // A blocked or disconnected peer still has to be reaped below.
        }
      }
      child.stdin.end();
      connection?.close(failure ?? new Error('Antigravity ACP session is closed.'));
      if (!(await waitForExit(SHUTDOWN_GRACE_MS))) {
        signalChild('SIGTERM');
        if (!(await waitForExit(TERMINATE_TIMEOUT_MS))) {
          signalChild('SIGKILL');
          if (!(await waitForExit(TERMINATE_TIMEOUT_MS))) {
            throw new Error('Antigravity ACP did not exit after SIGKILL.');
          }
        }
      }
    } finally {
      connection?.close(failure ?? new Error('Antigravity ACP session is closed.'));
      options.signal?.removeEventListener('abort', onAbort);
      if (processGroup) signalChild('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    turnCancelled = true;
    cancelPermissions();
    cancelElicitations();
    closePromise = shutdown();
    return closePromise;
  }

  function onAbort(): void {
    const cause = options.signal?.reason ?? new Error('Antigravity ACP connection was cancelled.');
    cancelPermissions();
    cancelElicitations();
    if (closing) connection?.close(asError(cause));
    else disconnect(cause);
  }

  child.once('error', (cause: NodeJS.ErrnoException) => {
    const message = cause.code === 'ENOENT'
      ? `Could not launch "${executable}": executable or working directory was not found (${cwd}). Install the official Antigravity CLI or provide its executable path.`
      : `Could not run Antigravity ACP ("${executable}"): ${cause.message}`;
    disconnect(new Error(message, { cause }));
  });
  child.once('exit', (code, signal) => {
    exited = true;
    cancelPermissions();
    cancelElicitations();
    const message = signal
      ? `Antigravity ACP exited after signal ${signal}.`
      : `Antigravity ACP exited with code ${code}.`;
    if (failure) diagnostic(`${message}\n`);
    else if (!closing) disconnect(new Error(message));
  });
  child.once('close', () => {
    exited = true;
    ended.resolve();
  });
  child.stdin.on('error', (error) => disconnect(error));
  child.stdout.on('error', (error) => disconnect(error));
  child.stderr.on('error', (error) => disconnect(error));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = stripVTControlCharacters(chunk).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    stderrTail = (stderrTail + text).slice(-4_096);
    if (text) diagnostic(text);
  });

  const startupTimer = setTimeout(() => {
    disconnect(new Error('Antigravity ACP startup timed out after 30 seconds during initialize/session/new.'));
  }, STARTUP_TIMEOUT_MS);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    if (failure) throw failure;
    connection = client({ name: 'agy-tern' })
      .onNotification(methods.client.session.update, ({ params }) => receiveUpdate(params))
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => {
        if (closing || failure || loggedOut || lifecycleMutation || pendingSession || turnCancelled || params.sessionId !== sessionId || signal.aborted) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const id = randomUUID();
        const allowed = new Set(params.options.map((option) => option.optionId));
        const response = Promise.withResolvers<RequestPermissionResponse>();
        const answer = (optionId: string | null): void => {
          if (!permissions.delete(id)) return;
          signal.removeEventListener('abort', abort);
          response.resolve({
            outcome: optionId !== null && allowed.has(optionId)
              ? { outcome: 'selected', optionId }
              : { outcome: 'cancelled' },
          });
        };
        const abort = (): void => answer(null);
        permissions.set(id, answer);
        signal.addEventListener('abort', abort, { once: true });
        try {
          events.permission({ id, request: params, answer });
        } catch (error) {
          answer(null);
          disconnect(error);
        }
        return response.promise;
      })
      .onRequest(methods.client.elicitation.create, ({ params, signal }) => {
        const scopedSession = 'sessionId' in params ? params.sessionId : undefined;
        if (
          closing ||
          failure ||
          loggedOut ||
          lifecycleMutation ||
          pendingSession ||
          turnCancelled ||
          (scopedSession !== undefined && scopedSession !== sessionId) ||
          signal.aborted
        ) {
          return { action: 'cancel' };
        }
        if (!events.elicitation) {
          return { action: 'decline' };
        }
        const id = randomUUID();
        const response = Promise.withResolvers<CreateElicitationResponse>();
        const answer = (reply: CreateElicitationResponse | null): void => {
          if (!elicitations.delete(id)) return;
          signal.removeEventListener('abort', abort);
          response.resolve(reply ?? { action: 'cancel' });
        };
        const abort = (): void => answer(null);
        elicitations.set(id, answer);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const promptItem: ElicitationPrompt = { id, request: params, answer };
          events.elicitation(promptItem);
        } catch (error) {
          answer(null);
          disconnect(error);
        }
        return response.promise;
      })
      .onNotification(methods.client.elicitation.complete, ({ params }) => {
        events.elicitationComplete?.(params);
      })
      .connect(processStream(child.stdout, child.stdin));
    connection.signal.addEventListener('abort', () => {
      disconnect(connection?.signal.reason ?? new Error('Antigravity ACP disconnected.'));
    }, { once: true });
    if (connection.signal.aborted) disconnect(connection.signal.reason);
    assertOpen();
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'agy-tern', version: '0.1.0' },
      clientCapabilities: {
        auth: { terminal: true },
        elicitation: { form: {}, url: {} },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: {
          compaction: {},
          configOptions: { boolean: {} },
          notices: {},
        },
      },
    });
    if (initialized?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported Antigravity ACP protocol version: ${initialized?.protocolVersion}; expected ${PROTOCOL_VERSION}.`);
    }
    capabilities = Object.freeze({
      listSessions: initialized.agentCapabilities?.sessionCapabilities?.list != null,
      loadSession: initialized.agentCapabilities?.loadSession === true,
      resumeSession: initialized.agentCapabilities?.sessionCapabilities?.resume != null,
      closeSession: initialized.agentCapabilities?.sessionCapabilities?.close != null,
      additionalDirectories: initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories != null,
      appendSystemPrompt: supportsSystemPromptAppend(initialized.agentCapabilities),
    });
    promptCapabilities = Object.freeze({
      image: initialized.agentCapabilities?.promptCapabilities?.image === true,
      embeddedContext: initialized.agentCapabilities?.promptCapabilities?.embeddedContext === true,
    });
    authentication = {
      terminalMethods: (initialized.authMethods ?? []).filter((method) => 'type' in method && method.type === 'terminal'),
      logout: initialized.agentCapabilities?.auth?.logout != null,
    };
    events.authentication?.(authentication);
    const addDirParam = capabilities.additionalDirectories && extraDirs.length ? { additionalDirectories: extraDirs } : {};
    const systemPromptMetaParam = capabilities.appendSystemPrompt && options.appendSystemPrompt
      ? { _meta: { antigravity: { systemPrompt: { append: options.appendSystemPrompt } } } }
      : {};
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
      ...addDirParam,
      ...systemPromptMetaParam,
    });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) {
      throw new Error('Invalid Antigravity ACP session/new response: missing sessionId.');
    }
    commitSession(session.sessionId, session.configOptions ?? [], startupSession, parseTier(session._meta));
  } catch (cause) {
    const error = failure ?? explainError(cause, stderrTail);
    disconnect(error);
    await close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }

  const agentConnection = connection;

  async function sessionRequest<T>(request: (requestOptions: SendRequestOptions) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      const error = new Error('Antigravity ACP session lifecycle request timed out after 30 seconds.');
      deadline.reject(error);
      controller.abort(error);
      disconnect(error);
    }, SESSION_REQUEST_TIMEOUT_MS);
    try {
      return await Promise.race([
        request({ cancellationSignal: controller.signal, stopWaitingOnCancel: true }),
        deadline.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function listSessions(cursor?: string): Promise<ListSessionsResponse> {
    assertOpen();
    if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
    if (!capabilities.listSessions) throw new Error('Antigravity ACP does not support listing sessions.');
    try {
      const response = await sessionRequest((requestOptions) => agentConnection.agent.request(
        methods.agent.session.list,
        cursor === undefined ? { cwd } : { cwd, cursor },
        requestOptions,
      ));
      if (!Array.isArray(response?.sessions)) {
        throw new Error('Invalid Antigravity ACP session/list response: missing sessions.');
      }
      return {
        ...response,
        sessions: response.sessions.filter((session) => (
          typeof session.cwd === 'string' && !session.cwd.includes('\0') &&
          isAbsolute(session.cwd) && resolve(session.cwd) === cwd
        )),
      };
    } catch (cause) {
      throw failure ?? explainError(cause, stderrTail);
    }
  }

  function changeSession(targetId?: string, mode: 'new' | 'load' | 'resume' = targetId === undefined ? 'new' : 'load'): Promise<void> {
    try {
      assertOpen();
      if (mode === 'load') {
        if (!capabilities.loadSession) throw new Error('Antigravity ACP does not support loading sessions.');
        if (!targetId) throw new Error('An Antigravity session id is required.');
      } else if (mode === 'resume') {
        if (!capabilities.resumeSession) throw new Error('Antigravity ACP does not support resuming sessions.');
        if (!targetId) throw new Error('An Antigravity session id is required.');
      }
      if (activePrompt) throw new Error('An Antigravity prompt is already running. Cancel it or wait before switching sessions.');
      if (cancellation) throw new Error('Antigravity cancellation is still in progress.');
      if (configMutation) throw new Error('Antigravity configuration is still being changed.');
      if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
      if (permissions.size) throw new Error('An Antigravity permission request is still awaiting an answer.');
      if (elicitations.size) throw new Error('An Antigravity follow-up question is still awaiting an answer.');
    } catch (error) {
      return Promise.reject(error);
    }
    const staged: PendingSession = { targetId, updates: [] };
    pendingSession = staged;
    const addDirParam = capabilities.additionalDirectories && extraDirs.length ? { additionalDirectories: extraDirs } : {};
    const systemPromptMetaParam = capabilities.appendSystemPrompt && options.appendSystemPrompt
      ? { _meta: { antigravity: { systemPrompt: { append: options.appendSystemPrompt } } } }
      : {};
    lifecycleMutation = sessionRequest(async (requestOptions) => {
      if (mode === 'load' && targetId !== undefined) {
        const response = await agentConnection.agent.request(methods.agent.session.load, {
          sessionId: targetId, cwd, mcpServers: [], ...addDirParam, ...systemPromptMetaParam,
        }, requestOptions);
        commitSession(targetId, response?.configOptions ?? [], staged, parseTier(response?._meta));
      } else if (mode === 'resume' && targetId !== undefined) {
        const response = await agentConnection.agent.request(methods.agent.session.resume, {
          sessionId: targetId, cwd, mcpServers: [], ...addDirParam, ...systemPromptMetaParam,
        }, requestOptions);
        commitSession(targetId, response?.configOptions ?? [], staged, parseTier(response?._meta));
      } else {
        const response = await agentConnection.agent.request(methods.agent.session.new, {
          cwd, mcpServers: [], ...addDirParam, ...systemPromptMetaParam,
        }, requestOptions);
        if (typeof response?.sessionId !== 'string' || !response.sessionId) {
          throw new Error('Invalid Antigravity ACP session/new response: missing sessionId.');
        }
        commitSession(response.sessionId, response.configOptions ?? [], staged, parseTier(response?._meta));
      }
    }).catch((cause: unknown) => {
      throw failure ?? explainError(cause, stderrTail);
    }).finally(() => {
      pendingSession = undefined;
      lifecycleMutation = undefined;
    });
    return lifecycleMutation;
  }

  function closeSession(targetId: string): Promise<void> {
    try {
      assertOpen();
      if (!capabilities.closeSession) throw new Error('Antigravity ACP does not support closing sessions.');
      if (!targetId) throw new Error('An Antigravity session id is required.');
      if (targetId === sessionId) throw new Error('Switch to another session before closing the active session.');
      if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
    } catch (error) {
      return Promise.reject(error);
    }
    lifecycleMutation = sessionRequest(async (requestOptions) => {
      await agentConnection.agent.request(methods.agent.session.close, { sessionId: targetId }, requestOptions);
    }).catch((cause: unknown) => {
      throw failure ?? explainError(cause, stderrTail);
    }).finally(() => {
      lifecycleMutation = undefined;
    });
    return lifecycleMutation;
  }

  function prompt(text: string, images?: readonly ImageAttachment[], resources?: readonly ResourceAttachment[]): Promise<string> {
    try {
      assertOpen();
      if (activePrompt) throw new Error('An Antigravity prompt is already running. Cancel it or wait to finish.');
      if (cancellation) throw new Error('Antigravity cancellation is still in progress.');
      if (configMutation) throw new Error('Antigravity configuration is still being changed.');
      if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
      if (images?.length && !promptCapabilities.image) {
        throw new Error('This ACP agent does not advertise image prompt support.');
      }
      if (resources?.length && !promptCapabilities.embeddedContext) {
        throw new Error('This ACP agent does not advertise embedded context support.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    turnCancelled = false;
    const blocks: ContentBlock[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(resources ?? []).map(resource => ({
        type: 'resource' as const,
        resource: {
          uri: resource.uri,
          text: resource.text,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        },
      })),
      ...(images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
    ];
    const request = agentConnection.agent.request<typeof methods.agent.session.prompt>(methods.agent.session.prompt, {
      sessionId,
      prompt: blocks.length ? blocks : [{ type: 'text', text }],
    });
    activePrompt = request.then((response) => {
      if (typeof response?.stopReason !== 'string') {
        const error = new Error('Invalid Antigravity ACP session/prompt response: missing stopReason.');
        disconnect(error);
        throw error;
      }
      return response.stopReason;
    }).catch((cause: unknown) => {
      throw failure ?? explainError(cause, stderrTail);
    }).finally(() => {
      activePrompt = undefined;
      cancelPermissions();
      cancelElicitations();
    });
    return activePrompt;
  }

  function setConfigOption(configId: string, value: string | boolean): Promise<void> {
    try {
      assertOpen();
      if (activePrompt) throw new Error('An Antigravity prompt is already running. Cancel it or wait before changing configuration.');
      if (cancellation) throw new Error('Antigravity cancellation is still in progress.');
      if (configMutation) throw new Error('Antigravity configuration is still being changed.');
      if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
      const option = metadata.configOptions.find((candidate) => candidate.id === configId);
      if (!option) throw new Error(`Unknown Antigravity configuration option: ${configId}.`);
      const valid = option.type === 'boolean'
        ? typeof value === 'boolean'
        : typeof value === 'string' && option.options.some((entry) => (
          'options' in entry
            ? entry.options.some((candidate) => candidate.value === value)
            : entry.value === value
        ));
      if (!valid) throw new Error(`Invalid value for Antigravity configuration option: ${configId}.`);
    } catch (error) {
      return Promise.reject(error);
    }
    const params: SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, value };
    configMutation = agentConnection.agent.request<typeof methods.agent.session.setConfigOption>(methods.agent.session.setConfigOption, params).then((response) => {
      if (!Array.isArray(response?.configOptions)) {
        const error = new Error('Invalid Antigravity ACP session/set_config_option response: missing configOptions.');
        disconnect(error);
        throw error;
      }
      publishMetadata({ configOptions: response.configOptions });
    }).catch((cause: unknown) => {
      throw failure ?? explainError(cause, stderrTail);
    }).finally(() => {
      configMutation = undefined;
    });
    return configMutation;
  }

  function logout(): Promise<void> {
    try {
      assertOpen();
      if (!authentication.logout) throw new Error('Antigravity ACP does not support logout.');
      if (activePrompt) throw new Error('An Antigravity prompt is already running. Cancel it or wait before logging out.');
      if (cancellation) throw new Error('Antigravity cancellation is still in progress.');
      if (configMutation) throw new Error('Antigravity configuration is still being changed.');
      if (lifecycleMutation) throw new Error('An Antigravity session lifecycle operation is already running.');
      if (permissions.size) throw new Error('An Antigravity permission request is still awaiting an answer.');
      if (elicitations.size) throw new Error('An Antigravity follow-up question is still awaiting an answer.');
    } catch (error) {
      return Promise.reject(error);
    }
    lifecycleMutation = sessionRequest(async (requestOptions) => {
      await agentConnection.agent.request(methods.agent.logout, {}, requestOptions);
      assertOpen();
      loggedOut = true;
      turnCancelled = true;
      cancelPermissions();
      cancelElicitations();
      sessionId = '';
      metadata = { configOptions: [], availableCommands: [] };
      events.metadata?.(metadata);
    }).catch((cause: unknown) => {
      throw failure ?? explainError(cause, stderrTail);
    }).finally(() => {
      lifecycleMutation = undefined;
    });
    return lifecycleMutation;
  }

  function cancel(): Promise<void> {
    if (loggedOut) return Promise.reject(new Error('Antigravity ACP is logged out. Log in and open a fresh connection.'));
    if (lifecycleMutation && !closing && !failure) {
      return Promise.reject(new Error('An Antigravity session lifecycle operation is already running.'));
    }
    if (configMutation && !closing && !failure) {
      return Promise.reject(new Error('Antigravity configuration is still being changed.'));
    }
    turnCancelled = true;
    cancelPermissions();
    cancelElicitations();
    if (closing || failure) return Promise.resolve();
    if (cancellation) return cancellation;
    cancellation = sendCancel().catch((cause: unknown) => {
      disconnect(cause);
      throw failure ?? asError(cause);
    }).finally(() => {
      cancellation = undefined;
    });
    return cancellation;
  }

  return {
    get sessionId() { return sessionId; },
    get metadata() { return metadata; },
    get authentication() { return authentication; },
    get capabilities() { return capabilities; },
    get promptCapabilities() { return promptCapabilities; },
    listSessions,
    newSession: () => changeSession(undefined, 'new'),
    loadSession: (targetId) => changeSession(targetId, 'load'),
    resumeSession: (targetId) => changeSession(targetId, 'resume'),
    closeSession,
    setConfigOption,
    prompt,
    cancel,
    logout,
    close,
  };
}
