import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserError,
  VIEWPORTS,
  analyzeGeometry,
  pickViewport,
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
