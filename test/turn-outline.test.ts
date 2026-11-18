import { describe, expect, test } from 'bun:test';
import { Conversation } from '../src/model';
import { buildTurnOutline, filterTurnOutline } from '../src/turn-outline';

describe('turn-outline indexing', () => {
  test('indexes prompts, replies, tools, thoughts, errors, and pinned filters cleanly', () => {
    const conv = new Conversation();
    conv.startPrompt('Inspect @src/ui.tsx for bugs', '10:01');
    conv.update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking render loop' },
    } as never);
    conv.update({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read src/ui.tsx',
      kind: 'read',
      status: 'completed',
    } as never);
    conv.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Found zero issues in render loop.' },
    } as never);

    conv.startPrompt('Run full build', '10:02');
    conv.notice('Build failed cleanly', true);

    const pinned = new Set([conv.entries[0]!.id]);
    const outline = buildTurnOutline(conv.entries, pinned);
    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      turnNumber: 1,
      pinned: true,
      toolCount: 1,
      thoughtCount: 1,
      hasError: false,
      replyPreview: 'Found zero issues in render loop.',
    });
    expect(outline[1]).toMatchObject({
      turnNumber: 2,
      pinned: false,
      hasError: true,
    });

    expect(filterTurnOutline(outline, 'pinned', '')).toHaveLength(1);
    expect(filterTurnOutline(outline, 'all', '#2')).toHaveLength(1);
    expect(filterTurnOutline(outline, 'all', 'zero issues')).toHaveLength(1);
  });
});
