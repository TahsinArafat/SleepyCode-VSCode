import test from 'node:test';
import assert from 'node:assert/strict';

const adapter = await import('../src/settings-adapter.ts');

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

test('the features payload carries only the fields the MCP page reads', () => {
  const features = adapter.toPanelFeatures(
    [{ name: 'docs', url: 'https://x.test/mcp', transport: 'http', enabled: true }],
    [{ name: 'docs', state: 'ok', toolCount: 2 }],
  );
  assert.equal(features.mcpServers.length, 1);
  assert.equal(features.mcpServers[0].name, 'docs');
  assert.equal(features.mcpStatus.length, 1);
  assert.equal(features.mcpStatus[0].connected, true);
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