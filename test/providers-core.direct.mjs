import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../src/providers-core.ts';

/*
 * The React settings window has no provider surface at all: the section is hidden,
 * so there is no way to add a compatibility endpoint or set its API key. SleepyAI
 * works (sign-in), everything else is unreachable.
 *
 * Two boundaries are load-bearing and pinned here. The canonical SleepyAI provider
 * cannot be removed or replaced — the product is built around it. And a key is
 * never shown back to the page: the host holds it in secret storage, so the panel
 * only ever learns whether one exists and its last few characters.
 */

const sleepy = { id: 'sleepyai', name: 'SleepyAI', baseURL: 'https://api.sleepyai.dev/v1', isSleepy: true };
const custom = { id: 'my-endpoint', name: 'My Endpoint', baseURL: 'https://example.com/v1', modelList: ['a-model'] };

test('rows list the first-party provider first and mark the active one', () => {
  const rows = providers.providerRows({
    providers: [custom, sleepy],
    keys: { 'my-endpoint': 'sk-1234567890abcdef' },
    activeId: 'my-endpoint',
  });
  assert.deepEqual(rows.map(r => r.id), ['sleepyai', 'my-endpoint'], 'the first-party provider leads');
  assert.equal(rows[0].isSleepy, true);
  assert.equal(rows[0].active, false);
  assert.equal(rows[1].active, true);
  assert.equal(rows[1].hasKey, true);
  assert.equal(rows[0].hasKey, false);
});

test('a key is never echoed back to the page', () => {
  const rows = providers.providerRows({ providers: [custom], keys: { 'my-endpoint': 'sk-super-secret-value' }, activeId: '' });
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /super-secret/, 'the full key must not leave the host');
  // Only the tail is shown, so a user can tell which key is installed.
  assert.equal(rows[0].keyHint, '••••alue');
});

test('the canonical provider cannot be removed or replaced', () => {
  // The product is built around it: settings must not be able to delete it.
  const rows = providers.providerRows({ providers: [sleepy, custom], keys: {}, activeId: '' });
  assert.equal(providers.canRemoveProvider(rows[0]), false);
  assert.equal(providers.canRemoveProvider(rows[1]), true);
  // Nor can an edit change its identity.
  const built = providers.providerFromDraft({ id: 'sleepyai', name: 'Renamed', baseURL: 'https://evil.test/v1', isSleepy: true });
  assert.equal(built.isSleepy, true, 'it stays the first-party provider');
});

test('a draft is validated before it is saved', () => {
  const ok = providers.validateProviderDraft({ name: 'Mine', baseURL: 'https://example.com/v1' });
  assert.equal(ok, null);
  assert.match(providers.validateProviderDraft({ name: '', baseURL: 'https://example.com' }), /name/i);
  assert.match(providers.validateProviderDraft({ name: 'Mine', baseURL: '' }), /url/i);
  assert.match(providers.validateProviderDraft({ name: 'Mine', baseURL: 'not a url' }), /url/i);
  // A key belongs in secret storage, so a non-https endpoint is refused outright
  // rather than sent in clear text.
  assert.match(providers.validateProviderDraft({ name: 'Mine', baseURL: 'http://example.com' }), /https/i);
  // Loopback is the exception: a local model server cannot offer TLS.
  assert.equal(providers.validateProviderDraft({ name: 'Mine', baseURL: 'http://localhost:11434/v1' }), null);
  assert.equal(providers.validateProviderDraft({ name: 'Mine', baseURL: 'http://127.0.0.1:8080/v1' }), null);
});

test('a model list is parsed from what people actually type', () => {
  // Commas, spaces, newlines and duplicates all arrive from a single text box.
  assert.deepEqual(providers.parseModelList('a, b,c\nd  e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(providers.parseModelList('a, a, a'), ['a'], 'duplicates collapse');
  assert.deepEqual(providers.parseModelList(''), []);
  assert.deepEqual(providers.parseModelList(undefined), []);
  assert.deepEqual(providers.parseModelList(' , , '), []);
});

test('a new provider gets an id derived from its name, and an edit keeps its own', () => {
  const created = providers.providerFromDraft({ name: 'My Endpoint!', baseURL: 'https://example.com/v1' });
  assert.equal(created.id, 'my-endpoint');
  assert.equal(created.isSleepy, undefined);
  // Editing must not mint a new id: the API key is stored against it.
  const edited = providers.providerFromDraft({ id: 'my-endpoint', name: 'Renamed Endpoint', baseURL: 'https://example.com/v2' });
  assert.equal(edited.id, 'my-endpoint');
});

test('an unnamed provider still gets a usable id', () => {
  const built = providers.providerFromDraft({ name: '!!!', baseURL: 'https://example.com' });
  assert.ok(built.id.length > 0);
  assert.match(built.id, /^[a-z0-9-]+$/);
});

test('a base url is normalised, not passed through raw', () => {
  // Trailing slashes and stray whitespace make two identical endpoints look like
  // two different providers.
  assert.equal(providers.normalizeBaseUrl('  https://example.com/v1/  '), 'https://example.com/v1');
  assert.equal(providers.normalizeBaseUrl('https://example.com/v1///'), 'https://example.com/v1');
  assert.equal(providers.normalizeBaseUrl(''), '');
});

test('a key hint hides everything but the tail, and nothing when unset', () => {
  assert.equal(providers.keyHint('sk-1234567890'), '••••7890');
  assert.equal(providers.keyHint(''), '');
  assert.equal(providers.keyHint(undefined), '');
  // A very short key is not revealed on the grounds that there is little to hide.
  assert.equal(providers.keyHint('abc'), '••••');
});

test('junk providers are dropped rather than rendered as blank rows', () => {
  const rows = providers.providerRows({
    providers: [null, {}, { id: '', name: 'no id' }, { id: 'ok', name: 'Fine', baseURL: 'https://x.test' }],
    keys: {},
    activeId: '',
  });
  assert.deepEqual(rows.map(r => r.id), ['ok']);
  assert.deepEqual(providers.providerRows({ providers: undefined, keys: {}, activeId: '' }), []);
});
test('the default provider can be changed from the page that shows it', () => {
  const rows = providers.providerRows({
    providers: [{ id: 'sleepy', name: 'SleepyAI', baseURL: 'https://api', isSleepy: true }, { id: 'local', name: 'Local', baseURL: '' }],
    keys: {},
    activeId: 'sleepy',
  });
  const [firstParty, local] = rows;
  // The dark state: "Active" rendered as a badge with nothing that writes it.
  assert.equal(providers.canActivateProvider(firstParty), false);
  assert.match(providers.activateHint(firstParty), /already the default/);
  // A keyless endpoint can still be the default: a local server needs no key.
  assert.equal(providers.canActivateProvider(local), true);
  assert.match(providers.activateHint(local), /Local/);
  assert.equal(providers.canActivateProvider(undefined), false);
});
