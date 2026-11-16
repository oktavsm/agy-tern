import { expect, test } from 'bun:test';
import { Conversation } from '../src/model';

test('keeps messages and tools in first-observed order, merging partial tool snapshots', () => {
  const chat = new Conversation();
  chat.startPrompt('Inspect the build');
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking ' } });
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'now.' } });
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'one', title: 'Read configuration', status: 'pending',
    rawInput: { path: 'package.json' }, content: [{ type: 'content', content: { type: 'text', text: 'initial' } }] });
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'two', title: 'Run build', status: 'in_progress' });
  chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'in_progress' });
  chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'one', title: null, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'final' } }], rawOutput: { ok: true } });
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build is still running.' } });
  expect(chat.entries.map(entry => entry.type)).toEqual(['message', 'message', 'tool', 'tool', 'message']);
  expect(chat.entries[1]).toMatchObject({ text: 'Checking now.' });
  expect(chat.entries[2]).toMatchObject({ call: { title: 'Read configuration', status: 'completed',
    rawInput: { path: 'package.json' }, rawOutput: { ok: true },
    content: [{ type: 'content', content: { type: 'text', text: 'final' } }] } });
  expect(chat.entries[3]).toMatchObject({ call: { toolCallId: 'two', status: 'in_progress' } });
});

test('accepts an update before a tool announcement without moving or duplicating the tool', () => {
  const chat = new Conversation();
  chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'early', rawOutput: 'partial' });
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Read done.' } });
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'early', title: 'Read', status: 'completed' });
  expect(chat.entries).toHaveLength(2);
  expect(chat.entries[0]).toMatchObject({ type: 'tool', call: { title: 'Read', rawOutput: 'partial', status: 'completed' } });
  chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'early', content: [], rawOutput: null });
  expect(chat.entries[0]).toMatchObject({ call: { content: [], rawOutput: null } });
});

test('uses explicit message IDs without joining different messages and keeps thoughts separate', () => {
  const chat = new Conversation();
  chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'First' } }, 100);
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read' }, 110);
  chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: ' answer' } }, 120);
  chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden ' } }, 130);
  chat.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'step' } }, 140);
  chat.update({ sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'Second answer' } }, 200);
  expect(chat.entries).toHaveLength(4);
  expect(chat.entries[0]).toMatchObject({ type: 'message', text: 'First answer' });
  expect(chat.entries[2]).toMatchObject({ type: 'thought', text: 'hidden step', startedAt: 130, endedAt: 200 });
  expect(chat.entries[3]).toMatchObject({ type: 'message', text: 'Second answer' });
});

test('tracks live tool duration only when observed active and exposes currentPlan', () => {
  const chat = new Conversation();
  chat.startPrompt('Update files');
  expect(chat.currentPlan).toBeUndefined();
  chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Edit file', priority: 'high', status: 'in_progress' }] }, 100);
  expect(chat.currentPlan?.entries).toHaveLength(1);
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'live', title: 'Live tool', status: 'in_progress' }, 200);
  chat.update({ sessionUpdate: 'tool_call_update', toolCallId: 'live', status: 'completed' }, 650);
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'replay', title: 'Replay tool', status: 'completed' }, 700);
  const live = chat.getTool('live');
  const replay = chat.getTool('replay');
  expect(live?.startedAt).toBe(200);
  expect(live?.endedAt).toBe(650);
  expect(replay?.startedAt).toBeUndefined();
  expect(replay?.endedAt).toBeUndefined();
});

test('replaces plan entries in place and starts a distinct plan for the next prompt', () => {
  const chat = new Conversation();
  chat.startPrompt('First task');
  chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', priority: 'high', status: 'pending' }] });
  chat.update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read' });
  chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', priority: 'high', status: 'completed' }] });
  expect(chat.entries.map(entry => entry.type)).toEqual(['message', 'plan', 'tool']);
  expect(chat.entries[1]).toMatchObject({ entries: [{ status: 'completed' }] });
  chat.startPrompt('Second task');
  chat.update({ sessionUpdate: 'plan', entries: [{ content: 'Build', priority: 'medium', status: 'in_progress' }] });
  expect(chat.entries.map(entry => entry.type)).toEqual(['message', 'plan', 'tool', 'message', 'plan']);
});

test('stores inline image blocks on agent messages alongside text chunks', () => {
  const chat = new Conversation();
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Screenshot captured:' } });
  chat.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'iVBORw0=', mimeType: 'image/png' } });
  expect(chat.entries).toHaveLength(1);
  expect(chat.entries[0]).toMatchObject({
    type: 'message',
    role: 'agent',
    text: 'Screenshot captured:',
    images: [{ data: 'iVBORw0=', mimeType: 'image/png' }],
  });
});

test('projects ACP notices and context compaction summary updates in order', () => {
  const chat = new Conversation();
  chat.update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
  chat.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'Part 1. ' } });
  chat.update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'Part 2.' } });
  chat.update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
  chat.update({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limit near', description: 'Consider /compact' });
  chat.update({ sessionUpdate: 'notice', severity: 'error', title: 'Sandbox denied' });
  expect(chat.entries).toEqual([
    { type: 'compaction', id: 'entry-1', compactionId: 'c1', status: 'completed', text: 'Part 1. Part 2.' },
    { type: 'notice', id: 'entry-2', text: 'Rate limit near: Consider /compact', error: false },
    { type: 'notice', id: 'entry-3', text: 'Sandbox denied', error: true },
  ]);
});
