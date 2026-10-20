import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_NAME_LENGTH,
  expandEnvironment,
  isMcpAuthRequired,
  mcpToolName,
  parseMcpServers,
  restrictedEnv,
  safeName,
  uniqueToolName,
} from '../src/mcp-core.ts';

test('parseMcpServers reads a bare server map', () => {
  const servers = parseMcpServers(JSON.stringify({
    mini: { command: 'node', args: ['server.mjs'] },
    remote: { url: 'https://example.test/mcp' },
  }));
  assert.deepEqual(servers, {
    mini: { command: 'node', args: ['server.mjs'], env: undefined, cwd: undefined },
    remote: { url: 'https://example.test/mcp', transport: 'http', headers: undefined },
  });
});

test('parseMcpServers accepts the mcpServers wrapper other tools emit', () => {
  const servers = parseMcpServers(JSON.stringify({
    mcpServers: { remote: { url: 'https://example.test/mcp', type: 'sse' } },
  }));
  assert.deepEqual(Object.keys(servers), ['remote']);
  assert.equal(servers.remote.transport, 'sse');
});

test('parseMcpServers accepts a declared type on stdio servers', () => {
  const servers = parseMcpServers(JSON.stringify({
    local: { type: 'stdio', command: 'node', args: ['server.mjs'] },
  }));
  assert.equal(servers.local.command, 'node');
});

test('parseMcpServers prefers a real server entry over the wrapper key', () => {
  const servers = parseMcpServers(JSON.stringify({
    mcpServers: { url: 'https://example.test/not-a-wrapper' },
    real: { url: 'https://example.test/mcp' },
  }));
  assert.deepEqual(Object.keys(servers).sort(), ['mcpServers', 'real']);
});

test('parseMcpServers rejects unusable configuration', () => {
  assert.throws(() => parseMcpServers('{'), /not valid JSON/);
  assert.throws(() => parseMcpServers('[]'), /must be a JSON object/);
  assert.throws(() => parseMcpServers('{"a": 1}'), /must be an object/);
  assert.throws(() => parseMcpServers('{"a": {}}'), /needs either a "url" or a "command"/);
  assert.deepEqual(parseMcpServers('   '), {});
});

test('expandEnvironment expands referenced env vars', () => {
  const expanded = expandEnvironment({ Authorization: 'Bearer ${env:TOKEN}' }, { TOKEN: 'abc' });
  assert.deepEqual(expanded, { Authorization: 'Bearer abc' });
});

test('restrictedEnv does not leak the full environment', () => {
  const env = restrictedEnv(
    { command: 'node', args: ['server.mjs'], headers: { 'X-Key': '${env:SECRET}' } },
    { PATH: '/usr/bin', SECRET: 'value', UNRELATED: 'nope' },
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SECRET, 'value');
  assert.equal(env.UNRELATED, undefined);
});

test('mcpToolName keeps provider-safe names', () => {
  assert.equal(mcpToolName('my server', 'read_file'), 'mcp_my_server_read_file');
  const long = mcpToolName('server-with-a-long-name', 'a'.repeat(60));
  assert.equal(long.length, MAX_TOOL_NAME_LENGTH);
  assert.match(long, /^[a-z0-9_]+$/);
  assert.equal(long, mcpToolName('server-with-a-long-name', 'a'.repeat(60)), 'name must be stable across turns');
});

test('mcpToolName keeps long names distinct', () => {
  const a = mcpToolName('server-with-a-long-name', 'a'.repeat(60));
  const b = mcpToolName('server-with-a-long-name', 'a'.repeat(59) + 'b');
  assert.notEqual(a, b);
});

test('uniqueToolName suffixes collisions within the length cap', () => {
  const used = new Set();
  const first = uniqueToolName(mcpToolName('server', 'search'), used);
  used.add(first);
  const second = uniqueToolName(mcpToolName('other', 'search'), used);
  used.add(second);
  assert.notEqual(first, second);
  assert.ok(second.length <= MAX_TOOL_NAME_LENGTH);

  const longUsed = new Set([uniqueToolName(mcpToolName('s'.repeat(40), 't'.repeat(20)), new Set())]);
  const collided = uniqueToolName([...longUsed][0], longUsed);
  assert.ok(collided.length <= MAX_TOOL_NAME_LENGTH);
  assert.match(collided, /_2$/);
});

test('safeName falls back instead of producing an empty name', () => {
  assert.equal(safeName('---'), 'server');
  assert.equal(safeName('My Server'), 'my_server');
});

test('isMcpAuthRequired recognises the messages servers actually send', () => {
  assert.equal(isMcpAuthRequired('401 Unauthorized'), true);
  assert.equal(isMcpAuthRequired('Request failed with status 403'), true);
  assert.equal(isMcpAuthRequired('OAuth authorization required. Open Settings to connect.'), true);
  assert.equal(isMcpAuthRequired('Authentication failed'), true);
  assert.equal(isMcpAuthRequired('connect ECONNREFUSED 127.0.0.1:9'), false);
});
