import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFallbackAgyArgs, parseCliArgs } from '../src/cli-args';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('CLI argument parser', () => {
  test('parses repeatable --add-dir, --agent, model/mode/thinking flags, and initial prompt', async () => {
    const root = await makeTempDir();
    const extra1 = join(root, 'extra-a');
    const extra2 = join(root, 'extra-b');
    await mkdir(extra1);
    await mkdir(extra2);

    const parsed = parseCliArgs([
      '--cwd', root,
      '--add-dir', 'extra-a',
      '--add-dir', extra2,
      '--agent', 'reviewer',
      '--model', 'gemini-4-argon',
      '--mode', 'plan',
      '--effort', 'high',
      '-c',
      'Audit this module',
    ], root);

    expect(parsed).toEqual({
      help: false,
      doctor: false,
      doctorJson: false,
      cwd: root,
      additionalDirectories: [extra1, extra2],
      agy: undefined,
      agentName: 'reviewer',
      model: 'gemini-4-argon',
      mode: 'plan',
      thinking: 'high',
      appendSystemPrompt: undefined,
      maxFps: undefined,
      motion: undefined,
      continueLast: true,
      conversationId: undefined,
      initialPrompt: 'Audit this module',
    });

    expect(buildFallbackAgyArgs(parsed)).toEqual([
      '--sandbox',
      '--add-dir', extra1,
      '--add-dir', extra2,
      '--agent', 'reviewer',
      '--model', 'gemini-4-argon',
      '--mode', 'plan',
      '--effort', 'high',
      '--continue',
      '--prompt-interactive', 'Audit this module',
    ]);
  });

  test('rejects conflicting flags, missing directories, and extra positionals', async () => {
    const root = await makeTempDir();
    const filePath = join(root, 'not-a-dir.txt');
    await writeFile(filePath, 'x');

    expect(() => parseCliArgs(['--continue', '--conversation', 'abc'], root)).toThrow('either --continue or --conversation');
    expect(() => parseCliArgs(['-i', 'one', 'two'], root)).toThrow('not both');
    expect(() => parseCliArgs(['one', 'two'], root)).toThrow('Unexpected extra arguments');
    expect(() => parseCliArgs(['--cwd', filePath], root)).toThrow('Not a workspace directory');
    expect(() => parseCliArgs(['--add-dir', 'missing-dir'], root)).toThrow('Not an additional workspace directory');
    expect(() => parseCliArgs(['--doctor', '--json'], root)).not.toThrow();
    expect(parseCliArgs(['--doctor', '--json'], root)).toMatchObject({ doctor: true, doctorJson: true });
  });

  test('parses and validates --max-fps, --motion, and --append-system-prompt flags', async () => {
    const root = await makeTempDir();
    const parsed = parseCliArgs([
      '--cwd', root,
      '--max-fps', '40',
      '--motion', 'reduce',
      '--append-system-prompt', 'Keep patches minimal.',
    ], root);

    expect(parsed).toMatchObject({
      cwd: root,
      maxFps: 40,
      motion: 'reduced',
      appendSystemPrompt: 'Keep patches minimal.',
    });

    expect(() => parseCliArgs(['--max-fps', '4'], root)).toThrow('--max-fps');
    expect(() => parseCliArgs(['--max-fps', '61'], root)).toThrow('--max-fps');
    expect(() => parseCliArgs(['--max-fps', 'fast'], root)).toThrow('--max-fps');
    expect(() => parseCliArgs(['--motion', 'hyper'], root)).toThrow('--motion');
  });

  test('parses update subcommand and -V/--version flags', async () => {
    const root = await makeTempDir();
    expect(parseCliArgs(['-V'], root)).toMatchObject({ version: true, help: false });
    expect(parseCliArgs(['--version'], root)).toMatchObject({ version: true, help: false });

    expect(parseCliArgs(['update'], root)).toMatchObject({
      help: false,
      update: { checkOnly: false, force: false },
    });
    expect(parseCliArgs(['update', '--check', '--force', '--version', 'v0.2.0'], root)).toMatchObject({
      help: false,
      update: { checkOnly: true, force: true, targetVersion: 'v0.2.0' },
    });
    expect(parseCliArgs(['update', '--help'], root)).toMatchObject({ help: true });
    expect(() => parseCliArgs(['update', 'extra-arg'], root)).toThrow('Unexpected extra arguments for update');
  });
});
