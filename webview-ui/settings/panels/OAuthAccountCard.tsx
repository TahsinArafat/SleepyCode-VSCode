/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */


import * as React from "react";
import { Icon } from "../../shared/icons";
import { ProviderIcon } from "../../shared/ProviderIcon";
import { vscode } from "../../shared/vscode";
import { OAUTH_LABEL, OAuthAccountInfo, OAuthKind, OAuthLimit, uid } from "../features";
import { Toggle } from "./Toggle";

// One signed-in OAuth account, with its live limits. It lives apart from the
// provider panels because it is the only part of that screen this build renders:
// the endpoints and keys screen is `ProviderKeysPanel`, and the ported panels
// beside it were unreachable — imported by a barrel and never rendered.

export function OAuthAccountCard({ account, defaultOpen, refreshToken = 0, grouped = false }: { account: OAuthAccountInfo; defaultOpen?: boolean; refreshToken?: number; grouped?: boolean }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const [limits, setLimits] = React.useState<OAuthLimit[] | null>(null);
  const [resetCredits, setResetCredits] = React.useState<number | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [resetMsg, setResetMsg] = React.useState<string | undefined>(undefined);
  const [resetNeedsRefresh, setResetNeedsRefresh] = React.useState(false);
  const limitsRequest = React.useRef<{ requestId: string; timer: number } | undefined>(undefined);
  const resetRequest = React.useRef<{ requestId: string; timer: number } | undefined>(undefined);
  const previousRefresh = React.useRef(refreshToken);
  const waitForLimits = React.useCallback((requestId: string) => {
    if (limitsRequest.current) window.clearTimeout(limitsRequest.current.timer);
    setLoading(true);
    setError(undefined);
    const timer = window.setTimeout(() => {
      if (limitsRequest.current?.requestId !== requestId) return;
      limitsRequest.current = undefined;
      setLoading(false);
      setError("Quota refresh did not respond. Try Refresh limits again.");
    }, 30_000);
    limitsRequest.current = { requestId, timer };
  }, []);
  const load = React.useCallback(() => {
    // The host refreshes quota after a reset; avoid racing the reset operation.
    if (resetRequest.current) return;
    const requestId = uid("quota");
    waitForLimits(requestId);
    vscode.postMessage({ type: "oauthLimits", id: account.id, requestId });
  }, [account.id, waitForLimits]);
  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "oauthLimits" && m.id === account.id) {
        const active = limitsRequest.current;
        if (!active || m.requestId !== active.requestId) return;
        window.clearTimeout(active.timer);
        limitsRequest.current = undefined;
        if (!m.error) {
          setLimits(m.limits || []);
          setResetCredits(m.resetCredits);
          setResetNeedsRefresh(false);
        }
        setError(m.error);
        setLoading(false);
      } else if (m?.type === "oauthResetResult" && m.id === account.id) {
        const active = resetRequest.current;
        if (!active || m.requestId !== active.requestId) return;
        window.clearTimeout(active.timer);
        resetRequest.current = undefined;
        setResetting(false);
        setResetMsg(m.ok ? "Windows reset." : (m.message || "Reset failed."));
        // A reset can consume a credit; cached pre-reset credits must not
        // enable another operation if the follow-up quota refresh fails.
        setResetNeedsRefresh(true);
        // Host sends a quota reply with this same ID after the reset result.
        waitForLimits(active.requestId);
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (limitsRequest.current) window.clearTimeout(limitsRequest.current.timer);
      if (resetRequest.current) window.clearTimeout(resetRequest.current.timer);
      limitsRequest.current = undefined;
      resetRequest.current = undefined;
    };
  }, [account.id, waitForLimits]);
  // Auto-load limits when rendered open (the Usage & Quota page).
  React.useEffect(() => { if (defaultOpen) load(); }, [defaultOpen, load]);
  React.useEffect(() => {
    if (previousRefresh.current === refreshToken) return;
    previousRefresh.current = refreshToken;
    if (open) load();
  }, [refreshToken, open, load]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && limits === null) load();
  };
  const refresh = (e: React.MouseEvent) => { e.stopPropagation(); load(); };
  const doReset = () => {
    if (resetRequest.current || resetNeedsRefresh) return;
    if (limitsRequest.current) window.clearTimeout(limitsRequest.current.timer);
    limitsRequest.current = undefined;
    setLoading(false);
    const requestId = uid("quota-reset");
    const timer = window.setTimeout(() => {
      if (resetRequest.current?.requestId !== requestId) return;
      resetRequest.current = undefined;
      setResetting(false);
      setResetNeedsRefresh(true);
      setResetMsg("Reset result not received. Refresh limits before retrying.");
    }, 30_000);
    resetRequest.current = { requestId, timer };
    setResetting(true);
    setResetMsg(undefined);
    vscode.postMessage({ type: "oauthResetCredit", id: account.id, requestId });
  };
  const enabled = account.disabled !== true;
  return (
    <div className="feature-card" style={enabled ? undefined : { opacity: 0.55 }}>
      <div className="fc-head" style={{ cursor: "pointer" }} onClick={toggle}>
        <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name={open ? "chevD" : "chevR"} size={14} />
          {!grouped && <><ProviderIcon provider={account.kind} size={20} /><span>{OAUTH_LABEL[account.kind]}</span></>}
          <span className={grouped ? "oauth-account-name" : "row-desc"}>{!grouped && "· "}{account.email || account.accountId || `Account ${account.id.slice(-6)}`}</span>
          {!enabled && <span className="badge-tag">Disabled</span>}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
          {open && (
            <button className="icon-btn" onClick={refresh} title="Refresh limits" disabled={loading || resetting}>
              <Icon name="reset" size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={() => vscode.postMessage({ type: "oauthDisconnect", id: account.id })} title="Sign out">
            <Icon name="trash" size={14} />
          </button>
          <Toggle label={`Enable ${OAUTH_LABEL[account.kind]} ${account.email || account.accountId || "account"}`} checked={enabled} onChange={(v) => vscode.postMessage({ type: "oauthSetEnabled", id: account.id, enabled: v })} />
        </div>
      </div>
      {open && (
        <div className="fc-body">
          {loading && <div className="row-desc" role="status">{limits === null ? "Loading limits…" : "Refreshing limits…"}</div>}
          {error && <div className="row-desc" role="alert">{error}{limits !== null && " Showing the last available limits."}</div>}
          {limits && limits.length === 0 ? (
            <div className="row-desc">No usage limits available.</div>
          ) : (
            (limits || []).map((l) => {
              const pct = Math.max(0, Math.min(100, Math.round(l.remaining)));
              return (
                <div key={l.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
                    <span className="row-desc">{l.label}</span>
                    <span className="row-desc">
                      {pct}% left{l.resetsAt ? ` · resets ${new Date(l.resetsAt).toLocaleString()}` : ""}
                    </span>
                  </div>
                  <div className="index-bar"><div className="index-bar-fill" style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })
          )}
          {account.kind === "codex" && resetCredits !== undefined && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 10, borderTop: "1px solid var(--vscode-panel-border, #333)" }}>
              <span className="row-desc">Reset credits: {resetCredits}{resetMsg ? ` · ${resetMsg}` : ""}</span>
              <button className="btn-ghost" onClick={doReset} disabled={resetting || loading || resetNeedsRefresh || resetCredits <= 0} title="Spend one credit to reset your rate-limit windows now">
                {resetting ? "Resetting…" : "Reset windows"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Existing browser/manual completion controls remain visible during login. */
