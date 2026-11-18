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
    const iso: IsolatedEnv = await createIsolatedEnv({
      prefix: 'agy-e2e-smoke-',
      seedFiles: {
        'src/app.ts': 'export const ok = true;\n',
        'README.md': '# Demo\n',
      },
    });
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

    // Verify Antigravity logo PNG blob renders on welcome screen and carries through to assistant message avatars.
    const brandAvatar = harness.findById('main.conversation.empty-wrap.agy-brand');
    expect(brandAvatar?.k).toBe('avatar');
    const brandBlob = String(brandAvatar?.p['blob'] ?? '');
    expect(brandBlob.length).toBeGreaterThan(0);
    expect(harness.getBlobs().get(brandBlob)?.mime).toBe('image/png');

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

    // Run a streaming turn and verify starburst working HUD, kitt shimmer, live expanded thought, and settle ops on completion.
    harness.sendText('stream');
    harness.sendKey('enter');

    const starburst = await harness.waitForNode(
      node => node.k === 'spinner' && node.p['style'] === 'starburst',
      5_000,
    );
    expect(starburst.p['style']).toBe('starburst');
    const kittShimmer = harness.findByKind('shimmer', 'dock').find(node => node.p['mode'] === 'kitt');
    expect(kittShimmer).toBeDefined();

    const liveThought = await harness.waitForNode(
      node => node.k === 'trace' && node.p['variant'] === 'card' && node.p['open'] === true && node.p['status'] === 'running',
      5_000,
    );
    expect(liveThought.p['open']).toBe(true);

    await harness.waitForText('Stream chunk 3/3.', 'main', 8_000);
    await harness.waitForReady({ timeoutMs: 5_000 });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 80));
    const settledThought = harness.findByKind('trace', 'main').find(node => node.id === liveThought.id);
    expect(settledThought?.p['open']).toBe(false);
    expect(settledThought?.p['status']).toBe('done');
    const agentMessage = harness.findByKind('message', 'main').find(node => node.p['author'] === 'Antigravity');
    expect(JSON.stringify(agentMessage)).toContain(brandBlob);
    expect(harness.getSettledIds().length).toBeGreaterThanOrEqual(2);
    harness.assertWireInvariants();

    // Verify /settings navigation, ACP config (Thinking level, Model picker, boolean toggle), and sub-panel Esc return BEFORE /fixture-refresh shrinks options.
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

    // Click navigation & ACP config updates via Tern wire events (`change` with `value` / `on`).
    harness.sendChange('layer.prefs', { value: 'session' });
    await harness.waitForNode(node => node.k === 'prefs' && node.p['page'] === 'session', 4_000);

    // Changing Thinking level & boolean ACP switch via `<prefs>` onChange updates ACP config cleanly.
    harness.sendChange('layer.prefs', { item: 'cfg-thought_level', value: 'low' });
    await harness.waitForText('Thinking level updated', 'layer', 4_000);
    await harness.waitForNode(
      node => node.k === 'prefs' && /"id":"cfg-thought_level"[^]*?"value":"low"/.test(JSON.stringify(node.p)),
      4_000,
    );
    harness.sendChange('layer.prefs', { item: 'cfg-reports', on: true });
    await harness.waitForText('Synthetic reports updated', 'layer', 4_000);
    await harness.waitForNode(
      node => node.k === 'prefs' && /"id":"cfg-reports"[^}]*"on":true/.test(JSON.stringify(node.p)),
      4_000,
    );

    // Clicking Model action in /settings opens the Model picker; selecting fixture-large updates Model & returns to /settings.
    harness.sendAction('layer.prefs', 'open-config:model');
    const modelPicker = await harness.waitForNode(node => node.k === 'picker' && node.p['title'] === 'Model', 4_000);
    expect(modelPicker.p['title']).toBe('Model');
    harness.sendActivate(modelPicker.id, 'fixture-large');
    await harness.waitForNode(
      node => node.k === 'prefs' && JSON.stringify(node.p).includes('Large synthetic model'),
      4_000,
    );

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

    // Verify ACP follow-up question (elicitation/create) opens centered modal, focuses clicked free-form <input>, edits text, and submits response cleanly.
    harness.sendText('ask-followup');
    harness.sendKey('enter');
    await harness.waitForText('Release channel', 'layer', 6_000);
    expect(harness.extractText('layer')).toContain('Choose target release channel before tagging.');
    const otherInputId = 'layer.panel.overlay-scroll.form.field-other.input-other';
    expect(harness.findById(otherInputId)).toBeDefined();
    harness.sendFocus(otherInputId);
    const focusDeadline = Date.now() + 4_000;
    while (harness.getFocusedId() !== otherInputId && Date.now() < focusDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.getFocusedId()).toBe(otherInputId);
    harness.sendEdit(otherInputId, 0, 0, 'custom note', 11);
    await harness.waitForNode(
      node => node.id === otherInputId && node.p['text'] === 'custom note' && node.p['cursor'] === 11,
      4_000,
    );
    harness.sendKey('enter');
    await harness.waitForText('"channel":"stable","other":"custom note"', 'main', 6_000);
    harness.assertWireInvariants();

    // Verify markdown follow-up auto-opens modal on turn end and clicking button re-opens cleanly without focus errors.
    harness.sendText('markdown-followup');
    harness.sendKey('enter');
    await harness.waitForText('Ready to test or release?', 'layer', 6_000);
    harness.assertWireInvariants();
    expect(harness.findById('layer.panel.overlay-scroll.form.field-q1.input-q1')).toBeDefined();
    expect(harness.extractText('main')).not.toContain('Request failed');
    harness.sendKey('esc');
    const followUpDeadline = Date.now() + 4_000;
    while (harness.findById('layer.panel') && Date.now() < followUpDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.panel')).toBeUndefined();

    // Re-open via message button too.
    const followUpBtn = harness.findByKind('button', 'main').find(node => String(node.p['text']).includes('Answer follow-up'));
    expect(followUpBtn).toBeDefined();
    harness.sendAction(followUpBtn!.id, 'click');
    await harness.waitForText('Ready to test or release?', 'layer', 6_000);
    harness.assertWireInvariants();
    harness.sendKey('esc');
    const reopenDeadline = Date.now() + 4_000;
    while (harness.findById('layer.panel') && Date.now() < reopenDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.panel')).toBeUndefined();

    // Verify markdown multiple-choice reply auto-opens modal with selectable option buttons.
    harness.sendText('markdown-choice');
    harness.sendKey('enter');
    await harness.waitForText('Which step should we take next?', 'layer', 6_000);
    expect(harness.extractText('layer')).toContain('Run locally');
    expect(harness.extractText('layer')).toContain('Release v0.2.2');
    harness.assertWireInvariants();
    harness.sendKey('esc');
    const choiceDeadline = Date.now() + 4_000;
    while (harness.findById('layer.panel') && Date.now() < choiceDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.panel')).toBeUndefined();

    // Verify Ctrl+K opens command palette and /keys opens keyboard shortcuts overlay.
    harness.sendKey('ctrl+k');
    await harness.waitForText('Commands & skills', 'layer', 5_000);
    harness.sendKey('esc');
    const kDeadline = Date.now() + 4_000;
    while (harness.findById('layer.picker') && Date.now() < kDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.picker')).toBeUndefined();

    harness.sendText('/keys');
    harness.sendKey('enter');
    await harness.waitForText('Keyboard shortcuts', 'layer', 5_000);
    harness.assertWireInvariants();
    harness.sendKey('esc');
    const keysDeadline = Date.now() + 4_000;
    while (harness.findById('layer.panel') && Date.now() < keysDeadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
    expect(harness.findById('layer.panel')).toBeUndefined();

    // Verify multiline @file popup keeps mode="insert", allows Up/Down navigation without cursor escaping, and inserts inline @path + decor.
    harness.sendText('line one');
    harness.sendKey('shift+enter');
    harness.sendText('check @');
    const filePopup = await harness.waitForNode(node => node.id === 'dock.shell.files', 5_000);
    expect(filePopup).toBeDefined();
    expect(harness.findById('dock.shell.composer.line.draft')?.p['mode']).toBe('insert');
    const initialSelected = String(filePopup.p['selected'] ?? '');
    harness.sendKey('down');
    await harness.waitForNode(
      node => node.id === 'dock.shell.files' && node.p['selected'] !== initialSelected,
      4_000,
    );
    harness.sendKey('up');
    await harness.waitForNode(
      node => node.id === 'dock.shell.files' && node.p['selected'] === initialSelected,
      4_000,
    );
    harness.sendKey('enter');
    await harness.waitForNode(
      node => {
        if (node.id !== 'dock.shell.composer.line.draft') return false;
        const text = String(node.p['text'] ?? '');
        return text.includes('line one') && /@\S+/.test(text) && Array.isArray(node.p['decor']) && node.p['decor'].length > 0;
      },
      4_000,
    );
    harness.assertWireInvariants();

    // Quit cleanly with Ctrl+Q.
    harness.sendKey('ctrl+q');
    const closed = await harness.waitForExit(5_000);
    expect(closed.exitCode).toBe(0);
  }, 30_000);
});
