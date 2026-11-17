import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PREFS, normalizePrefs, PrefsStore } from '../src/prefs';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-prefs-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('local user preferences', () => {
  test('returns defaults without creating storage when missing or corrupt', async () => {
    const dir = await tempDir();
    const store = new PrefsStore(dir);
    expect(await store.load()).toEqual(DEFAULT_PREFS);
    await writeFile(join(dir, 'prefs.json'), '{not-json', 'utf8');
    expect(await store.load()).toEqual(DEFAULT_PREFS);
  });

  test('normalizes partial or invalid fields safely', () => {
    expect(normalizePrefs({
      diffMode: 'split',
      composerLines: 10,
      thoughtExpanded: true,
      showKeyLegend: 'yes',
      toolDisplay: 'bad',
      transcriptDensity: 'compact',
      showTimestamps: false,
      autoPreviewMedia: true,
      notifyOnTurnComplete: false,
      rememberModel: false,
      lastModel: '  gemini-4-hydrogen  ',
      lastThinking: '',
    })).toEqual({
      diffMode: 'split',
      toolDisplay: 'compact',
      thoughtExpanded: true,
      showKeyLegend: true,
      composerLines: 10,
      transcriptDensity: 'compact',
      showTimestamps: false,
      autoPreviewMedia: true,
      notifyOnTurnComplete: false,
      rememberModel: false,
      maxFps: 25,
      motion: 'auto',
      lastModel: 'gemini-4-hydrogen',
    });
  });

  test('persists updates atomically with owner-only permissions and resets cleanly', async () => {
    const dir = await tempDir();
    const store = new PrefsStore(dir);
    const updated = await store.update({
      diffMode: 'unified',
      toolDisplay: 'expanded',
      showKeyLegend: false,
      lastModel: 'gemini-4-hydrogen',
      lastThinking: 'high',
    });
    expect(updated).toEqual({
      diffMode: 'unified',
      toolDisplay: 'expanded',
      thoughtExpanded: false,
      showKeyLegend: false,
      composerLines: 6,
      transcriptDensity: 'comfortable',
      showTimestamps: true,
      autoPreviewMedia: false,
      notifyOnTurnComplete: true,
      rememberModel: true,
      maxFps: 25,
      motion: 'auto',
      lastModel: 'gemini-4-hydrogen',
      lastThinking: 'high',
    });
    expect(await store.load()).toEqual(updated);

    if (process.platform !== 'win32') {
      const dirMode = (await stat(dir)).mode & 0o777;
      const fileMode = (await stat(join(dir, 'prefs.json'))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const stored = JSON.parse(await readFile(join(dir, 'prefs.json'), 'utf8'));
    expect(stored.diffMode).toBe('unified');
    expect(stored.lastModel).toBe('gemini-4-hydrogen');
    expect(await store.reset()).toEqual(DEFAULT_PREFS);

    // Concurrent updates serialize cleanly without dropping either patch.
    await Promise.all([
      store.update({ lastModel: 'model-a' }),
      store.update({ lastThinking: 'high', maxFps: 30 }),
    ]);
    const finalPrefs = await store.load();
    expect(finalPrefs.lastModel).toBe('model-a');
    expect(finalPrefs.lastThinking).toBe('high');
    expect(finalPrefs.maxFps).toBe(30);
  });
});
