import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_RESULT_CAP,
  BrowserError,
  VIEWPORTS,
  analyzeGeometry,
  findFrameIndex,
  findTabIndex,
  pickViewport,
  stringifyEvalResult,
  summarizeConsoleErrors,
  summarizeNetworkErrors,
} from '../src/browser.ts';

test('pickViewport returns the named preset and defaults to laptop', () => {
  assert.equal(pickViewport('mobile').width, 390);
  assert.equal(pickViewport('desktop').width, 1920);
  assert.equal(pickViewport('nonsense').name, 'laptop');
  assert.equal(pickViewport(undefined).name, 'laptop');
  assert.equal(Object.keys(VIEWPORTS).length, 4);
});

test('summarizeConsoleErrors splits errors and warnings', () => {
  const { errors, warnings } = summarizeConsoleErrors([
    { type: 'error', text: 'boom' },
    { type: 'warning', text: 'hmm' },
    { type: 'log', text: 'info' },
  ]);
  assert.deepEqual(errors.map(e => e.text), ['boom']);
  assert.deepEqual(warnings.map(w => w.text), ['hmm']);
});

test('summarizeNetworkErrors reports failed requests and status >= 400', () => {
  const failed = summarizeNetworkErrors([
    { url: 'a', method: 'GET', status: 200, failed: false },
    { url: 'b', method: 'GET', status: 404, failed: false },
    { url: 'c', method: 'GET', status: 0, failed: true },
  ]);
  assert.deepEqual(failed.map(r => r.url), ['b', 'c']);
});

test('analyzeGeometry flags horizontal overflow and offscreen elements', () => {
  const viewport = VIEWPORTS.mobile;
  const geometry = analyzeGeometry(viewport, viewport.width, viewport.width + 100, [
    { selector: '#ok', box: { x: 10, y: 10, width: 50, height: 50 } },
    { selector: '#wide', box: { x: 0, y: 0, width: viewport.width + 200, height: 20 } },
  ]);
  assert.equal(geometry.horizontalOverflow, true);
  assert.deepEqual(geometry.offscreen, ['#wide']);
});

test('analyzeGeometry reports a clean layout as non-overflowing', () => {
  const viewport = VIEWPORTS.desktop;
  const geometry = analyzeGeometry(viewport, viewport.width, viewport.width, []);
  assert.equal(geometry.horizontalOverflow, false);
  assert.deepEqual(geometry.offscreen, []);
});

test('BrowserError carries an install hint', () => {
  const error = new BrowserError('nope', 'run npm install');
  assert.equal(error.name, 'BrowserError');
  assert.equal(error.installHint, 'run npm install');
});

test('findTabIndex resolves numeric indexes and URL/title substrings', () => {
  const tabs = [
    { url: 'https://example.com/login', title: 'Sign in' },
    { url: 'https://example.com/dashboard', title: 'Dashboard' },
    { url: 'https://other.dev/home', title: 'Home' },
  ];
  assert.equal(findTabIndex(tabs, 0), 0);
  assert.equal(findTabIndex(tabs, 2), 2);
  assert.equal(findTabIndex(tabs, 3), -1);
  assert.equal(findTabIndex(tabs, -1), -1);
  assert.equal(findTabIndex(tabs, 1.5), -1);
  assert.equal(findTabIndex(tabs, 5), -1);
  assert.equal(findTabIndex(tabs, 'dashboard'), 1);
  assert.equal(findTabIndex(tabs, 'example.com'), -2); // matches tabs 0 and 1
  assert.equal(findTabIndex(tabs, 'sign in'), 0);
  assert.equal(findTabIndex(tabs, 'nope'), -1);
  assert.equal(findTabIndex(tabs, ''), -1);
  assert.equal(findTabIndex([], 'x'), -1);
});

test('findFrameIndex resolves numeric frame indexes and URL substrings', () => {
  const frames = [
    { url: 'https://app.example.com/' },
    { url: 'https://cdn.example.com/widget' },
    { url: 'https://app.example.com/pay' },
  ];
  assert.equal(findFrameIndex(frames, '0'), 0);
  assert.equal(findFrameIndex(frames, '2'), 2);
  assert.equal(findFrameIndex(frames, '3'), -1);
  assert.equal(findFrameIndex(frames, 'widget'), 1);
  assert.equal(findFrameIndex(frames, 'app.example.com'), -2); // frames 0 and 2
  assert.equal(findFrameIndex(frames, 'missing'), -1);
  assert.equal(findFrameIndex([], '0'), -1);
});

test('stringifyEvalResult handles scalars, undefined, cycles, and caps', () => {
  assert.equal(stringifyEvalResult({ a: 1, b: 'x' }), JSON.stringify({ a: 1, b: 'x' }, null, 2));
  assert.equal(stringifyEvalResult('hi'), '"hi"');
  assert.equal(stringifyEvalResult(42), '42');
  assert.equal(stringifyEvalResult(undefined), 'undefined');
  assert.equal(stringifyEvalResult(null), 'null');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(stringifyEvalResult(cyclic), '<unserializable>');
  const big = 'x'.repeat(BROWSER_RESULT_CAP + 500);
  const capped = stringifyEvalResult(big, BROWSER_RESULT_CAP);
  assert.equal(capped.length, BROWSER_RESULT_CAP + '\n…(truncated)'.length);
  assert.ok(capped.endsWith('…(truncated)'));
  assert.ok(!capped.includes('y'));
});
