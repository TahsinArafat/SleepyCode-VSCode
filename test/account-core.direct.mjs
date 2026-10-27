import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary } from '../src/account-core.ts';

/*
 * The account had no section at all: the host could sign in, refresh a token and
 * read the tier, and the settings window showed none of it. These are the figures
 * that section shows, and the rule that decides what to leave out.
 */

test('a signed-out account says so and offers no figures', () => {
  const summary = accountSummary({ loggedIn: false });
  assert.equal(summary.signedIn, false);
  assert.equal(summary.identity, 'Not signed in');
  assert.deepEqual(summary.rows, []);
  // Nothing at all is the same answer as signed out, not a crash.
  assert.deepEqual(accountSummary(undefined).rows, []);
});

test('a signed-in account is identified by email, with the plan named', () => {
  const summary = accountSummary({ loggedIn: true, email: 'a@b.co', tier: 'pro', subscription: { plan: 'Pro', status: 'active' } });
  assert.equal(summary.signedIn, true);
  assert.equal(summary.identity, 'a@b.co');
  // The subscription names the plan when it is known; the tier is the fallback.
  assert.equal(summary.plan, 'Pro');
  assert.equal(accountSummary({ loggedIn: true, email: 'a@b.co', tier: 'free' }).plan, 'free');
});

test('the daily token allowance is the headline figure, with its share', () => {
  const summary = accountSummary({ loggedIn: true, limits: { usedTokensToday: 25_000, tokensPerDay: 100_000 } });
  const row = summary.rows.find(entry => entry.label === 'Free tokens today');
  assert.ok(row, 'the allowance row exists');
  assert.equal(row.value, '25k / 100k');
  assert.equal(row.percent, 25);
  assert.equal(row.level, 'safe');
  // Running out is the point of showing it at all.
  const nearly = accountSummary({ loggedIn: true, limits: { usedTokensToday: 95_000, tokensPerDay: 100_000 } });
  assert.equal(nearly.rows.find(entry => entry.label === 'Free tokens today').level, 'danger');
});

test('a limit that was never reported is left out rather than drawn as zero', () => {
  // "0 used" would say the quota is untouched; not knowing is a different fact.
  const summary = accountSummary({ loggedIn: true, limits: { usedTokensToday: 500 } });
  assert.equal(summary.rows.some(entry => entry.label === 'Free tokens today'), false);
  const noSpend = accountSummary({ loggedIn: true, limits: { cost24h: 1.5 } });
  assert.equal(noSpend.rows.some(entry => entry.label === 'Spend, last 24 hours'), false);
});

test('spend windows and credits read as money', () => {
  const summary = accountSummary({
    loggedIn: true,
    limits: { cost24h: 1.5, limit24h: 5, costMonthly: 12, limitMonthly: 20 },
    balances: { credits: 3.25, currency: 'USD' },
    subscription: { monthlySpend: 4, monthlyLimit: 10 },
  });
  const byLabel = Object.fromEntries(summary.rows.map(row => [row.label, row.value]));
  assert.equal(byLabel['Spend, last 24 hours'], '$1.50 / $5.00');
  assert.equal(byLabel['Spend, this month'], '$12.00 / $20.00');
  assert.equal(byLabel.Credits, '$3.25');
  assert.equal(byLabel['Plan usage this month'], '$4.00 / $10.00');
  assert.equal(summary.rows.find(row => row.label === 'Spend, last 24 hours').percent, 30);
});