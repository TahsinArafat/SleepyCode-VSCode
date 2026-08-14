import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SLEEPY_DASHBOARD_URL = process.env.SLEEPY_DASHBOARD_URL || 'https://www.sleepyai.org';

function sleepyApiBase(dashboardUrl = SLEEPY_DASHBOARD_URL) {
  return `${dashboardUrl}/api/v1`;
}

function buildAuthorizeUrl(dashboardUrl, port) {
  const params = new URLSearchParams({
    client_id: 'sleepy-cli',
    redirect_uri: `http://localhost:${port}/callback`,
    response_type: 'code',
  });
  return `${dashboardUrl}/api/auth/oauth/authorize?${params.toString()}`;
}

async function fetchSleepyModels(token) {
  const response = await fetch(`${sleepyApiBase()}/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => null);
  const data = body && body.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter(model => model && typeof model.modelId === 'string')
    .map(model => model.omniRouteModelId || model.modelId);
}

describe('sleepyApiBase', () => {
  it('builds the OpenAI-compatible API base', () => {
    assert.equal(sleepyApiBase('https://www.sleepyai.org'), 'https://www.sleepyai.org/api/v1');
    assert.equal(sleepyApiBase('http://localhost:3000'), 'http://localhost:3000/api/v1');
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri and response_type', () => {
    const url = new URL(buildAuthorizeUrl('https://www.sleepyai.org', 40822));
    assert.equal(url.pathname, '/api/auth/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'sleepy-cli');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:40822/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
  });
});

describe('fetchSleepyModels', () => {
  it('maps data[].modelId to API ids', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ modelId: 'sleepy-v2.5' }, { modelId: 'sleepy-v2.5-pro' }] }),
    });
    const models = await fetchSleepyModels('token');
    assert.deepEqual(models, ['sleepy-v2.5', 'sleepy-v2.5-pro']);
  });

  it('prefers omniRouteModelId when present', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ modelId: 'sleepy-auto', omniRouteModelId: 'route-1' }] }),
    });
    const models = await fetchSleepyModels('token');
    assert.deepEqual(models, ['route-1']);
  });

  it('sends the Bearer token', async () => {
    let received;
    globalThis.fetch = async (_url, init) => {
      received = init.headers;
      return { ok: true, json: async () => ({ data: [{ modelId: 'm1' }] }) };
    };
    await fetchSleepyModels('secret-token');
    assert.equal(received.Authorization, 'Bearer secret-token');
  });

  it('returns empty array on non-ok response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    const models = await fetchSleepyModels('bad');
    assert.deepEqual(models, []);
  });
});

describe('fetchSleepyAccountData', () => {
  async function fetchSleepyDashboardUsage(token) {
    const res = await fetch(`${SLEEPY_DASHBOARD_URL}/api/usage?days=30`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;

    return {
      limits: {
        requestsPerMinute: typeof data.limits?.rpmLimit === 'number' ? data.limits.rpmLimit : undefined,
        requestsPerDay: typeof data.limits?.limit24h === 'number' ? data.limits.limit24h : undefined,
        usedTokensToday: typeof data.freeTokensToday === 'number' ? data.freeTokensToday : undefined,
        tokensPerDay: typeof data.freeTokenLimit === 'number' ? data.freeTokenLimit : undefined,
      },
      balances: {
        credits: typeof data.balanceUSD === 'number' ? Math.round(data.balanceUSD * 100) / 100 : undefined,
        currency: 'USD',
      },
      subscription: {
        plan: typeof data.tier === 'string' ? data.tier : undefined,
        status: 'active',
        monthlySpend: typeof data.monthlyUsageUSD === 'number' ? Math.round(data.monthlyUsageUSD * 100) / 100 : undefined,
        monthlyLimit: typeof data.monthlyAllowanceUSD === 'number' ? data.monthlyAllowanceUSD : undefined,
      },
    };
  }

  async function fetchSleepyModelPrices(token) {
    const response = await fetch(`${sleepyApiBase()}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = await response.json().catch(() => null);
    const data = body && body.data;
    if (!Array.isArray(data)) return [];
    return data
      .filter(model => model && typeof model.modelId === 'string')
      .map(model => ({
        modelId: model.modelId,
        name: typeof model.name === 'string' ? model.name : model.modelId,
        inputPrice: typeof model.inputPrice === 'number' ? model.inputPrice : undefined,
        outputPrice: typeof model.outputPrice === 'number' ? model.outputPrice : undefined,
        cacheReadPrice: typeof model.cacheReadPrice === 'number' ? model.cacheReadPrice : undefined,
        cacheWritePrice: typeof model.cacheWritePrice === 'number' ? model.cacheWritePrice : undefined,
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
        maxOutputLimit: typeof model.maxOutputLimit === 'number' ? model.maxOutputLimit : undefined,
      }));
  }

  async function fetchSleepyAccountData(token) {
    const [dashUsage, modelPrices] = await Promise.all([
      fetchSleepyDashboardUsage(token),
      fetchSleepyModelPrices(token),
    ]);
    return {
      limits: dashUsage?.limits ?? undefined,
      balances: dashUsage?.balances ?? undefined,
      subscription: dashUsage?.subscription ?? undefined,
      modelPrices,
    };
  }

  it('fetches all account data in parallel from real dashboard endpoints', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url.includes('/api/usage')) {
        return {
          ok: true,
          json: async () => ({
            tier: 'pro',
            balanceUSD: 47.42,
            monthlyUsageUSD: 2.07,
            monthlyAllowanceUSD: 195,
            freeTokensToday: 40000000,
            freeTokenLimit: 500000000,
            // Regression: the live server returns limits.creditUSD with the same value as
            // balanceUSD, so it must never surface as a second (duplicate) balance field.
            limits: { rpmLimit: 200, limit24h: 40, creditUSD: 47.42 }
          })
        };
      }
      if (url.includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ modelId: 'm1', name: 'Model 1', inputPrice: 0.001, outputPrice: 0.002 }] }) };
      }
      return { ok: false };
    };

    const data = await fetchSleepyAccountData('token');
    assert.equal(callCount, 2);
    assert.equal(data.limits.requestsPerMinute, 200);
    assert.equal(data.limits.requestsPerDay, 40);
    assert.equal(data.balances.credits, 47.42);
    assert.equal(data.balances.currency, 'USD');
    // Regression: server limits.creditUSD is the same quantity as balanceUSD; it must not
    // be exposed as a second balance field (previously surfaced as "Extra Credits").
    assert.equal(data.balances.freeCreditsRemaining, undefined);
    assert.deepEqual(Object.keys(data.balances).sort(), ['credits', 'currency']);
    assert.equal(data.subscription.plan, 'pro');
    assert.equal(data.subscription.status, 'active');
    assert.equal(data.subscription.monthlySpend, 2.07);
    assert.equal(data.subscription.monthlyLimit, 195);
    assert.equal(data.modelPrices.length, 1);
    assert.equal(data.modelPrices[0].modelId, 'm1');
  });

  it('handles missing data gracefully', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    const data = await fetchSleepyAccountData('bad-token');
    assert.equal(data.limits, undefined);
    assert.equal(data.balances, undefined);
    assert.equal(data.subscription, undefined);
    assert.deepEqual(data.modelPrices, []);
  });

  it('parses model prices correctly', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { modelId: 'gpt-4', name: 'GPT-4', inputPrice: 0.03, outputPrice: 0.06, cacheReadPrice: 0.015, cacheWritePrice: 0.03, contextWindow: 128000, maxOutputLimit: 4096 },
          { modelId: 'gpt-3.5', name: 'GPT-3.5' },
        ]
      })
    });
    const prices = await fetchSleepyModelPrices('token');
    assert.equal(prices.length, 2);
    assert.equal(prices[0].modelId, 'gpt-4');
    assert.equal(prices[0].inputPrice, 0.03);
    assert.equal(prices[0].outputPrice, 0.06);
    assert.equal(prices[0].cacheReadPrice, 0.015);
    assert.equal(prices[0].cacheWritePrice, 0.03);
    assert.equal(prices[0].contextWindow, 128000);
    assert.equal(prices[0].maxOutputLimit, 4096);
    assert.equal(prices[1].modelId, 'gpt-3.5');
    assert.equal(prices[1].inputPrice, undefined);
  });
});
