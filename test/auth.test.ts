import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, fstatSync, watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMethodTerminal } from '@agentclientprotocol/sdk';
import { runTerminalLogin, terminalLoginProblem, type TerminalLoginResult } from '../src/auth';

const fixture = fileURLToPath(new URL('./fixtures/auth.ts', import.meta.url));
const method: AuthMethodTerminal = { id: 'terminal-login', name: 'Fixture terminal login', args: ['--login'] };
const workspaces: string[] = [];
const logins: Array<{ controller: AbortController; result: Promise<TerminalLoginResult> }> = [];
const drivers: Array<{ child: ChildProcess; closed: Promise<number | null> }> = [];

async function workspace(scenario = 'success'): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `agy-auth-${scenario}-`));
  workspaces.push(cwd);
  return cwd;
}

function startLogin(cwd: string, descriptor = method, executable = fixture) {
  const controller = new AbortController();
  const result = runTerminalLogin({ cwd, executable, signal: controller.signal }, descriptor);
  const login = { controller, result };
  logins.push(login);
  return login;
}

async function waitForFile(path: string): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), { signal: AbortSignal.timeout(5_000) }, () => {
    if (existsSync(path)) ready.resolve();
  });
  // Bun 1.2.22 can drop subsequent directory watch events after an earlier file rename.
  const poll = setInterval(() => {
    if (existsSync(path)) ready.resolve();
  }, 20);
  watcher.once('error', ready.reject);
  watcher.once('close', () => ready.reject(new Error(`Stopped waiting for ${path}`)));
  try {
    if (existsSync(path)) ready.resolve();
    await ready.promise;
  } finally {
    clearInterval(poll);
    watcher.close();
  }
}

interface Report {
  pid: number;
  descendantPid?: number;
  cwd: string;
  executable: string;
  args: string[];
  path?: string;
  descriptors: Array<{ dev: number; ino: number; rdev: number }>;
}

async function report(cwd: string): Promise<Report> {
  const path = join(cwd, 'report.json');
  await waitForFile(path);
  return JSON.parse(await readFile(path, 'utf8'));
}

function startDriver(cwd: string, role: 'driver' | 'descendant' = 'driver') {
  const child = spawn(process.execPath, [fixture, role, cwd], { cwd, stdio: 'ignore' });
  const completion = Promise.withResolvers<number | null>();
  child.once('error', completion.reject);
  child.once('close', code => completion.resolve(code));
  const driver = { child, closed: completion.promise };
  drivers.push(driver);
  return driver;
}

function expectReaped(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

afterEach(async () => {
  for (const login of logins) login.controller.abort();
  await Promise.all(logins.splice(0).map(login => login.result));
  for (const driver of drivers) {
    if (driver.child.exitCode === null && driver.child.signalCode === null) driver.child.kill('SIGTERM');
  }
  await Promise.all(drivers.splice(0).map(driver => driver.closed));
  await Promise.all(workspaces.splice(0).map(cwd => rm(cwd, { recursive: true, force: true })));
});

describe('official terminal login', () => {
  test('runs the configured executable in the workspace with inherited terminal and environment', async () => {
    const cwd = await workspace();
    const login = startLogin(cwd);
    expect(await login.result).toEqual({ status: 'success' });
    const observed = await report(cwd);
    expect(observed.cwd).toBe(cwd);
    expect(observed.executable).toBe(fixture);
    expect(observed.args).toEqual(['acp', '--sandbox', '--login']);
    expect(observed.path).toBe(process.env.PATH);
    expect(observed.descriptors).toEqual([0, 1, 2].map(fd => {
      const stat = fstatSync(fd);
      return { dev: stat.dev, ino: stat.ino, rdev: stat.rdev };
    }));
    expectReaped(observed.pid);
  });

  test('accepts an empty environment descriptor without changing the inherited environment', async () => {
    const cwd = await workspace();
    expect(terminalLoginProblem({ ...method, env: {} })).toBeUndefined();
    expect(await startLogin(cwd, { ...method, env: {} }).result).toEqual({ status: 'success' });
    expect((await report(cwd)).path).toBe(process.env.PATH);
  });

  test('reports the actual unsuccessful exit code and reaps the process', async () => {
    const cwd = await workspace('nonzero');
    const result = await startLogin(cwd).result;
    if (result.status !== 'failed') throw new Error('Expected failed login');
    expect(result.message).toMatch(/\b7\b/);
    expectReaped((await report(cwd)).pid);
  });

  test('reports launch errors without falling back to another executable', async () => {
    const cwd = await workspace();
    const result = await startLogin(cwd, method, join(cwd, 'missing-agy')).result;
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected launch failure');
    expect(result.message).toContain('missing-agy');
    expect(existsSync(join(cwd, 'report.json'))).toBe(false);
  });

  test('rejects unsupported arguments and environment overrides before launching', async () => {
    const cwd = await workspace();
    const descriptors: AuthMethodTerminal[] = [
      { ...method, args: undefined },
      { ...method, args: [] },
      { ...method, args: ['--login', '--endpoint=https://example.invalid'] },
      { ...method, args: ['--login', '--no-sandbox'] },
      { ...method, args: ['--login; touch injected'] },
      { ...method, env: { HTTPS_PROXY: 'https://example.invalid' } },
      { ...method, env: { PATH: '/untrusted' } },
    ];
    for (const descriptor of descriptors) {
      const problem = terminalLoginProblem(descriptor);
      if (!problem) throw new Error('Unsafe terminal login descriptor was accepted');
      expect(await startLogin(cwd, descriptor).result).toMatchObject({ status: 'failed' });
    }
    expect(existsSync(join(cwd, 'report.json'))).toBe(false);
    expect(existsSync(join(cwd, 'injected'))).toBe(false);
  });

  test('does not interpret executable text through a shell', async () => {
    const cwd = await workspace();
    const result = await startLogin(cwd, method, `${fixture}; touch ${join(cwd, 'injected')}`).result;
    expect(result.status).toBe('failed');
    expect(existsSync(join(cwd, 'injected'))).toBe(false);
    expect(existsSync(join(cwd, 'report.json'))).toBe(false);
  });

  test('an already-aborted signal prevents process creation', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort();
    expect(await runTerminalLogin({ cwd, executable: fixture, signal: controller.signal }, method)).toEqual({ status: 'cancelled' });
    expect(existsSync(join(cwd, 'report.json'))).toBe(false);
  });

  test('abort remains cancellation when the child handles SIGINT by exiting successfully', async () => {
    const cwd = await workspace('cancel-exit-zero');
    const login = startLogin(cwd);
    const observed = await report(cwd);
    login.controller.abort();
    expect(await login.result).toEqual({ status: 'cancelled' });
    expect(await readFile(join(cwd, 'signals.txt'), 'utf8')).toBe('SIGINT\n');
    expectReaped(observed.pid);
  });

  test('ignored interrupt and TERM escalate to KILL and are reaped', async () => {
    const cwd = await workspace('ignore-signals');
    const login = startLogin(cwd);
    const observed = await report(cwd);
    login.controller.abort();
    expect(await login.result).toEqual({ status: 'cancelled' });
    expect(await readFile(join(cwd, 'signals.txt'), 'utf8')).toBe('SIGINT\nSIGTERM\n');
    expectReaped(observed.pid);
  });

  test.skipIf(process.platform === 'win32')('cancels owned login descendants without signalling unrelated processes', async () => {
    const unrelatedCwd = await workspace('unrelated');
    const unrelated = startDriver(unrelatedCwd, 'descendant');
    await waitForFile(join(unrelatedCwd, 'descendant-ready.json'));
    const cwd = await workspace('ignore-signals-descendants');
    const login = startLogin(cwd);
    const observed = await report(cwd);
    if (observed.descendantPid === undefined) throw new Error('Fixture did not start its auth helper');
    login.controller.abort();
    expect(await login.result).toEqual({ status: 'cancelled' });
    expect(await readFile(join(cwd, 'descendant-signals.txt'), 'utf8')).toBe('SIGINT\nSIGTERM\n');
    expectReaped(observed.pid);
    expectReaped(observed.descendantPid);
    expect(unrelated.child.exitCode).toBeNull();
    expect(unrelated.child.signalCode).toBeNull();
    expect(existsSync(join(unrelatedCwd, 'descendant-signals.txt'))).toBe(false);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`forwards ${signal}, preserves its outcome, and restores parent handlers`, async () => {
      const cwd = await workspace('cancel-exit-zero');
      const driver = startDriver(cwd);
      const observed = await report(cwd);
      expect(driver.child.kill(signal)).toBe(true);
      expect(await driver.closed).toBe(0);
      const result = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'));
      expect(result).toEqual({
        result: signal === 'SIGINT' ? { status: 'cancelled' } : { status: 'terminated', signal },
        handlersRestored: true,
      });
      expect(await readFile(join(cwd, 'signals.txt'), 'utf8')).toBe(`${signal}\n`);
      expectReaped(observed.pid);
    });
  }
});
