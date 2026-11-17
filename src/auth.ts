import { spawn, type ChildProcess } from 'node:child_process';
import type { AuthMethodTerminal } from '@agentclientprotocol/sdk';
import { terminalLoginProblem, type AgentOptions } from './contracts';

export { terminalLoginProblem };

export type TerminalLoginResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }
  | { status: 'terminated'; signal: 'SIGTERM' | 'SIGHUP' };

const INTERRUPT_GRACE_MS = 500;
const TERMINATE_GRACE_MS = 1_000;

export async function runTerminalLogin(
  options: AgentOptions,
  method: AuthMethodTerminal,
): Promise<TerminalLoginResult> {
  const problem = terminalLoginProblem(method);
  if (problem) return { status: 'failed', message: problem };
  if (options.signal?.aborted) return { status: 'cancelled' };

  const processGroup = process.platform !== 'win32';

  let child: ChildProcess;
  try {
    child = spawn(options.executable ?? 'agy', ['acp', '--sandbox', ...method.args ?? []], {
      cwd: options.cwd,
      stdio: 'inherit',
      detached: processGroup,
    });
  } catch (cause) {
    return { status: 'failed', message: `Could not start official terminal login: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const completion = Promise.withResolvers<TerminalLoginResult>();
  let interrupted: Extract<TerminalLoginResult, { status: 'cancelled' | 'terminated' }> | undefined;
  let failure: Error | undefined;
  let closed = false;
  let terminateTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const signalChild = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || (!processGroup && closed)) return;
    try {
      if (processGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause;
    }
  };

  const interrupt = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void => {
    if (closed) return;
    if (signal !== 'SIGINT') interrupted = { status: 'terminated', signal };
    else interrupted ??= { status: 'cancelled' };
    signalChild(signal);
    if (terminateTimer || killTimer) return;
    terminateTimer = setTimeout(() => {
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), TERMINATE_GRACE_MS);
    }, INTERRUPT_GRACE_MS);
  };
  const onInterrupt = (): void => interrupt('SIGINT');
  const onTerminate = (): void => interrupt('SIGTERM');
  const onHangup = (): void => interrupt('SIGHUP');
  child.once('error', error => { failure = error; });
  child.once('close', (code, signal) => {
    closed = true;
    if (interrupted) completion.resolve(interrupted);
    else if (failure) completion.resolve({ status: 'failed', message: `Could not run official terminal login: ${failure.message}` });
    else if (signal === 'SIGINT') completion.resolve({ status: 'cancelled' });
    else if (code === 0) completion.resolve({ status: 'success' });
    else completion.resolve({ status: 'failed', message: signal
      ? `Official terminal login ended with ${signal}.`
      : `Official terminal login exited with code ${code ?? 'unknown'}.` });
  });
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.on('SIGHUP', onHangup);
  options.signal?.addEventListener('abort', onInterrupt, { once: true });
  if (options.signal?.aborted) onInterrupt();
  try {
    const result = await completion.promise;
    // A cancelled leader can exit before its auth helpers; never target other groups.
    if (processGroup && result.status !== 'success') signalChild('SIGKILL');
    return result;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('SIGHUP', onHangup);
    options.signal?.removeEventListener('abort', onInterrupt);
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
  }
}
