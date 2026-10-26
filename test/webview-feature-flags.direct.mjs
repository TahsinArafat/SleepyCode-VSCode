import { test } from 'node:test';
import assert from 'node:assert/strict';

const flags = await import('../webview-ui/shared/featureFlags.ts');

test('OpenCursor-only settings sections are hidden', () => {
  for (const id of ['providers', 'llamacpp', 'ollama', 'personas', 'subagents', 'indexing', 'hooks']) {
    assert.equal(flags.isSectionHidden(id), true, `${id} should be hidden`);
  }
});

test('sections SleepyCode actually backs stay visible', () => {
  // These are the surfaces the settings window serves real SleepyCode data for.
  for (const id of ['general', 'usage', 'behavior', 'rules', 'mcp', 'advanced', 'about']) {
    assert.equal(flags.isSectionHidden(id), false, `${id} should stay visible`);
  }
});

test('sections backed only by OpenCursor stores are hidden', () => {
  // Their data lives in OpenCursor's feature store, which SleepyCode does not
  // have; rendering them would show controls that write nowhere.
  for (const id of ['models', 'agents']) {
    assert.equal(flags.isSectionHidden(id), true, `${id} should be hidden`);
  }
});

test('filterSections drops hidden entries and keeps order', () => {
  const input = [
    { id: 'general' },
    { id: 'providers' },
    { id: 'ollama' },
    { id: 'mcp' },
  ];
  assert.deepEqual(flags.filterSections(input).map(s => s.id), ['general', 'mcp']);
});

test('hidden list is exported so it can be re-enabled later', () => {
  assert.ok(Array.isArray(flags.HIDDEN_SETTINGS_SECTIONS));
  assert.ok(flags.HIDDEN_SETTINGS_SECTIONS.length > 0);
});

test('composer model grouping collapses to a single provider list', () => {
  assert.equal(flags.SHOW_PROVIDER_GROUPS, false);
});

test('external integrations are hidden but flagged', () => {
  assert.equal(flags.isFeatureHidden('remoteJobs'), true);
  assert.equal(flags.isFeatureHidden('plugins'), true);
  assert.equal(flags.isFeatureHidden('worktrees'), false);
  assert.equal(flags.isFeatureHidden('docsIndexing'), true);
  assert.equal(flags.isFeatureHidden('semanticSearch'), true);
});

test('multitask and project modes are hidden', () => {
  const modes = [
    { id: 'agent' }, { id: 'plan' }, { id: 'multitask' }, { id: 'project' }, { id: 'ask' },
  ];
  assert.deepEqual(flags.filterModes(modes).map(m => m.id), ['agent', 'plan', 'ask']);
});

test('the webview section rules ARE the host adapter rules, not a second copy', async () => {
  // The rail shows a section and the host routes to it; if these two disagreed,
  // the rail would offer a page the host refuses to open — or hide one it would.
  // Re-exporting is what keeps them identical, so assert the identity.
  const host = await import('../src/settings-adapter.ts');
  assert.equal(flags.isSectionHidden, host.isSectionHidden, 'isSectionHidden must be the same function');
  assert.equal(flags.HIDDEN_SETTINGS_SECTIONS, host.HIDDEN_SETTINGS_SECTIONS, 'the hidden list must be shared');
});

test('the rail never offers a section the host will not route to', async () => {
  const host = await import('../src/settings-adapter.ts');
  const nav = ['general', 'providers', 'llamacpp', 'ollama', 'usage', 'agents', 'models', 'behavior',
    'personas', 'rules', 'marketplace', 'subagents', 'mcp', 'hooks', 'indexing', 'advanced', 'about'];
  for (const id of nav) {
    // Either it is visible and routes to itself, or it is hidden and drops out
    // of the rail. Nothing may be visible-but-unroutable.
    if (!flags.isSectionHidden(id)) {
      assert.equal(host.visibleSection(id), id, `${id} is visible in the rail, so it must route to itself`);
    }
  }
});
