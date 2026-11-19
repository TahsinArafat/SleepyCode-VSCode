import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeShellCommand } from '../src/tool-payload-core.ts';

/*
 * Tool card headers.
 *
 * A card header is one row and a command is not. The reporter's `docker exec … cgi-fcgi`
 * invocation was twelve lines, and the header rendered every one of them: it filled the
 * sidebar and pushed the rest of the conversation off screen.
 */

test('a multi-line command collapses to one readable line', () => {
  const command = [
    'cd /Users/someone/Project/.sleepycode/apcu-probe && docker rm -f apcu-probe-run >/dev/null 2>&1',
    'docker run -d --name apcu-probe-run apcu-probe >/dev/null',
    'sleep 2',
    "docker exec apcu-probe-run sh -c 'SCRIPT_NAME=/index.php REQUEST_METHOD=GET cgi-fcgi -bind -connect 127.0.0.1:9000'",
  ].join('\n');
  const summary = summarizeShellCommand(command);
  assert.doesNotMatch(summary, /\n/, 'no newlines survive');
  assert.ok(summary.length <= 121, 'and it fits a header');
});

test('a leading bare `cd` is dropped, because it says nothing on its own', () => {
  // The first line of a multi-line command is usually just the working directory, which
  // the card already knows. Keeping it wastes the most valuable part of the header.
  const summary = summarizeShellCommand('cd /some/where\ndocker ps');
  assert.equal(summary, 'docker ps');
  // A lone `cd` with nothing after it is the entire command and must be kept.
  assert.equal(summarizeShellCommand('cd /some/where'), 'cd /some/where');
});

test('continuations join with && so the shape of the command survives', () => {
  assert.equal(summarizeShellCommand('npm run build\ngit status'), 'npm run build && git status');
  assert.equal(summarizeShellCommand('  a  \n\n  b  '), 'a && b', 'blank lines and padding are trimmed');
});

test('a long single-line command is truncated on a word boundary', () => {
  const long = 'docker exec container sh -c ' + 'x'.repeat(400);
  const summary = summarizeShellCommand(long, 60);
  assert.ok(summary.length <= 61);
  assert.match(summary, /…$/, 'and says it was cut');
  // Cutting mid-token would make the command look corrupt; a boundary is preferred.
  assert.doesNotMatch(summary, /x{59}…$/, 'not cut mid-token when a boundary exists');
});

test('an empty or missing command yields nothing rather than a placeholder', () => {
  assert.equal(summarizeShellCommand(''), '');
  assert.equal(summarizeShellCommand('   '), '');
  assert.equal(summarizeShellCommand(undefined), '');
});
