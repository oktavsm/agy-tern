import type { AgentMetadata } from './contracts';
import { parseQuotaReport } from './reports';
import { summarizeQuotaRows } from './ui-format';

export const MAX_OPEN_SESSION_TABS = 6;

/** Track recently opened ACP sessions cleanly with bounded tab capacity while keeping active visible. */
export function recordOpenSessionTab(
  tabs: readonly string[],
  sessionId: string,
  maxTabs = MAX_OPEN_SESSION_TABS,
): string[] {
  if (!sessionId) return [...tabs];
  if (tabs.includes(sessionId)) return [...tabs];
  const next = [...tabs, sessionId];
  while (next.length > maxTabs) next.shift();
  return next;
}

/** Remove a closed session from open tabs. */
export function removeOpenSessionTab(tabs: readonly string[], sessionId: string): string[] {
  return tabs.filter(id => id !== sessionId);
}

/** Return the next (or previous) session ID when cycling open session tabs. */
export function cycleOpenSessionTab(
  tabs: readonly string[],
  currentId: string,
  direction: 1 | -1 = 1,
): string | undefined {
  if (tabs.length < 2) return undefined;
  const idx = tabs.indexOf(currentId);
  const start = idx < 0 ? 0 : idx;
  const nextIdx = (start + (direction === 1 ? 1 : tabs.length - 1)) % tabs.length;
  return tabs[nextIdx];
}

/** Format a compact single-line summary of the active tier and cached tightest quota for `/account`. */
export function formatAccountSnapshot(
  metadata: AgentMetadata,
  cachedUsageReport: string,
): string | undefined {
  const parts: string[] = [];
  if (metadata.tier) parts.push(`Tier: ${metadata.tier.name}`);
  const rows = parseQuotaReport(cachedUsageReport);
  const quotaSummary = summarizeQuotaRows(rows);
  if (quotaSummary) {
    parts.push(`Tightest quota: ${quotaSummary.tightest.remaining} (${quotaSummary.tightest.group})`);
  }
  return parts.length ? parts.join(' | ') : undefined;
}
