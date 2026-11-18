import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { UsageUpdate } from '@agentclientprotocol/sdk';
import type { LoadedImageAttachment } from './files';

export const DEFAULT_EMBEDDED_RESOURCE_BYTES = 64 * 1024;
export const DEFAULT_DIR_ESTIMATE_BYTES = 1_536;
export const ESTIMATED_TOKENS_PER_IMAGE = 1_200;

export type DraftBudgetLevel = 'ok' | 'warn' | 'tight';

export interface AttachmentSizeEntry {
  path: string;
  kind: 'file' | 'dir' | 'image';
  bytes: number;
  estimatedTokens: number;
  capped?: boolean;
}

export interface DraftContextBudget {
  draftTokens: number;
  attachmentTokens: number;
  totalEstimatedTokens: number;
  remainingTokens?: number;
  percentOfRemaining?: number;
  level: DraftBudgetLevel;
  entries: AttachmentSizeEntry[];
}

/** Estimate UTF-8 token count coarsely (~4 bytes per token) for pre-send display. */
export function estimateTextTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / 4)) : 0;
}

/** Format token quantities compactly (e.g. `850` or `2.4K`). */
export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  const k = tokens / 1_000;
  return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
}

/** Estimate pre-send draft + attachment context weight against reported ACP remaining window. */
export function computeDraftContextBudget(input: {
  draftText: string;
  attachedFiles: readonly string[];
  attachedDirs: readonly string[];
  attachedImages: readonly LoadedImageAttachment[];
  fileSizes: ReadonlyMap<string, number>;
  usage?: UsageUpdate;
}): DraftContextBudget {
  const draftTokens = estimateTextTokens(input.draftText);
  const entries: AttachmentSizeEntry[] = [];
  let attachmentTokens = 0;

  for (const file of input.attachedFiles) {
    const rawBytes = input.fileSizes.get(file);
    const capped = rawBytes !== undefined && rawBytes > DEFAULT_EMBEDDED_RESOURCE_BYTES;
    const effectiveBytes = rawBytes === undefined ? 0 : Math.min(rawBytes, DEFAULT_EMBEDDED_RESOURCE_BYTES);
    const tokens = effectiveBytes > 0 ? Math.max(1, Math.ceil(effectiveBytes / 4)) : 16;
    entries.push({ path: file, kind: 'file', bytes: rawBytes ?? 0, estimatedTokens: tokens, capped });
    attachmentTokens += tokens;
  }

  for (const dir of input.attachedDirs) {
    const tokens = Math.ceil(DEFAULT_DIR_ESTIMATE_BYTES / 4);
    entries.push({ path: dir, kind: 'dir', bytes: DEFAULT_DIR_ESTIMATE_BYTES, estimatedTokens: tokens });
    attachmentTokens += tokens;
  }

  for (const image of input.attachedImages) {
    entries.push({
      path: image.path,
      kind: 'image',
      bytes: image.size,
      estimatedTokens: ESTIMATED_TOKENS_PER_IMAGE,
    });
    attachmentTokens += ESTIMATED_TOKENS_PER_IMAGE;
  }

  const totalEstimatedTokens = draftTokens + attachmentTokens;
  const remainingTokens = input.usage && input.usage.size > 0
    ? Math.max(0, input.usage.size - input.usage.used)
    : undefined;
  const percentOfRemaining = remainingTokens !== undefined
    ? (remainingTokens === 0 ? (totalEstimatedTokens > 0 ? 100 : 0) : Math.round((totalEstimatedTokens / remainingTokens) * 100))
    : undefined;

  let level: DraftBudgetLevel = 'ok';
  if (percentOfRemaining !== undefined) {
    if (percentOfRemaining >= 80) level = 'tight';
    else if (percentOfRemaining >= 40) level = 'warn';
  } else if (totalEstimatedTokens >= 24_000) {
    level = 'tight';
  } else if (totalEstimatedTokens >= 10_000) {
    level = 'warn';
  }

  return {
    draftTokens,
    attachmentTokens,
    totalEstimatedTokens,
    remainingTokens,
    percentOfRemaining,
    level,
    entries,
  };
}

/** Cache file byte sizes asynchronously so `render()` stays synchronous and never blocks on `stat()`. */
export class AttachmentSizeCache {
  private readonly sizes = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly onResolve: () => void) {}

  get snapshot(): ReadonlyMap<string, number> {
    return this.sizes;
  }

  warm(cwd: string, filePaths: readonly string[]): void {
    const root = resolve(cwd);
    for (const filePath of filePaths) {
      const key = `${root}\0${filePath}`;
      if (this.sizes.has(filePath) || this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
      void stat(abs)
        .then(info => {
          this.inFlight.delete(key);
          this.sizes.set(filePath, info.isFile() ? info.size : 0);
          this.onResolve();
        })
        .catch(() => {
          this.inFlight.delete(key);
          this.sizes.set(filePath, 0);
        });
    }
  }

  clear(): void {
    this.sizes.clear();
    this.inFlight.clear();
  }
}
