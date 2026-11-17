import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOfficialBrainTranscript, TranscriptStore } from '../src/history';
import { Conversation } from '../src/model';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-history-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('local transcript store & official brain log reader', () => {
  test('saves and loads sanitized transcripts with owner-only permissions', async () => {
    const cwd = await tempDir();
    const stateDir = await tempDir();
    const store = new TranscriptStore(cwd, stateDir);

    await store.save('sess-1', [
      { type: 'notice', id: 'n1', text: 'Temporary info', error: false },
      {
        type: 'message',
        id: 'entry-1',
        role: 'user',
        text: 'Check this image',
        time: '10:00',
        images: [{ mimeType: 'image/png', data: 'VERY_LONG_BASE64_DATA' }],
      },
      { type: 'message', id: 'entry-2', role: 'agent', text: 'Looks good.', time: '10:01' },
    ]);

    const loaded = await store.load('sess-1');
    expect(loaded).toBeDefined();
    expect(loaded?.source).toBe('cache');
    // Non-error notice omitted and inline base64 stripped cleanly.
    expect(loaded?.entries).toEqual([
      { type: 'message', id: 'entry-1', role: 'user', text: '[Image: image/png]\n\nCheck this image', time: '10:00' },
      { type: 'message', id: 'entry-2', role: 'agent', text: 'Looks good.', time: '10:01' },
    ]);

    if (process.platform !== 'win32') {
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    }

    const hydrated = new Conversation();
    hydrated.restoreEntries(loaded!.entries);
    expect(hydrated.entries).toHaveLength(2);
    hydrated.startPrompt('Next turn');
    expect(hydrated.entries[2]?.id).toBe('entry-3');
  });

  test('reads bounded official antigravity brain transcript.jsonl safely', async () => {
    const appData = await tempDir();
    const sessionId = '8da228d9-9fce-473c-954f-20ce7c51b1f9';
    const logDir = join(appData, 'brain', sessionId, '.system_generated', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'transcript.jsonl'), [
      JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-17T03:00:00Z', content: '<USER_REQUEST>\naudit project\n</USER_REQUEST>' }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-17T03:00:02Z',
        status: 'DONE',
        thinking: 'Checking src directory',
        tool_calls: [{ name: 'read_file', args: { Path: '"/repo/src/ui.tsx"' } }],
      }),
      JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'line 1' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: '2026-11-17T03:00:05Z', status: 'DONE', content: 'Audit complete.' }),
    ].join('\n'), 'utf8');

    const loaded = await readOfficialBrainTranscript(sessionId, { appDataDir: appData });
    expect(loaded?.source).toBe('brain');
    expect(loaded?.entries.map(e => e.type)).toEqual(['message', 'thought', 'tool', 'message']);
    expect(loaded?.entries[0]).toMatchObject({ type: 'message', role: 'user', text: 'audit project' });
    expect(loaded?.entries[2]).toMatchObject({
      type: 'tool',
      call: { name: 'read_file', kind: 'read', rawInput: { Path: '/repo/src/ui.tsx' }, rawOutput: 'line 1' },
    });
    expect(loaded?.entries[3]).toMatchObject({ type: 'message', role: 'agent', text: 'Audit complete.' });

    // Rejects invalid/non-UUID IDs against path traversal.
    expect(await readOfficialBrainTranscript('../etc/passwd', { appDataDir: appData })).toBeUndefined();
  });
});
