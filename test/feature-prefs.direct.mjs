import test from 'node:test';
import assert from 'node:assert/strict';
import * as prefs from '../src/feature-prefs.ts';

/*
 * The settings window's toggles posted `saveFeatures`, and the host applied
 * `features.mcpServers` and nothing else — so every other control appeared to
 * save and did not exist anywhere afterwards.
 *
 * This module is the mapping between the window's feature payload and the places
 * SleepyCode actually stores those choices: chat preferences (per workspace
 * storage) and VS Code configuration. It is pure, so the round trip can be
 * asserted: what the window sends must come back as what it displays.
 */

test('a stored value that is not a preference is replaced by the default', () => {
  const p = prefs.normalizePrefs(undefined);
  assert.deepEqual(p, prefs.DEFAULT_CHAT_PREFS);
  assert.equal(prefs.normalizePrefs({ chatTextSize: 'enormous' }).chatTextSize, prefs.DEFAULT_CHAT_PREFS.chatTextSize);
  assert.equal(prefs.normalizePrefs({ motion: 42 }).motion, prefs.DEFAULT_CHAT_PREFS.motion);
  assert.equal(prefs.normalizePrefs({ maxTabCount: 'many' }).maxTabCount, prefs.DEFAULT_CHAT_PREFS.maxTabCount);
  assert.equal(prefs.normalizePrefs('nope').perTabDrafts, prefs.DEFAULT_CHAT_PREFS.perTabDrafts);
});

test('a partial stored value keeps the fields it does carry', () => {
  const p = prefs.normalizePrefs({ completionSound: true, maxTabCount: 3 });
  assert.equal(p.completionSound, true);
  assert.equal(p.maxTabCount, 3);
  // Untouched fields fall back rather than becoming undefined.
  assert.equal(p.chatTextSize, prefs.DEFAULT_CHAT_PREFS.chatTextSize);
  assert.equal(p.perTabDrafts, prefs.DEFAULT_CHAT_PREFS.perTabDrafts);
});

test('a nonsense tab count is clamped to a usable range, not accepted', () => {
  // A stored 0 would allow no tabs at all and a huge number would defeat the
  // setting's purpose; both are read from disk, so both are bounded here.
  assert.equal(prefs.normalizePrefs({ maxTabCount: 0 }).maxTabCount, 1);
  assert.equal(prefs.normalizePrefs({ maxTabCount: -5 }).maxTabCount, 1);
  assert.equal(prefs.normalizePrefs({ maxTabCount: 1e9 }).maxTabCount, prefs.MAX_TAB_COUNT_CEILING);
  assert.equal(prefs.normalizePrefs({ maxTabCount: 4.6 }).maxTabCount, 4);
});

test('only the preference keys a patch actually carries are taken', () => {
  const patch = prefs.prefsFromFeatures({ chatTextSize: 'large', motion: 'reduced', mcpServers: [], subagents: [] });
  assert.deepEqual(patch, { chatTextSize: 'large', motion: 'reduced' });
  // A payload with none of them produces no patch at all, so an unrelated
  // `saveFeatures` (an MCP edit) cannot reset the chat preferences.
  assert.deepEqual(prefs.prefsFromFeatures({ mcpServers: [] }), {});
  assert.deepEqual(prefs.prefsFromFeatures(undefined), {});
  assert.deepEqual(prefs.prefsFromFeatures({ completionSound: 'yes' }), {});
});

test('applying a patch leaves the other preferences alone', () => {
  const base = { ...prefs.DEFAULT_CHAT_PREFS, perTabDrafts: true, maxTabCount: 5 };
  const next = prefs.applyPrefs(base, { completionSound: true });
  assert.equal(next.completionSound, true);
  assert.equal(next.perTabDrafts, true);
  assert.equal(next.maxTabCount, 5);
  // The result is always a complete, validated record.
  assert.deepEqual(prefs.applyPrefs(base, { maxTabCount: 99 }), { ...base, maxTabCount: prefs.MAX_TAB_COUNT_CEILING });
});

test('configuration-backed features map onto the settings SleepyCode has', () => {
  const patch = prefs.configPatchFromFeatures({ notifyOnComplete: false, maxAgentSteps: 40, indexingEnabled: false });
  assert.deepEqual(patch, { systemNotifications: false, maxSteps: 40, repoIndex: false });
  // Fields SleepyCode has no setting for are not invented here.
  assert.deepEqual(prefs.configPatchFromFeatures({ trackUsage: false, autoGenerateTitles: false }), {});
  assert.deepEqual(prefs.configPatchFromFeatures(undefined), {});
});

test('a nonsense step count is not written to configuration', () => {
  // `maxSteps: 0` means unlimited in SleepyCode, so it is meaningful and kept;
  // negatives and non-numbers are not.
  assert.equal(prefs.configPatchFromFeatures({ maxAgentSteps: 0 }).maxSteps, 0);
  assert.equal(prefs.configPatchFromFeatures({ maxAgentSteps: -1 }).maxSteps, undefined);
  assert.equal(prefs.configPatchFromFeatures({ maxAgentSteps: 'lots' }).maxSteps, undefined);
});

test('the window is shown the values that are actually stored', () => {
  // Otherwise a toggle reads its own default rather than reality, and a saved
  // preference looks like it did not stick.
  const shown = prefs.featuresFromHost({
    prefs: { ...prefs.DEFAULT_CHAT_PREFS, completionSound: true, chatTextSize: 'large', maxTabCount: 6 },
    settings: { systemNotifications: true, maxSteps: 12, repoIndex: false },
  });
  assert.equal(shown.completionSound, true);
  assert.equal(shown.chatTextSize, 'large');
  assert.equal(shown.maxTabCount, 6);
  assert.equal(shown.notifyOnComplete, true);
  assert.equal(shown.maxAgentSteps, 12);
  assert.equal(shown.indexingEnabled, false);
});

test('what the window sends comes back as what it displays', () => {
  // The round trip is the property that matters: a toggle that saves but reads
  // back its default is the bug this file exists to prevent.
  const sent = { chatTextSize: 'compact', motion: 'system', perTabDrafts: true, completionSound: true, notifyOnComplete: false, maxAgentSteps: 7 };
  const stored = prefs.applyPrefs(prefs.DEFAULT_CHAT_PREFS, prefs.prefsFromFeatures(sent));
  const config = prefs.configPatchFromFeatures(sent);
  const shown = prefs.featuresFromHost({
    prefs: stored,
    settings: { systemNotifications: config.systemNotifications, maxSteps: config.maxSteps, repoIndex: true },
  });
  assert.equal(shown.chatTextSize, sent.chatTextSize);
  assert.equal(shown.motion, sent.motion);
  assert.equal(shown.perTabDrafts, sent.perTabDrafts);
  assert.equal(shown.completionSound, sent.completionSound);
  assert.equal(shown.notifyOnComplete, sent.notifyOnComplete);
  assert.equal(shown.maxAgentSteps, sent.maxAgentSteps);
});

// ---------------------------------------------------------------- approval mode

test('a uniform approval policy maps back to the single mode SleepyCode has', () => {
  // SleepyCode gates by kind (edits vs commands) with one mode, not per action
  // type. The window's policy is projected onto that mode and back.
  const policy = (mode) => Object.fromEntries(['shell', 'edits', 'delete', 'mcp', 'web', 'outside'].map(k => [k, { mode, allowlist: [], denylist: [] }]));
  assert.equal(prefs.approvalModeFromPolicy(policy('allow')), 'autonomous');
  assert.equal(prefs.approvalModeFromPolicy(policy('ask')), 'ask');
  assert.equal(prefs.approvalModeFromPolicy(policy('review')), 'edits');
  assert.equal(prefs.approvalModeFromPolicy(undefined), undefined);
});

test('a policy that permits edits but asks about commands reads as edits', () => {
  // That is exactly SleepyCode's `edits` mode: apply edits, still ask before
  // running a command. Taking the shell rule as "the mode" would call it ask and
  // silently stop applying edits.
  const mixed = {
    shell: { mode: 'ask', allowlist: [], denylist: [] },
    edits: { mode: 'allow', allowlist: [], denylist: [] },
    delete: { mode: 'ask', allowlist: [], denylist: [] },
    mcp: { mode: 'allow', allowlist: [], denylist: [] },
    web: { mode: 'allow', allowlist: [], denylist: [] },
    outside: { mode: 'allow', allowlist: [], denylist: [] },
  };
  assert.equal(prefs.approvalModeFromPolicy(mixed), 'edits');
});

test('an empty or malformed policy yields no mode rather than a guess', () => {
  assert.equal(prefs.approvalModeFromPolicy({}), undefined);
  assert.equal(prefs.approvalModeFromPolicy({ shell: {} }), undefined);
  assert.equal(prefs.approvalModeFromPolicy({ shell: { mode: 'nonsense' } }), undefined);
  assert.equal(prefs.approvalModeFromPolicy(null), undefined);
});
// ---------------------------------------------------------------- routing

test('a feature save is routed to every store it belongs in, not just MCP', () => {
  // The defect: saveFeatures applied mcpServers and returned, so every other
  // control saved nowhere. One pure routing step makes that testable.
  const routed = prefs.routeFeatureSave({
    mcpServers: [{ name: 'echo', transport: 'stdio', command: 'node' }],
    chatTextSize: 'large',
    completionSound: true,
    notifyOnComplete: false,
    maxAgentSteps: 15,
    indexingEnabled: false,
    approvalPolicy: { shell: { mode: 'ask' }, edits: { mode: 'allow' } },
  });
  assert.deepEqual(routed.connections, [{ name: 'echo', transport: 'stdio', command: 'node' }]);
  assert.deepEqual(routed.prefs, { chatTextSize: 'large', completionSound: true });
  assert.deepEqual(routed.config, { systemNotifications: false, maxSteps: 15, repoIndex: false });
  assert.equal(routed.approvalMode, 'edits');
});

test('a payload with no MCP servers leaves the connections untouched', () => {
  // `undefined`, not `[]`: an empty array means "delete them all", and a chat
  // preference save must never do that.
  const routed = prefs.routeFeatureSave({ chatTextSize: 'compact' });
  assert.equal(routed.connections, undefined);
  assert.deepEqual(routed.prefs, { chatTextSize: 'compact' });
});

test('an empty or junk payload routes to nothing at all', () => {
  for (const payload of [undefined, null, {}, 'x', 7]) {
    const routed = prefs.routeFeatureSave(payload);
    assert.equal(routed.connections, undefined);
    assert.deepEqual(routed.prefs, {});
    assert.deepEqual(routed.config, {});
    assert.equal(routed.approvalMode, undefined);
  }
});

test('Track Usage can be turned off and stays off', () => {
  // The toggle was persisted but never consulted, so turning it off changed
  // nothing. It has to survive a save/read cycle AND read back as off.
  assert.equal(prefs.DEFAULT_CHAT_PREFS.trackUsage, true, 'a fresh install records usage');
  const off = prefs.applyPrefs(prefs.DEFAULT_CHAT_PREFS, prefs.prefsFromFeatures({ trackUsage: false }));
  assert.equal(off.trackUsage, false);
  assert.equal(prefs.normalizePrefs(off).trackUsage, false);
  assert.equal(prefs.featuresFromHost({ prefs: off, settings: {} }).trackUsage, false);
  // And an unrelated save does not silently turn it back on.
  assert.equal(prefs.applyPrefs(off, prefs.prefsFromFeatures({ mcpServers: [] })).trackUsage, false);
  assert.equal(prefs.applyPrefs(off, prefs.prefsFromFeatures({ chatTextSize: 'large' })).trackUsage, false);
});
