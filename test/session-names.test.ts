import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionNames } from '../src/session-names';

let root: string;
let directory: string;
let names: SessionNames;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agy-tern-session-names-'));
  directory = join(root, 'session-names');
  names = new SessionNames(join(root, 'workspace'), directory);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storedFile(): Promise<string> {
  const files = await readdir(directory);
  const file = files[0];
  if (files.length !== 1 || file === undefined) throw new Error('Expected one stored label');
  return join(directory, file);
}

describe('local session names', () => {
  test('does not create storage when constructed, reading a missing name or clearing it', async () => {
    expect(await readdir(root)).toEqual([]);
    expect(await names.get('missing')).toBeUndefined();
    await names.set('missing', '   ');
    expect(await readdir(root)).toEqual([]);
  });

  test('trims, persists, replaces and clears only the chosen local label', async () => {
    await names.set('session', '  Investigate parser  ');
    const reopened = new SessionNames(join(root, 'workspace'), directory);
    expect(await reopened.get('session')).toBe('Investigate parser');
    expect(await readFile(await storedFile(), 'utf8')).toBe('Investigate parser');
    await reopened.set('session', 'Parser fixed');
    expect(await names.get('session')).toBe('Parser fixed');
    await names.set('session', '');
    expect(await reopened.get('session')).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  test('scopes the same opaque session ID to its workspace', async () => {
    const other = new SessionNames(join(root, 'other-workspace'), directory);
    await names.set('same-id', 'First workspace');
    expect(await other.get('same-id')).toBeUndefined();
    await other.set('same-id', 'Second workspace');
    expect(await names.get('same-id')).toBe('First workspace');
    expect(await other.get('same-id')).toBe('Second workspace');
    await other.set('same-id', '');
    expect(await names.get('same-id')).toBe('First workspace');
  });
});

describe('private session name storage', () => {
  test('treats traversal and absolute session IDs as opaque values', async () => {
    const outside = join(root, 'escape');
    await writeFile(outside, 'untouched');
    const ids = ['../escape', '../../escape', outside, 'a/b\\c\u0000d'];
    for (const [index, id] of ids.entries()) await names.set(id, `Label ${index}`);
    for (const [index, id] of ids.entries()) expect(await names.get(id)).toBe(`Label ${index}`);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await readdir(root)).sort()).toEqual(['escape', 'session-names']);
    const files = await readdir(directory);
    expect(files).toHaveLength(ids.length);
    for (const file of files) expect(file).toMatch(/^[a-f0-9]{64}\.txt$/);
  });

  test('keeps the directory owner-only and files owner-readable and writable after replacement', async () => {
    await mkdir(directory);
    await chmod(directory, 0o777);
    await names.set('session', 'Private label');
    const file = await storedFile();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await chmod(file, 0o666);
    await names.set('session', 'Replacement');
    expect((await stat(await storedFile())).mode & 0o777).toBe(0o600);
    expect(await names.get('session')).toBe('Replacement');
  });

  test('does not lose distinct-session labels during simultaneous writes', async () => {
    const ids = Array.from({ length: 32 }, (_, index) => `session-${index}`);
    await Promise.all(ids.map((id, index) => names.set(id, `Label ${index}`)));
    expect(await Promise.all(ids.map(id => names.get(id))))
      .toEqual(Array.from({ length: 32 }, (_, index) => `Label ${index}`));
    expect(await readdir(directory)).toHaveLength(ids.length);
  });

  test('preserves sequential last writes and publishes only whole labels during concurrent writes', async () => {
    await names.set('session', 'Initial');
    const labels = Array.from({ length: 16 }, (_, index) => `Label ${index} ${'x'.repeat(120)}`);
    await Promise.all(labels.map(label => names.set('session', label)));
    const stored = await names.get('session');
    if (stored === undefined) throw new Error('A completed write must publish a session name');
    expect(labels).toContain(stored);
    expect(await readdir(directory)).toHaveLength(1);
    await names.set('session', 'Final');
    expect(await names.get('session')).toBe('Final');
  });

  test('surfaces non-missing read and write failures', async () => {
    await writeFile(directory, 'not a directory');
    await expect(names.get('session')).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(names.set('session', 'Label')).rejects.toThrow();
    await expect(names.set('session', '')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('session name validation', () => {
  test.each([
    ['line feed', 'first\nsecond'],
    ['leading line feed', '\nLabel'],
    ['carriage return', 'first\rsecond'],
    ['tab', 'first\tsecond'],
    ['null', 'first\u0000second'],
    ['escape', '\u001b[31mLabel'],
    ['delete', 'first\u007fsecond'],
    ['C1 control', 'first\u0085second'],
    ['line separator', 'first\u2028second'],
    ['paragraph separator', 'first\u2029second'],
    ['unpaired surrogate', 'first\ud800second'],
    ['161 UTF-16 units', 'x'.repeat(161)],
    ['81 supplementary characters', '😀'.repeat(81)],
  ])('rejects %s without replacing an existing label', async (_description, input) => {
    await names.set('session', 'Original');
    await expect(names.set('session', input)).rejects.toThrow();
    expect(await names.get('session')).toBe('Original');
    expect(await readdir(directory)).toHaveLength(1);
  });

  test('accepts exactly 160 UTF-16 units including supplementary characters', async () => {
    await names.set('session', 'x'.repeat(160));
    expect(await names.get('session')).toBe('x'.repeat(160));
    await names.set('session', `  ${'😀'.repeat(80)}  `);
    expect(await names.get('session')).toBe('😀'.repeat(80));
  });

  test.each([
    ['empty', Buffer.from('')],
    ['whitespace', Buffer.from('   ')],
    ['untrimmed', Buffer.from(' Label ')],
    ['multiline', Buffer.from('first\nsecond')],
    ['control', Buffer.from('first\u001bsecond')],
    ['line separator', Buffer.from('first\u2028second')],
    ['oversized', Buffer.from('x'.repeat(161))],
    ['oversized supplementary characters', Buffer.from('😀'.repeat(81))],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['UTF-8 surrogate', Buffer.from([0xed, 0xa0, 0x80])],
  ])('surfaces corrupt %s stored labels rather than treating them as absent', async (_description, contents) => {
    await names.set('session', 'Original');
    await writeFile(await storedFile(), contents);
    await expect(names.get('session')).rejects.toThrow();
  });
});

describe('session name state directory', () => {
  test.each(['absolute', undefined, '', 'relative-state'])('honors XDG value %s in an isolated home', async setting => {
    const xdg = setting === 'absolute' ? join(root, 'xdg') : setting;
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    if (xdg === undefined) delete environment.XDG_STATE_HOME;
    else environment.XDG_STATE_HOME = xdg;
    // Bun caches homedir at process startup; changing HOME inside a test is not isolated.
    const script = `import { SessionNames } from ${JSON.stringify(new URL('../src/session-names.ts', import.meta.url).href)};
      await new SessionNames(${JSON.stringify(join(root, 'workspace'))}).set('session', 'Private label');`;
    const child = Bun.spawn({
      cmd: [process.execPath, '--eval', script], env: environment, cwd: root, stdout: 'ignore', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const explicit = new SessionNames(join(root, 'workspace'), join(
      setting === 'absolute' ? join(root, 'xdg') : join(root, '.local', 'state'), 'agy-tern', 'session-names',
    ));
    expect(await explicit.get('session')).toBe('Private label');
  });
});
