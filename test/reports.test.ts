import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQuotaReport, readOfficialReport } from '../src/reports';

const fixture = fileURLToPath(new URL('./fixtures/agent.ts', import.meta.url));

describe('official information reports', () => {
  test('preserves group, limit, percentage and reset from a CLI quota report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-tern-reports-'));
    try {
      const usage = await readOfficialReport({ cwd, executable: fixture }, 'usage');
      expect(parseQuotaReport(usage)).toEqual([{
        group: 'Synthetic account quota', limit: 'Weekly limit', remaining: '75%', reset: '2026-11-21T00:00:00Z',
      }]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('rejects non-allowlisted commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-tern-reports-'));
    try {
      // @ts-expect-error testing runtime guard against arbitrary commands
      await expect(readOfficialReport({ cwd, executable: fixture }, 'dangerous')).rejects.toThrow('information-only');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('surfaces non-zero exits from the official CLI report', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-tern-report-error-'));
    try {
      await expect(readOfficialReport({ cwd, executable: fixture }, 'usage')).rejects.toMatchObject({ code: 12 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('aborts when the provided signal fires', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agy-tern-reports-'));
    const controller = new AbortController();
    controller.abort(new Error('report aborted'));
    try {
      await expect(readOfficialReport({ cwd, executable: fixture, signal: controller.signal }, 'usage'))
        .rejects.toMatchObject({ code: 'ABORT_ERR' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test('keeps zero and full quota distinct and never drops unrecognized report rows', () => {
    expect(parseQuotaReport('Gemini\tWeekly\t0%\treset-a\nGemini\tFive Hour\t100%\treset-b')?.map(row => row.remaining)).toEqual(['0%', '100%']);
    expect(parseQuotaReport('Gemini\tWeekly\t0%\treset-a\nservice unavailable')).toBeUndefined();
    expect(parseQuotaReport('Gemini\tWeekly\t101%\treset-a')).toBeUndefined();
    expect(parseQuotaReport('')).toBeUndefined();
  });

  test('parses real space-padded agy /usage CLI output including Quota: header and WIB timestamps', () => {
    const realReport = [
      'Quota:',
      'Gemini Models          Weekly Limit Remaining       64%   2026-11-26 15:24 WIB',
      'Gemini Models          Five Hour Limit Remaining    82%   2026-11-21 05:48 WIB',
      'Gemini 4 Argon         Gemini 4 Argon Weekly Limit  100%  2026-11-28 01:08 WIB',
    ].join('\n');
    expect(parseQuotaReport(realReport)).toEqual([
      { group: 'Gemini Models', limit: 'Weekly Limit Remaining', remaining: '64%', reset: '2026-11-26 15:24 WIB' },
      { group: 'Gemini Models', limit: 'Five Hour Limit Remaining', remaining: '82%', reset: '2026-11-21 05:48 WIB' },
      { group: 'Gemini 4 Argon', limit: 'Gemini 4 Argon Weekly Limit', remaining: '100%', reset: '2026-11-28 01:08 WIB' },
    ]);
  });
});
