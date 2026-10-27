/*
 * Load the real, built sidebar bundle in a real browser.
 *
 * Every UI bug reported against the React chat is webview code, and the webview
 * only needs three things from VS Code: `acquireVsCodeApi`, a `message` event in,
 * and `postMessage` out. That is small enough to stand in for, so a bug can be
 * reproduced and re-tested without launching an editor:
 *
 *   import { openSidebar } from './webview-harness.mjs';
 *   const app = await openSidebar();
 *   await app.boot();                       // the host's opening payload
 *   await app.click('.tab:nth-child(2)');
 *   console.log(await app.sent());          // what the webview posted
 *   await app.shot('/tmp/tabs.png');        // and what it looked like
 *
 * Requires `npm run build` first: it loads `dist/webview/sidebar.{js,css}`, so it
 * always exercises the same bundle the extension ships.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A conversation summary as the host posts it. */
export function conversation(id, title, extra = {}) {
  return { id, title, updatedAt: Date.now(), archived: false, pinned: false, hasMessages: true, messageCount: 2, status: 'done', running: false, ...extra };
}

/** A transcript item pair, so a conversation has something to render. */
export function turns(text) {
  return [
    { role: 'user', text: `${text} request` },
    { role: 'assistant', blocks: [{ kind: 'text', text: `${text} answer` }] },
  ];
}

export async function openSidebar({ width = 460, height = 820, headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage({ viewport: { width, height } });

  const css = readFileSync(path.join(root, 'dist/webview/sidebar.css'), 'utf8');
  const js = readFileSync(path.join(root, 'dist/webview/sidebar.js'), 'utf8');
  await page.setContent(`<!doctype html><html data-theme="dark" class="vscode-dark" style="--vscode-font-family: system-ui"><head><style>${css}</style></head><body class="vscode-dark"><div id="root"></div></body></html>`);
  // The three things the webview needs from its host. Injected as a script tag
  // rather than an init script: `setContent` reuses the document, so an init
  // script never runs and the bundle dies on `acquireVsCodeApi is not defined`.
  await page.addScriptTag({
    content: `window.__sent = []; window.__state = undefined;
      window.acquireVsCodeApi = function () {
        return {
          postMessage: function (message) { window.__sent.push(message); },
          getState: function () { return window.__state; },
          setState: function (state) { window.__state = state; },
        };
      };`,
  });
  await page.addScriptTag({ content: js });
  await page.waitForSelector('#root > *', { timeout: 10_000 });

  const app = {
    page,
    browser,

    /** Post one host -> webview message and let React commit. */
    async send(message, settle = 60) {
      await page.evaluate((m) => window.postMessage(m, '*'), message);
      await page.waitForTimeout(settle);
      return app;
    },

    /** Everything the webview has posted since the last call, and clear it. */
    async sent() {
      return page.evaluate(() => window.__sent.splice(0));
    },

    async click(selector, settle = 80) {
      await page.click(selector);
      await page.waitForTimeout(settle);
      return app;
    },

    async exists(selector) {
      return (await page.$(selector)) !== null;
    },

    async text(selector) {
      return page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
    },

    async count(selector) {
      return page.evaluate((s) => document.querySelectorAll(s).length, selector);
    },

    /** The opening payload the host sends on `ready`. */
    async boot({
      activeId,
      conversations = [],
      mode = 'agent',
      selectedModel = 'test-model',
      workspaceRoot = '/tmp/workspace',
      usedTokens = 0,
      sessionStats,
      /** Tabs the host restored from workspace storage. */
      openTabs = conversations.map((entry) => entry.id),
    } = {}) {
      const active = conversations.find((entry) => entry.id === activeId);
      await app.send({
        type: 'initialState',
        mode,
        selectedModel,
        activeId,
        turns: active ? turns(active.title) : [],
        personas: [],
        activePersonaId: '',
        hasProviders: true,
        usedTokens,
        workspaceRoot,
        workspaceState: { openTabs, drafts: {} },
        approvalPolicy: 'ask',
        reasoningEffort: 'medium',
        reasoningEfforts: [{ id: 'low', label: 'Low', hint: 'Faster' }, { id: 'medium', label: 'Medium', hint: 'Balanced' }, { id: 'high', label: 'High', hint: 'Slower' }],
      }, 140);
      await app.send({ type: 'configState', personas: [], activePersonaId: '', hasProviders: true, approvalPolicy: 'ask' });
      await app.send({ type: 'modelsFetched', models: [selectedModel] });
      if (conversations.length) {
        await app.send({ type: 'conversations', list: conversations, activeId, runningConvIds: [] });
        await app.send({ type: 'loadConversation', activeId, turns: active ? turns(active.title) : [], usedTokens, running: false, workspaceRoot });
      }
      if (sessionStats) await app.send({ type: 'sessionStats', ...sessionStats });
      await app.sent();
      return app;
    },

    async shot(file) {
      await page.screenshot({ path: file, fullPage: false });
      return file;
    },

    async close() {
      await browser.close();
    },
  };

  return app;
}