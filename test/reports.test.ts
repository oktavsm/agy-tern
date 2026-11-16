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
});
