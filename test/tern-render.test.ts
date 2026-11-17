import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Op, TspEvent } from '@stencil-hq/tern';
import { jsx } from '@stencil-hq/tern/jsx-runtime';
import { Conversation } from '../src/model';
import {
  AsyncPathPresenceCache,
  isEntrySettled,
  TernRenderController,
  type RenderTimerAdapter,
  type TernSessionLike,
  type TernSurfaceLike,
} from '../src/tern-render';

function makeFakeSession(opts?: {
  features?: string[];
  reduceMotion?: boolean;
  dark?: boolean;
  cols?: number;
}) {
  const sentOps: Op[][] = [];
  let renderCalls = 0;
  let blocked = false;
  let closed = false;

  const surface: TernSurfaceLike = {
    id: 's1',
    get closed() { return closed; },
    get blocked() { return blocked; },
    render() { renderCalls++; },
    send(ops) { sentOps.push([...ops]); },
    focus() {},
    reveal() {},
    scroll() {},
  };

  const session: TernSessionLike = {
    caps: {
      cols: opts?.cols ?? 120,
      dark: opts?.dark ?? true,
      reduceMotion: opts?.reduceMotion ?? false,
      features: opts?.features ?? ['settle', 'edit', 'undo'],
    },
    open() { return surface; },
  };

  return {
    session,
    surface,
    sentOps,
    get renderCalls() { return renderCalls; },
    setBlocked(v: boolean) { blocked = v; },
    setClosed(v: boolean) { closed = v; },
  };
}

function makeFakeTimers() {
  let now = 1_000;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  const timers: RenderTimerAdapter = {
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

  return { timers, advanceBy };
}

describe('AsyncPathPresenceCache', () => {
  test('never blocks on cold path and notifies once async probe resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-path-cache-'));
    try {
      const target = join(dir, 'hello.txt');
      await writeFile(target, 'ok');
      const cache = new AsyncPathPresenceCache({ ttlMs: 10_000, maxEntries: 8 });

      let notified = 0;
      expect(cache.peek(target, () => { notified++; })).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(notified).toBe(1);
      expect(cache.peek(target)).toBe(true);
      expect(cache.version).toBeGreaterThan(0);

      const missing = join(dir, 'nope.txt');
      expect(await cache.probe(missing)).toBe(false);
      expect(cache.peek(missing)).toBe(false);
      cache.clear();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isEntrySettled and TernRenderController', () => {
  test('adapts frame cadence, caps reduced-motion FPS, handles TSP events, and emits settle ops', () => {
    const fake = makeFakeSession({ features: ['settle'], reduceMotion: false });
    const { timers, advanceBy } = makeFakeTimers();
    const ctrl = new TernRenderController({
      session: fake.session,
      surface: fake.surface,
      title: 'Test',
      maxFps: 25,
      motion: 'auto',
      timers,
    });

    expect(ctrl.effectiveFps()).toBe(25);
    expect(ctrl.frameIntervalMs(true)).toBe(40);
    expect(ctrl.frameIntervalMs(false)).toBe(20);

    ctrl.updatePreferences({ maxFps: 60, motion: 'reduced' });
    expect(ctrl.effectiveReduceMotion()).toBe(true);
    expect(ctrl.effectiveFps()).toBe(12);
    expect(ctrl.frameIntervalMs(true)).toBe(83);

    ctrl.updatePreferences({ maxFps: 25, motion: 'auto' });

    // Stable age freezes snapshot for a given startedAt so Tern ticks natively without churn.
    const a1 = ctrl.stableAge('t1', 500);
    advanceBy(500);
    expect(ctrl.stableAge('t1', 500)).toBe(a1);
    expect(ctrl.stableAge('t1', 1200)).toBe(300);

    // Visibility gating defers hidden renders until visible returns.
    let renderCount = 0;
    expect(ctrl.handleSessionEvent({ ev: 'visible', visible: false } as TspEvent, () => { renderCount++; })).toBe(true);
    ctrl.scheduleRender(true, () => { renderCount++; });
    expect(renderCount).toBe(0);
    expect(ctrl.dirtyWhenHidden).toBe(true);
    expect(ctrl.handleSessionEvent({ ev: 'visible', visible: true } as TspEvent, () => { renderCount++; })).toBe(true);
    expect(renderCount).toBe(1);

    // Resize debouncing + theme + motion events.
    ctrl.handleSessionEvent({ ev: 'theme', dark: false } as TspEvent, () => { renderCount++; });
    expect(ctrl.dark).toBe(false);
    expect(renderCount).toBe(2);

    ctrl.handleSessionEvent({ ev: 'motion', reduce: true } as TspEvent, () => { renderCount++; });
    expect(ctrl.effectiveReduceMotion()).toBe(true);
    expect(renderCount).toBe(3);

    // Entry memoization and settle ops on settled entries.
    const conv = new Conversation();
    conv.startPrompt('Hello', '12:00');
    conv.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } }, 1_000, '12:00');
    conv.finishTurn(1_200, false);

    const entries = conv.entries;
    expect(isEntrySettled(entries[0]!, 0, entries.length, false, false, undefined)).toBe(true);
    expect(isEntrySettled(entries[1]!, 1, entries.length, false, false, undefined)).toBe(true);
    expect(isEntrySettled(entries[1]!, 1, entries.length, false, true, undefined)).toBe(false);

    let builds = 0;
    const recs = entries.map(entry => ctrl.renderEntryMemoized(
      entry,
      { sig: `${conv.revisionOf(entry)}|settled`, settled: true },
      () => {
        builds++;
        return jsx('text', { children: entry.id }, entry.id);
      },
    ));
    expect(builds).toBe(2);

    // Re-evaluating with same sig hits WeakMap cache with zero builds.
    ctrl.renderEntryMemoized(entries[0]!, { sig: `${conv.revisionOf(entries[0]!)}|settled`, settled: true }, () => {
      builds++;
      return jsx('text', { children: 'miss' });
    });
    expect(builds).toBe(2);

    const newlySettled = ctrl.commitFrame({ main: jsx('col', {}) }, recs, false);
    expect(newlySettled).toEqual(entries.map(e => `main.conversation.${e.id}`));
    expect(fake.sentOps[0]).toEqual(newlySettled.map(id => ['settle', id] as Op));

    // Re-committing unchanged settled entries emits no redundant settle ops.
    expect(ctrl.commitFrame({ main: jsx('col', {}) }, recs, false)).toEqual([]);

    ctrl.dispose();
  });
});
