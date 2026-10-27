import { test } from 'node:test';
import assert from 'node:assert/strict';

const flags = await import('../webview-ui/shared/featureFlags.ts');

test('sections with no host backing are hidden', () => {
  // `hooks` left this list: it now edits the rules the host actually evaluates,
  // instead of shell commands nothing ran and nothing stored.
  for (const id of ['llamacpp', 'ollama', 'personas', 'subagents']) {
    assert.equal(flags.isSectionHidden(id), true, `${id} should be hidden`);
  }
});

test('sections SleepyCode actually backs stay visible', () => {
  // These are the surfaces the settings window serves real SleepyCode data for.
  // `providers` is here on purpose: it gained a real surface, so it is no longer
  // an OpenCursor-only page.
  for (const id of ['general', 'account', 'providers', 'usage', 'behavior', 'rules', 'marketplace', 'hooks', 'indexing', 'models', 'agents', 'mcp', 'advanced', 'about']) {
    assert.equal(flags.isSectionHidden(id), false, `${id} should stay visible`);
  }
});

test('the section that was never an agent manager is gone', () => {
  // `agents` used to render text-size controls under an Agents heading. It now
  // manages the agents the host resolves, so it is served and visible.
  assert.equal(flags.isSectionHidden('agents'), false);
  assert.equal(flags.isSectionHidden('models'), false);
});

test('filterSections drops hidden entries and keeps order', () => {
  const input = [
    { id: 'general' },
    { id: 'ollama' },
    { id: 'providers' },
    { id: 'mcp' },
  ];
  assert.deepEqual(flags.filterSections(input).map(s => s.id), ['general', 'providers', 'mcp']);
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

test('every @ category the composer offers is one the host can answer', async () => {
  // The composer listed Files & Folders, Docs, Terminals and Past Chats, but the
  // adapter answers only `files` — so three categories always said "No matches".
  // Worse than useless: every mention pill serialises its path as a FILE
  // attachment, so a chat id or terminal name would reach the model as a bogus
  // file path. A category is only offered when the host answers it, and the
  // offered list is derived from that predicate rather than restated.
  const host = await import('../src/webview-adapter.ts');
  const composer = await import('node:fs/promises')
    .then(fs => fs.readFile(new URL('../webview-ui/sidebar/components/Composer.tsx', import.meta.url), 'utf8'));

  const declared = composer.match(/const ALL_MENTION_CATEGORIES[\s\S]*?=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
  const ids = [...declared.matchAll(/id:\s*"([a-zA-Z]+)"/g)].map(m => m[1]);
  assert.ok(ids.length > 0, 'the composer should still declare mention categories');

  // The offered list must be the declared list filtered by the host's predicate,
  // not a hand-maintained second copy that can drift.
  assert.match(
    composer,
    /const MENTION_CATEGORIES = ALL_MENTION_CATEGORIES\.filter\(\(c\) => isMentionCategoryAnswered\(c\.id\)\)/,
    'the offered categories must be filtered by isMentionCategoryAnswered',
  );

  // Applying that predicate must leave only answerable categories, and at least
  // one must survive or the @ menu would be empty.
  const offered = ids.filter(id => host.isMentionCategoryAnswered(id));
  assert.ok(offered.length > 0, 'the @ menu would have nothing to offer');
  for (const id of offered) assert.equal(host.isMentionCategoryAnswered(id), true, `${id} is offered but unanswered`);
  // The categories that must NOT survive.
  for (const id of ['docs', 'terminals', 'chats']) {
    assert.equal(offered.includes(id), false, `${id} must not be offered`);
  }
});

test('the adapter answers files and refuses what it cannot serve', async () => {
  const host = await import('../src/webview-adapter.ts');
  assert.equal(host.isMentionCategoryAnswered('files'), true);
  for (const id of ['docs', 'terminals', 'chats', 'git', 'rules', 'code', 'branch', 'link']) {
    assert.equal(host.isMentionCategoryAnswered(id), false, `${id} has no SleepyCode source`);
  }
});
