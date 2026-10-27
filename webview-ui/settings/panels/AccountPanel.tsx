/*
 * The SleepyAI account.
 *
 * Everything here already existed in the host — sign-in, the token, the tier,
 * the daily free-token allowance — and the settings window had no page for any of
 * it. The only surface was a banner in the chat, and there was no way to sign out
 * at all: `clearGatewayConfig` existed and nothing called it.
 *
 * What is shown comes from `src/account-core.ts`, so the arithmetic and the
 * decision about what to leave out are testable without a browser.
 */

import * as React from "react";
import { vscode } from "../../shared/vscode";
import { accountSummary, type AccountView } from "../../../src/account-core.ts";
import { Icon } from "../../shared/icons";

export function AccountPanel() {
  const [account, setAccount] = React.useState<AccountView | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "account") {
        setAccount(msg.account ?? { loggedIn: false });
        setBusy(false);
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getAccount" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const summary = accountSummary(account);

  return (
    <>
      <h1 className="page-title">SleepyAI Account</h1>
      <p className="panel-hint">
        The first-party account. Compatibility endpoints you added yourself keep working without it; this is what
        SleepyAI models, limits and billing run on.
      </p>

      <div className="section-label">Status</div>
      <div className="feature-card">
        <div className="fc-head">
          <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="shieldWarning" size={14} />
            <span>{summary.identity}</span>
            {summary.plan && <span className="panel-hint" style={{ margin: 0, fontSize: 11 }}>{summary.plan}</span>}
          </div>
          <button
            className={"btn-secondary" + (summary.signedIn ? " danger" : "")}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              vscode.postMessage({ type: summary.signedIn ? "signOut" : "signIn" });
              // Sign-in happens in the browser, so the answer arrives as a new
              // `account` message rather than a reply to this click. Re-ask once
              // either way, so a cancelled flow does not leave the button stuck.
              window.setTimeout(() => vscode.postMessage({ type: "getAccount" }), 1500);
            }}
          >
            {busy ? "Working…" : summary.signedIn ? "Sign out" : "Sign in"}
          </button>
        </div>
        {!summary.signedIn && (
          <div className="fc-body">
            Signing in opens your browser. Nothing is sent anywhere until you finish there.
          </div>
        )}
      </div>

      {summary.rows.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 24 }}>Limits and usage</div>
          <div className="feature-card">
            {summary.rows.map((row) => (
              <div key={row.label} style={{ padding: "6px 0" }}>
                <div className="fc-head" style={{ alignItems: "baseline" }}>
                  <span>{row.label}</span>
                  <span className="panel-hint" style={{ margin: 0 }}>{row.value}</span>
                </div>
                {typeof row.percent === "number" && (
                  <div className="limit-track" style={{ marginTop: 4 }}>
                    <div className={"limit-fill " + (row.level ?? "safe")} style={{ width: `${row.percent}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}