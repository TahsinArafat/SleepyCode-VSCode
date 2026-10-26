import test from 'node:test';
import assert from 'node:assert/strict';

const oauth = await import('../src/mcp-oauth.ts');

function secrets() {
  const store = new Map();
  return {
    get: async (key) => store.get(key),
    store: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    raw: store,
  };
}

function provider(overrides = {}) {
  return new oauth.McpOAuthProvider(
    overrides.url ?? 'https://example.test/mcp',
    overrides.name ?? 'example',
    secrets(),
    async () => undefined,
    overrides.options ?? {},
  );
}

// These pin the two things that made OAuth impossible against a real server.
// Verified against https://shamela.link/mcp: without application_type the
// authorization server classifies the client as "web" and refuses the loopback
// redirect, so registration fails before the browser ever opens.

test('the client registers as a native app so a loopback redirect is allowed', () => {
  assert.equal(provider().clientMetadata.application_type, 'native');
});

test('the redirect is a loopback http URL', () => {
  const url = new URL(provider().redirectUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, 'localhost');
  assert.match(url.pathname, /\/mcp\/oauth\/callback$/);
});

test('the client asks for no secret, which is what a desktop app can hold', () => {
  assert.equal(provider().clientMetadata.token_endpoint_auth_method, 'none');
});

test('configured scopes are requested', () => {
  const meta = provider({ options: { scopes: ['profile', 'offline_access'] } }).clientMetadata;
  assert.equal(meta.scope, 'profile offline_access');
});

test('a configured client id is used instead of dynamic registration', async () => {
  const p = provider({ options: { clientId: 'preset-client' } });
  assert.deepEqual(await p.clientInformation(), { client_id: 'preset-client' });
});

test('without interactive sign-in, asking for a state raises auth-required', () => {
  // This is how the client learns a server needs the user, so it must throw the
  // typed error rather than a generic one.
  assert.throws(() => provider().state(), oauth.McpAuthRequiredError);
});

test('remote URLs must be HTTPS, or plain HTTP on loopback only', () => {
  assert.doesNotThrow(() => oauth.validateMcpRemoteUrl('https://example.test/mcp'));
  assert.doesNotThrow(() => oauth.validateMcpRemoteUrl('http://localhost:3000/mcp'));
  assert.doesNotThrow(() => oauth.validateMcpRemoteUrl('http://127.0.0.1:3000/mcp'));
  assert.throws(() => oauth.validateMcpRemoteUrl('http://example.test/mcp'), /HTTPS/);
  assert.throws(() => oauth.validateMcpRemoteUrl('ftp://example.test/mcp'), /HTTPS/);
});

test('URLs with embedded credentials are refused', () => {
  assert.throws(() => oauth.validateMcpRemoteUrl('https://user:pw@example.test/mcp'), /credentials/);
});

test('a non-interactive client without saved credentials is auth-required', async () => {
  await assert.rejects(() => provider().clientInformation(), oauth.McpAuthRequiredError);
});