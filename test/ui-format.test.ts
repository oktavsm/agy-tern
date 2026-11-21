import { describe, expect, test } from 'bun:test';
import {
  buildUnifiedDiffHunks,
  clipDiffHunks,
  clipInlinePreview,
  collectSessionDiffs,
  computeResponsiveLayout,
  countSessionDiffs,
  extractMarkdownImagePaths,
  extractToolImagePaths,
  extractToolInlineImages,
  extractToolLiveOutput,
  extractToolOutputText,
  buildTaskDetailText,
  formatCompactTokens,
  formatCompactWorkspacePath,
  formatContextUsage,
  formatPathLabel,
  formatPlanSummary,
  formatQuotaResetCountdown,
  formatQuotaResetDisplay,
  formatTranscriptJson,
  formatTranscriptMarkdown,
  isRunnableCodeLang,
  parseUnifiedGitDiff,
  searchTranscript,
  splitMarkdownSegments,
  selectSoonestQuotaReset,
  summarizeQuotaRows,
  summarizeThoughtTopic,
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

  test('segments fenced markdown code blocks, identifies runnable shells, parses git diffs, and extracts tool output', () => {
    expect(isRunnableCodeLang('bash')).toBe(true);
    expect(isRunnableCodeLang('sh')).toBe(true);
    expect(isRunnableCodeLang('typescript')).toBe(false);

    const segs = splitMarkdownSegments([
      'Run the checks:',
      '```bash',
      'bun run typecheck',
      'bun test',
      '```',
      'And review:',
      '```ts',
      'export const x = 1;',
      '```',
    ].join('\n'));
    expect(segs).toEqual([
      { kind: 'prose', text: 'Run the checks:' },
      { kind: 'code', lang: 'bash', text: 'bun run typecheck\nbun test', runnable: true, closed: true },
      { kind: 'prose', text: 'And review:' },
      { kind: 'code', lang: 'ts', text: 'export const x = 1;', runnable: false, closed: true },
    ]);

    const openStreaming = splitMarkdownSegments('Intro\n```sh\necho hi');
    expect(openStreaming).toEqual([
      { kind: 'prose', text: 'Intro' },
      { kind: 'code', lang: 'sh', text: 'echo hi', runnable: false, closed: false },
    ]);

    const parsedDiff = parseUnifiedGitDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,3 +10,4 @@ function run() {',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
    ].join('\n'));
    expect(parsedDiff).toEqual({
      added: 2,
      removed: 1,
      hunks: [{ oldStart: 10, newStart: 10, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'] }],
    });

    expect(extractToolOutputText({ stdout: 'ok\n', stderr: 'warn\n' })).toBe('ok\nwarn');
    expect(extractToolOutputText('')).toBeUndefined();
    expect(extractToolOutputText({ code: 42 })).toBe('{\n  "code": 42\n}');

    expect(countSessionDiffs([
      { type: 'message', id: 'm1', role: 'user', text: 'hi' },
      { type: 'tool', id: 't1', call: { toolCallId: 'c1', content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }] } },
    ])).toBe(1);

    const longLines = Array.from({ length: 40 }, (_, idx) => `line ${idx}`).join('\n');
    const clippedText = clipInlinePreview(longLines, 10, 500);
    expect(clippedText.truncated).toBe(true);
    expect(clippedText.text.split('\n')).toHaveLength(10);

    const clippedHunks = clipDiffHunks([{ oldStart: 1, newStart: 1, lines: Array.from({ length: 50 }, () => '+x') }], 15);
    expect(clippedHunks.truncated).toBe(true);
    expect(clippedHunks.hunks[0]?.lines).toHaveLength(15);

    const cwd = process.cwd();
    const toolImgs = extractToolImagePaths({
      toolCallId: 'shot-1',
      rawOutput: { screenshotPath: 'docs/screenshots/missing-not-checked.png' },
    }, cwd);
    expect(toolImgs).toEqual([`${cwd}/docs/screenshots/missing-not-checked.png`]);

    // Real existing repo path matches via backticked or markdown image only when present on disk.
    expect(extractMarkdownImagePaths('See ![remote](https://example.com/a.png) and `docs/nonexistent.png`', cwd)).toEqual([]);

    const wide = computeResponsiveLayout(180, 50, {
      userComposerLines: 6,
      userShowKeyLegend: true,
      hasPermission: false,
      hasSuggestionsOrAt: false,
      queuedCount: 0,
      hasAttachments: false,
      hasImageAttachments: false,
      hasHud: false,
    });
    expect(wide.panelSize).toBe('lg');
    expect(wide.proseMaxW).toBe('116ch');
    expect(wide.showKeyLegend).toBe(true);
    expect(wide.scrollMaxH).toBe('43lines');

    const smallSplit = computeResponsiveLayout(58, 16, {
      userComposerLines: 10,
      userShowKeyLegend: true,
      hasPermission: false,
      hasSuggestionsOrAt: true,
      queuedCount: 1,
      hasAttachments: true,
      hasImageAttachments: false,
      hasHud: true,
    });
    expect(smallSplit.panelSize).toBe('full');
    expect(smallSplit.proseMaxW).toBe('46ch');
    expect(smallSplit.composerMaxLines).toBe(4);
    expect(smallSplit.dockPopupMaxLines).toBe(3);
    expect(smallSplit.showKeyLegend).toBe(false);
    expect(smallSplit.compactEmpty).toBe(true);
    expect(smallSplit.scrollMaxH).toBe('4lines');

    const longCmd = "bun -e 'import { x } from \"./src/x\";\n" + Array.from({ length: 20 }, (_, i) => `console.log(${i});`).join('\n') + "'";
    const longTool = summarizeToolCall({
      toolCallId: 'long-cmd',
      kind: 'execute',
      title: longCmd,
      status: 'in_progress',
      rawInput: { command: longCmd },
    }, cwd);
    expect(longTool.title).toBe('Run command');
    expect(longTool.target?.includes('\n')).toBe(false);
    expect((longTool.target?.length ?? 0) <= 88).toBe(true);
    expect(longTool.fullCommand).toBe(longCmd);

    expect(summarizeThoughtTopic('')).toBeUndefined();
    expect(summarizeThoughtTopic('**Inspecting settings**\nReading nav rows\n**Updating controls**\nWriting edits')).toBe('Updating controls');
    expect(summarizeThoughtTopic('- First check `src/ui.tsx` for **inline** styles')).toBe('First check src/ui.tsx for inline styles');

    const liveStep = {
      type: 'tool' as const,
      id: 't-live',
      startedAt: 1_000,
      call: {
        toolCallId: 'c-dev',
        kind: 'execute' as const,
        name: 'run_command',
        title: 'npm run dev',
        status: 'in_progress' as const,
        rawInput: { CommandLine: 'npm run dev' },
        content: [{ type: 'content' as const, content: { type: 'text' as const, text: 'VITE v6.0 ready' } }],
        rawOutput: { output: 'VITE v6.0 ready\nLocal: http://localhost:5173' },
      },
    };
    expect(extractToolLiveOutput(liveStep)).toBe('VITE v6.0 ready\nLocal: http://localhost:5173');
    const detail = buildTaskDetailText(liveStep, cwd, {
      pid: 4123,
      stat: 'S+',
      elapsed: '00:12',
      commandLine: 'npm run dev',
    });
    expect(detail).toContain('PID 4123');
    expect(detail).toContain('http://localhost:5173');

    const nowMs = Date.parse('2026-11-21T01:08:00+07:00');
    expect(formatQuotaResetCountdown('2026-11-21 05:48 WIB', nowMs)).toBe('in 4h 40m');
    expect(formatQuotaResetCountdown('2026-11-26 15:24 WIB', nowMs)).toBe('in 5d 14h');
    expect(formatQuotaResetDisplay('2026-11-21 05:48 WIB', nowMs)).toBe('2026-11-21 05:48 WIB (in 4h 40m)');
    expect(formatQuotaResetCountdown('reset-a', nowMs)).toBeUndefined();

    const summary = summarizeQuotaRows([
      { group: 'Gemini', limit: 'Weekly', remaining: '64%', reset: '2026-11-26 15:24 WIB' },
      { group: 'Gemini', limit: 'Five Hour', remaining: '82%', reset: '2026-11-21 05:48 WIB' },
    ])!;
    const soonest = selectSoonestQuotaReset(summary, nowMs);
    expect(soonest.row.limit).toBe('Five Hour');
    expect(soonest.countdown).toBe('in 4h 40m');

    expect(formatCompactWorkspacePath('/home/me/Code/repo', 30, '/home/me')).toBe('~/Code/repo');
    expect(formatCompactWorkspacePath('/home/me/Code/github.com/org/very-long-repo-name', 28, '/home/me'))
      .toContain('very-long-repo-name');
  });
});
