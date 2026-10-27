/*
 * The SleepyAI quota, in one place.
 *
 * Two pages need it: the account page (where you sign in) and Usage & Quota
 * (where you look for it). Two copies of the same readout is how the numbers
 * start disagreeing, so both render this — and the arithmetic itself lives in
 * `src/account-core.ts`, where it is tested without a browser.
 */

import * as React from "react";
import { vscode } from "../../shared/vscode";
import { accountSummary, type AccountRow, type AccountView } from "../../../src/account-core.ts";

/**
 * Ask the host who is signed in and what the plan allows.
 *
 * The answer arrives as an `account` message rather than a reply, because signing
 * in happens in the browser and lands later.
 */
export function useSleepyAccount(): { account: AccountView | undefined; refresh: () => void } {
  const [account, setAccount] = React.useState<AccountView | undefined>(undefined);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "account") setAccount(message.account ?? { loggedIn: false });
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getAccount" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const refresh = React.useCallback(() => { vscode.postMessage({ type: "getAccount" }); }, []);
  return { account, refresh };
}

/** One row: the label, the figure, and a bar when the figure is a share. */
export function QuotaRows({ rows }: { rows: readonly AccountRow[] }) {
  return (
    <>
      {rows.map((row) => (
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
    </>
  );
}

/**
 * The quota block. Renders nothing when there is no account: an empty block reads
 * as broken, absent reads as absent.
 */
export function SleepyQuota({ account, title = "SleepyAI Quota" }: { account: AccountView | undefined; title?: string }) {
  const summary = accountSummary(account);
  if (!summary.signedIn || summary.rows.length === 0) return null;
  return (
    <>
      <div className="section-label">{title}</div>
      <div className="feature-card">
        <QuotaRows rows={summary.rows} />
      </div>
    </>
  );
}