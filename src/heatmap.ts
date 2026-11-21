export const DEFAULT_HEATMAP_WEEKS = 16;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface CalendarHeatmapGrid {
  weeks: number;
  totalCount: number;
  activeDays: number;
  maxDailyCount: number;
  currentStreak: number;
  longestStreak: number;
  busiestDate?: { date: string; count: number };
  rows: string[];
  cols: Array<{ at: number; label: string }>;
  cells: Array<Array<number | null>>;
  tips: Array<Array<string | null>>;
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

/** Format a local `Date` instance as `YYYY-MM-DD` matching runtime JS calendar day. */
export function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Normalize either `YYYY-MM-DD` or an ISO-8601 timestamp into local `YYYY-MM-DD`. */
export function normalizeTimestampDateKey(rawDate: string): string | undefined {
  const trimmed = rawDate.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return formatLocalDateKey(new Date(ms));
  }
  return undefined;
}

/** Compute Sunday-aligned start and end boundaries for a `weeks`-column calendar grid. */
export function calendarWindowBounds(weeksInput?: number, nowInput?: Date): {
  weeks: number;
  todayUtc: Date;
  todayKey: string;
  startSunday: Date;
  startKey: string;
} {
  const weeks = Math.max(4, Math.min(26, weeksInput ?? DEFAULT_HEATMAP_WEEKS));
  const now = nowInput ?? new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const todayKey = formatUtcDateKey(todayUtc);
  const currentWeekSunday = addUtcDays(todayUtc, -todayUtc.getUTCDay());
  const startSunday = addUtcDays(currentWeekSunday, -(weeks - 1) * 7);
  const startKey = formatUtcDateKey(startSunday);
  return { weeks, todayUtc, todayKey, startSunday, startKey };
}

/** Build a 7xN GitHub-style calendar heatmap matrix with streaks, month markers, and tooltips. */
export function buildCalendarHeatmap(
  countsByDate: ReadonlyMap<string, number>,
  opts: {
    weeks?: number;
    now?: Date;
    formatTip: (date: string, count: number) => string;
  },
): CalendarHeatmapGrid {
  const { weeks, todayUtc, todayKey, startSunday, startKey } = calendarWindowBounds(opts.weeks, opts.now);
  const cells: Array<Array<number | null>> = Array.from({ length: 7 }, () => Array<number | null>(weeks).fill(null));
  const tips: Array<Array<string | null>> = Array.from({ length: 7 }, () => Array<string | null>(weeks).fill(null));
  const cols: Array<{ at: number; label: string }> = [];

  let totalCount = 0;
  for (const [date, count] of countsByDate.entries()) {
    if (date >= startKey && date <= todayKey && count > 0) totalCount += count;
  }

  let lastLabeledMonth = -1;
  let lastLabelCol = -4;
  let activeDays = 0;
  let maxDailyCount = 0;
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
      tips[dow]![w] = opts.formatTip(key, count);

      if (count > 0) {
        activeDays++;
        runningStreak++;
        if (runningStreak > longestStreak) longestStreak = runningStreak;
        if (count > maxDailyCount) {
          maxDailyCount = count;
          busiestDate = { date: key, count };
        }
      } else {
        runningStreak = 0;
      }
    }
  }

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
    totalCount,
    activeDays,
    maxDailyCount,
    currentStreak,
    longestStreak,
    ...(busiestDate ? { busiestDate } : {}),
    rows: ['', 'Mon', '', 'Wed', '', 'Fri', ''],
    cols,
    cells,
    tips,
  };
}
