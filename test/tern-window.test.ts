import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAttentionSequence, openInTernSplit, resolveTernTarget, sendTerminalAttention } from '../src/tern-window';

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
});
