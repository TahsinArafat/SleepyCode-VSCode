import * as path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type ViewportName = 'mobile' | 'tablet' | 'laptop' | 'desktop';

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export const VIEWPORTS: Record<ViewportName, Viewport> = {
  mobile: { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { name: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  laptop: { name: 'laptop', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  desktop: { name: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

export function pickViewport(name?: string): Viewport {
  const key = (name || 'laptop').toLowerCase() as ViewportName;
  return VIEWPORTS[key] ?? VIEWPORTS.laptop;
}

export interface ConsoleMessage {
  type: 'error' | 'warning' | 'log' | 'info' | 'debug';
  text: string;
  location?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  failed: boolean;
  errorText?: string;
  resourceType?: string;
  durationMs?: number;
}

export function summarizeConsoleErrors(messages: ConsoleMessage[]): { errors: ConsoleMessage[]; warnings: ConsoleMessage[] } {
  const errors: ConsoleMessage[] = [];
  const warnings: ConsoleMessage[] = [];
  for (const message of messages) {
    if (message.type === 'error') errors.push(message);
    else if (message.type === 'warning') warnings.push(message);
  }
  return { errors, warnings };
}

export function summarizeNetworkErrors(requests: NetworkRequest[]): NetworkRequest[] {
  return requests.filter((r) => r.failed || r.status >= 400);
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResponsiveGeometry {
  viewport: Viewport;
  documentWidth: number;
  documentHeight: number;
  scrollWidth: number;
  horizontalOverflow: boolean;
  elements: { selector: string; box: ElementBox }[];
  offscreen: string[];
}

export function analyzeGeometry(viewport: Viewport, documentWidth: number, scrollWidth: number, elements: { selector: string; box: ElementBox }[]): ResponsiveGeometry {
  const offscreen: string[] = [];
  for (const element of elements) {
    const { box } = element;
    if (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) offscreen.push(element.selector);
  }
  return { viewport, documentWidth, documentHeight: 0, scrollWidth, horizontalOverflow: scrollWidth > viewport.width + 1, elements, offscreen };
}

export interface BrowserSessionOptions {
  url: string;
  viewport?: ViewportName;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  screenshotPath?: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  dom: string;
  accessibility: unknown;
  console: ConsoleMessage[];
  network: NetworkRequest[];
  geometry?: ResponsiveGeometry;
}

export class BrowserError extends Error {
  readonly installHint?: string;
  constructor(message: string, installHint?: string) {
    super(message);
    this.name = 'BrowserError';
    this.installHint = installHint;
  }
}

interface BrowserLaunchCandidate {
  name: string;
  engine: 'chromium' | 'firefox';
  /** Branded channel resolved by Playwright itself (chrome / msedge). */
  channel?: string;
  /** Absolute path to a system browser binary; skipped when the file is absent. */
  executablePath?: string;
}

/** Known install locations for system browsers per OS. */
export function systemBrowserPaths(): { brave: string[]; firefox: string[] } {
  const localAppData = process.env.LOCALAPPDATA ?? 'C:\\Users\\Default\\AppData\\Local';
  switch (process.platform) {
    case 'darwin':
      return {
        brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
        firefox: [
          '/Applications/Firefox.app/Contents/MacOS/firefox',
          '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
          '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
        ],
      };
    case 'win32':
      return {
        brave: [
          'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
          `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        ],
        firefox: [
          'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
          'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
          `${localAppData}\\Mozilla Firefox\\firefox.exe`,
        ],
      };
    default:
      return {
        brave: ['/usr/bin/brave-browser', '/snap/bin/brave'],
        firefox: ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox'],
      };
  }
}

/** Ordered browser launch chain: bundled engines, Playwright channels, then system binaries. */
export function browserLaunchCandidates(): BrowserLaunchCandidate[] {
  const paths = systemBrowserPaths();
  return [
    { name: 'Playwright Chromium', engine: 'chromium' },
    { name: 'Google Chrome', engine: 'chromium', channel: 'chrome' },
    { name: 'Microsoft Edge', engine: 'chromium', channel: 'msedge' },
    { name: 'Playwright Firefox', engine: 'firefox' },
    ...paths.brave.map(executablePath => ({ name: 'Brave', engine: 'chromium' as const, executablePath })),
    ...paths.firefox.map(executablePath => ({ name: 'Firefox', engine: 'firefox' as const, executablePath })),
  ];
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/** Largest evaluate()/snapshot output we send to the model (matches the DOM cap). */
export const BROWSER_RESULT_CAP = 20_000;

/** Resolve a tab target (numeric index, or URL/title substring) to a tab index. -1 = no match, -2 = ambiguous. */
export function findTabIndex(tabs: { url: string; title: string }[], target: number | string): number {
  if (typeof target === 'number') {
    return Number.isInteger(target) && target >= 0 && target < tabs.length ? target : -1;
  }
  const query = String(target).trim().toLowerCase();
  if (!query) return -1;
  const matches: number[] = [];
  tabs.forEach((tab, index) => {
    if (tab.url.toLowerCase().includes(query) || tab.title.toLowerCase().includes(query)) matches.push(index);
  });
  if (!matches.length) return -1;
  if (matches.length > 1) return -2;
  return matches[0]!;
}

/** Resolve a frame target (numeric frame index or URL substring) to a frame index. -1 = no match, -2 = ambiguous. */
export function findFrameIndex(frames: { url: string }[], target: string): number {
  if (/^\d+$/.test(target)) {
    const index = Number(target);
    return Number.isInteger(index) && index >= 0 && index < frames.length ? index : -1;
  }
  const query = target.trim().toLowerCase();
  if (!query) return -1;
  const matches: number[] = [];
  frames.forEach((frame, index) => {
    if (frame.url.toLowerCase().includes(query)) matches.push(index);
  });
  if (!matches.length) return -1;
  if (matches.length > 1) return -2;
  return matches[0]!;
}

/** Safely stringify an evaluate() result for tool output, capped with a truncation marker. */
export function stringifyEvalResult(value: unknown, cap = BROWSER_RESULT_CAP): string {
  let text: string;
  if (value === undefined) text = 'undefined';
  else {
    try {
      const json = JSON.stringify(value, null, 2);
      text = json === undefined ? String(value) : json;
    } catch {
      text = typeof value === 'object' && value !== null ? '<unserializable>' : String(value);
    }
  }
  return text.length > cap ? `${text.slice(0, cap)}\n…(truncated)` : text;
}

type PageLike = any;
type BrowserLike = any;

export class BrowserController {
  private browser: BrowserLike | undefined;
  /** The ACTIVE page; every interaction targets this one. */
  private page: PageLike | undefined;
  /** Controller-owned mirror of all open tabs; `browser.pages()` ordering is not trusted. */
  private pages: PageLike[] = [];
  /** Per-tab evidence so one tab's console/network never leaks into another tab's snapshot. */
  private logs = new Map<PageLike, { console: ConsoleMessage[]; network: NetworkRequest[] }>();
  private capturingConsole = false;
  private capturingNetwork = false;
  private resolvedViewport: Viewport | undefined;

  get consoleMessages(): ConsoleMessage[] {
    return [...this.activeLog().console];
  }
  get networkRequests(): NetworkRequest[] {
    return [...this.activeLog().network];
  }

  private requirePage(): PageLike {
    if (!this.page) throw new BrowserError('No active browser session.');
    return this.page;
  }

  private activeLog(): { console: ConsoleMessage[]; network: NetworkRequest[] } {
    const entry = this.page ? this.logs.get(this.page) : undefined;
    return entry ?? { console: [], network: [] };
  }

  private wirePage(page: PageLike): void {
    const entry = { console: [] as ConsoleMessage[], network: [] as NetworkRequest[] };
    this.logs.set(page, entry);
    if (this.capturingConsole) {
      page.on('console', (msg: any) => {
        const type = msg.type() as ConsoleMessage['type'];
        if (type === 'error' || type === 'warning' || type === 'log') entry.console.push({ type, text: msg.text() });
      });
      page.on('pageerror', (err: any) => {
        entry.console.push({ type: 'error', text: String(err?.message ?? err) });
      });
    }
    if (this.capturingNetwork) {
      page.on('requestfailed', (req: any) => {
        entry.network.push({ url: req.url(), method: req.method(), status: 0, failed: true, errorText: req.failure()?.errorText, resourceType: req.resourceType() });
      });
      page.on('response', (res: any) => {
        entry.network.push({ url: res.url(), method: res.request().method(), status: res.status(), failed: false, resourceType: res.request().resourceType() });
      });
    }
  }

  private async loadPlaywright(): Promise<any> {
    // Playwright is an optional runtime dependency; playwright-core is bundled
    // with the extension so system browsers work out of the box.
    for (const moduleName of ['playwright', 'playwright-core']) {
      try {
        return await import(moduleName);
      } catch { /* try the next driver */ }
    }
    throw new BrowserError('No browser driver is available.', 'Install Chrome, Edge, Brave, or Firefox, then reinstall this extension.');
  }

  /** Resolve a frame target against a FRESH page.frames() snapshot (frames go stale on reload). */
  private frameFor(page: PageLike, target: string): any {
    const frames: any[] = (page.frames() as any[]) ?? [];
    const index = findFrameIndex(frames.map(frame => ({ url: frame.url() })), target);
    if (index === -1) throw new BrowserError(`No iframe matches "${target}".`);
    if (index === -2) throw new BrowserError(`"${target}" matches multiple iframes; use a frame index. Frames: ${frames.map((frame, i) => `${i}:${frame.url()}`).join(', ')}`);
    return frames[index];
  }

  async launch(options: BrowserSessionOptions): Promise<void> {
    const pw = await this.loadPlaywright();
    const viewport = pickViewport(options.viewport);
    this.resolvedViewport = viewport;
    this.pages = [];
    this.logs.clear();
    this.page = undefined;
    // Deterministic bundled Chromium first, then progressively fall back to
    // system browsers so the tools work without any Playwright browser install.
    const candidates = browserLaunchCandidates();
    let lastError: unknown;
    const tried: string[] = [];
    for (const candidate of candidates) {
      if (candidate.executablePath && !existsSync(candidate.executablePath)) continue;
      tried.push(candidate.name);
      const engine = candidate.engine === 'firefox' ? pw.firefox : pw.chromium;
      try {
        this.browser = await engine.launch({
          headless: true,
          ...(candidate.channel ? { channel: candidate.channel } : {}),
          ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.browser) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new BrowserError(`Could not launch any browser${tried.length ? ` (tried ${tried.join(', ')})` : ''}: ${detail}`, 'Install Google Chrome, Microsoft Edge, Brave, or Firefox, or run `npx playwright install chromium`.');
    }
    this.capturingConsole = options.captureConsole ?? true;
    this.capturingNetwork = options.captureNetwork ?? true;
    this.page = await this.browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
    });
    this.pages = [this.page];
    this.wirePage(this.page);
    await this.page.goto(options.url, { waitUntil: options.waitUntil ?? 'load', timeout: options.timeoutMs ?? 30_000 });
  }

  async snapshot(frame?: string): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const target = frame ? this.frameFor(page, frame) : undefined;
    const dom = target ? await target.content() : await page.content();
    let accessibility: unknown = null;
    try {
      if (target) accessibility = await target.locator('body').ariaSnapshot();
      else accessibility = page.accessibility?.snapshot ? await page.accessibility.snapshot() : await page.locator('body').ariaSnapshot();
    } catch {
      accessibility = null;
    }
    const title = target ? target.url() : await page.title(); // frames expose a URL, not a title
    const url = target ? target.url() : page.url();
    return { url, title, dom, accessibility, console: [...this.activeLog().console], network: [...this.activeLog().network] };
  }

  async click(selector: string, frame?: string): Promise<void> {
    const page = this.requirePage();
    const root = frame ? this.frameFor(page, frame) : page;
    await root.locator(selector).first().click({ timeout: 10_000 });
  }

  async navigate(url: string): Promise<void> {
    const page = this.requirePage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  }

  async type(selector: string, text: string, options: { clear?: boolean; delayMs?: number } = {}, frame?: string): Promise<void> {
    const page = this.requirePage();
    const root = frame ? this.frameFor(page, frame) : page;
    const locator = root.locator(selector).first();
    await locator.click({ timeout: 10_000 });
    if (options.clear ?? true) {
      await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await locator.press('Backspace');
    }
    await locator.pressSequentially(text, { delay: Math.min(250, Math.max(0, options.delayMs ?? 24)), timeout: 30_000 });
  }

  async press(key: string, selector?: string, frame?: string): Promise<void> {
    const page = this.requirePage();
    if (selector) {
      const root = frame ? this.frameFor(page, frame) : page;
      const locator = root.locator(selector).first();
      await locator.focus({ timeout: 10_000 });
      await locator.press(key, { timeout: 10_000 });
    } else {
      if (frame) throw new BrowserError('A frame was given without a selector; pass a selector to press a key inside an iframe.');
      await page.keyboard.press(key);
    }
  }

  async evaluate<T = unknown>(expr: string, frame?: string): Promise<T> {
    const page = this.requirePage();
    const target = frame ? this.frameFor(page, frame) : page;
    return target.evaluate(expr);
  }

  async wait(selector: string | undefined, state: 'visible' | 'hidden' | 'attached' | 'detached' = 'visible', timeoutMs = 10_000, ms?: number): Promise<string> {
    const page = this.requirePage();
    if (ms !== undefined) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
      return `Waited ${ms}ms.`;
    }
    if (!selector) throw new BrowserError('browser_wait needs either ms or selector.');
    try {
      await page.locator(selector).waitFor({ state, timeout: timeoutMs });
    } catch {
      throw new BrowserError(`Timed out waiting for "${selector}" (state=${state}) after ${timeoutMs}ms.`);
    }
    return `Ready: "${selector}" (state=${state}).`;
  }

  private async historyCommand(method: 'goBack' | 'goForward' | 'reload', options: { waitUntil?: 'load' | 'domcontentloaded'; timeoutMs?: number }): Promise<{ ok: boolean; url: string; reason?: string }> {
    const page = this.requirePage();
    const before = page.url();
    const result = await (page as any)[method]({ waitUntil: options.waitUntil ?? 'load', timeout: options.timeoutMs ?? 30_000 });
    const after = page.url();
    // goBack/goForward return null when nothing to navigate to, but can also return
    // null after a REAL navigation (e.g. about:blank) — judge by whether the URL moved.
    // reload() can also resolve without a Response (data: URLs) yet still reload the document.
    if (method !== 'reload' && result === null && before === after) return { ok: false, url: after, reason: 'no history' };
    return { ok: true, url: after };
  }

  async back(options: { waitUntil?: 'load' | 'domcontentloaded'; timeoutMs?: number } = {}): Promise<{ ok: boolean; url: string; reason?: string }> {
    return this.historyCommand('goBack', options);
  }

  async forward(options: { waitUntil?: 'load' | 'domcontentloaded'; timeoutMs?: number } = {}): Promise<{ ok: boolean; url: string; reason?: string }> {
    return this.historyCommand('goForward', options);
  }

  async reload(options: { waitUntil?: 'load' | 'domcontentloaded'; timeoutMs?: number } = {}): Promise<{ ok: boolean; url: string; reason?: string }> {
    return this.historyCommand('reload', options);
  }

  private async tabInfo(index: number, page: PageLike): Promise<TabInfo> {
    return { index, url: await page.url(), title: await page.title(), active: page === this.page };
  }

  async newTab(url?: string): Promise<TabInfo> {
    this.requirePage();
    if (!this.browser) throw new BrowserError('No active browser session.');
    const viewport = this.resolvedViewport;
    const created = await this.browser.newPage({
      viewport: viewport ? { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch } : undefined,
    });
    this.wirePage(created);
    this.pages.push(created);
    this.page = created;
    if (url) await created.goto(url, { waitUntil: 'load', timeout: 30_000 });
    return this.tabInfo(this.pages.length - 1, created);
  }

  async listTabs(): Promise<TabInfo[]> {
    this.requirePage();
    return Promise.all(this.pages.map((page, index) => this.tabInfo(index, page)));
  }

  async switchTab(target: number | string): Promise<TabInfo> {
    this.requirePage();
    const tabs = await this.listTabs();
    const index = findTabIndex(tabs, target);
    if (index === -1) throw new BrowserError(`No tab matches "${target}".`);
    if (index === -2) throw new BrowserError(`"${target}" matches multiple tabs; use an index.`);
    this.page = this.pages[index]!;
    return tabs[index]!;
  }

  async closeTab(): Promise<TabInfo[]> {
    this.requirePage();
    if (this.pages.length <= 1) throw new BrowserError('Cannot close the last tab; use browser_close to end the session.');
    const closing = this.page!;
    const index = this.pages.indexOf(closing);
    await closing.close().catch(() => undefined);
    this.pages.splice(index, 1);
    this.logs.delete(closing);
    const nextIndex = Math.max(0, Math.min(index, this.pages.length - 1));
    this.page = this.pages[nextIndex];
    return this.listTabs();
  }

  async scroll(selector?: string, deltaY?: number, frame?: string): Promise<string> {
    const page = this.requirePage();
    const root = frame ? this.frameFor(page, frame) : page;
    if (selector) {
      await root.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
      if (deltaY) await root.evaluate((offset: number) => window.scrollBy(0, offset), deltaY);
      return `Scrolled to "${selector}".`;
    }
    if (deltaY !== undefined) {
      await root.evaluate((offset: number) => window.scrollBy(0, offset), deltaY);
      return `Scrolled ${deltaY}px.`;
    }
    throw new BrowserError('browser_scroll needs either selector or deltaY.');
  }

  async collectGeometry(viewportName?: ViewportName): Promise<ResponsiveGeometry> {
    const page = this.requirePage();
    const viewport = pickViewport(viewportName);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const data = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const sample = els
        .filter((el: any) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.id;
        })
        .slice(0, 200)
        .map((el: any) => {
          const r = el.getBoundingClientRect();
          return { selector: `#${el.id}`, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
        });
      return { documentWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, elements: sample };
    });
    return analyzeGeometry(viewport, data.documentWidth, data.scrollWidth, data.elements);
  }

  async screenshot(targetPath: string): Promise<string> {
    const page = this.requirePage();
    const resolved = targetPath.endsWith('.png') ? targetPath : `${targetPath}.png`;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await page.screenshot({ path: resolved, fullPage: true });
    return resolved;
  }

  async previewDataUrl(): Promise<string> {
    const page = this.requirePage();
    const image = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false, scale: 'css' });
    return `data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`;
  }

  async cursorPoint(selector: string): Promise<{ x: number; y: number } | undefined> {
    const page = this.requirePage();
    const box = await page.locator(selector).first().boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport?.width || !viewport.height) return undefined;
    return { x: Math.min(1, Math.max(0, (box.x + box.width / 2) / viewport.width)), y: Math.min(1, Math.max(0, (box.y + box.height / 2) / viewport.height)) };
  }

  get active(): boolean {
    return Boolean(this.page);
  }

  static fileUrl(localPath: string): string {
    return pathToFileURL(localPath).href;
  }

  async close(): Promise<void> {
    await this.browser?.close?.().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
    this.pages = [];
    this.logs.clear();
  }
}
