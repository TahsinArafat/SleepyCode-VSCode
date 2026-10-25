import { test } from 'node:test';
import assert from 'node:assert/strict';

const flags = await import('../webview-ui/shared/featureFlags.ts');

test('OpenCursor-only settings sections are hidden', () => {
  for (const id of ['providers', 'llamacpp', 'ollama', 'personas', 'subagents', 'indexing', 'hooks']) {
    assert.equal(flags.isSectionHidden(id), true, `${id} should be hidden`);
  }
});

test('sections SleepyCode supports stay visible', () => {
  for (const id of ['general', 'usage', 'agents', 'models', 'behavior', 'rules', 'mcp', 'advanced', 'about']) {
    assert.equal(flags.isSectionHidden(id), false, `${id} should stay visible`);
  }
});

test('filterSections drops hidden entries and keeps order', () => {
  const input = [
    { id: 'general' },
    { id: 'providers' },
    { id: 'ollama' },
    { id: 'models' },
  ];
  assert.deepEqual(flags.filterSections(input).map(s => s.id), ['general', 'models']);
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
