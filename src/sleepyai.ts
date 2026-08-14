import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const SLEEPY_WEBSITE_URL = process.env.SLEEPY_WEBSITE_URL || 'https://www.sleepyai.org';
export const SLEEPY_DASHBOARD_URL = process.env.SLEEPY_DASHBOARD_URL || SLEEPY_WEBSITE_URL;
export const SLEEPY_ACCOUNT_URL = process.env.SLEEPY_ACCOUNT_URL || `${SLEEPY_WEBSITE_URL}/dashboard`;
export const LOGIN_PORT = 40822;

export function gatewayCandidates(): string[] {
  const home = os.homedir();
  const list: string[] = [];
  if (process.env.SLEEPY_HOME) {
    list.push(path.join(process.env.SLEEPY_HOME, 'config', 'gateway.json'));
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  list.push(path.join(xdgConfig, 'sleepy', 'gateway.json'));
  list.push(path.join(home, '.sleepy', 'gateway.json'));
  return [...new Set(list)];
}

export const GATEWAY_FILE = gatewayCandidates()[0];

export interface GatewayConfig {
  access_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number;
  endpoint?: string;
  tier?: string;
  email?: string;
  dashboard_url?: string;
}

export interface SleepyModel {
  modelId: string;
  name: string;
  omniRouteModelId?: string;
  contextWindow?: number;
  maxOutputLimit?: number;
}

export function sleepyApiBase(dashboardUrl = SLEEPY_DASHBOARD_URL): string {
  return `${dashboardUrl}/api/v1`;
}

export function readGatewayConfig(): GatewayConfig | null {
  for (const candidate of gatewayCandidates()) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as GatewayConfig;
      if (parsed && typeof parsed === 'object' && (parsed.access_token || parsed.token)) {
        return parsed;
      }
    } catch { }
  }
  return null;
}

export async function writeGatewayConfig(config: GatewayConfig): Promise<void> {
  for (const file of gatewayCandidates()) {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmpPath = `${file}.tmp`;
      await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      await fsp.rename(tmpPath, file);
    } catch { }
  }
}

export async function clearGatewayConfig(): Promise<void> {
  for (const file of gatewayCandidates()) {
    await fsp.unlink(file).catch(() => { });
  }
}

function dashboardUrlOf(config: GatewayConfig | null): string {
  return config?.dashboard_url || SLEEPY_DASHBOARD_URL;
}

async function refreshToken(dashboardUrl: string, refreshTokenValue: string): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${dashboardUrl}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshTokenValue }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
      if (res.status === 401 || res.status === 403) return null;
    } catch {
      // network error — retry
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

export function getSleepyTokenSync(): string | null {
  const config = readGatewayConfig();
  return config?.access_token || config?.token || null;
}

export async function getSleepyToken(): Promise<string | null> {
  const config = readGatewayConfig();
  if (!config) return null;
  let token = config.access_token || config.token || null;
  if (!token) return null;

  const expiresAt = config.expires_at ?? 0;
  if (config.refresh_token && (Date.now() >= expiresAt || expiresAt - Date.now() < 10 * 60 * 1000)) {
    const refreshed = await refreshToken(dashboardUrlOf(config), config.refresh_token);
    if (refreshed) {
      token = refreshed.access_token;
      await writeGatewayConfig({
        ...config,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
      });
    }
  }
  return token;
}

export interface SleepyLimits {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerMinute?: number;
  tokensPerDay?: number;
  usedTokensToday?: number;
  cost5h?: number;
  limit5h?: number;
  cost24h?: number;
  limit24h?: number;
  costWeekly?: number;
  limitWeekly?: number;
  costMonthly?: number;
  limitMonthly?: number;
  rpmLimit?: number;
}

export interface SleepyBalances {
  credits?: number;
  currency?: string;
}

export interface SleepySubscription {
  plan?: string;
  status?: string;
  expiresAt?: number;
  monthlySpend?: number;
  monthlyLimit?: number;
}

export interface SleepyModelPrice {
  modelId: string;
  name: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  contextWindow?: number;
  maxOutputLimit?: number;
}

export interface SleepyAccount {
  loggedIn: boolean;
  email?: string;
  tier?: string;
  limits?: SleepyLimits;
  balances?: SleepyBalances;
  subscription?: SleepySubscription;
  modelPrices?: SleepyModelPrice[];
}

export function getSleepyAccount(): SleepyAccount {
  const config = readGatewayConfig();
  if (!config || !(config.access_token || config.token)) return { loggedIn: false };
  return { loggedIn: true, email: config.email, tier: config.tier };
}

export async function fetchSleepyDashboardUsage(token: string): Promise<{ limits?: SleepyLimits; balances?: SleepyBalances; subscription?: SleepySubscription } | null> {
  const dashboardUrl = dashboardUrlOf(readGatewayConfig());
  try {
    const res = await fetch(`${dashboardUrl}/api/usage?days=30`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!data || typeof data !== 'object') return null;

    const limits: SleepyLimits = {
      requestsPerMinute: typeof data.limits?.rpmLimit === 'number' ? data.limits.rpmLimit : undefined,
      requestsPerDay: typeof data.limits?.limit24h === 'number' ? data.limits.limit24h : undefined,
      usedTokensToday: typeof data.freeTokensToday === 'number' ? data.freeTokensToday : undefined,
      tokensPerDay: typeof data.freeTokenLimit === 'number' ? data.freeTokenLimit : undefined,
      cost5h: typeof data.usageByWindow?.cost5h === 'number' ? data.usageByWindow.cost5h : undefined,
      limit5h: typeof data.limits?.limit5h === 'number' ? data.limits.limit5h : undefined,
      cost24h: typeof data.usageByWindow?.cost24h === 'number' ? data.usageByWindow.cost24h : undefined,
      limit24h: typeof data.limits?.limit24h === 'number' ? data.limits.limit24h : undefined,
      costWeekly: typeof data.usageByWindow?.costWeekly === 'number' ? data.usageByWindow.costWeekly : undefined,
      limitWeekly: typeof data.limits?.limitWeekly === 'number' ? data.limits.limitWeekly : undefined,
      costMonthly: typeof data.usageByWindow?.costMonthly === 'number' ? data.usageByWindow.costMonthly : undefined,
      limitMonthly: typeof data.limits?.limitMonthly === 'number' ? data.limits.limitMonthly : undefined,
      rpmLimit: typeof data.limits?.rpmLimit === 'number' ? data.limits.rpmLimit : undefined,
    };

    const balances: SleepyBalances = {
      credits: typeof data.balanceUSD === 'number' ? Math.round(data.balanceUSD * 100) / 100 : undefined,
      currency: 'USD',
    };

    const subscription: SleepySubscription = {
      plan: typeof data.tier === 'string' ? data.tier : undefined,
      status: 'active',
      monthlySpend: typeof data.monthlyUsageUSD === 'number' ? Math.round(data.monthlyUsageUSD * 100) / 100 : undefined,
      monthlyLimit: typeof data.monthlyAllowanceUSD === 'number' ? data.monthlyAllowanceUSD : (typeof data.limits?.limitMonthly === 'number' ? data.limits.limitMonthly : undefined),
    };

    return { limits, balances, subscription };
  } catch {
    return null;
  }
}

export async function fetchSleepyAccountData(token: string): Promise<Pick<SleepyAccount, 'limits' | 'balances' | 'subscription' | 'modelPrices'>> {
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

export async function fetchSleepyModelPrices(token: string): Promise<SleepyModelPrice[]> {
  const dashboardUrl = dashboardUrlOf(readGatewayConfig());
  const parseNum = (val: unknown): number | undefined =>
    typeof val === 'number' ? val : (typeof val === 'string' && !isNaN(Number(val)) ? Number(val) : undefined);
  const parseModels = (arr: unknown[]): SleepyModelPrice[] => {
    return arr
      .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === 'object' && (typeof (model as any).modelId === 'string' || typeof (model as any).id === 'string' || typeof (model as any).omniRouteModelId === 'string')))
      .map(model => {
        const rawId = (model.omniRouteModelId || model.modelId || model.id) as string;
        const modelId = typeof rawId === 'string' ? rawId.replace(/^models\//, '') : '';
        const name = typeof model.name === 'string' ? model.name : modelId;
        return {
          modelId,
          name,
          inputPrice: parseNum(model.inputPrice ?? model.input_price),
          outputPrice: parseNum(model.outputPrice ?? model.output_price),
          cacheReadPrice: parseNum(model.cacheReadPrice ?? model.cache_read_price),
          cacheWritePrice: parseNum(model.cacheWritePrice ?? model.cache_write_price),
          contextWindow: parseNum(model.contextWindow ?? model.context_window),
          maxOutputLimit: parseNum(model.maxOutputLimit ?? model.max_output_limit),
        };
      });
  };

  try {
    const response = await fetch(`${sleepyApiBase(dashboardUrl)}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { data?: unknown[] } | unknown[] | null;
      const rawData = Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray((body as any).data) ? (body as any).data : null);
      if (Array.isArray(rawData) && rawData.length) {
        const prices = parseModels(rawData);
        if (prices.length) return prices;
      }
    }
  } catch { }

  try {
    const responseAlt = await fetch(`${dashboardUrl}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (responseAlt.ok) {
      const body = (await responseAlt.json().catch(() => null)) as { data?: unknown[] } | unknown[] | null;
      const rawData = Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray((body as any).data) ? (body as any).data : null);
      if (Array.isArray(rawData) && rawData.length) {
        return parseModels(rawData);
      }
    }
  } catch { }

  return [];
}

let codeResolver: ((code: string) => void) | null = null;
let codePromise: Promise<string> | null = null;

function waitForCode(): Promise<string> {
  if (!codePromise) {
    codePromise = new Promise<string>(resolve => {
      codeResolver = resolve;
    });
  }
  return codePromise;
}

function listen(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#10b981">Login Successful</h1><p>You can close this window and return to SleepyCode.</p></div></body></html>');
          codeResolver?.(code);
          codeResolver = null;
          codePromise = null;
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:sans-serif"><h1 style="color:#ef4444">Login Failed</h1><p>No authorization code received.</p></body></html>');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function startLoginServer(): Promise<{ server: http.Server; port: number }> {
  try {
    const server = await listen(LOGIN_PORT);
    return { server, port: LOGIN_PORT };
  } catch {
    const server = await listen(0);
    const address = server.address();
    return { server, port: typeof address === 'object' && address ? address.port : LOGIN_PORT };
  }
}

function buildAuthorizeUrl(dashboardUrl: string, port: number): string {
  const params = new URLSearchParams({
    client_id: 'sleepy-cli',
    redirect_uri: `http://localhost:${port}/callback`,
    response_type: 'code',
  });
  return `${dashboardUrl}/api/auth/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code: string, dashboardUrl: string): Promise<GatewayConfig> {
  const response = await fetch(`${dashboardUrl}/api/auth/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, client_id: 'sleepy-cli' }),
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.statusText}`);
  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in?: number; endpoint?: string; tier?: string; email?: string };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    endpoint: data.endpoint,
    tier: data.tier,
    email: data.email,
    dashboard_url: dashboardUrl,
  };
}

export async function loginWithBrowser(onStatus?: (text: string) => void): Promise<SleepyAccount> {
  const dashboardUrl = dashboardUrlOf(readGatewayConfig());
  const { server, port } = await startLoginServer();
  const authorizeUrl = buildAuthorizeUrl(dashboardUrl, port);
  onStatus?.(`Waiting for browser authorization at ${authorizeUrl}`);
  try { await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl)); } catch { /* user can open manually */ }
  const code = await waitForCode();
  server.close();
  onStatus?.('Exchanging code for token…');
  const config = await exchangeCodeForToken(code, dashboardUrl);
  await writeGatewayConfig(config);
  return getSleepyAccount();
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
}

export async function loginWithDevice(onStatus?: (text: string) => void): Promise<SleepyAccount> {
  const dashboardUrl = dashboardUrlOf(readGatewayConfig());
  const res = await fetch(`${dashboardUrl}/api/auth/oauth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'sleepy-cli' }),
  });
  if (!res.ok) throw new Error('Failed to start device login.');
  const device = (await res.json()) as DeviceCodeResponse;
  onStatus?.(`Open ${device.verification_uri_complete} and enter code ${device.user_code}`);
  try { await vscode.env.openExternal(vscode.Uri.parse(device.verification_uri_complete)); } catch { /* user can open manually */ }

  const pollMs = (device.interval || 5) * 1000;
  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const tokenRes = await fetch(`${dashboardUrl}/api/auth/oauth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: 'sleepy-cli' }),
    });
    if (tokenRes.ok) {
      const data = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in?: number; endpoint?: string; tier?: string; email?: string };
      await writeGatewayConfig({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
        endpoint: data.endpoint,
        tier: data.tier,
        email: data.email,
        dashboard_url: dashboardUrl,
      });
      return getSleepyAccount();
    }
    let code = '';
    try {
      const body = (await tokenRes.json()) as { error?: string };
      code = body.error ?? '';
    } catch {
      code = 'server_error';
    }
    if (code === 'authorization_pending' || code === 'slow_down') continue;
    if (code === 'expired_token') throw new Error('Login expired. Please try again.');
    if (code === 'access_denied') throw new Error('Login denied.');
    throw new Error(code ? `Login failed: ${code}` : `Login failed (HTTP ${tokenRes.status}).`);
  }
}

export interface SleepyModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputLimit?: number;
  recommended?: boolean;
}

export async function fetchSleepyModels(token: string): Promise<SleepyModelInfo[]> {
  const dashboardUrl = dashboardUrlOf(readGatewayConfig());
  const parseList = (arr: unknown[]): SleepyModelInfo[] => {
    return arr
      .filter((model): model is Record<string, unknown> => Boolean(model && typeof model === 'object' && (typeof (model as any).modelId === 'string' || typeof (model as any).id === 'string' || typeof (model as any).omniRouteModelId === 'string')))
      .map(model => {
        const rawId = (model.omniRouteModelId || model.modelId || model.id) as string;
        const id = typeof rawId === 'string' ? rawId.replace(/^models\//, '') : '';
        const name = typeof model.name === 'string' ? model.name : id;
        const numberField = (...keys: string[]): number | undefined => {
          for (const key of keys) {
            const value = model[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
          }
          return undefined;
        };
        const recommended = model.recommended === true || model.default === true || model.isDefault === true || model.is_default === true;
        return { id, name, contextWindow: numberField('contextWindow', 'context_window', 'context_length'), maxOutputLimit: numberField('maxOutputLimit', 'max_output_limit', 'max_output_tokens'), recommended };
      })
      .filter(m => Boolean(m.id));
  };

  try {
    const response = await fetch(`${sleepyApiBase(dashboardUrl)}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { data?: unknown[] } | unknown[] | null;
      const rawData = Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray((body as any).data) ? (body as any).data : null);
      if (Array.isArray(rawData) && rawData.length) {
        const list = parseList(rawData);
        if (list.length) return list;
      }
    }
  } catch { }

  try {
    const responseAlt = await fetch(`${dashboardUrl}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (responseAlt.ok) {
      const body = (await responseAlt.json().catch(() => null)) as { data?: unknown[] } | unknown[] | null;
      const rawData = Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray((body as any).data) ? (body as any).data : null);
      if (Array.isArray(rawData) && rawData.length) {
        return parseList(rawData);
      }
    }
  } catch { }

  return [];
}
