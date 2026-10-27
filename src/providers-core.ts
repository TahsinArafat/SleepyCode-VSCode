/*
 * The provider rows behind the settings window's Providers page.
 *
 * SleepyCode has one first-party provider (SleepyAI) plus optional compatibility
 * endpoints the user adds. The React settings window had no provider surface at
 * all, so adding an endpoint or setting its key was impossible.
 *
 * Two boundaries are load-bearing:
 *
 *   - the canonical SleepyAI provider cannot be removed or replaced. The product is
 *     built around it, and a settings payload must not be able to delete the
 *     first-party route.
 *   - a key never goes back to the page. The host holds it in secret storage; the
 *     page only learns whether one exists and its last few characters, so a
 *     credential cannot be read out of the webview.
 */

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  isSleepy?: boolean;
  modelList?: string[];
  customHeaders?: Record<string, string>;
}

export interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  isSleepy: boolean;
  active: boolean;
  hasKey: boolean;
  /** The tail of the stored key, or '' when there is none. */
  keyHint: string;
}

/** The visible tail of a key. Short keys reveal nothing. */
export function keyHint(key: string | undefined): string {
  const value = typeof key === 'string' ? key : '';
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Trim and strip trailing slashes: two spellings of one endpoint are one endpoint. */
export function normalizeBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

/** First-party first, then whatever order the user's endpoints were added in. */
export function providerRows(input: {
  providers: readonly unknown[] | undefined;
  keys: Record<string, string | undefined> | undefined;
  activeId: string | undefined;
}): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const entry of input.providers ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const provider = entry as Partial<ProviderConfig>;
    if (typeof provider.id !== 'string' || !provider.id) continue;
    if (typeof provider.name !== 'string' || !provider.name) continue;
    const key = input.keys?.[provider.id];
    rows.push({
      id: provider.id,
      name: provider.name,
      baseUrl: normalizeBaseUrl(provider.baseURL),
      models: Array.isArray(provider.modelList) ? provider.modelList.filter(model => typeof model === 'string' && model) : [],
      isSleepy: provider.isSleepy === true,
      active: provider.id === input.activeId,
      hasKey: Boolean(key),
      keyHint: keyHint(key),
    });
  }
  // Sort is stable, so the user's own order survives.
  return rows.sort((a, b) => Number(b.isSleepy) - Number(a.isSleepy));
}

/** The first-party provider stays; everything else can go. */
export function canRemoveProvider(row: ProviderRow | undefined): boolean {
  return Boolean(row) && row!.isSleepy !== true;
}

export interface ProviderDraft {
  id?: string;
  name?: string;
  baseURL?: string;
  models?: string;
  isSleepy?: boolean;
}

/**
 * A validation message, or null when the draft is usable.
 *
 * Plain http is refused because the API key travels on every request: sending it
 * in clear text is worse than not supporting the endpoint. Loopback is the
 * exception — a local model server cannot offer TLS.
 */
export function validateProviderDraft(draft: ProviderDraft | undefined): string | null {
  const name = typeof draft?.name === 'string' ? draft.name.trim() : '';
  if (!name) return 'Give the endpoint a name.';
  const base = normalizeBaseUrl(draft?.baseURL);
  if (!base) return 'Enter the endpoint URL, for example https://example.com/v1.';
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return 'Enter a valid URL, for example https://example.com/v1.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The URL must start with https://.';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) return 'Use https:// — an API key must not travel in clear text.';
  if (url.username || url.password) return 'Remove the credentials from the URL; enter the key separately.';
  return null;
}

/** Parse the single text box people type model ids into. */
export function parseModelList(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : '';
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const model = part.trim();
    if (model) seen.add(model);
  }
  return [...seen];
}

/**
 * Build the provider to save.
 *
 * An edit keeps its id, because the API key is stored against it — minting a new
 * one would silently orphan the key.
 */
export function providerFromDraft(draft: ProviderDraft): ProviderConfig {
  const name = typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : 'Endpoint';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
  const id = typeof draft.id === 'string' && draft.id ? draft.id : slug;
  const provider: ProviderConfig = { id, name, baseURL: normalizeBaseUrl(draft.baseURL) };
  if (draft.isSleepy) provider.isSleepy = true;
  const models = parseModelList(draft.models);
  if (models.length) provider.modelList = models;
  return provider;
}