import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_HEATMAP_WEEKS = 16;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface CommitEntry {
  hash: string;
  shortHash: string;
  date: string;
  relativeTime: string;
  author: string;
  subject: string;
}

export interface CommitHeatmapGrid {
  weeks: number;
  totalCommits: number;
  activeDays: number;
  maxDailyCommits: number;
  currentStreak: number;
  longestStreak: number;
  busiestDate?: { date: string; count: number };
  rows: string[];
  cols: Array<{ at: number; label: string }>;
  cells: Array<Array<number | null>>;
  tips: Array<Array<string | null>>;
  commits: CommitEntry[];
}

function formatUtcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addUtcDays(base: Date, days: number): Date {
  const copy = new Date(base.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeCommitDate(rawDate: string): string | undefined {
  const trimmed = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return formatLocalDateKey(new Date(ms));
  }
  return undefined;
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
    const date = rawDate ? normalizeCommitDate(rawDate) : undefined;
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
  const weeks = Math.max(4, Math.min(26, opts?.weeks ?? DEFAULT_HEATMAP_WEEKS));
  const now = opts?.now ?? new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const todayKey = formatUtcDateKey(todayUtc);

  // Align column 0 to Sunday of the week (weeks - 1) before today's week.
  const todayDow = todayUtc.getUTCDay();
  const currentWeekSunday = addUtcDays(todayUtc, -todayDow);
  const startSunday = addUtcDays(currentWeekSunday, -(weeks - 1) * 7);
  const startKey = formatUtcDateKey(startSunday);

  const countsByDate = new Map<string, number>();
  let totalCommits = 0;
  for (const commit of commits) {
    if (commit.date < startKey || commit.date > todayKey) continue;
    totalCommits++;
    countsByDate.set(commit.date, (countsByDate.get(commit.date) ?? 0) + 1);
  }

  const cells: Array<Array<number | null>> = Array.from({ length: 7 }, () => Array<number | null>(weeks).fill(null));
  const tips: Array<Array<string | null>> = Array.from({ length: 7 }, () => Array<string | null>(weeks).fill(null));
  const cols: Array<{ at: number; label: string }> = [];

  let lastLabeledMonth = -1;
  let lastLabelCol = -4;
  let activeDays = 0;
  let maxDailyCommits = 0;
  let busiestDate: { date: string; count: number } | undefined;
  let longestStreak = 0;
  let runningStreak = 0;

  for (let w = 0; w < weeks; w++) {
    const colSunday = addUtcDays(startSunday, w * 7);
    const colMonth = colSunday.getUTCMonth();
    if (colMonth !== lastLabeledMonth && w - lastLabelCol >= 2) {
      cols.push({ at: w, label: MONTH_NAMES[colMonth]! });
      lastLabeledMonth = colMonth;
      lastLabelCol = w;
    }

    for (let dow = 0; dow < 7; dow++) {
      const day = addUtcDays(colSunday, dow);
      if (day.getTime() > todayUtc.getTime()) continue;
      const key = formatUtcDateKey(day);
      const count = countsByDate.get(key) ?? 0;
      cells[dow]![w] = count;
      tips[dow]![w] = count === 0
        ? `No commits on ${key}`
        : `${count} ${count === 1 ? 'commit' : 'commits'} on ${key}`;

      if (count > 0) {
        activeDays++;
        runningStreak++;
        if (runningStreak > longestStreak) longestStreak = runningStreak;
        if (count > maxDailyCommits) {
          maxDailyCommits = count;
          busiestDate = { date: key, count };
        }
      } else {
        runningStreak = 0;
      }
    }
  }

  // Current streak counts backwards from today (allowing zero commits today if yesterday was active).
  let currentStreak = 0;
  let probe = (countsByDate.get(todayKey) ?? 0) > 0 ? todayUtc : addUtcDays(todayUtc, -1);
  while (probe.getTime() >= startSunday.getTime()) {
    const key = formatUtcDateKey(probe);
    if ((countsByDate.get(key) ?? 0) <= 0) break;
    currentStreak++;
    probe = addUtcDays(probe, -1);
  }

  return {
    weeks,
    totalCommits,
    activeDays,
    maxDailyCommits,
    currentStreak,
    longestStreak,
    ...(busiestDate ? { busiestDate } : {}),
    rows: ['', 'Mon', '', 'Wed', '', 'Fri', ''],
    cols,
    cells,
    tips,
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
