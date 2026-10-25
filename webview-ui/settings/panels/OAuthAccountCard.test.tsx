/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OAuthAccountCard } from "./ProvidersPanel";
import { vscode } from "../../shared/vscode";

vi.mock("../../shared/vscode", () => ({ vscode: { postMessage: vi.fn() } }));
let root: Root;
let container: HTMLDivElement;
function receive(data: unknown) { act(() => window.dispatchEvent(new MessageEvent("message", { data }))); }
function latest(type: string): any {
  const messages = vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message as any).filter(message => message.type === type);
  return messages[messages.length - 1];
}
function refreshButton() { return container.querySelector<HTMLButtonElement>('[title="Refresh limits"]')!; }
function resetButton() { return container.querySelector<HTMLButtonElement>('[title="Spend one credit to reset your rate-limit windows now"]')!; }
function click(button: HTMLButtonElement) { act(() => button.click()); }
function limits(requestId: string, remaining = 80, resetCredits = 2) { receive({ type: "oauthLimits", id: "account", requestId, resetCredits, limits: [{ label: "Five-hour", remaining, limit: 100 }] }); }
function render(refreshToken = 0) { act(() => root.render(<OAuthAccountCard account={{ id: "account", kind: "codex" }} defaultOpen refreshToken={refreshToken} />)); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("settles matching quota failures while preserving last known limits", () => {
  const first = latest("oauthLimits");
  expect(first.requestId).toEqual(expect.any(String));
  limits(first.requestId);
  click(refreshButton());
  const next = latest("oauthLimits");
  expect(container.textContent).toContain("Refreshing limits…");
  receive({ type: "oauthLimits", id: "other-account", requestId: next.requestId, error: "Wrong account" });
  expect(refreshButton().disabled).toBe(true);
  receive({ type: "oauthLimits", id: "account", requestId: next.requestId, error: "Network unavailable" });
  expect(refreshButton().disabled).toBe(false);
  expect(container.textContent).toContain("Network unavailable");
  expect(container.textContent).toContain("80% left");
});

it("recovers after timeout and prevents late replies from overwriting a newer quota", () => {
  const old = latest("oauthLimits");
  act(() => vi.advanceTimersByTime(30_000));
  expect(refreshButton().disabled).toBe(false);
  expect(container.textContent).toContain("Quota refresh did not respond");
  click(refreshButton());
  const current = latest("oauthLimits");
  limits(old.requestId, 10);
  expect(refreshButton().disabled).toBe(true);
  limits(current.requestId, 70);
  limits(old.requestId, 5);
  expect(container.textContent).toContain("70% left");
  expect(container.textContent).not.toContain("5% left");
});

it("refreshes visible cards when the Usage page requests another refresh", () => {
  limits(latest("oauthLimits").requestId);
  const first = latest("oauthLimits");
  render(1);
  expect(latest("oauthLimits").requestId).not.toBe(first.requestId);
  expect(refreshButton().disabled).toBe(true);
});

it("correlates reset and follow-up limits without sending duplicate reset operations", () => {
  limits(latest("oauthLimits").requestId);
  click(resetButton());
  const reset = latest("oauthResetCredit");
  expect(resetButton().disabled).toBe(true);
  receive({ type: "oauthResetResult", id: "account", requestId: "stale", ok: true });
  expect(resetButton().disabled).toBe(true);
  receive({ type: "oauthResetResult", id: "account", requestId: reset.requestId, ok: true });
  expect(container.textContent).toContain("Windows reset.");
  expect(refreshButton().disabled).toBe(true);
  limits(reset.requestId, 100, 1);
  expect(container.textContent).toContain("100% left");
  expect(container.textContent).toContain("Reset credits: 1");
  expect(resetButton().disabled).toBe(false);
});

it("does not enable another reset using stale credits after its follow-up refresh fails", () => {
  limits(latest("oauthLimits").requestId);
  click(resetButton());
  const reset = latest("oauthResetCredit");
  receive({ type: "oauthResetResult", id: "account", requestId: reset.requestId, ok: true });
  receive({ type: "oauthLimits", id: "account", requestId: reset.requestId, error: "Quota unavailable" });
  expect(refreshButton().disabled).toBe(false);
  expect(resetButton().disabled).toBe(true);
  expect(container.textContent).toContain("Quota unavailable");
  click(refreshButton());
  limits(latest("oauthLimits").requestId, 100, 1);
  expect(resetButton().disabled).toBe(false);
});

it("recovers reset controls after failure and refreshes state before retrying an unknown result", () => {
  limits(latest("oauthLimits").requestId);
  click(resetButton());
  const oldReset = latest("oauthResetCredit");
  act(() => vi.advanceTimersByTime(30_000));
  expect(refreshButton().disabled).toBe(false);
  expect(resetButton().disabled).toBe(true);
  expect(container.textContent).toContain("Refresh limits before retrying");
  click(refreshButton());
  limits(latest("oauthLimits").requestId, 100, 1);
  expect(resetButton().disabled).toBe(false);
  receive({ type: "oauthResetResult", id: "account", requestId: oldReset.requestId, ok: false, message: "Old failure" });
  expect(container.textContent).not.toContain("Old failure");
  click(resetButton());
  const current = latest("oauthResetCredit");
  receive({ type: "oauthResetResult", id: "account", requestId: current.requestId, ok: false, message: "Service rejected reset" });
  limits(current.requestId, 100, 1);
  expect(container.textContent).toContain("Service rejected reset");
  expect(resetButton().disabled).toBe(false);
});
