import test from 'node:test';
import assert from 'node:assert/strict';

const adapter = await import('../src/settings-adapter.ts');

/**
 * Messages posted only by the hidden `indexing` page. Listed so the guard above
 * can be exact: a reachable page posting an unsupported type is a defect, and a
 * page this build does not render is not.
 */
const HIDDEN_PANEL_POSTS = new Set(['setEmbedModel', 'syncIndex', 'deleteIndex', 'openCursorignore', 'getIndexStatus']);

// The settings window is OpenCursor's, so its MCP page speaks OpenCursor's
// config shape. SleepyCode stores its own. These tests pin both directions,
// including the stdio support SleepyCode's saved connections never had.

test('a stored remote connection becomes an MCP panel config', () => {
  const config = adapter.toMcpPanelConfig({
    name: 'docs', description: 'Docs server', url: 'https://example.test/mcp',
    transport: 'http', auth: { type: 'none' }, enabled: true, order: 0,
  });
  assert.equal(config.name, 'docs');
  assert.equal(config.transport, 'http');
  assert.equal(config.url, 'https://example.test/mcp');
  assert.equal(config.enabled, true);
});

test('a stored stdio connection becomes an MCP panel config', () => {
  const config = adapter.toMcpPanelConfig({
    name: 'local', description: '', command: 'npx', args: ['-y', 'server'],
    env: { TOKEN: 'x' }, transport: 'stdio', auth: { type: 'none' }, enabled: true, order: 1,
  });
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, ['-y', 'server']);
  assert.deepEqual(config.env, { TOKEN: 'x' });
  assert.equal(config.url, undefined);
});

test('a panel config becomes a stored connection', () => {
  const stored = adapter.fromMcpPanelConfig(
    { name: 'docs', transport: 'sse', url: 'https://example.test/sse', headers: { 'X-A': '1' }, enabled: false },
    2,
  );
  assert.equal(stored.name, 'docs');
  assert.equal(stored.transport, 'sse');
  assert.equal(stored.url, 'https://example.test/sse');
  assert.equal(stored.enabled, false);
  assert.equal(stored.order, 2);
  assert.deepEqual(stored.auth, { type: 'none' });
});

test('a stdio panel config round-trips without losing its command', () => {
  const stored = adapter.fromMcpPanelConfig({ name: 'local', transport: 'stdio', command: 'node', args: ['s.mjs'], enabled: true }, 0);
  const back = adapter.toMcpPanelConfig(stored);
  assert.equal(back.transport, 'stdio');
  assert.equal(back.command, 'node');
  assert.deepEqual(back.args, ['s.mjs']);
});

test('a connection with neither url nor command is rejected, not silently kept', () => {
  assert.equal(adapter.isUsableConnection({ name: 'broken', url: '', command: '' }), false);
  assert.equal(adapter.isUsableConnection({ name: 'ok', url: 'https://x.test/mcp' }), true);
  assert.equal(adapter.isUsableConnection({ name: 'ok', command: 'npx' }), true);
});

test('loading keeps stdio connections that have no url', () => {
  // The previous loader required a url, which silently dropped every stdio entry.
  const kept = adapter.usableConnections([
    { name: 'remote', url: 'https://x.test/mcp' },
    { name: 'local', command: 'npx', args: ['-y', 'server'] },
    { name: 'broken' },
  ]);
  assert.deepEqual(kept.map((c) => c.name), ['remote', 'local']);
});

test('statuses carry the connected flag, tool count and auth state', () => {
  const ok = adapter.toMcpPanelStatus({ name: 'docs', state: 'ok', toolCount: 4 });
  assert.deepEqual(ok, { name: 'docs', connected: true, toolCount: 4, authState: 'none' });

  const auth = adapter.toMcpPanelStatus({ name: 'docs', state: 'auth_required', error: 'needs sign in' });
  assert.equal(auth.connected, false);
  assert.equal(auth.authState, 'required');
  assert.equal(auth.error, 'needs sign in');

  const failed = adapter.toMcpPanelStatus({ name: 'docs', state: 'error', error: 'boom' });
  assert.equal(failed.connected, false);
  assert.equal(failed.error, 'boom');
});

test('the features payload nests the config under `features`, as the window reads it', () => {
  // The window does `setFeaturesState({ ...EMPTY_FEATURES, ...msg.features })`.
  // Sending `mcpServers` at the top level left msg.features undefined, so the
  // list fell back to EMPTY_FEATURES and no server ever rendered — even though
  // the host was sending one.
  const payload = adapter.toPanelFeatures(
    [{ name: 'docs', url: 'https://x.test/mcp', transport: 'http', enabled: true }],
    [{ name: 'docs', state: 'ok', toolCount: 2 }],
  );
  assert.ok(payload.features, 'config must be nested under `features`');
  assert.equal(payload.features.mcpServers.length, 1);
  assert.equal(payload.features.mcpServers[0].name, 'docs');
  assert.equal(payload.mcpStatus.length, 1);
  assert.equal(payload.mcpStatus[0].connected, true);
  // mcpStatus stays at the top level: the window reads msg.mcpStatus directly.
  assert.equal(payload.type, 'features');
});

test('settings map onto the panel shape instead of showing blank fields', () => {
  const settings = adapter.toPanelSettings({
    model: 'sleepy/auto-best-coding',
    maxSteps: 200,
    systemPrompt: 'Be terse.',
    repoIndex: false,
  });
  assert.equal(settings.model, 'sleepy/auto-best-coding');
  assert.equal(settings.systemPrompt, 'Be terse.');
  // A disabled project index is the closest real equivalent of workspace context.
  assert.equal(settings.enableWorkspaceContext, false);
  assert.equal(settings.maxResponseLength, 200);
});

test('panel settings edits map back onto SleepyCode configuration', () => {
  const patch = adapter.fromPanelSettings({ model: 'm1', systemPrompt: 'Hi', enableWorkspaceContext: false, maxResponseLength: 50 });
  assert.equal(patch.model, 'm1');
  assert.equal(patch.systemPrompt, 'Hi');
  assert.equal(patch.repoIndex, false);
  assert.equal(patch.maxSteps, 50);
});

test('usage aggregates become per-model rows keyed by model name', () => {
  const rows = adapter.toPanelUsage({
    models: [
      { model: 'sleepy/auto', requestCount: 3, periods: { today: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } } },
    ],
  });
  assert.deepEqual(Object.keys(rows), ['sleepy/auto']);
  assert.equal(rows['sleepy/auto'].promptTokens, 100);
  assert.equal(rows['sleepy/auto'].completionTokens, 20);
  assert.equal(rows['sleepy/auto'].requests, 3);
  assert.equal(rows['sleepy/auto'].cachedReadTokens, 5);
});

test('models with no use in the period are left out of the usage rows', () => {
  const rows = adapter.toPanelUsage({ models: [{ model: 'idle', requestCount: 0, periods: { today: { input: 0, output: 0 } } }] });
  assert.deepEqual(rows, {});
});

test('missing usage data yields an empty map, not a broken row set', () => {
  assert.deepEqual(adapter.toPanelUsage(undefined), {});
  assert.deepEqual(adapter.toPanelUsage({}), {});
});

test('marketplace messages are routed, not ignored', () => {
  for (const type of ['marketplaceTop', 'marketplaceSearch', 'marketplaceInstall', 'marketplaceUninstall', 'requestMarketplaceInstalled']) {
    assert.equal(adapter.isPanelMessage({ type }), true, `${type} should be routed`);
  }
});

test('MCP sign-in messages are routed, not ignored', () => {
  assert.equal(adapter.isPanelMessage({ type: 'mcpLogin' }), true);
  assert.equal(adapter.isPanelMessage({ type: 'mcpLogout' }), true);
  assert.equal(adapter.isPanelMessage({ type: 'syncMcp' }), true);
});

test('unknown panel messages are ignored rather than forwarded', () => {
  assert.equal(adapter.isPanelMessage({ type: 'getSettings' }), true);
  assert.equal(adapter.isPanelMessage({ type: 'deleteIndex' }), false);
  assert.equal(adapter.isPanelMessage({ type: 'llamacppStart' }), false);
  assert.equal(adapter.isPanelMessage(null), false);
});
// ---------------------------------------------------------------- status completeness

test('every stored connection gets a status row, so none can read as idle', () => {
  const connections = [
    { name: 'connected', enabled: true },
    { name: 'broken', enabled: true },
    { name: 'off', enabled: false },
  ];
  // Only one status came back; the others must still be represented.
  const statuses = adapter.completeMcpStatuses(connections, [{ name: 'connected', state: 'ok', toolCount: 3 }]);
  assert.deepEqual(statuses.map(s => s.name), ['connected', 'broken', 'off']);
  assert.equal(statuses[0].connected, true);
  assert.equal(statuses[1].connected, false);
  assert.match(statuses[1].error, /did not report/);
  assert.equal(statuses[2].error, 'Disabled');
});

test('a disabled server is never reported as an error', () => {
  const statuses = adapter.completeMcpStatuses([{ name: 'off', enabled: false }], []);
  assert.equal(statuses[0].connected, false);
  assert.equal(statuses[0].error, 'Disabled');
});

test('an enabled server with no status is an explicit failure, not silence', () => {
  const statuses = adapter.completeMcpStatuses([{ name: 'mystery', enabled: true }], []);
  assert.equal(statuses[0].connected, false);
  assert.ok(statuses[0].error, 'expected a visible reason instead of an idle row');
});

test('an unnamed sync fallback does not leak a fake server row', () => {
  // safeSync previously reported a single status named "MCP", which matched no
  // server and left every real row showing "idle".
  const statuses = adapter.completeMcpStatuses(
    [{ name: 'real', enabled: true }],
    [{ name: 'MCP', state: 'error', error: 'boom' }],
  );
  assert.deepEqual(statuses.map(s => s.name), ['real']);
  assert.match(statuses[0].error, /boom/);
});

test('statuses for servers no longer stored are dropped', () => {
  const statuses = adapter.completeMcpStatuses([{ name: 'kept', enabled: true }], [
    { name: 'kept', state: 'ok', toolCount: 1 },
    { name: 'deleted', state: 'ok', toolCount: 9 },
  ]);
  assert.deepEqual(statuses.map(s => s.name), ['kept']);
});

test('no connections means no rows', () => {
  assert.deepEqual(adapter.completeMcpStatuses([], [{ name: 'ghost', state: 'ok' }]), []);
  assert.deepEqual(adapter.completeMcpStatuses(undefined, undefined), []);
});

// ---------------------------------------------------------------- url validation parity

test('the panel and the client agree on which URLs are usable', () => {
  // The modal accepted plain http, then the ported client refused it, so a
  // saveable server could never connect. Both now use this one rule.
  assert.equal(adapter.validatePanelMcpUrl('https://example.test/mcp'), null);
  assert.equal(adapter.validatePanelMcpUrl('http://localhost:3000/mcp'), null);
  assert.equal(adapter.validatePanelMcpUrl('http://127.0.0.1:3000/mcp'), null);
  assert.match(adapter.validatePanelMcpUrl('http://192.168.1.5:3000/mcp'), /HTTPS/);
  assert.match(adapter.validatePanelMcpUrl('ftp://example.test/mcp'), /HTTP/);
  assert.match(adapter.validatePanelMcpUrl('https://user:pw@example.test/mcp'), /credentials/);
});

test('an empty or malformed URL is rejected with a readable reason', () => {
  assert.match(adapter.validatePanelMcpUrl(''), /URL/);
  assert.match(adapter.validatePanelMcpUrl('not a url'), /URL/);
});

// ---------------------------------------------------------------- payload round trip

test('the features payload keeps every field through the real double map', () => {
  // readConnections() maps stored → panel, then toPanelFeatures maps again.
  // A field lost on the second pass would be invisible in the window.
  const stored = {
    name: 'Shamela', description: '', transport: 'http',
    auth: { type: 'none' }, enabled: true, order: 0, url: 'https://shamela.test/mcp',
  };
  const panelConfig = adapter.toMcpPanelConfig(stored);
  const payload = adapter.toPanelFeatures([panelConfig], []);
  assert.equal(payload.features.mcpServers.length, 1);
  assert.equal(payload.features.mcpServers[0].name, 'Shamela');
  assert.equal(payload.features.mcpServers[0].url, 'https://shamela.test/mcp');
  assert.equal(payload.features.mcpServers[0].transport, 'http');
  assert.equal(payload.features.mcpServers[0].enabled, true);
});

test('a stdio payload keeps its command through the double map', () => {
  const stored = {
    name: 'local', description: '', transport: 'stdio',
    auth: { type: 'none' }, enabled: true, order: 0, command: 'npx', args: ['-y', 's'],
  };
  const payload = adapter.toPanelFeatures([adapter.toMcpPanelConfig(stored)], []);
  assert.equal(payload.features.mcpServers[0].command, 'npx');
  assert.deepEqual(payload.features.mcpServers[0].args, ['-y', 's']);
});

test('a disabled server stays disabled in the payload', () => {
  const stored = { name: 'off', description: '', transport: 'http', auth: { type: 'none' }, enabled: false, order: 0, url: 'https://x.test/mcp' };
  const payload = adapter.toPanelFeatures([adapter.toMcpPanelConfig(stored)], []);
  assert.equal(payload.features.mcpServers[0].enabled, false);
});

// ---------------------------------------------------------------- tool names in status

test('tool names reach the panel status', () => {
  const row = adapter.toMcpPanelStatus({ name: 'a', state: 'ok', toolCount: 2, tools: ['search', 'open'] });
  assert.deepEqual(row.tools, ['search', 'open']);
  assert.equal(row.toolCount, 2);
});

test('a connected server with no names still reports its count', () => {
  const row = adapter.toMcpPanelStatus({ name: 'a', state: 'ok', toolCount: 6 });
  assert.equal(row.toolCount, 6);
  assert.equal(row.tools, undefined);
});

test('completion keeps tool names when the sync supplied them', () => {
  const rows = adapter.completeMcpStatuses(
    [{ name: 'archiveorg', enabled: true }],
    [{ name: 'archiveorg', state: 'ok', toolCount: 6, tools: ['search_inside', 'search_items'] }],
  );
  assert.deepEqual(rows[0].tools, ['search_inside', 'search_items']);
  assert.equal(rows[0].connected, true);
});

// ---------------------------------------------------------------- skills and rules

test('installed skills map onto the panel skill rows', () => {
  const skills = adapter.toPanelSkills([
    { name: 'pdf', description: 'Read PDFs', folder: 'pdf', skillMdPath: '/skills/pdf/SKILL.md' },
  ]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'pdf');
  assert.equal(skills[0].description, 'Read PDFs');
  assert.equal(skills[0].path, '/skills/pdf/SKILL.md');
});

test('a skill without a description still renders', () => {
  const skills = adapter.toPanelSkills([{ name: 'x', folder: 'x', skillMdPath: '/s/x/SKILL.md' }]);
  assert.equal(skills[0].description, '');
});

test('no installed skills means no rows', () => {
  assert.deepEqual(adapter.toPanelSkills(undefined), []);
  assert.deepEqual(adapter.toPanelSkills([]), []);
});

test('the project memory file is listed as an always-applied rule', () => {
  const rules = adapter.toPanelRules({ memoryPath: '.sleepycode/memory.md', memoryExists: true });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].file, 'memory.md');
  assert.equal(rules[0].path, '.sleepycode/memory.md');
  assert.equal(rules[0].alwaysApply, true);
});

test('a missing memory file produces no rule', () => {
  assert.deepEqual(adapter.toPanelRules({ memoryPath: '.sleepycode/memory.md', memoryExists: false }), []);
  assert.deepEqual(adapter.toPanelRules(undefined), []);
});

test('features carry skills and rules so the section is not empty', () => {
  const payload = adapter.toPanelFeatures([], [], {
    skills: [{ name: 'pdf', description: '', folder: 'pdf', skillMdPath: '/s/pdf/SKILL.md' }],
    memory: { memoryPath: '.sleepycode/memory.md', memoryExists: true },
  });
  assert.equal(payload.skills.length, 1);
  assert.equal(payload.rules.length, 1);
});

// ---------------------------------------------------------------- marketplace

test('marketplace search results map onto installable rows', () => {
  const rows = adapter.toMarketplaceSkillRows([
    { name: 'pdf', description: 'Read PDFs', author: 'ada', stars: 42, githubUrl: 'https://github.com/ada/skills', skillUrl: 'https://x/1' },
  ], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'pdf');
  assert.equal(rows[0].author, 'ada');
  assert.equal(rows[0].stars, 42);
  // The install source is the repo URL, which is what resolveInstallPath parses.
  assert.equal(rows[0].source, 'https://github.com/ada/skills');
  assert.equal(rows[0].installed, false);
});

test('an already installed skill is marked so the button can be disabled', () => {
  const rows = adapter.toMarketplaceSkillRows(
    [{ name: 'pdf', description: '', author: 'ada', stars: 1, githubUrl: 'https://github.com/ada/skills' }],
    ['pdf'],
  );
  assert.equal(rows[0].installed, true);
});

test('installed matching ignores case, since folder names are sanitized', () => {
  const rows = adapter.toMarketplaceSkillRows(
    [{ name: 'PDF Tools', description: '', author: '', stars: 0, githubUrl: 'https://github.com/a/b' }],
    ['pdf-tools'],
  );
  assert.equal(rows[0].installed, true);
});

test('a row without a repo URL cannot be installed', () => {
  const rows = adapter.toMarketplaceSkillRows([{ name: 'mystery', description: '', author: '', stars: 0 }], []);
  assert.equal(rows[0].source, undefined);
});

test('marketplace rows tolerate a missing list and junk entries', () => {
  assert.deepEqual(adapter.toMarketplaceSkillRows(undefined, []), []);
  assert.deepEqual(adapter.toMarketplaceSkillRows([null, undefined, { description: 'no name' }], []), []);
});

test('installed skill rows carry the folder needed to uninstall', () => {
  const rows = adapter.toInstalledSkillRows([
    { name: 'pdf', description: 'Read PDFs', folder: 'pdf', skillMdPath: '/s/pdf/SKILL.md' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'pdf');
  assert.equal(rows[0].name, 'pdf');
});

// ---------------------------------------------------------------- mode display

test('approval is only offered in agent mode', () => {
  // Approval governs edits and commands, which only agent mode can perform, so a
  // read-only mode should not present an approval preset at all.
  assert.equal(adapter.approvalAppliesInMode('agent'), true);
  assert.equal(adapter.approvalAppliesInMode('ask'), false);
  assert.equal(adapter.approvalAppliesInMode('plan'), false);
});

// ---------------------------------------------------------------- section routing

test('a hidden section resolves to a visible one instead of a blank page', () => {
  // The rail never offers a hidden section, but a jump or a host `navigate` can
  // still name one — and the window renders nothing for it, which reads as a
  // broken settings page rather than an absent one.
  // `providers` is SERVED now — it gained a real surface (endpoints and keys), so
  // it routes to itself. The rest still resolve away.
  assert.equal(adapter.visibleSection('providers'), 'providers');
  assert.equal(adapter.visibleSection('models'), 'general');
  assert.equal(adapter.visibleSection('personas'), 'general');
  // A visible section is returned unchanged, so no jump is ever redirected.
  for (const id of ['general', 'providers', 'usage', 'behavior', 'rules', 'mcp', 'marketplace', 'advanced', 'about']) {
    assert.equal(adapter.visibleSection(id), id, `${id} must not be redirected`);
  }
});

test('no section, or an unknown one, falls back to the fallback', () => {
  assert.equal(adapter.visibleSection(undefined), 'general');
  assert.equal(adapter.visibleSection(''), 'general');
  assert.equal(adapter.visibleSection('not-a-section'), 'general');
  // A hidden section still honours a caller's own fallback.
  assert.equal(adapter.visibleSection('ollama', 'about'), 'about');
  assert.equal(adapter.visibleSection('mcp', 'about'), 'mcp');
});

test('the webview and the host agree on which sections are hidden', () => {
  // Two lists that must match are a bug waiting to happen: the rail would show a
  // section the host refuses to route to, or vice versa. The webview re-exports
  // this one, so they cannot drift — assert that it is still the same list.
  for (const id of adapter.HIDDEN_SETTINGS_SECTIONS) {
    assert.equal(adapter.isSectionHidden(id), true, `${id} should be hidden`);
    assert.equal(adapter.visibleSection(id), 'general', `${id} should resolve away`);
  }
  assert.equal(adapter.isSectionHidden('general'), false);
  assert.equal(adapter.isSectionHidden('marketplace'), false);
});

// ---------------------------------------------------------------- usage actions
//
// Usage -> Refresh and Reset Usage both posted a message and then waited for a
// `usageActionResult` that no code ever sent, so each one hung for 30 seconds and
// reported "No response received" — a fake timeout on a read that works. These
// pin the reply the window actually matches on.

test('a usage action result echoes the request and the action it answers', () => {
  // The window ignores a result whose requestId or action do not match the one
  // it is waiting on, so both must be carried back verbatim.
  assert.deepEqual(
    adapter.usageActionResultMessage({ requestId: 'usage-7', action: 'refresh', status: 'success' }),
    { type: 'usageActionResult', requestId: 'usage-7', action: 'refresh', status: 'success' },
  );
  assert.deepEqual(
    adapter.usageActionResultMessage({ requestId: 'usage-8', action: 'reset', status: 'cancelled' }),
    { type: 'usageActionResult', requestId: 'usage-8', action: 'reset', status: 'cancelled' },
  );
});

test('an error result carries the reason, and only then', () => {
  const failure = adapter.usageActionResultMessage({ requestId: 'u', action: 'reset', status: 'error', error: 'Disk is read-only.' });
  assert.equal(failure.error, 'Disk is read-only.');
  assert.equal(failure.status, 'error');
  // A success has no `error` key at all, so the window cannot show a stale reason.
  assert.equal('error' in adapter.usageActionResultMessage({ requestId: 'u', action: 'refresh', status: 'success' }), false);
});

test('an unsupported status is refused rather than sent', () => {
  // The window only accepts success/cancelled/error; anything else leaves it
  // waiting for its 30 s timeout, which is the bug being fixed.
  assert.equal(adapter.usageActionResultMessage({ requestId: 'u', action: 'refresh', status: 'maybe' }), null);
  assert.equal(adapter.usageActionResultMessage({ requestId: '', action: 'refresh', status: 'success' }), null);
  assert.equal(adapter.usageActionResultMessage({ requestId: 'u', action: 'nonsense', status: 'success' }), null);
});

test('usage recording is gated on the Track Usage preference', () => {
  // The toggle existed and saved nowhere; making it real means honouring it.
  assert.equal(adapter.shouldRecordUsage({}), true);
  assert.equal(adapter.shouldRecordUsage({ trackUsage: true }), true);
  assert.equal(adapter.shouldRecordUsage({ trackUsage: false }), false);
  assert.equal(adapter.shouldRecordUsage(undefined), true);
});

test('account quota is hidden when no OAuth provider exists in this build', () => {
  // SleepyCode has one first-party account and optional key-based endpoints; it
  // has no OAuth provider accounts at all. A permanently empty "Account Quota"
  // section reads as broken rather than as absent.
  assert.equal(adapter.shouldShowAccountQuota({ accounts: [], errors: {}, hasProviders: false }), false);
  assert.equal(adapter.shouldShowAccountQuota({ accounts: [], errors: {}, hasProviders: true }), false);
  // If a build ever does have accounts, the section comes back.
  assert.equal(adapter.shouldShowAccountQuota({ accounts: [{ id: 'a1', kind: 'anthropic' }], errors: {}, hasProviders: true }), true);
  assert.equal(adapter.shouldShowAccountQuota(undefined), false);
});

test('the empty OAuth status is the truthful one, not a placeholder', () => {
  // Served for `oauthGet` so the window stops waiting for a reply it never gets.
  // It says "no accounts", which is true, rather than inventing any.
  assert.deepEqual(adapter.emptyOAuthStatus(), { accounts: [], errors: {} });
});

// ---------------------------------------------------------------- rules & skills
//
// Every button in Rules & Skills posted a type the settings window refused, so
// the whole section was furniture: rows did not open, nothing could be created
// or removed. These pin the parts that decide whether an action is safe.

test('a skill path resolves to its folder only when it is inside the skills root', () => {
  const root = '/home/u/.config/Code/User/globalStorage/x/skills';
  assert.equal(adapter.skillFolderFromPath(root, `${root}/my-skill/SKILL.md`), 'my-skill');
  assert.equal(adapter.skillFolderFromPath(root, `${root}/my-skill/skill.md`), 'my-skill');
  // Anything outside the root is refused: this path arrives in a webview message
  // and must not be able to point at the user's home directory.
  assert.equal(adapter.skillFolderFromPath(root, '/home/u/other/SKILL.md'), null);
  assert.equal(adapter.skillFolderFromPath(root, `${root}/../secrets/SKILL.md`), null);
  assert.equal(adapter.skillFolderFromPath(root, `${root}/SKILL.md`), null, 'a file directly in the root has no skill folder');
  assert.equal(adapter.skillFolderFromPath(root, ''), null);
  assert.equal(adapter.skillFolderFromPath(root, undefined), null);
});

test('a new skill is scaffolded with frontmatter the loader can read', () => {
  const scaffold = adapter.skillScaffold('My Fancy Skill');
  // `parseSkillFrontmatter` reads name/description between --- markers, so a
  // scaffold without them installs a skill that shows up unnamed.
  assert.match(scaffold, /^---\n/);
  assert.match(scaffold, /\nname: my-fancy-skill\n/);
  assert.match(scaffold, /\ndescription: .+\n/);
  assert.match(scaffold, /\n---\n/);
  // A heading body, so the file is not empty when opened.
  assert.match(scaffold, /\n# /);
});

test('a scaffolded skill name cannot escape the skills directory', () => {
  // The name becomes a folder name; a separator or traversal would place the
  // file elsewhere.
  for (const raw of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
    const scaffold = adapter.skillScaffold(raw);
    assert.doesNotMatch(scaffold, /name: .*[\/\\]/, `${raw} produced a path separator`);
    assert.doesNotMatch(scaffold, /name: \.\./, `${raw} produced traversal`);
  }
  // An empty or symbol-only name still yields a usable, non-empty slug.
  assert.match(adapter.skillScaffold(''), /\nname: .+\n/);
  assert.match(adapter.skillScaffold('***'), /\nname: .+\n/);
});

test('only a path inside a known root can be opened from the panel', () => {
  const roots = ['/work/project', '/state/skills'];
  assert.equal(adapter.openableFile('/work/project/.sleepycode/memory.md', roots), '/work/project/.sleepycode/memory.md');
  assert.equal(adapter.openableFile('/state/skills/a/SKILL.md', roots), '/state/skills/a/SKILL.md');
  // A message cannot make the host open an arbitrary file.
  assert.equal(adapter.openableFile('/etc/passwd', roots), null);
  assert.equal(adapter.openableFile('/work/project/../../etc/passwd', roots), null);
  assert.equal(adapter.openableFile('relative/path.md', roots), null);
  assert.equal(adapter.openableFile('', roots), null);
});

test('deleting a rule is only ever the project memory file', () => {
  const memory = '/work/project/.sleepycode/memory.md';
  assert.equal(adapter.isProjectMemoryPath(memory, memory), true);
  // Normalised, so a redundant segment is not treated as a different file.
  assert.equal(adapter.isProjectMemoryPath('/work/project/./.sleepycode/memory.md', memory), true);
  assert.equal(adapter.isProjectMemoryPath('/work/project/.sleepycode/other.md', memory), false);
  assert.equal(adapter.isProjectMemoryPath('/etc/passwd', memory), false);
  assert.equal(adapter.isProjectMemoryPath(undefined, memory), false);
  assert.equal(adapter.isProjectMemoryPath(memory, undefined), false);
});

test('the skill-file check still matches the list the loader uses', async () => {
  // settings-adapter is in the browser bundle, so it cannot import skills.ts
  // (which imports vscode). The comparison is duplicated, so it is asserted
  // against the real list rather than trusted.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/skills.ts', import.meta.url), 'utf8'));
  const list = source.match(/SKILL_FILE_NAMES\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
  const names = [...list.matchAll(/'([^']+)'/g)].map(m => m[1].toLowerCase());
  assert.ok(names.length > 0, 'skills.ts should still declare SKILL_FILE_NAMES');
  assert.ok(names.includes('skill.md'), 'settings-adapter compares against skill.md');
  // Every accepted spelling must resolve to the same folder.
  const root = '/r/skills';
  for (const name of names) {
    assert.equal(adapter.skillFolderFromPath(root, `${root}/s/${name}`), 's', `${name} should resolve`);
  }
});

test('a workspace-relative panel path is resolved before it is checked', () => {
  // The Rules row carries `.sleepycode/memory.md`, which is relative — so it has
  // to be joined onto the workspace before containment can mean anything. A
  // relative path that climbs out of the workspace resolves to null.
  assert.equal(adapter.resolvePanelPath('.sleepycode/memory.md', '/work/project'), '/work/project/.sleepycode/memory.md');
  assert.equal(adapter.resolvePanelPath('./.sleepycode/memory.md', '/work/project'), '/work/project/.sleepycode/memory.md');
  assert.equal(adapter.resolvePanelPath('../../etc/passwd', '/work/project'), null);
  assert.equal(adapter.resolvePanelPath('a/../../../etc/passwd', '/work/project'), null);
  // An absolute path is passed through unchanged; `openableFile` validates it.
  assert.equal(adapter.resolvePanelPath('/state/skills/a/SKILL.md', '/work/project'), '/state/skills/a/SKILL.md');
  assert.equal(adapter.resolvePanelPath('', '/work/project'), null);
  assert.equal(adapter.resolvePanelPath(undefined, '/work/project'), null);
  assert.equal(adapter.resolvePanelPath('.sleepycode/memory.md', undefined), null);
});

test('a resolved relative path then clears the containment check', () => {
  // The two steps compose: resolve, then authorise.
  const roots = ['/work/project', '/state/skills'];
  const resolved = adapter.resolvePanelPath('.sleepycode/memory.md', '/work/project');
  assert.equal(adapter.openableFile(resolved, roots), '/work/project/.sleepycode/memory.md');
  const escaped = adapter.resolvePanelPath('../../etc/passwd', '/work/project');
  assert.equal(adapter.openableFile(escaped, roots), null);
});

// ---------------------------------------------------------------- allow-list guard
//
// Every message the settings window posts must be in the allow-list, or the host
// silently drops it and the button does nothing. `signIn` was added to the host's
// switch but not to the list, so the only sign-in control in the window — and the
// primary first-run CTA — was dead. This test reads the real source so the two
// cannot drift again.

test('every message the settings window posts is allowed through', async () => {
  const fs = await import('node:fs/promises');
  const root = new URL('..', import.meta.url);
  const sources = [
    'webview-ui/settings/App.tsx',
    'webview-ui/settings/panels/ProviderKeysPanel.tsx',
    'webview-ui/settings/panels/MarketplacePanel.tsx',
    'webview-ui/settings/panels/McpPanel.tsx',
    'webview-ui/settings/panels/RulesPanel.tsx',
  ];
  const offenders = [];
  for (const file of sources) {
    const text = await fs.readFile(new URL(file, root), 'utf8');
    for (const match of text.matchAll(/postMessage\(\s*\{\s*type:\s*"([a-zA-Z]+)"/g)) {
      const type = match[1];
      // The hidden `indexing` page posts types this build does not serve; it is
      // unreachable, so those are listed separately rather than pretended.
      if (HIDDEN_PANEL_POSTS.has(type)) continue;
      if (!adapter.isPanelMessage({ type })) offenders.push(`${file}: ${type}`);
    }
  }
  assert.deepEqual(offenders, [], `posted but dropped by the allow-list:\n${offenders.join('\n')}`);
});

test('the hidden indexing page is the only source of unsupported posts', () => {
  // If this set ever grows, a reachable page is posting something the host drops.
  assert.deepEqual([...HIDDEN_PANEL_POSTS].sort(), [
    'deleteIndex', 'getIndexStatus', 'openCursorignore', 'setEmbedModel', 'syncIndex',
  ]);
  for (const type of HIDDEN_PANEL_POSTS) {
    assert.equal(adapter.isPanelMessage({ type }), false, `${type} should still be unsupported`);
  }
});

test('signIn reaches the host, because it is the only sign-in control in the window', () => {
  assert.equal(adapter.isPanelMessage({ type: 'signIn' }), true);
});

test('the OAuth status is posted in the shape the window reads', () => {
  // The window reads `msg.status`; posting the status flat left `oauthStatus`
  // undefined, and the quota section would crash the moment accounts exist.
  const payload = adapter.panelOAuthStatusMessage();
  assert.equal(payload.type, 'oauthStatus');
  assert.ok(payload.status, 'the status must be nested under `status`');
  assert.deepEqual(payload.status.accounts, []);
});
