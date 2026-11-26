import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAttentionSequence, isSafeExternalUrl, openExternalUrl, openInTernSplit, openOfficialAgyInTernSplit, resolveTernTarget, runCommandInTernSplit, sendDesktopNotification, sendTerminalAttention } from '../src/tern-window';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-tern-win-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Tern window and notification helpers', () => {
  test('validates file paths and optional line numbers for tern open', async () => {
    const dir = await tempDir();
    const targetFile = join(dir, 'sample.ts');
    await writeFile(targetFile, 'export const a = 1;\n', 'utf8');

    expect(resolveTernTarget(dir, 'sample.ts')).toBe(targetFile);
    expect(resolveTernTarget(dir, 'sample.ts', 12)).toBe(`${targetFile}:12`);
    expect(() => resolveTernTarget(dir, '--split')).toThrow('Invalid file target');
    expect(() => resolveTernTarget(dir, 'missing.ts')).toThrow('File not found on disk');
  });

  test('executes tern open --split right cleanly and captures errors', async () => {
    const dir = await tempDir();
    const targetFile = join(dir, 'code.ts');
    const logFile = join(dir, 'tern.log');
    const fakeTern = join(dir, 'tern-stub');
    await writeFile(targetFile, 'console.log(1);\n', 'utf8');
    await writeFile(fakeTern, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
exit 0
`, 'utf8');
    await chmod(fakeTern, 0o755);

    const res = await openInTernSplit(dir, 'code.ts', { line: 4, ternBin: fakeTern });
    expect(res).toEqual({ ok: true, target: `${targetFile}:4` });
    expect(await readFile(logFile, 'utf8')).toContain(`open --split right ${targetFile}:4`);

    const missing = await openInTernSplit(dir, 'nope.ts', { ternBin: fakeTern });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('File not found on disk');

    const expectedPane = process.env.TERN_PANE?.trim() || '@focused';
    const cmdRes = await runCommandInTernSplit(dir, 'bun test', { ternBin: fakeTern });
    expect(cmdRes).toEqual({ ok: true, target: 'bun test' });
    expect(await readFile(logFile, 'utf8')).toContain(`split ${expectedPane} right --cwd ${dir} --keep-open -- /bin/sh -lc bun test`);

    const explicitBlockRes = await runCommandInTernSplit(dir, 'bun test', { block: '@focused', ternBin: fakeTern });
    expect(explicitBlockRes).toEqual({ ok: true, target: 'bun test' });
    expect(await readFile(logFile, 'utf8')).toContain(`split @focused right --cwd ${dir} --keep-open -- /bin/sh -lc bun test`);

    const emptyCmd = await runCommandInTernSplit(dir, '   ', { ternBin: fakeTern });
    expect(emptyCmd.ok).toBe(false);

    const agySplit = await openOfficialAgyInTernSplit(dir, { block: '@focused', ternBin: fakeTern });
    expect(agySplit).toEqual({ ok: true, target: 'agy --sandbox' });
    expect(await readFile(logFile, 'utf8')).toContain(`split @focused right --cwd ${dir} -- agy --sandbox`);

    const customAgySplit = await openOfficialAgyInTernSplit(dir, { executable: '/usr/local/bin/agy', mode: 'down', block: '@focused', ternBin: fakeTern });
    expect(customAgySplit).toEqual({ ok: true, target: '/usr/local/bin/agy --sandbox' });
    expect(await readFile(logFile, 'utf8')).toContain(`split @focused down --cwd ${dir} -- /usr/local/bin/agy --sandbox`);

    const badAgySplit = await openOfficialAgyInTernSplit(dir, { executable: '--bad', ternBin: fakeTern });
    expect(badAgySplit.ok).toBe(false);
  });

  test('sanitizes and emits OSC 9 attention sequence only on TTY streams', () => {
    expect(buildAttentionSequence('agy-tern', 'Turn; done\nnow')).toBe('\x1b]9;agy-tern: Turn done now\x07\x07');
    let output = '';
    const nonTty = { isTTY: false, write: (chunk: string) => { output += chunk; return true; } };
    expect(sendTerminalAttention('agy-tern', 'Ready', nonTty)).toBe(false);
    expect(output).toBe('');

    const tty = { isTTY: true, write: (chunk: string) => { output += chunk; return true; } };
    expect(sendTerminalAttention('agy-tern', 'Ready', tty)).toBe(true);
    expect(output).toBe('\x1b]9;agy-tern: Ready\x07\x07');
  });

  test('dispatches OS desktop notification cleanly on Linux/macOS and degrades quietly when unavailable', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    expect(await sendDesktopNotification('agy-tern', 'Turn; done\nnow', {
      platform: 'linux',
      hasCommand: cmd => cmd === 'notify-send',
      exec: async (cmd, args) => { calls.push({ cmd, args }); },
    })).toBe(true);
    expect(calls[0]).toEqual({ cmd: 'notify-send', args: ['-a', 'agy-tern', 'agy-tern', 'Turn done now'] });

    expect(await sendDesktopNotification('agy-tern', 'Approval required', {
      platform: 'darwin',
      hasCommand: cmd => cmd === 'osascript',
      exec: async (cmd, args) => { calls.push({ cmd, args }); },
    })).toBe(true);
    expect(calls[1]?.cmd).toBe('osascript');
    expect(calls[1]?.args.slice(-2)).toEqual(['Approval required', 'agy-tern']);

    expect(await sendDesktopNotification('agy-tern', 'Done', {
      platform: 'linux',
      hasCommand: () => false,
    })).toBe(false);
  });

  test('validates and opens only safe external https or localhost http URLs', async () => {
    expect(isSafeExternalUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=1')).toBe(true);
    expect(isSafeExternalUrl('http://127.0.0.1:33313/callback')).toBe(true);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const opened = await openExternalUrl('https://accounts.google.com/o/oauth2/v2/auth', {
      platform: 'linux',
      hasCommand: cmd => cmd === 'xdg-open',
      exec: async (cmd, args) => { calls.push({ cmd, args }); },
    });
    expect(opened.ok).toBe(true);
    expect(calls[0]).toEqual({ cmd: 'xdg-open', args: ['https://accounts.google.com/o/oauth2/v2/auth'] });

    const blocked = await openExternalUrl('file:///etc/passwd', {
      platform: 'linux',
      hasCommand: () => true,
    });
    expect(blocked.ok).toBe(false);
  });
});
