#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { isatty } from 'node:tty';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const cwd = process.cwd();

function logMeta(entry: Record<string, unknown>): void {
  const logPath = process.env.AGY_E2E_META_LOG;
  if (!logPath) return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

if (argv[0] === 'descendant') {
  process.on('SIGINT', () => {
    appendFileSync(join(cwd, 'descendant-signals.txt'), 'SIGINT\n');
  });
  process.on('SIGTERM', () => {
    appendFileSync(join(cwd, 'descendant-signals.txt'), 'SIGTERM\n');
    process.exit(0);
  });
  const tmpPath = join(cwd, 'descendant-ready.tmp');
  const readyPath = join(cwd, 'descendant-ready.json');
  writeFileSync(tmpPath, JSON.stringify({ pid: process.pid }));
  renameSync(tmpPath, readyPath);
  process.send?.('ready');
  setInterval(() => {}, 60_000);
} else if (argv[0] === 'help' && argv[1] === 'acp') {
  console.log('Usage: agy acp [--stdio] [--sandbox] [--add-dir DIR] [--agent NAME]');
  process.exit(0);
} else if (argv.includes('--version')) {
  console.log('e2e-auth 1.0.0');
  process.exit(0);
} else if (argv.includes('--login') || argv[0] !== 'acp') {
  const mode = (process.env.AGY_E2E_AUTH_MODE ?? 'success').toLowerCase();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

  if (mode.includes('ignore-signals')) {
    for (const sig of signals) {
      process.on(sig, () => appendFileSync(join(cwd, 'signals.txt'), `${sig}\n`));
    }
  } else if (mode.includes('cancel-exit-zero')) {
    for (const sig of signals) {
      process.on(sig, () => {
        appendFileSync(join(cwd, 'signals.txt'), `${sig}\n`);
        process.exit(0);
      });
    }
  }

  let descendantPid: number | undefined;
  if (mode.includes('descendants')) {
    const ready = Promise.withResolvers<void>();
    const descendant = spawn(process.execPath, [import.meta.path, 'descendant'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    descendant.once('error', ready.reject);
    descendant.once('message', () => ready.resolve());
    await ready.promise;
    descendantPid = descendant.pid;
  }

  const descriptors = [0, 1, 2].map(fd => {
    try {
      const st = fstatSync(fd);
      return { dev: st.dev, ino: st.ino, rdev: st.rdev };
    } catch {
      return null;
    }
  });
  const ttyFlags = [0, 1, 2].map(fd => isatty(fd));

  const reportPath = process.env.AGY_E2E_AUTH_REPORT || join(cwd, 'report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  const tmpReport = `${reportPath}.tmp-${process.pid}`;
  writeFileSync(
    tmpReport,
    JSON.stringify({
      pid: process.pid,
      descendantPid,
      cwd,
      executable: process.argv[1],
      args: argv,
      path: process.env.PATH,
      descriptors,
      isTTY: ttyFlags,
      authMode: mode,
    }),
  );
  renameSync(tmpReport, reportPath);

  logMeta({ event: 'auth_login', mode, pid: process.pid, args: argv, cwd });

  if (mode.includes('nonzero') || mode.includes('fail')) {
    process.stderr.write('Synthetic auth failure\n');
    process.exit(Number(process.env.AGY_E2E_AUTH_EXIT ?? '17'));
  }

  if (mode.includes('wait') || mode.includes('ignore-signals') || mode.includes('cancel-exit-zero')) {
    if (!mode.includes('ignore-signals') && !mode.includes('cancel-exit-zero')) {
      process.once('SIGINT', () => process.exit(130));
    }
    setInterval(() => {}, 60_000);
  } else {
    const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
    if (markerPath) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, 'SYNTHETIC e2e login marker\n');
    }
    console.log('Synthetic terminal login complete. No real account was accessed.');
    process.exit(0);
  }
} else {
  const connection = agent({ name: 'e2e-auth-fixture' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [
        { id: 'terminal-login', name: 'Log in from the terminal', type: 'terminal', args: ['--login'] },
      ],
      agentCapabilities: {
        auth: { logout: {} },
      },
      agentInfo: { name: 'e2e-auth-fixture', version: '1.0.0' },
    }))
    .onRequest(methods.agent.session.new, () => {
      const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
      const requireAuth = process.env.AGY_E2E_AUTH_REQUIRE === '1';
      if ((markerPath && !existsSync(markerPath)) || (requireAuth && !markerPath)) {
        throw RequestError.authRequired();
      }
      return { sessionId: 'auth-session-1' };
    })
    .onRequest(methods.agent.logout, () => {
      const markerPath = process.env.AGY_E2E_LOGIN_MARKER;
      if (markerPath) {
        rmSync(markerPath, { force: true });
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const first = params.prompt[0];
      const text = first?.type === 'text' ? first.text : '';
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Auth session active: ${text}` },
        },
      });
      return { stopReason: 'end_turn' };
    })
    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

  await connection.closed;
}
