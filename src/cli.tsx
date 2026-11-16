#!/usr/bin/env bun
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runTerminalLogin } from './auth';
import { buildFallbackAgyArgs, CLI_HELP, parseCliArgs } from './cli-args';
import { runNativeChat, type ChatLaunchState } from './ui';

function probeVersionLine(bin: string, args: string[]): string | undefined {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 3_000 });
  if (res.error || res.status !== 0) return undefined;
  const line = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return line;
}

function detectClipboardCommand(): string | undefined {
  const candidates = process.platform === 'darwin' ? ['pbcopy'] : ['wl-copy', 'xclip', 'xsel'];
  for (const cmd of candidates) {
    const found = Bun.which(cmd);
    if (found) return found;
  }
  return undefined;
}

function inspectEntrypointLink(): { path: string; target?: string; valid: boolean } | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  try {
    const st = lstatSync(entry);
    if (!st.isSymbolicLink()) return undefined;
    const rawTarget = readlinkSync(entry);
    const resolved = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(entry), rawTarget);
    return { path: entry, target: resolved, valid: existsSync(resolved) };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(CLI_HELP);
    return;
  }

  const executable = Bun.which(parsed.agy ?? 'agy');
  if (!executable) throw new Error('Official agy executable not found. Install Antigravity CLI or pass --agy /path/to/agy.');

  if (parsed.doctor) {
    const result = spawnSync(executable, ['help', 'acp'], { cwd: parsed.cwd, encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    const help = result.stdout + result.stderr;
    if (result.status !== 0 || !help.includes('--sandbox') || !help.includes('--stdio')) {
      throw new Error('This agy does not advertise the required ACP stdio and sandbox options. Update the official Antigravity CLI.');
    }
    const ternPath = Bun.which('tern');
    const agyVersion = probeVersionLine(executable, ['--version']);
    const ternVersion = ternPath ? probeVersionLine(ternPath, ['--version']) : undefined;
    const clipboard = detectClipboardCommand();
    const symlink = inspectEntrypointLink();
    const report = {
      bun: Bun.version,
      agy: executable,
      ...(agyVersion ? { agyVersion } : {}),
      acpOptions: ['--stdio', '--sandbox'],
      tern: ternPath ?? null,
      ...(ternVersion ? { ternVersion } : {}),
      clipboard: clipboard ?? null,
      ...(symlink ? { launcherSymlink: symlink } : {}),
      workspace: parsed.cwd,
      unverified: ['authentication', 'os_sandbox_enforcement'],
    };
    if (parsed.doctorJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log([
      `Bun: ${report.bun}`,
      `agy: ${report.agy}${agyVersion ? ` (${agyVersion})` : ''}`,
      'ACP: stdio and sandbox options available',
      `Tern: ${ternPath ? `${ternPath}${ternVersion ? ` (${ternVersion})` : ''}` : 'not on PATH (official agy fallback available)'}`,
      `Clipboard: ${clipboard ?? 'not found (install wl-copy, xclip, or xsel)'}`,
      ...(symlink ? [`Launcher: ${symlink.path} -> ${symlink.target} (${symlink.valid ? 'ok' : 'broken'})`] : []),
      `Workspace: ${report.workspace}`,
      'Authentication and OS sandbox enforcement: not checked',
    ].join('\n'));
    return;
  }

  const initialConfig = {
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
  };
  let launch: ChatLaunchState | undefined = (parsed.continueLast || parsed.conversationId || parsed.initialPrompt) ? {
    ...(parsed.continueLast ? { continueLast: true } : {}),
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
    ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
  } : undefined;
  while (true) {
    const result = await runNativeChat({
      cwd: parsed.cwd,
      executable,
      ...(parsed.additionalDirectories.length ? { additionalDirectories: parsed.additionalDirectories } : {}),
      ...(parsed.agentName ? { agentName: parsed.agentName } : {}),
      ...(Object.keys(initialConfig).length ? { initialConfig } : {}),
    }, launch);
    if (result.kind === 'unavailable') break;
    if (result.kind === 'quit') return;
    const login = await runTerminalLogin({ cwd: parsed.cwd, executable }, result.method);
    if (login.status === 'terminated') {
      process.exitCode = login.signal === 'SIGTERM' ? 143 : 129;
      return;
    }
    process.exitCode = undefined;
    launch = {
      draft: result.draft,
      ...(result.previousSessionId ? { previousSessionId: result.previousSessionId } : {}),
      notice: {
        text: login.status === 'success'
          ? 'Official terminal login exited successfully. Starting a fresh connection; account identity and access are not verified.'
          : login.status === 'cancelled' ? 'Terminal login cancelled.' : `Terminal login failed: ${login.message}`,
        error: login.status !== 'success',
      },
      openAccount: login.status !== 'success',
    };
  }

  console.error('Tern Surface Protocol unavailable; opening the official agy UI.');
  const child = spawn(executable, buildFallbackAgyArgs(parsed), { cwd: parsed.cwd, stdio: 'inherit' });
  const forwardInterrupt = (): void => { child.kill('SIGINT'); };
  const forwardTerminate = (): void => { child.kill('SIGTERM'); };
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  try {
    const completion = Promise.withResolvers<number>();
    child.once('error', completion.reject);
    child.once('exit', (code, signal) => completion.resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    process.exitCode = await completion.promise;
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
}

main().catch(error => {
  console.error(`agy-tern: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
