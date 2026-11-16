import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface TernOpenResult {
  ok: boolean;
  target?: string;
  error?: string;
}

/** Check whether a target path is safe to pass to `tern open`. */
export function resolveTernTarget(cwd: string, filePath: string, line?: number): string {
  const cleaned = filePath.trim();
  if (!cleaned || cleaned.startsWith('-') || /[\0-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`Invalid file target: ${filePath}`);
  }
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
  if (!existsSync(abs)) {
    throw new Error(`File not found on disk: ${filePath}`);
  }
  if (line !== undefined && Number.isInteger(line) && line > 0) {
    return `${abs}:${line}`;
  }
  return abs;
}

function runTernSubcommand(
  ternPath: string,
  args: string[],
  cwd: string,
  timeoutMessage: string,
  target?: string,
): Promise<TernOpenResult> {
  return new Promise(resolvePromise => {
    const child = spawn(ternPath, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolvePromise({ ok: false, error: timeoutMessage });
    }, 3_000);
    child.stderr.on('data', chunk => {
      if (stderr.length < 2_048) stderr += String(chunk);
    });
    child.once('error', err => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ ok: true, ...(target ? { target } : {}) });
      else resolvePromise({ ok: false, error: stderr.trim() || `tern exited with code ${code}` });
    });
  });
}

/** Open a workspace file side-by-side inside a Tern split pane without blocking the TUI loop. */
export async function openInTernSplit(
  cwd: string,
  filePath: string,
  options: { line?: number; mode?: 'right' | 'down' | 'tab' | 'preview'; ternBin?: string } = {},
): Promise<TernOpenResult> {
  let target: string;
  try {
    target = resolveTernTarget(cwd, filePath, options.line);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const ternPath = options.ternBin ?? Bun.which('tern');
  if (!ternPath) {
    return { ok: false, error: '`tern` CLI not found on PATH.' };
  }
  const mode = options.mode ?? 'right';
  const args = mode === 'tab'
    ? ['open', '--tab', target]
    : mode === 'preview'
      ? ['open', '--preview', target]
      : ['open', '--split', mode, target];
  return runTernSubcommand(ternPath, args, cwd, '`tern open` timed out.', target);
}

/** Execute a shell snippet in a kept-open Tern split pane scoped to the active workspace. */
export async function runCommandInTernSplit(
  cwd: string,
  command: string,
  options: { mode?: 'right' | 'down'; ternBin?: string } = {},
): Promise<TernOpenResult> {
  const cleaned = command.trim();
  if (!cleaned || cleaned.includes('\0') || cleaned.length > 8_000) {
    return { ok: false, error: 'Command must be non-empty and under 8,000 characters.' };
  }
  const ternPath = options.ternBin ?? Bun.which('tern');
  if (!ternPath) {
    return { ok: false, error: '`tern` CLI not found on PATH.' };
  }
  const mode = options.mode ?? 'right';
  const workdir = resolve(cwd);
  const args = ['split', '@focused', mode, '--cwd', workdir, '--keep-open', '--', '/bin/sh', '-lc', cleaned];
  return runTernSubcommand(ternPath, args, workdir, '`tern split` timed out.', cleaned);
}

function sanitizeOscText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f;]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Emit a standard terminal attention notification (OSC 9 + BEL) when attached to an interactive TTY. */
export function buildAttentionSequence(title: string, body?: string): string {
  const head = sanitizeOscText(title);
  const detail = body ? sanitizeOscText(body) : '';
  const payload = detail ? `${head}: ${detail}` : head;
  if (!payload) return '';
  return `\x1b]9;${payload}\x07\x07`;
}

export function sendTerminalAttention(
  title: string,
  body?: string,
  stream: { isTTY?: boolean; write(data: string): unknown } = process.stdout,
): boolean {
  if (!stream.isTTY) return false;
  const seq = buildAttentionSequence(title, body);
  if (!seq) return false;
  stream.write(seq);
  return true;
}
