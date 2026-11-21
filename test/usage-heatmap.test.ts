import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUsageHeatmap, parseBrainUsageEvents, readAgyUsageActivity } from '../src/usage-heatmap';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('usage-heatmap Antigravity activity builder', () => {
  test('aggregates daily prompts and distinct sessions into heatmap grid and tooltips', () => {
    const now = new Date('2026-11-21T12:00:00Z');
    const heatmap = buildUsageHeatmap([
      { date: '2026-11-21', sessionId: 's1', weight: 2 },
      { date: '2026-11-21', sessionId: 's2', weight: 1 },
      { date: '2026-11-20', sessionId: 's1', weight: 3 },
      { date: '2026-11-18', sessionId: 's3', weight: 1 },
    ], { weeks: 8, now });

    expect(heatmap.totalTurns).toBe(7);
    expect(heatmap.totalSessions).toBe(3);
    expect(heatmap.activeDays).toBe(3);
    expect(heatmap.currentStreak).toBe(2);
    expect(heatmap.longestStreak).toBe(2);
    expect(heatmap.cells[6]?.[7]).toBe(3);
    expect(heatmap.tips[6]?.[7]).toBe('3 prompts (2 sessions) on 2026-11-21');
  });

  test('parses official brain transcript.jsonl USER_INPUT steps safely and merges active session fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-usage-brain-'));
    dirs.push(root);
    const sid = '11111111-2222-4333-8444-555555555555';
    const logDir = join(root, 'brain', sid, '.system_generated', 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'transcript.jsonl'), [
      '{"type":"USER_INPUT","created_at":"2026-11-21T03:00:00Z","content":"hi"}',
      '{"type":"PLANNER_RESPONSE","created_at":"2026-11-21T03:00:02Z","content":"hello"}',
      '{"type":"USER_INPUT","created_at":"2026-11-21T03:05:00Z","content":"fix bug"}',
      'corrupt-trailing-line',
    ].join('\n'), 'utf8');

    const parsed = parseBrainUsageEvents(
      '{"type":"USER_INPUT","created_at":"2026-11-21T03:00:00Z"}\nnot-json',
      sid,
    );
    expect(parsed).toHaveLength(1);

    const grid = await readAgyUsageActivity({
      appDataDir: root,
      listedSessions: [{ sessionId: 'other-sess', updatedAt: '2026-11-20T10:00:00Z' }],
      activeSessionId: 'live-only',
      activeEntries: [{ type: 'message', id: 'm1', role: 'user', text: 'live prompt' }],
      weeks: 6,
      now: new Date('2026-11-21T12:00:00Z'),
    });

    expect(grid.totalTurns).toBe(4);
    expect(grid.totalSessions).toBe(3);
    expect(grid.activeDays).toBe(2);
  });
});
