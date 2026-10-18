import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertSource } from './source-assert.mjs';

const runtime = readFileSync(new URL('../src/webview/runtime.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/webview/styles.ts', import.meta.url), 'utf8');

test('an assistant turn carries a visible identity label', () => {
  // Assistant prose was flush-left with no marker, so the agent's side of the turn
  // was indistinguishable from a system note or a code block.
  assertSource(runtime, /function ensureIdentity\(turn\)/);
  assertSource(runtime, /className='assistant-identity'/);
  assert.match(styles, /\.assistant-identity\{/);
  assert.match(styles, /\.assistant-identity-mark\{[^}]*background:var\(--sc-accent\)/);
});

test('the identity appears in both the history and the streaming path', () => {
  // A label that only renders after reload, or only while streaming, is worse than none.
  assertSource(runtime, "else{ensureIdentity(turn);const answer=document.createElement('div')", 'history render must mark the turn');
  assertSource(runtime, "if(s.currentRaw){ensureIdentity(turn);", 'streaming render must mark the turn');
});

test('the identity is inserted once per turn, not per streamed chunk', () => {
  // renderLive re-runs on every chunk against the same turn element.
  assertSource(runtime, /if\(turn\.dataset\.identity==='1'\)return;/);
});
