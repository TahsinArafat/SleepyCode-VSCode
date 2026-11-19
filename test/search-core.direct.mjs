import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../src/search-core.ts';

/*
 * Workspace search.
 *
 * The old implementation read every candidate file in full, sequentially, on the
 * extension host's single thread: 85 ms for 500 files here, and linear, so a large
 * workspace blocked for seconds on every search. It also had no regex, no case control
 * and no context lines, so the agent often had to search several times.
 */

test('ripgrep candidates cover both packaged layouts and the platform subfolder', () => {
  const candidates = s.ripgrepCandidates('/app/root', 'darwin', 'arm64');
  assert.ok(candidates.length >= 4, 'every known layout is probed');
  assert.ok(candidates.some(p => p.includes('ripgrep-universal') && p.includes('darwin-arm64')), 'the universal build nests a target folder');
  assert.ok(candidates.some(p => p.includes('@vscode') && p.endsWith('/rg')), 'and the plain build keeps the binary in bin/');
  // macOS and Linux use `rg`; Windows ships `rg.exe`.
  assert.ok(s.ripgrepCandidates('/app', 'win32', 'x64').every(p => p.endsWith('rg.exe')));
  // No appRoot means no candidates rather than a bogus path.
  assert.deepEqual(s.ripgrepCandidates(undefined), []);
});

test('the arguments express what the caller asked for', () => {
  const base = s.searchArgs({ pattern: 'needle' }, '/root');
  assert.ok(base.includes('--fixed-strings'), 'a plain query is literal by default');
  assert.ok(base.includes('--ignore-case'), 'and case-insensitive by default, matching the old behaviour');
  assert.ok(!base.includes('--context'), 'no context unless asked');

  const regex = s.searchArgs({ pattern: 'a.*b', regex: true, caseSensitive: true, contextLines: 3, glob: 'src/**/*.ts', limit: 7 }, '/root');
  assert.ok(!regex.includes('--fixed-strings'), 'regex mode drops the literal flag');
  assert.ok(!regex.includes('--ignore-case'), 'case sensitivity is honoured');
  assert.deepEqual(regex.slice(regex.indexOf('--context'), regex.indexOf('--context') + 2), ['--context', '3']);
  assert.ok(regex.includes('src/**/*.ts'));
});

test('the pattern and root come after `--` so a pattern cannot be read as a flag', () => {
  // A search for "--help" must search for that text, not print ripgrep's help.
  const args = s.searchArgs({ pattern: '--help' }, '/root');
  assert.equal(args[args.length - 2], '--help');
  assert.equal(args[args.length - 1], '/root');
  assert.ok(args.indexOf('--') < args.length - 2, 'the separator precedes the pattern');
});

test('build output is excluded but the user\'s own ignore files are respected', () => {
  const args = s.searchArgs({ pattern: 'x' }, '/root');
  for (const excluded of ['!node_modules/**', '!.git/**', '!dist/**', '!build/**']) {
    assert.ok(args.includes(excluded), `${excluded} is excluded`);
  }
  // --no-ignore would defeat .gitignore; it must not be passed.
  assert.ok(!args.includes('--no-ignore'));
});

test('a context request is clamped rather than trusted', () => {
  const args = s.searchArgs({ pattern: 'x', contextLines: 999 }, '/root');
  const at = args.indexOf('--context');
  assert.equal(args[at + 1], String(s.MAX_CONTEXT_LINES), 'clamped to the maximum');
});

test('output is capped because --max-count is per file, not overall', () => {
  // A broad pattern over many files can exceed the limit even with --max-count.
  const lines = Array.from({ length: 200 }, (_, i) => `file${i}.ts:1: hit`).join('\n');
  const capped = s.capSearchOutput(lines, 80);
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.split('\n').filter(l => l.includes(': hit')).length, 80);
  assert.match(capped.text, /showing the first 80 of 200/, 'and says so, so it is not mistaken for the whole answer');

  const whole = s.capSearchOutput('a:1: x\nb:1: y', 80);
  assert.equal(whole.truncated, false);
  assert.doesNotMatch(whole.text, /showing the first/);
});

test('secret files are withheld by the same rule the file tools use', () => {
  // Applied to output rather than arguments: the glob list is about build output, and a
  // .env the user asked about directly must still be withheld.
  assert.equal(s.isSecretPath('.env'), true);
  assert.equal(s.isSecretPath('config/.env.local'), true);
  assert.equal(s.isSecretPath('secrets.yaml'), true);
  assert.equal(s.isSecretPath('credentials.json'), true);
  assert.equal(s.isSecretPath('src/agent.ts'), false);
  assert.equal(s.isSecretPath('environment.ts'), false, 'a name merely starting with "env" is not a secret file');
});
