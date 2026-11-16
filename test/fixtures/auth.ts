#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { appendFileSync, fstatSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AuthMethodTerminal } from '@agentclientprotocol/sdk';
import { runTerminalLogin } from '../../src/auth';

const method: AuthMethodTerminal = { id: 'terminal-login', name: 'Fixture terminal login', args: ['--login'] };

if (process.argv[2] === 'driver') {
  const cwd = process.argv[3]!;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const before = signals.map(signal => process.listenerCount(signal));
  const result = await runTerminalLogin({ cwd, executable: import.meta.path }, method);
  writeFileSync(join(cwd, 'result.json'), JSON.stringify({
    result,
    handlersRestored: signals.every((signal, index) => process.listenerCount(signal) === before[index]),
  }));
} else if (process.argv[2] === 'descendant') {
  process.on('SIGINT', () => appendFileSync('descendant-signals.txt', 'SIGINT\n'));
  process.on('SIGTERM', () => {
    appendFileSync('descendant-signals.txt', 'SIGTERM\n');
    process.exit(0);
  });
  writeFileSync('descendant-ready.tmp', JSON.stringify({ pid: process.pid }));
  renameSync('descendant-ready.tmp', 'descendant-ready.json');
  process.send?.('ready');
  setInterval(() => {}, 60_000);
} else {
  const scenario = basename(process.cwd());
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  if (scenario.includes('ignore-signals')) {
    for (const signal of signals) {
      process.on(signal, () => appendFileSync('signals.txt', `${signal}\n`));
    }
  } else if (scenario.includes('cancel-exit-zero')) {
    for (const signal of signals) {
      process.on(signal, () => {
        appendFileSync('signals.txt', `${signal}\n`);
        process.exit(0);
      });
    }
  }
  let descendantPid: number | undefined;
  if (scenario.includes('descendants')) {
    const ready = Promise.withResolvers<void>();
    const descendant = spawn(process.execPath, [import.meta.path, 'descendant'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    descendant.once('error', ready.reject);
    descendant.once('message', () => ready.resolve());
    await ready.promise;
    descendantPid = descendant.pid;
  }
  const descriptors = [0, 1, 2].map(fd => {
    const stat = fstatSync(fd);
    return { dev: stat.dev, ino: stat.ino, rdev: stat.rdev };
  });
  writeFileSync('report.tmp', JSON.stringify({
    pid: process.pid,
    descendantPid,
    cwd: process.cwd(),
    executable: process.argv[1],
    args: process.argv.slice(2),
    path: process.env.PATH,
    descriptors,
  }));
  renameSync('report.tmp', 'report.json');
  if (scenario.includes('nonzero')) process.exit(7);
  if (scenario.includes('ignore-signals') || scenario.includes('cancel-exit-zero') || scenario.includes('wait')) {
    setInterval(() => {}, 60_000);
  }
}
