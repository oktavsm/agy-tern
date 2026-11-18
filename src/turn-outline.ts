import type { TranscriptEntry } from './model';

export interface TurnOutlineItem {
  turnNumber: number;
  entryId: string;
  promptText: string;
  promptPreview: string;
  replyPreview?: string;
  time?: string;
  toolCount: number;
  thoughtCount: number;
  hasError: boolean;
  pinned: boolean;
}

function singleLineSnippet(text: string, maxLen = 84): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 3)}...` : flat;
}

/** Index every user prompt turn along with tool, thought, reply, error, and pin metadata. */
export function buildTurnOutline(
  entries: readonly TranscriptEntry[],
  pinnedIds?: ReadonlySet<string>,
): TurnOutlineItem[] {
  const items: TurnOutlineItem[] = [];
  let current: TurnOutlineItem | undefined;

  for (const entry of entries) {
    if (entry.type === 'message' && entry.role === 'user') {
      current = {
        turnNumber: items.length + 1,
        entryId: entry.id,
        promptText: entry.text,
        promptPreview: singleLineSnippet(entry.text, 72) || '(image prompt)',
        time: entry.time,
        toolCount: 0,
        thoughtCount: 0,
        hasError: false,
        pinned: pinnedIds?.has(entry.id) ?? false,
      };
      items.push(current);
      continue;
    }
    if (!current) continue;
    if (entry.type === 'tool') current.toolCount++;
    else if (entry.type === 'thought') current.thoughtCount++;
    else if (entry.type === 'notice' && entry.error) current.hasError = true;
    else if (entry.type === 'message' && entry.role === 'agent') {
      const snippet = singleLineSnippet(entry.text, 96);
      if (snippet) current.replyPreview = snippet;
    }
  }

  return items;
}

/** Filter turn outline entries by active tab (`all` or `pinned`) and search query (`#N`, prompt, reply). */
export function filterTurnOutline(
  items: readonly TurnOutlineItem[],
  tab: string,
  query: string,
): TurnOutlineItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(item => {
    if (tab === 'pinned' && !item.pinned) return false;
    if (!needle) return true;
    const haystack = `#${item.turnNumber} turn ${item.turnNumber} ${item.promptText} ${item.replyPreview ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}
