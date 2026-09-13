import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueTasks,
  evaluateHook,
  evaluateHooks,
  matchGlob,
  nextRunAt,
  normalizeHookRule,
  normalizeSchedule,
} from '../src/hooks.ts';

// --- normalizeSchedule ---

test('normalizeSchedule clamps interval to a 60s minimum', () => {
  assert.equal(normalizeSchedule({ kind: 'interval', everyMs: 5_000 }).everyMs, 60_000);
  assert.equal(normalizeSchedule({ kind: 'interval', everyMs: 120_000 }).everyMs, 120_000);
  assert.equal(normalizeSchedule({ kind: 'interval' }).everyMs, 3_600_000);
});

test('normalizeSchedule clamps daily hour/minute', () => {
  assert.deepEqual(normalizeSchedule({ kind: 'daily', hour: 99, minute: 99 }), { kind: 'daily', hour: 23, minute: 59 });
  assert.deepEqual(normalizeSchedule({ kind: 'daily', hour: -5, minute: -5 }), { kind: 'daily', hour: 0, minute: 0 });
  assert.deepEqual(normalizeSchedule({ kind: 'daily' }), { kind: 'daily', hour: 9, minute: 0 });
});

test('normalizeSchedule keeps a cron expression and falls back when blank', () => {
  assert.deepEqual(normalizeSchedule({ kind: 'cron', cron: '  */5 * * * *  ' }), { kind: 'cron', cron: '*/5 * * * *' });
  assert.equal(normalizeSchedule({ kind: 'cron', cron: '   ' }).kind, 'interval');
});

// --- nextRunAt ---

test('nextRunAt adds the interval', () => {
  assert.equal(nextRunAt({ kind: 'interval', everyMs: 60_000 }, 1_000), 61_000);
});

test('nextRunAt rolls a daily schedule to the next day when the time has passed', () => {
  const from = Date.UTC(2026, 0, 1, 12, 0, 0);
  const next = nextRunAt({ kind: 'daily', hour: 9, minute: 0 }, from);
  assert.equal(next, Date.UTC(2026, 0, 2, 9, 0, 0));
});

test('nextRunAt keeps a daily schedule the same day when still ahead', () => {
  const from = Date.UTC(2026, 0, 1, 8, 0, 0);
  const next = nextRunAt({ kind: 'daily', hour: 9, minute: 0 }, from);
  assert.equal(next, Date.UTC(2026, 0, 1, 9, 0, 0));
});

test('nextRunAt handles cron step and range fields', () => {
  const from = Date.UTC(2026, 0, 1, 10, 2, 0);
  const next = nextRunAt({ kind: 'cron', cron: '*/15 * * * *' }, from);
  assert.equal(new Date(next).getUTCMinutes(), 15);
});

// --- dueTasks ---

test('dueTasks only returns enabled tasks whose nextRunAt has passed', () => {
  const now = 10_000;
  const tasks = [
    { id: 'a', enabled: true, nextRunAt: 5_000 },
    { id: 'b', enabled: false, nextRunAt: 5_000 },
    { id: 'c', enabled: true, nextRunAt: 20_000 },
    { id: 'd', enabled: true },
  ];
  assert.deepEqual(dueTasks(tasks, now).map(t => t.id), ['a', 'd']);
});

// --- matchGlob ---

test('matchGlob matches ** across directories and * within a segment', () => {
  assert.equal(matchGlob('**/*.ts', 'src/deep/file.ts'), true);
  assert.equal(matchGlob('src/*.ts', 'src/file.ts'), true);
  assert.equal(matchGlob('src/*.ts', 'src/deep/file.ts'), false);
});

// --- evaluateHook(s) ---

const rule = (over) => ({ id: 'r', name: 'Rule', event: 'beforeTool', action: 'allow', enabled: true, ...over });

test('evaluateHook respects enabled, event, and matchers', () => {
  assert.equal(evaluateHook(rule({ enabled: false }), { event: 'beforeTool' }).triggered, false);
  assert.equal(evaluateHook(rule({}), { event: 'afterTool' }).triggered, false);
  assert.equal(evaluateHook(rule({ matcher: { tool: 'run_command' } }), { event: 'beforeTool', tool: 'run_command' }).triggered, true);
  assert.equal(evaluateHook(rule({ matcher: { tool: 'run_command' } }), { event: 'beforeTool', tool: 'write_file' }).triggered, false);
  assert.equal(evaluateHook(rule({ matcher: { contains: 'rm -rf' } }), { event: 'beforeTool', text: 'please rm -rf /' }).triggered, true);
});

test('evaluateHooks gives block precedence over other matching rules', () => {
  const rules = [
    rule({ id: 'warn', action: 'warn' }),
    rule({ id: 'block', action: 'block', message: 'no' }),
  ];
  const decision = evaluateHooks(rules, { event: 'beforeTool' });
  assert.equal(decision.action, 'block');
  assert.equal(decision.message, 'no');
});

test('evaluateHooks returns the last non-block triggered decision', () => {
  const rules = [
    rule({ id: 'warn', action: 'warn', message: 'careful' }),
    rule({ id: 'log', action: 'log', message: 'noted' }),
  ];
  assert.deepEqual(evaluateHooks(rules, { event: 'beforeTool' }), { triggered: true, action: 'log', message: 'noted' });
});

test('evaluateHooks defaults to allow when nothing matches', () => {
  assert.deepEqual(evaluateHooks([rule({ enabled: false })], { event: 'beforeTool' }), { triggered: false, action: 'allow', message: '' });
});

// --- normalizeHookRule ---

test('normalizeHookRule fills defaults and preserves a provided id', () => {
  const normalized = normalizeHookRule({ id: 'keep', name: '  Guard  ', event: 'onEdit', action: 'block' });
  assert.equal(normalized.id, 'keep');
  assert.equal(normalized.name, 'Guard');
  assert.equal(normalized.enabled, true);
  const fallback = normalizeHookRule({ name: '', event: 'onEdit', action: 'allow' });
  assert.match(fallback.id, /^hook-/);
  assert.equal(fallback.name, 'Untitled hook');
});
