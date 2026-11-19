import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vscode } from "../../shared/vscode";
import { ProviderKeysPanel } from "./ProviderKeysPanel";

/*
 * The Providers page's Add/Edit form.
 *
 * Two gaps were reported together: no API key field, and no advanced options. Both
 * were in this dialog — adding an endpoint and giving it a key were separate steps, so
 * a saved endpoint that could not authenticate looked like a broken provider rather
 * than an unfinished setup.
 */

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;

const row = (over: Record<string, unknown> = {}) => ({
  id: "acme", name: "Acme", baseUrl: "https://acme.test/v1", models: ["gpt-4o"],
  isSleepy: false, active: false, hasKey: true, keyHint: "••••cdef", ...over,
});

function render(providers: unknown[] = []) {
  act(() => root.render(<ProviderKeysPanel providers={providers as never} />));
}
function button(label: string | RegExp): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => (typeof label === "string" ? candidate.textContent?.trim() === label : label.test(candidate.textContent ?? "")));
  if (!match) throw new Error(`no button matching ${String(label)}`);
  return match;
}
function click(label: string | RegExp) { act(() => button(label).click()); }
function type(placeholder: string | RegExp, value: string) {
  const field = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .find(candidate => (typeof placeholder === "string" ? candidate.placeholder === placeholder : placeholder.test(candidate.placeholder)));
  if (!field) throw new Error(`no field with placeholder ${String(placeholder)}`);
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function field(placeholder: string | RegExp) {
  const match = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .find(candidate => (typeof placeholder === "string" ? candidate.placeholder === placeholder : placeholder.test(candidate.placeholder)));
  if (!match) throw new Error(`no field with placeholder ${String(placeholder)}`);
  return match;
}
function apiKeyField() {
  const match = container.querySelector<HTMLInputElement>('input[aria-label="API key"], input[type="password"]');
  if (!match) throw new Error("no API key field");
  return match;
}
function saved() {
  return vi.mocked(vscode.postMessage).mock.calls
    .map(([message]) => message as { type?: string; draft?: Record<string, unknown> })
    .filter(message => message.type === "saveProvider")
    .pop()?.draft;
}
const HEADERS_PLACEHOLDER = /\{\s*"X-Organization"/;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers an API key field, so an endpoint can be saved with its key", () => {
  render();
  click(/Add endpoint/);
  expect(apiKeyField()).toBeTruthy();
});

it("sends the key with the endpoint in one save", () => {
  render();
  click(/Add endpoint/);
  type("My endpoint", "Acme");
  type("https://example.com/v1", "https://acme.test/v1");
  type("sk-…", "sk-secret");
  click("Save");
  expect(saved()).toMatchObject({ name: "Acme", baseURL: "https://acme.test/v1", apiKey: "sk-secret" });
});

it("shows advanced options with model discovery and extra headers", () => {
  render();
  click(/Add endpoint/);
  expect(container.textContent).toContain("Advanced options");
  expect(button(/Discover/)).toBeTruthy();
  expect(field(HEADERS_PLACEHOLDER)).toBeTruthy();
});

it("asks the host to discover models using what is typed, before saving", () => {
  render();
  click(/Add endpoint/);
  type("My endpoint", "Acme");
  type("https://example.com/v1", "https://acme.test/v1");
  type("sk-…", "sk-secret");
  click(/Discover/);
  const request = vi.mocked(vscode.postMessage).mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .find(message => message.type === "fetchProviderModels");
  expect(request).toMatchObject({ baseURL: "https://acme.test/v1", apiKey: "sk-secret", name: "Acme" });
});

it("fills the model list from the discovery reply and says how many", () => {
  render();
  click(/Add endpoint/);
  type("My endpoint", "Acme");
  type("https://example.com/v1", "https://acme.test/v1");
  click(/Discover/);
  act(() => {
    window.dispatchEvent(new CustomEvent("sleepycode:providerModels", { detail: { models: ["gpt-4o", "o3-mini"], ok: true } }));
  });
  expect((field("gpt-4o-mini, llama-3.1-8b") as HTMLInputElement).value).toBe("gpt-4o, o3-mini");
  expect(container.textContent).toContain("Found 2 models");
});

it("reports a discovery failure instead of silently doing nothing", () => {
  render();
  click(/Add endpoint/);
  type("My endpoint", "Acme");
  type("https://example.com/v1", "https://acme.test/v1");
  click(/Discover/);
  act(() => {
    window.dispatchEvent(new CustomEvent("sleepycode:providerModels", { detail: { ok: false, models: [], text: "401 Unauthorized" } }));
  });
  expect(container.textContent).toContain("401 Unauthorized");
});

it("refuses a bad header block in the form, and does not save", () => {
  render();
  click(/Add endpoint/);
  type("My endpoint", "Acme");
  type("https://example.com/v1", "https://acme.test/v1");
  type(HEADERS_PLACEHOLDER, "{nope");
  click("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/JSON object/);
  expect(saved()).toBeUndefined();
});

it("shows stored headers when editing, so an existing option is not hidden", () => {
  render([row({ customHeaders: { "X-Org": "acme" } })]);
  click("Edit");
  expect((field(HEADERS_PLACEHOLDER) as HTMLTextAreaElement).value).toContain("X-Org");
});

it("leaves the key blank when editing, because the host never sends it back", () => {
  render([row()]);
  click("Edit");
  expect((apiKeyField() as HTMLInputElement).value).toBe("");
});
