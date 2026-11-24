#!/usr/bin/env bun
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildFallbackAgyArgs, CLI_HELP, parseCliArgs } from './cli-args';
import type { ChatLaunchState } from './ui';

interface ProbeOutput {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

async function runProbe(bin: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<ProbeOutput> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeoutMs);
  timer.unref?.();
  try {
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout && typeof proc.stdout !== 'number' ? new Response(proc.stdout).text() : Promise.resolve(''),
      proc.stderr && typeof proc.stderr !== 'number' ? new Response(proc.stderr).text() : Promise.resolve(''),
    ]);
    if (timedOut) {
      return { status: null, stdout, stderr, error: new Error(`Command timed out after ${timeoutMs}ms: ${bin} ${args.join(' ')}`) };
    }
    return { status, stdout, stderr };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeVersionLine(bin: string, args: readonly string[], cwd: string): Promise<string | undefined> {
  const res = await runProbe(bin, args, cwd, 3_000);
  if (res.error || res.status !== 0) return undefined;
  return `${res.stdout}\n${res.stderr}`.split(/\r?\n/).map(s => s.trim()).find(Boolean);
}

function detectClipboardCommand(): string | undefined {
  const candidates = process.platform === 'darwin' ? ['pbcopy'] : ['wl-copy', 'xclip', 'xsel'];
  for (const cmd of candidates) {
    const found = Bun.which(cmd);
    if (found) return found;
  }
  return undefined;
}

function detectClipboardPasteCommand(): string | undefined {
  const candidates = process.platform === 'darwin'
    ? ['pngpaste', 'osascript']
    : process.env.WAYLAND_DISPLAY
      ? ['wl-paste', 'xclip', 'powershell.exe']
      : ['xclip', 'wl-paste', 'powershell.exe'];
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
  if (parsed.version) {
    const { CURRENT_VERSION } = await import('./updater');
    console.log(`agy-tern ${CURRENT_VERSION}`);
    return;
  }
  if (parsed.update) {
    const { runSelfUpdate } = await import('./updater');
    await runSelfUpdate(parsed.update);
    return;
  }

  const executable = Bun.which(parsed.agy ?? 'agy');
  if (!executable) throw new Error('Official agy executable not found. Install Antigravity CLI or pass --agy /path/to/agy.');

  if (parsed.doctor) {
    const ternPath = Bun.which('tern');
    const [result, agyVersion, ternVersion] = await Promise.all([
      runProbe(executable, ['help', 'acp'], parsed.cwd, 10_000),
      probeVersionLine(executable, ['--version'], parsed.cwd),
      ternPath ? probeVersionLine(ternPath, ['--version'], parsed.cwd) : Promise.resolve(undefined),
    ]);
    if (result.error) throw result.error;
    const help = result.stdout + result.stderr;
    if (result.status !== 0 || !help.includes('--sandbox') || !help.includes('--stdio')) {
      throw new Error('This agy does not advertise the required ACP stdio and sandbox options. Update the official Antigravity CLI.');
    }
    const clipboard = detectClipboardCommand();
    const clipboardPaste = detectClipboardPasteCommand();
    const symlink = inspectEntrypointLink();
    const report = {
      bun: Bun.version,
      agy: executable,
      ...(agyVersion ? { agyVersion } : {}),
      acpOptions: ['--stdio', '--sandbox'],
      tern: ternPath ?? null,
      ...(ternVersion ? { ternVersion } : {}),
      clipboard: clipboard ?? null,
      clipboardPaste: clipboardPaste ?? null,
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
      `Clipboard copy: ${clipboard ?? 'not found (install wl-copy, xclip, or xsel)'}`,
      `Clipboard image paste: ${clipboardPaste ?? (process.platform === 'darwin' ? 'not found (install pngpaste or ensure osascript is available)' : process.env.WAYLAND_DISPLAY ? 'not found (install wl-clipboard: sudo dnf install wl-clipboard / sudo apt install wl-clipboard)' : 'not found (install xclip: sudo dnf install xclip / sudo apt install xclip)')}`,
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
  let launch: ChatLaunchState | undefined = (
    parsed.continueLast || parsed.conversationId || parsed.initialPrompt || parsed.maxFps !== undefined || parsed.motion !== undefined
  ) ? {
    ...(parsed.continueLast ? { continueLast: true } : {}),
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
    ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
    ...(parsed.maxFps !== undefined ? { maxFps: parsed.maxFps } : {}),
    ...(parsed.motion !== undefined ? { motion: parsed.motion } : {}),
  } : undefined;
  const { runNativeChat } = await import('./ui');
  while (true) {
    const result = await runNativeChat({
      cwd: parsed.cwd,
      executable,
      ...(parsed.additionalDirectories.length ? { additionalDirectories: parsed.additionalDirectories } : {}),
      ...(parsed.agentName ? { agentName: parsed.agentName } : {}),
      ...(parsed.appendSystemPrompt !== undefined ? { appendSystemPrompt: parsed.appendSystemPrompt } : {}),
      ...(Object.keys(initialConfig).length ? { initialConfig } : {}),
    }, launch);
    if (result.kind === 'unavailable') break;
    if (result.kind === 'quit') return;
    if (result.kind === 'handoff') {
      const handoffArgs = [
        '--sandbox',
        ...parsed.additionalDirectories.flatMap(dir => ['--add-dir', dir]),
        ...(parsed.agentName ? ['--agent', parsed.agentName] : []),
        ...(result.previousSessionId ? ['--conversation', result.previousSessionId] : []),
      ];
      console.error(`\n[agy-tern] ${result.reason}. Exit official agy (/exit or Ctrl+C) to return to agy-tern.\n`);
      const child = spawn(executable, handoffArgs, { cwd: parsed.cwd, stdio: 'inherit' });
      const forwardInterrupt = (): void => { child.kill('SIGINT'); };
      const forwardTerminate = (): void => { child.kill('SIGTERM'); };
      process.on('SIGINT', forwardInterrupt);
      process.on('SIGTERM', forwardTerminate);
      try {
        const done = Promise.withResolvers<number | null>();
        child.once('error', done.reject);
        child.once('exit', code => done.resolve(code));
        await done.promise;
      } finally {
        process.off('SIGINT', forwardInterrupt);
        process.off('SIGTERM', forwardTerminate);
      }
      process.exitCode = undefined;
      launch = {
        draft: result.draft,
        ...(result.previousSessionId ? { previousSessionId: result.previousSessionId, conversationId: result.previousSessionId } : {}),
        ...(result.returnPanel ? { openPanel: result.returnPanel } : {}),
        ...(parsed.maxFps !== undefined ? { maxFps: parsed.maxFps } : {}),
        ...(parsed.motion !== undefined ? { motion: parsed.motion } : {}),
        notice: { text: 'Returned from official agy CLI; refreshed session.', error: false },
      };
      continue;
    }
    const { runTerminalLogin } = await import('./auth');
    const login = await runTerminalLogin({ cwd: parsed.cwd, executable }, result.method);
    if (login.status === 'terminated') {
      process.exitCode = login.signal === 'SIGTERM' ? 143 : 129;
      return;
    }
    process.exitCode = undefined;
    launch = {
      draft: result.draft,
      ...(result.previousSessionId ? { previousSessionId: result.previousSessionId } : {}),
      ...(parsed.maxFps !== undefined ? { maxFps: parsed.maxFps } : {}),
      ...(parsed.motion !== undefined ? { motion: parsed.motion } : {}),
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
