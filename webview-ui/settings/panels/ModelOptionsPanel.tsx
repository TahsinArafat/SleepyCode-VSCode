/*
 * Per-model options.
 *
 * The chat's model menu already edits these, and the settings window had no page
 * for them — the ported one was built around a provider/account store and local
 * runtimes this build does not have, plus an embedding model picker that has
 * nothing to pick. What it did have that maps here: a model's option list.
 *
 * The values are the ones SleepyCode actually budgets a request with — the context
 * window and the maximum output — and the rules live in `src/model-options.ts`,
 * where they are tested without a browser.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { Select } from "../../shared/Select";
import { vscode } from "../../shared/vscode";
import type { ModelOptionInfo } from "../../../src/model-options.ts";

interface ModelRow {
  id: string;
  name: string;
  providerName?: string;
  providerId?: string;
  options?: ModelOptionInfo[];
}

export function ModelOptionsPanel() {
  const [rows, setRows] = React.useState<ModelRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "modelsFetched") return;
      setRows(Array.isArray(message.modelList) ? message.modelList : []);
      setLoaded(true);
      setBusy(false);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "fetchAllModels" });
    return () => window.removeEventListener("message", handler);
  }, []);

  /** Save one model's whole option set, which is what the host expects. */
  const save = (row: ModelRow, key: string, value: string) => {
    const options = (row.options ?? []).map((option) => ({ key: option.key, value: option.key === key ? value : option.value }));
    setBusy(true);
    vscode.postMessage({ type: "saveModelOptions", modelId: row.id, options });
  };

  const reset = (row: ModelRow) => {
    setBusy(true);
    vscode.postMessage({ type: "resetModelOptions", modelId: row.id });
  };

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? rows.filter((row) => `${row.name} ${row.id} ${row.providerName ?? ""}`.toLowerCase().includes(needle))
    : rows;

  return (
    <>
      <h1 className="page-title">Models</h1>
      <p className="panel-hint">
        How much of each model SleepyCode asks for. The context window decides how much of the conversation is sent and
        when it is compacted; the output limit decides how long one response can be. Change one only when the model does
        not match what its endpoint reports.
      </p>

      <div className="index-actions" style={{ marginBottom: 12 }}>
        <input
          className="field-input"
          style={{ maxWidth: 320 }}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models"
          aria-label="Filter models"
        />
        <button className="btn-secondary" disabled={busy} onClick={() => { setBusy(true); vscode.postMessage({ type: "fetchAllModels" }); }}>
          <Icon name="reset" /> {busy ? "Refreshing…" : "Refresh catalog"}
        </button>
      </div>

      {loaded && rows.length === 0 && (
        <div className="empty-card">
          No models are known yet. Add an endpoint on the Providers page, then refresh the catalog.
        </div>
      )}
      {loaded && rows.length > 0 && visible.length === 0 && (
        <div className="empty-card">No model matches “{filter}”.</div>
      )}

      {visible.map((row) => (
        <div className="feature-card" key={row.id}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="model" size={14} />
              <span>{row.name}</span>
              {row.providerName && <span className="badge-tag glob">{row.providerName}</span>}
            </div>
            <button className="btn-ghost" title="Return this model to the values its endpoint reports" onClick={() => reset(row)}>
              Reset
            </button>
          </div>
          <div className="fc-body" style={{ display: "grid", gap: 8 }}>
            {(row.options ?? []).map((option) => (
              <label key={option.key} title={option.description}>
                {option.label}
                <Select
                  aria-label={`${row.name} ${option.label}`}
                  value={option.value}
                  onChange={(event) => save(row, option.key, event.target.value)}
                >
                  {option.values.map((value) => (
                    <option key={value} value={value}>
                      {Number(value).toLocaleString()}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
            {(row.options ?? []).length === 0 && (
              <p className="row-desc" style={{ margin: 0 }}>
                This endpoint reports no limits for {row.name}, so there is nothing to configure.
              </p>
            )}
          </div>
        </div>
      ))}
    </>
  );
}