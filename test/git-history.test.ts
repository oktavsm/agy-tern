import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommitHeatmap, parseGitLogRecords, readCommitHistory, readCommitPatch } from '../src/git-history';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('git-history commit heatmap helpers', () => {
  test('parses delimited git log output and computes GitHub-style 7xN grid, streaks, and peaks', () => {
    const raw = [
      'aaaa1111\x1faaaa111\x1f2026-11-21\x1f2 hours ago\x1fAlice\x1ffeat: add heatmap',
      'bbbb2222\x1fbbbb222\x1f2026-11-21\x1f3 hours ago\x1fAlice\x1ffix: align columns',
      'cccc3333\x1fcccc333\x1f2026-11-20\x1f1 day ago\x1fBob\x1fdocs: update changelog',
      'dddd4444\x1fdddd444\x1f2026-11-18\x1f3 days ago\x1fAlice\x1fchore: bump deps',
    ].join('\n');

    const commits = parseGitLogRecords(raw);
    expect(commits).toHaveLength(4);
    expect(commits[0]?.shortHash).toBe('aaaa111');

    // Saturday Nov 21, 2026 -> row 6 of final week column (col 7 for weeks=8) is today.
    const now = new Date('2026-11-21T12:00:00Z');
    const grid = buildCommitHeatmap(commits, { weeks: 8, now });
    expect(grid.weeks).toBe(8);
    expect(grid.totalCommits).toBe(4);
    expect(grid.activeDays).toBe(3);
    expect(grid.currentStreak).toBe(2);
    expect(grid.longestStreak).toBe(2);
    expect(grid.busiestDate).toEqual({ date: '2026-11-21', count: 2 });
    expect(grid.cells).toHaveLength(7);
    expect(grid.cells[0]).toHaveLength(8);
    expect(grid.cells[6]?.[7]).toBe(2);
    expect(grid.tips[6]?.[7]).toBe('2 commits on 2026-11-21');
    expect(grid.cells[5]?.[7]).toBe(1);
    expect(grid.rows).toEqual(['', 'Mon', '', 'Wed', '', 'Fri', '']);
    expect(grid.cols.length).toBeGreaterThan(0);
  });

  test('reads real git repository commits, patches, and validates commit hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-commits-'));
    dirs.push(dir);
    spawnSync('git', ['init'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    await writeFile(join(dir, 'hello.txt'), 'world\n', 'utf8');
    spawnSync('git', ['add', 'hello.txt'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'init repo'], { cwd: dir });

    const grid = await readCommitHistory(dir, { weeks: 6 });
    expect(grid.totalCommits).toBe(1);
    expect(grid.commits[0]?.subject).toBe('init repo');

    const patch = await readCommitPatch(dir, grid.commits[0]!.hash);
    expect(patch).toContain('hello.txt');
    expect(patch).toContain('+world');

    await expect(readCommitPatch(dir, '--exec=bad')).rejects.toThrow('Invalid commit hash');
  });
});
