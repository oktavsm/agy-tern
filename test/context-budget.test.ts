import { describe, expect, test } from 'bun:test';
import { computeDraftContextBudget, estimateTextTokens, formatCompactTokens } from '../src/context-budget';

describe('context-budget estimator', () => {
  test('estimates compact tokens and severity thresholds against remaining ACP window', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('hello world')).toBe(3);
    expect(formatCompactTokens(850)).toBe('850');
    expect(formatCompactTokens(2_400)).toBe('2.4K');
    expect(formatCompactTokens(18_400)).toBe('18K');

    const ok = computeDraftContextBudget({
      draftText: 'explain this module',
      attachedFiles: ['src/ui.tsx'],
      attachedDirs: ['src/'],
      attachedImages: [{ path: 'shot.png', mimeType: 'image/png', data: '', size: 4096 }],
      fileSizes: new Map([['src/ui.tsx', 8_000]]),
      usage: { used: 10_000, size: 100_000 } as never,
    });
    expect(ok.attachmentTokens).toBe(2_000 + 384 + 1_200);
    expect(ok.remainingTokens).toBe(90_000);
    expect(ok.level).toBe('ok');

    const tight = computeDraftContextBudget({
      draftText: 'review all',
      attachedFiles: ['huge.log'],
      attachedDirs: [],
      attachedImages: [],
      fileSizes: new Map([['huge.log', 200_000]]),
      usage: { used: 84_000, size: 100_000 } as never,
    });
    expect(tight.attachmentTokens).toBe(16_384);
    expect(tight.level).toBe('tight');
  });
});
