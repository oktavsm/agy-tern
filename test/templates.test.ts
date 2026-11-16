import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptTemplatesStore } from '../src/templates';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-tpl-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('workspace prompt templates store', () => {
  test('saves, updates, scopes by workspace, and deletes templates cleanly', async () => {
    const stateDir = await tempDir();
    const repoA = await tempDir();
    const repoB = await tempDir();

    const storeA = new PromptTemplatesStore(repoA, stateDir);
    const storeB = new PromptTemplatesStore(repoB, stateDir);

    expect(await storeA.list()).toEqual([]);
    await storeA.save('review-diff', 'Review staged changes for regressions.');
    await storeA.save('test-plan', 'List edge cases and add unit tests.');
    expect((await storeA.list()).map(t => t.name)).toEqual(['test-plan', 'review-diff']);
    expect(await storeB.list()).toEqual([]);

    await storeA.save('review-diff', 'Updated review prompt.');
    const listed = await storeA.list();
    expect(listed.find(t => t.name === 'review-diff')?.text).toBe('Updated review prompt.');

    await storeA.remove('test-plan');
    expect((await storeA.list()).map(t => t.name)).toEqual(['review-diff']);

    await expect(storeA.save('   ', 'body')).rejects.toThrow('Template name');
    await expect(storeA.save('valid-name', '   ')).rejects.toThrow('Template text');

    if (process.platform !== 'win32') {
      const dirMode = (await stat(stateDir)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  });
});
