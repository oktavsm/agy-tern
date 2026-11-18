import { describe, expect, test } from 'bun:test';
import { Conversation } from '../src/model';
import {
  DEFAULT_HISTORY_VISIBLE,
  hasRichConversationHistory,
  HistoryReplayCoordinator,
  isReplayContentUpdate,
  SessionStateManager,
  type ReplayTimerAdapter,
} from '../src/session-state';

function makeFakeTimers() {
  let now = 1_000;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  const timers: ReplayTimerAdapter = {
    setTimeout(fn: () => void, ms: number): unknown {
      const id = ++seq;
      tasks.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === 'number') tasks.delete(handle);
    },
    now(): number {
      return now;
    },
  };

  function advanceBy(ms: number): void {
    const target = now + Math.max(0, ms);
    while (true) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, task] of tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const task = tasks.get(nextId)!;
      tasks.delete(nextId);
      now = Math.max(now, task.at);
      task.fn();
    }
    now = target;
  }

  return { timers, advanceBy, setNow: (v: number) => { now = v; }, pendingCount: () => tasks.size };
}

describe('SessionStateManager', () => {
  test('isolates drafts, queues, attachments, retry payloads, and fold overrides per session with LRU eviction', () => {
    const evicted: Array<{ id: string; size: number }> = [];
    const mgr = new SessionStateManager({
      maxInMemory: 2,
      initialDraft: { text: 'boot draft', cursor: 10 },
      onEvictConversation: (id, conv) => evicted.push({ id, size: conv.entries.length }),
    });

    // Empty sessionId adopts boot draft directly onto first session.
    const s1 = mgr.switchSession('s1');
    expect(s1.state.draft).toEqual({ text: 'boot draft', cursor: 10 });
    s1.state.draft = { text: 'draft one', cursor: 9 };
    s1.state.attachedFiles = ['README.md'];
    s1.state.thoughtFoldOverrides.set('t1', true);
    s1.state.historyVisibleCount = 80;
    s1.conversation.startPrompt('hello from s1', '10:00');
    mgr.enqueuePrompt({ text: 'queued 1', files: [], dirs: [], images: [] });
    mgr.setRetryPayload('retry 1', [], ['a.ts'], []);

    // Switching to s2 starts clean without leaking s1's state.
    const s2 = mgr.switchSession('s2');
    expect(mgr.activeSessionId).toBe('s2');
    expect(s2.state.draft).toEqual({ text: '', cursor: 0 });
    expect(s2.state.attachedFiles).toEqual([]);
    expect(s2.state.queuedPrompts).toEqual([]);
    expect(s2.state.lastPrompt).toBe('');
    expect(s2.state.thoughtFoldOverrides.size).toBe(0);
    expect(s2.state.historyVisibleCount).toBe(DEFAULT_HISTORY_VISIBLE);
    s2.conversation.startPrompt('hello from s2', '10:01');

    // Touching s3 while maxInMemory=2 evicts oldest LRU conversation (s1), preserving s1 UI state.
    const s3 = mgr.switchSession('s3');
    s3.conversation.startPrompt('hello from s3', '10:02');
    expect(evicted).toEqual([{ id: 's1', size: 1 }]);
    expect(mgr.hasCachedConversation('s1')).toBe(false);
    expect(mgr.hasCachedConversation('s2')).toBe(true);
    expect(mgr.hasCachedConversation('s3')).toBe(true);

    // Switching back to s1 preserves s1's draft and queue even after conversation eviction.
    const back1 = mgr.switchSession('s1');
    expect(back1.state.draft).toEqual({ text: 'draft one', cursor: 9 });
    expect(back1.state.attachedFiles).toEqual(['README.md']);
    expect(back1.state.queuedPrompts).toHaveLength(1);
    expect(back1.state.lastPrompt).toBe('retry 1');
    expect(back1.state.historyVisibleCount).toBe(80);
  });

  test('supports undo stack, prompt history navigation, queue operations, and session deletion', () => {
    const mgr = new SessionStateManager();
    mgr.switchSession('s1');
    const history = ['first', 'second'];

    expect(mgr.stepPromptHistory(history, -1)).toBe(true);
    expect(mgr.getActive().draft.text).toBe('second');
    expect(mgr.stepPromptHistory(history, -1)).toBe(true);
    expect(mgr.getActive().draft.text).toBe('first');
    expect(mgr.stepPromptHistory(history, 1)).toBe(true);
    expect(mgr.getActive().draft.text).toBe('second');
    expect(mgr.stepPromptHistory(history, 1)).toBe(true);
    expect(mgr.getActive().draft.text).toBe('');

    const d0 = { text: 'a', cursor: 1 };
    const d1 = { text: 'ab', cursor: 2 };
    mgr.getActive().draft = d1;
    mgr.recordUndo(d0, d1);
    expect(mgr.applyUndo()).toEqual(d0);

    mgr.enqueuePrompt({ text: 'p1', files: [], dirs: [], images: [] });
    mgr.enqueuePrompt({ text: 'p2', files: [], dirs: [], images: [] });
    mgr.enqueuePrompt({ text: 'p3', files: [], dirs: [], images: [] });
    expect(mgr.moveQueued(2, 0)).toBe(true);
    expect(mgr.getActive().queuedPrompts.map(q => q.text)).toEqual(['p3', 'p1', 'p2']);
    expect(mgr.moveQueued(99, 0)).toBe(false);
    expect(mgr.togglePinnedTurn('entry-1')).toBe(true);
    expect(mgr.getActive().pinnedTurnIds.has('entry-1')).toBe(true);
    expect(mgr.togglePinnedTurn('entry-1')).toBe(false);
    expect(mgr.drainNextQueued()?.text).toBe('p3');
    expect(mgr.pullQueuedAt(0)?.text).toBe('p1');
    expect(mgr.dropQueuedAt(0)?.text).toBe('p2');
    expect(mgr.deleteSession('s1')).toBe(false);
    mgr.switchSession('s2');
    expect(mgr.deleteSession('s1')).toBe(true);
    expect(mgr.hasCachedConversation('s1')).toBe(false);

    const fresh = new Conversation();
    mgr.replaceActiveConversation(fresh);
    expect(mgr.getConversation()).toBe(fresh);
  });
});

describe('HistoryReplayCoordinator', () => {
  test('settles faster without content updates and extends debounce while replay chunks stream', () => {
    const { timers, advanceBy } = makeFakeTimers();
    const coord = new HistoryReplayCoordinator({
      initialGraceMs: 250,
      settleMs: 350,
      maxSettleMs: 1_500,
      timers,
    });

    const t1 = coord.begin('sess-a', 'load');
    expect(coord.isReplaying).toBe(true);

    let settledCount = 0;
    coord.markRpcResolved(t1, info => {
      settledCount++;
      expect(info.sessionId).toBe('sess-a');
      expect(info.sawContentUpdate).toBe(false);
    });
    advanceBy(249);
    expect(settledCount).toBe(0);
    advanceBy(1);
    expect(settledCount).toBe(1);
    expect(coord.isReplaying).toBe(false);

    // Now test streaming chunks during settling phase.
    const t2 = coord.begin('sess-b', 'load');
    coord.markRpcResolved(t2, () => { settledCount++; });
    advanceBy(100);
    expect(coord.onUpdate('sess-b', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Part 1' },
    })).toBe('replaying');
    advanceBy(300);
    expect(settledCount).toBe(1);
    advanceBy(60);
    expect(settledCount).toBe(2);
    coord.dispose();
  });

  test('guards fallback history against duplicate live appends and delivers late rich replay cleanly', () => {
    const { timers, advanceBy } = makeFakeTimers();
    const coord = new HistoryReplayCoordinator({
      initialGraceMs: 100,
      settleMs: 200,
      maxSettleMs: 1_000,
      timers,
    });

    expect(isReplayContentUpdate({ sessionUpdate: 'session_info_update', title: 'X' })).toBe(false);
    expect(isReplayContentUpdate({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    })).toBe(true);

    const token = coord.begin('sess-late', 'load');
    let settled = false;
    coord.markRpcResolved(token, () => { settled = true; });
    advanceBy(120);
    expect(settled).toBe(true);

    let lateEntries = 0;
    let sawAgent = false;
    coord.enterFallbackWatching(token, {
      hadDiskEntries: false,
      preNoticeEntryCount: 0,
      onLateRichReplay: entries => {
        lateEntries = entries.length;
        const c = new Conversation();
        c.restoreEntries(entries);
        sawAgent = hasRichConversationHistory(c);
      },
    });

    expect(coord.onUpdate('sess-late', {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Old user' },
    })).toBe('shadow');
    expect(coord.onUpdate('sess-late', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Old agent reply' },
    })).toBe('shadow');
    advanceBy(250);
    expect(lateEntries).toBe(2);
    expect(sawAgent).toBe(true);

    // Disarm prevents any subsequent late delivery once user starts interacting.
    const t2 = coord.begin('sess-disarm', 'resume');
    coord.markRpcResolved(t2, () => {});
    let firedAfterDisarm = false;
    coord.enterFallbackWatching(t2, {
      hadDiskEntries: false,
      preNoticeEntryCount: 0,
      onLateRichReplay: () => { firedAfterDisarm = true; },
    });
    coord.disarmLateReplay();
    expect(coord.onUpdate('sess-disarm', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Should be ignored' },
    })).toBe('ignored');
    advanceBy(500);
    expect(firedAfterDisarm).toBe(false);
  });
});
