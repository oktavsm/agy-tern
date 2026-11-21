import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TranscriptEntry } from './model';
import {
  buildCalendarHeatmap,
  calendarWindowBounds,
  DEFAULT_HEATMAP_WEEKS,
  formatLocalDateKey,
  normalizeTimestampDateKey,
  type CalendarHeatmapGrid,
} from './heatmap';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BRAIN_SESSIONS_SCAN = 120;
const MAX_BRAIN_TAIL_BYTES = 256 * 1024;

export interface UsageActivityEvent {
  date: string;
  sessionId?: string;
  weight?: number;
}

export interface UsageHeatmapData extends CalendarHeatmapGrid {
  totalTurns: number;
  totalSessions: number;
}

/** Aggregate daily Antigravity prompt/session activity into a GitHub-style calendar heatmap. */
export function buildUsageHeatmap(
  events: readonly UsageActivityEvent[],
  opts?: { weeks?: number; now?: Date },
): UsageHeatmapData {
  const { weeks, todayKey, startKey } = calendarWindowBounds(opts?.weeks, opts?.now);
  const countsByDate = new Map<string, number>();
  const sessionsByDate = new Map<string, Set<string>>();
  const distinctSessions = new Set<string>();

  for (const event of events) {
    if (event.date < startKey || event.date > todayKey) continue;
    const weight = Math.max(1, Math.round(event.weight ?? 1));
    countsByDate.set(event.date, (countsByDate.get(event.date) ?? 0) + weight);
    if (event.sessionId) {
      distinctSessions.add(event.sessionId);
      let daySet = sessionsByDate.get(event.date);
      if (!daySet) {
        daySet = new Set<string>();
        sessionsByDate.set(event.date, daySet);
      }
      daySet.add(event.sessionId);
    }
  }

  const base = buildCalendarHeatmap(countsByDate, {
    weeks,
    now: opts?.now,
    formatTip: (date, count) => {
      if (count <= 0) return `No agy activity on ${date}`;
      const sessions = sessionsByDate.get(date)?.size ?? 0;
      const turnLabel = `${count} ${count === 1 ? 'prompt' : 'prompts'}`;
      return sessions > 0
        ? `${turnLabel} (${sessions} ${sessions === 1 ? 'session' : 'sessions'}) on ${date}`
        : `${turnLabel} on ${date}`;
    },
  });

  return {
    ...base,
    totalTurns: base.totalCount,
    totalSessions: distinctSessions.size,
  };
}

/** Extract prompt/turn dates safely from official `brain/<uuid>/.system_generated/logs/transcript.jsonl` lines. */
export function parseBrainUsageEvents(rawJsonl: string, sessionId: string): UsageActivityEvent[] {
  if (!rawJsonl.trim()) return [];
  const events: UsageActivityEvent[] = [];
  for (const line of rawJsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; created_at?: string };
      if (parsed.type !== 'USER_INPUT' || typeof parsed.created_at !== 'string') continue;
      const date = normalizeTimestampDateKey(parsed.created_at);
      if (date) events.push({ date, sessionId, weight: 1 });
    } catch {
      // Ignore partial leading or malformed line safely.
    }
  }
  return events;
}

async function readBoundedTail(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const file = await open(filePath, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0) return undefined;
      const offset = Math.max(0, info.size - maxBytes);
      const length = info.size - offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Collect bounded Antigravity usage activity from local non-credential brain logs and active ACP sessions. */
export async function readAgyUsageActivity(opts?: {
  appDataDir?: string;
  listedSessions?: ReadonlyArray<{ sessionId: string; updatedAt?: string | null }>;
  activeEntries?: readonly TranscriptEntry[];
  activeSessionId?: string;
  weeks?: number;
  now?: Date;
}): Promise<UsageHeatmapData> {
  const weeks = Math.max(4, Math.min(26, opts?.weeks ?? DEFAULT_HEATMAP_WEEKS));
  const now = opts?.now ?? new Date();
  const { startSunday } = calendarWindowBounds(weeks, now);
  const cutoffMs = startSunday.getTime() - 24 * 60 * 60 * 1000;

  const events: UsageActivityEvent[] = [];
  const seenSessionsWithPrompts = new Set<string>();
  const brainDir = join(resolve(opts?.appDataDir ?? join(homedir(), '.gemini', 'antigravity-cli')), 'brain');

  try {
    const folderNames = (await readdir(brainDir)).filter(name => UUID_RE.test(name));
    const candidates: Array<{ id: string; path: string; mtimeMs: number }> = [];
    await Promise.all(folderNames.map(async id => {
      const logPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const info = await stat(logPath).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs >= cutoffMs) {
        candidates.push({ id, path: logPath, mtimeMs: info.mtimeMs });
      }
    }));

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const bounded = candidates.slice(0, MAX_BRAIN_SESSIONS_SCAN);
    await Promise.all(bounded.map(async item => {
      const text = await readBoundedTail(item.path, MAX_BRAIN_TAIL_BYTES);
      if (!text) return;
      const parsed = parseBrainUsageEvents(text, item.id);
      if (parsed.length) {
        seenSessionsWithPrompts.add(item.id);
        events.push(...parsed);
      } else {
        seenSessionsWithPrompts.add(item.id);
        events.push({ date: formatLocalDateKey(new Date(item.mtimeMs)), sessionId: item.id, weight: 1 });
      }
    }));
  } catch {
    // Missing or unreadable brain directory falls back cleanly to ACP session metadata and active turns.
  }

  for (const row of opts?.listedSessions ?? []) {
    if (!row.updatedAt || seenSessionsWithPrompts.has(row.sessionId)) continue;
    const date = normalizeTimestampDateKey(row.updatedAt);
    if (date) {
      seenSessionsWithPrompts.add(row.sessionId);
      events.push({ date, sessionId: row.sessionId, weight: 1 });
    }
  }

  if (opts?.activeSessionId && !seenSessionsWithPrompts.has(opts.activeSessionId) && opts.activeEntries?.length) {
    const userCount = opts.activeEntries.filter(entry => entry.type === 'message' && entry.role === 'user').length;
    if (userCount > 0) {
      events.push({ date: formatLocalDateKey(now), sessionId: opts.activeSessionId, weight: userCount });
    }
  }

  return buildUsageHeatmap(events, { weeks, now });
}
