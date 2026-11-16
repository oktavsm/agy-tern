import { describe, expect, test } from 'bun:test';
import {
  buildUnifiedDiffHunks,
  collectSessionDiffs,
  extractToolImagePaths,
  extractToolInlineImages,
  formatCompactTokens,
  formatContextUsage,
  formatPathLabel,
  formatPlanSummary,
  formatTranscriptJson,
  formatTranscriptMarkdown,
  searchTranscript,
  summarizeQuotaRows,
  summarizeToolCall,
  thinkingOption,
} from '../src/ui-format';

describe('ui formatting helpers', () => {
  test('builds unified diff hunks with accurate line numbers and counts', () => {
    const oldText = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join('\n');
    const newText = ['line 1', 'line 2', 'line 3', 'line four', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9'].join('\n');
    const result = buildUnifiedDiffHunks(oldText, newText, 1);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.hunks).toEqual([
      {
        oldStart: 3,
        newStart: 3,
        lines: [' line 3', '-line 4', '+line four', ' line 5'],
      },
      {
        oldStart: 8,
        newStart: 8,
        lines: [' line 8', '+line 9'],
      },
    ]);
  });

  test('shortens workspace paths while preserving external paths', () => {
    expect(formatPathLabel('/repo/app/src/ui.tsx', '/repo/app')).toBe('src/ui.tsx');
    expect(formatPathLabel('/etc/hosts', '/repo/app')).toBe('/etc/hosts');
    expect(formatPathLabel('relative/file.ts', '/repo/app')).toBe('relative/file.ts');
  });

  test('summarizes tool calls into native targets, inline vs card frames, and diff badges', () => {
    const readTool = summarizeToolCall({
      toolCallId: 't1',
      name: 'read_file',
      title: 'Read ui.tsx',
      status: 'completed',
      locations: [{ path: '/repo/app/src/ui.tsx', line: 12 }],
      rawInput: { path: '/repo/app/src/ui.tsx' },
    }, '/repo/app');
    expect(readTool).toMatchObject({
      name: 'read',
      target: 'src/ui.tsx:12',
      targetKind: 'path',
      frame: 'inline',
      showRawInput: false,
    });

    const editTool = summarizeToolCall({
      toolCallId: 't2',
      name: 'edit_file',
      title: 'Edit Navigation.kt',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/app/Navigation.kt', oldText: 'a\nb\n', newText: 'a\nc\nd\n' }],
    }, '/repo/app');
    expect(editTool).toMatchObject({
      name: 'edit',
      frame: 'card',
      hasDiff: true,
      badges: [
        { text: '+2', tone: 'success' },
        { text: '-1', tone: 'error' },
      ],
    });

    const bashTool = summarizeToolCall({
      toolCallId: 't3',
      kind: 'execute',
      title: 'Run tests',
      status: 'completed',
      rawInput: { command: 'bun test' },
      rawOutput: { exitCode: 0, stdout: 'ok' },
    }, '/repo/app');
    expect(bashTool).toMatchObject({
      name: 'bash',
      target: 'bun test',
      targetKind: 'command',
      frame: 'card',
      exit: 0,
      showRawInput: false,
    });
  });

  test('formats context usage and plan summary honestly without inventing data', () => {
    expect(formatContextUsage(undefined)).toBeUndefined();
    expect(formatContextUsage({ used: 0, size: 0 })).toBeUndefined();
    expect(formatCompactTokens(512)).toBe('512');
    expect(formatCompactTokens(4_096)).toBe('4.1K');
    expect(formatCompactTokens(500_000)).toBe('500K');
    expect(formatContextUsage({ used: 240_000, size: 500_000 })).toEqual({
      percent: 48,
      usedLabel: '240K',
      sizeLabel: '500K',
      summary: '48% · 240K/500K',
    });

    expect(formatPlanSummary(undefined)).toBeUndefined();
    expect(formatPlanSummary({
      type: 'plan',
      id: 'p1',
      entries: [
        { content: 'Step 1', priority: 'high', status: 'completed' },
        { content: 'Step 2', priority: 'high', status: 'in_progress' },
        { content: 'Step 3', priority: 'medium', status: 'pending' },
      ],
    })).toEqual({
      done: 1,
      total: 3,
      activeText: 'Step 2',
    });

    expect(summarizeQuotaRows(undefined)).toBeUndefined();
    expect(summarizeQuotaRows([
      { group: 'Gemini', limit: 'Weekly', remaining: '75%', reset: '2026-11-21' },
      { group: 'Flash', limit: '5h', remaining: '30%', reset: '2026-11-16' },
    ])).toEqual({
      groupCount: 2,
      tightest: { group: 'Flash', limit: '5h', remaining: '30%', reset: '2026-11-16', fraction: 0.3 },
      rows: [
        { group: 'Gemini', limit: 'Weekly', remaining: '75%', reset: '2026-11-21', fraction: 0.75 },
        { group: 'Flash', limit: '5h', remaining: '30%', reset: '2026-11-16', fraction: 0.3 },
      ],
    });
  });

  test('collects session diffs and locates thought_level config option', () => {
    const diffs = collectSessionDiffs([
      {
        type: 'tool',
        id: 'entry-1',
        call: {
          toolCallId: 't1',
          title: 'Edit 1',
          content: [{ type: 'diff', path: '/repo/src/a.ts', oldText: 'const x = 1;\n', newText: 'const x = 2;\n' }],
        },
      },
      {
        type: 'tool',
        id: 'entry-2',
        call: {
          toolCallId: 't2',
          title: 'Create b.ts',
          content: [{ type: 'diff', path: '/repo/src/b.ts', oldText: null, newText: 'export const b = 1;\nexport const c = 2;' }],
        },
      },
    ], '/repo');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({
      id: 'entry-1:0',
      path: 'src/a.ts',
      added: 1,
      removed: 1,
    });
    expect(diffs[0]?.newFileText).toBeUndefined();
    expect(diffs[1]).toMatchObject({
      id: 'entry-2:0',
      path: 'src/b.ts',
      added: 2,
      removed: 0,
      newFileText: 'export const b = 1;\nexport const c = 2;',
    });
    expect(thinkingOption([
      { id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [] },
      { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'medium', options: [] },
    ])?.currentValue).toBe('medium');
    expect(thinkingOption([])).toBeUndefined();

    const md = formatTranscriptMarkdown([
      { type: 'message', id: 'm1', role: 'user', text: 'Check file' },
      { type: 'tool', id: 't1', call: { toolCallId: 'tc1', title: 'Edit a.ts', content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a\n', newText: 'b\n' }] } },
      { type: 'message', id: 'm2', role: 'agent', text: 'Done.' },
    ], '/repo', { title: 'Test Chat', sessionId: 'sess-1' });
    expect(md).toContain('# Test Chat');
    expect(md).toContain('## User\n\nCheck file');
    expect(md).toContain('```diff');
    expect(md).toContain('+b');
    expect(md).toContain('## Antigravity\n\nDone.');

    const parsedJson = JSON.parse(formatTranscriptJson([
      { type: 'message', id: 'm1', role: 'user', text: 'Check file' },
      { type: 'message', id: 'm2', role: 'agent', text: 'Done.' },
    ], '/repo', { title: 'Test Chat', sessionId: 'sess-1' }));
    expect(parsedJson).toMatchObject({
      title: 'Test Chat',
      sessionId: 'sess-1',
      workspace: '/repo',
      entries: [
        { type: 'message', role: 'user', text: 'Check file' },
        { type: 'message', role: 'agent', text: 'Done.' },
      ],
    });
  });

  test('extracts tool image paths, inline images, and filters transcript entries for /find', () => {
    const toolCall = {
      toolCallId: 'img-1',
      name: 'read_file',
      title: 'Inspect screenshot',
      locations: [{ path: 'shots/screen.png' }],
      rawInput: { screenshotPath: '/repo/shots/screen.png', other: 'src/app.ts' },
      content: [
        { type: 'content' as const, content: { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' } },
      ],
    };
    expect(extractToolImagePaths(toolCall, '/repo')).toEqual(['/repo/shots/screen.png']);
    expect(extractToolInlineImages(toolCall)).toEqual([{ data: 'AAAA', mimeType: 'image/png' }]);

    const matches = searchTranscript([
      { type: 'message', id: 'm1', role: 'user', text: 'Inspect screenshot' },
      { type: 'thought', id: 'th1', text: 'Checking PNG header dimensions', startedAt: 1 },
      { type: 'tool', id: 't1', call: toolCall },
      { type: 'notice', id: 'n1', text: 'Done scanning', error: false },
    ], '/repo', 'png');
    expect(matches.map(m => m.id)).toEqual(['t1', 'th1']);
    expect(searchTranscript([
      { type: 'message', id: 'm1', role: 'user', text: 'Inspect screenshot' },
      { type: 'thought', id: 'th1', text: 'Checking PNG header dimensions', startedAt: 1 },
      { type: 'tool', id: 't1', call: toolCall },
    ], '/repo', 'dimensions').map(m => m.id)).toEqual(['th1']);
    expect(searchTranscript([
      { type: 'message', id: 'm1', role: 'user', text: 'Inspect screenshot' },
      { type: 'tool', id: 't1', call: toolCall },
    ], '/repo', 'screen').map(m => m.id)).toEqual(['t1', 'm1']);
  });
});
