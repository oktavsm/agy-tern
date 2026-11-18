import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv } from './harness/cli-runner';
import { TspHarness } from './harness/tsp-emulator';

const E2E_AGENT_PATH = resolve(import.meta.dir, 'fixtures/e2e-agent.ts');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
});

describe('agy-tern native Tern E2E smoke', () => {
  test('renders composer bar, starburst spinner, settle ops, server permission filtering, and /settings controls', async () => {
    const iso: IsolatedEnv = await createIsolatedEnv({ prefix: 'agy-e2e-smoke-' });
    cleanups.push(() => iso.cleanup());

    const harness = await TspHarness.launch({
      agyPath: E2E_AGENT_PATH,
      isolatedEnv: iso,
      cols: 120,
      rows: 40,
      args: ['--max-fps', '40'],
      env: {
        AGY_E2E_STREAM_DELAY_MS: '60',
        AGY_E2E_THOUGHT_CHUNKS: '2',
        AGY_E2E_STREAM_CHUNKS: '3',
      },
    });
    cleanups.push(async () => { await harness.close(); });

    await harness.waitForReady({ timeoutMs: 8_000 });
    harness.assertWireInvariants();

    // Verify centered rounded composer card, composer control bar, and effort indicator render on idle screen.
    const composerShell = harness.findById('dock.shell');
    expect(composerShell).toBeDefined();
    expect(composerShell?.p['role']).toBe('agy.dock.center');
    expect(composerShell?.p['max']).toEqual({ w: '92ch' });
    const composerCard = harness.findById('dock.shell.composer');
    expect(composerCard?.p['role']).toBe('omp.editor');
    const draftNode = harness.findById('dock.shell.composer.line.draft');
    expect(draftNode?.p['variant']).toBe('well');
    const composerBar = harness.findById('dock.shell.composer.composer-bar');
    expect(composerBar).toBeDefined();
    const usageButton = harness.findByKind('button', 'dock').find(node => node.id.endsWith('.usage'));
    expect(usageButton).toBeDefined();
    expect(String(usageButton?.p['text'])).toContain('Usage');
    harness.sendAction(usageButton!.id, 'click');
    await harness.waitForText('Usage & Quota', 'layer', 5_000);
    harness.sendKey('esc');
    const panelDeadline = Date.now() + 4_000;
    while (harness.findById('layer.panel') && Date.now() < panelDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.panel')).toBeUndefined();
    expect(harness.findByKind('effort', 'dock').length).toBeGreaterThanOrEqual(1);

    // Run a streaming turn and verify starburst working HUD + settle ops on completion.
    harness.sendText('stream');
    harness.sendKey('enter');

    const starburst = await harness.waitForNode(
      node => node.k === 'spinner' && node.p['style'] === 'starburst',
      5_000,
    );
    expect(starburst.p['style']).toBe('starburst');

    await harness.waitForText('Stream chunk 3/3.', 'main', 8_000);
    await harness.waitForReady({ timeoutMs: 5_000 });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
    expect(harness.getSettledIds().length).toBeGreaterThanOrEqual(2);
    harness.assertWireInvariants();

    // Verify usage + cost meter renders after /fixture-refresh.
    harness.sendText('/fixture-refresh');
    harness.sendKey('enter');
    await harness.waitForText('Local fixture metadata refreshed.', 'main', 6_000);
    await harness.waitForNode(node => node.k === 'meter' && node.id.includes('context'), 5_000);
    expect(harness.extractText('dock')).toContain('0.2500 fixture-credits');

    // Verify permission panel offers only allow_once/reject_once (never allow_always) and answers server optionId.
    harness.sendText('permission-rich');
    harness.sendKey('enter');
    await harness.waitForText('Approval required', 'dock', 6_000);
    const dockApprovalText = harness.extractText('dock');
    expect(dockApprovalText).toContain('Allow once (srv)');
    expect(dockApprovalText).toContain('Reject once (srv)');
    expect(dockApprovalText).not.toContain('Always allow');

    harness.sendKey('ctrl+y');
    await harness.waitForText('"optionId":"srv-allow-1"', 'main', 6_000);
    harness.assertWireInvariants();

    // Verify ACP follow-up question (elicitation/create) opens centered modal and submits response cleanly.
    harness.sendText('ask-followup');
    harness.sendKey('enter');
    await harness.waitForText('Release channel', 'layer', 6_000);
    expect(harness.extractText('layer')).toContain('Choose target release channel before tagging.');
    harness.sendKey('enter');
    await harness.waitForText('"channel":"stable"', 'main', 6_000);
    harness.assertWireInvariants();

    // Verify /settings navigation (clicks + keyboard), switches, choices, and sub-panel return cleanly.
    harness.sendText('/settings');
    harness.sendKey('enter');
    const prefsNode = await harness.waitForNode(node => node.k === 'prefs', 5_000);
    const prefsJson = JSON.stringify(prefsNode.p);
    expect(prefsJson).toContain('"id":"maxFps"');
    expect(prefsJson).toContain('"id":"motion"');
    expect(prefsNode.p['page']).toBe('appearance');
    expect(prefsNode.p['focus']).toBe('diffMode');

    // Keyboard: Right changes diffMode (auto -> unified); Down+Down+Enter flips thoughtExpanded switch.
    harness.sendKey('right');
    await harness.waitForNode(node => node.k === 'prefs' && JSON.stringify(node.p).includes('"value":"unified"'), 4_000);
    harness.sendKey('down');
    harness.sendKey('down');
    harness.sendKey('enter');
    await harness.waitForNode(
      node => node.k === 'prefs' && /"id":"thoughtExpanded"[^}]*"on":true/.test(JSON.stringify(node.p)),
      4_000,
    );

    // Click navigation & click switch via Tern wire events (`change` with `value` / `on`).
    harness.sendChange('layer.prefs', { value: 'session' });
    await harness.waitForNode(node => node.k === 'prefs' && node.p['page'] === 'session', 4_000);
    harness.sendAction('layer.prefs', 'page', { value: 'permissions' });
    await harness.waitForNode(node => node.k === 'prefs' && node.p['page'] === 'permissions', 4_000);
    harness.sendChange('layer.prefs', { item: 'showTimestamps', on: false });
    await harness.waitForNode(
      node => node.k === 'prefs' && /"id":"showTimestamps"[^}]*"on":false/.test(JSON.stringify(node.p)),
      4_000,
    );

    // Trigger View details on permissions page -> Esc returns back to /settings instead of closing modal.
    harness.sendAction('layer.prefs', 'open-permissions');
    await harness.waitForText('Permissions & Sandbox', 'layer', 4_000);
    harness.sendKey('esc');
    await harness.waitForNode(node => node.k === 'prefs' && node.p['page'] === 'permissions', 4_000);
    harness.assertWireInvariants();

    harness.sendKey('esc');
    const deadline = Date.now() + 4_000;
    while (harness.findById('layer.prefs') && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.prefs')).toBeUndefined();

    // Quit cleanly with Ctrl+Q.
    harness.sendKey('ctrl+q');
    const closed = await harness.waitForExit(5_000);
    expect(closed.exitCode).toBe(0);
  }, 30_000);
});
