import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildCalendarHeatmap,
  calendarWindowBounds,
  DEFAULT_HEATMAP_WEEKS,
  normalizeTimestampDateKey,
  type CalendarHeatmapGrid,
} from './heatmap';

const execFileAsync = promisify(execFile);

export { DEFAULT_HEATMAP_WEEKS };

export interface CommitEntry {
  hash: string;
  shortHash: string;
  date: string;
  relativeTime: string;
  author: string;
  subject: string;
}

export interface CommitHeatmapGrid extends CalendarHeatmapGrid {
  totalCommits: number;
  maxDailyCommits: number;
  commits: CommitEntry[];
}

/** Parse delimited `git log` records cleanly into typed commit summaries. */
export function parseGitLogRecords(raw: string): CommitEntry[] {
  if (!raw.trim()) return [];
  const entries: CommitEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    if (parts.length < 6) continue;
    const [hash, shortHash, rawDate, relativeTime, author, ...rest] = parts;
    const date = rawDate ? normalizeTimestampDateKey(rawDate) : undefined;
    const subject = rest.join('\x1f').trim();
    if (!hash || !date) continue;
    entries.push({
      hash: hash.trim(),
      shortHash: (shortHash ?? hash.slice(0, 7)).trim(),
      date,
      relativeTime: (relativeTime ?? '').trim(),
      author: (author ?? '').trim(),
      subject: subject || '(no subject)',
    });
  }
  return entries;
}

/** Build a 7xN GitHub-style commit contribution heatmap grid ending on `now`'s week. */
export function buildCommitHeatmap(
  commits: readonly CommitEntry[],
  opts?: { weeks?: number; now?: Date },
): CommitHeatmapGrid {
  const { weeks, todayKey, startKey } = calendarWindowBounds(opts?.weeks, opts?.now);
  const countsByDate = new Map<string, number>();
  for (const commit of commits) {
    if (commit.date < startKey || commit.date > todayKey) continue;
    countsByDate.set(commit.date, (countsByDate.get(commit.date) ?? 0) + 1);
  }
  const base = buildCalendarHeatmap(countsByDate, {
    weeks,
    now: opts?.now,
    formatTip: (date, count) => count === 0
      ? `No commits on ${date}`
      : `${count} ${count === 1 ? 'commit' : 'commits'} on ${date}`,
  });
  return {
    ...base,
    totalCommits: base.totalCount,
    maxDailyCommits: base.maxDailyCount,
    commits: [...commits],
  };
}

/** Read bounded workspace git commit history and build a heatmap grid. */
export async function readCommitHistory(
  cwd: string,
  opts?: { weeks?: number; maxCommits?: number; now?: Date },
): Promise<CommitHeatmapGrid> {
  const weeks = Math.max(4, Math.min(26, opts?.weeks ?? DEFAULT_HEATMAP_WEEKS));
  const maxCommits = opts?.maxCommits ?? 500;
  const lookbackDays = weeks * 7 + 7;
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        `--since=${lookbackDays} days ago`,
        '-n',
        String(maxCommits),
        '--date=iso-strict',
        '--format=%H%x1f%h%x1f%ad%x1f%ar%x1f%an%x1f%s',
      ],
      { cwd, timeout: 2_000, maxBuffer: 512 * 1024, encoding: 'utf8' },
    );
    return buildCommitHeatmap(parseGitLogRecords(stdout), { weeks, now: opts?.now });
  } catch {
    return buildCommitHeatmap([], { weeks, now: opts?.now });
  }
}

/** Read stat + patch diff safely for a validated commit SHA inside `cwd`. */
export async function readCommitPatch(cwd: string, hash: string): Promise<string> {
  const trimmed = hash.trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(trimmed)) {
    throw new Error('Invalid commit hash.');
  }
  const { stdout } = await execFileAsync(
    'git',
    ['show', '--stat', '--patch', '--no-color', trimmed],
    { cwd, timeout: 2_500, maxBuffer: 256 * 1024, encoding: 'utf8' },
  );
  return stdout;
}
