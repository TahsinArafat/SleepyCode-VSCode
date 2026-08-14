import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function expandEnvironment(values, env = process.env) {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(/\$\{env:([^}\r\n]+)\}/g, (_match, rawName) => env[rawName.trim()] ?? ''),
  ]));
}

const MINIMAL_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL',
  'ComSpec', 'SystemRoot', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
]);

function restrictedEnv(server, env = process.env) {
  const result = {};
  const command = server.command ?? '';
  const args = server.args ?? [];
  const url = server.url ?? '';
  const headers = server.headers ?? {};
  const cwd = server.cwd ?? '';
  const serverEnv = server.env ?? {};
  const allText = [
    command,
    ...args,
    ...(url ? [url] : []),
    ...(headers ? Object.values(headers) : []),
    cwd,
    ...(serverEnv ? Object.values(serverEnv) : []),
  ].join('');
  const referencedVars = new Set();
  for (const match of allText.matchAll(/\$\{env:([^}]+)\}/g)) {
    if (match && match[1]) referencedVars.add(match[1].trim());
  }
  for (const key of [...referencedVars, ...MINIMAL_ENV_KEYS]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseMcpServers(raw) {
  if (!raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`MCP server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP server configuration must be a JSON object keyed by server name.');
  const result = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP server '${name}' must be an object.`);
    const item = value;
    if (typeof item.url === 'string' && item.url.trim()) {
      result[name] = { url: item.url.trim(), headers: item.headers };
    } else if (typeof item.command === 'string' && item.command.trim()) {
      result[name] = { command: item.command.trim(), args: Array.isArray(item.args) ? item.args.filter(arg => typeof arg === 'string') : undefined, env: item.env };
    } else {
      throw new Error(`MCP server '${name}' needs either a url or command.`);
    }
  }
  return result;
}

describe('parseMcpServers', () => {
  it('parses valid stdio config', () => {
    const servers = parseMcpServers(JSON.stringify({ local: { command: 'node', args: ['server.js'] } }));
    assert.equal(servers.local.command, 'node');
    assert.deepEqual(servers.local.args, ['server.js']);
  });

  it('parses valid HTTP config', () => {
    const servers = parseMcpServers(JSON.stringify({ remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } } }));
    assert.equal(servers.remote.url, 'https://example.com/mcp');
    assert.deepEqual(servers.remote.headers, { Authorization: 'Bearer token' });
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseMcpServers('not json'), /not valid JSON/);
  });

  it('rejects non-object JSON', () => {
    assert.throws(() => parseMcpServers('[]'), /must be a JSON object/);
  });

  it('rejects server without url or command', () => {
    assert.throws(() => parseMcpServers(JSON.stringify({ bad: { foo: 'bar' } })), /needs either a url or command/);
  });
});

describe('expandEnvironment', () => {
  it('expands referenced env vars', () => {
    const result = expandEnvironment({ TOKEN: '${env:MCP_TOKEN}' }, { MCP_TOKEN: 'secret' });
    assert.equal(result?.TOKEN, 'secret');
  });

  it('leaves unreferenced vars as-is', () => {
    const result = expandEnvironment({ STATIC: 'hello' });
    assert.equal(result?.STATIC, 'hello');
  });
});

describe('restrictedEnv', () => {
  it('includes minimal env by default', () => {
    const server = { command: 'node', args: ['server.js'] };
    const env = restrictedEnv(server, { PATH: '/usr/bin', HOME: '/home/user', SECRET: 'leaked' });
    assert.ok(env?.PATH);
    assert.ok(env?.HOME);
    assert.equal(env?.SECRET, undefined);
  });

  it('includes referenced env vars', () => {
    const server = { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${env:MCP_TOKEN}' } };
    const env = restrictedEnv(server, { MCP_TOKEN: 'secret', PATH: '/usr/bin' });
    assert.equal(env?.MCP_TOKEN, 'secret');
    assert.equal(env?.PATH, '/usr/bin');
  });

  it('does not leak full process.env', () => {
    const original = process.env;
    process.env = { ...original, PRIVATE_KEY: 'secret', API_TOKEN: 'secret' };
    try {
      const server = { command: 'node', args: ['server.js'] };
      const env = restrictedEnv(server);
      assert.equal(env?.PRIVATE_KEY, undefined);
      assert.equal(env?.API_TOKEN, undefined);
    } finally {
      process.env = original;
    }
  });
});
