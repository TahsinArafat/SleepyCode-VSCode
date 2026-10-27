/*
 * Providers: the endpoints this extension can talk to, and their keys.
 *
 * Written for SleepyCode rather than reusing the ported OpenCursor panel, because
 * that one is built around its own provider store (accounts, OAuth, balances,
 * per-provider model catalogs) — none of which exists here. This one covers what
 * SleepyCode actually supports: a first-party provider plus compatibility
 * endpoints with a base URL, an optional model list, and an API key.
 *
 * The key never comes back from the host. The page learns whether one is set and
 * its last few characters, so a credential cannot be read out of the webview.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import type { ProviderDraft, ProviderRow } from "../../../src/providers-core";

export function ProviderKeysPanel({ providers }: { providers: ProviderRow[] }) {
  const [editing, setEditing] = React.useState<ProviderDraft | null>(null);
  const [keyFor, setKeyFor] = React.useState<string | null>(null);
  const [keyValue, setKeyValue] = React.useState("");
  const [error, setError] = React.useState("");

  const openNew = () => { setError(""); setEditing({ name: "", baseURL: "", models: "" }); };
  const openEdit = (row: ProviderRow) => {
    setError("");
    setEditing({ id: row.id, name: row.name, baseURL: row.baseUrl, models: row.models.join(", "), isSleepy: row.isSleepy });
  };

  const save = () => {
    if (!editing) return;
    vscode.postMessage({ type: "saveProvider", draft: editing });
    setEditing(null);
  };

  return (
    <>
      <h1 className="page-title">Providers</h1>
      <p className="panel-hint">
        SleepyAI is built in and signs in above. Compatibility endpoints are optional: any OpenAI-compatible API
        you add yourself, with its own key.
      </p>

      {error && <div className="fc-error" role="alert">{error}</div>}

      {providers.length === 0 && <div className="empty-card">No providers yet.</div>}

      <div className="provider-list">
        {providers.map((row) => (
          <div className="provider-row" key={row.id}>
            <div className="provider-main">
              <div className="provider-name">
                {row.name}
                {row.isSleepy && <span className="badge-tag always">First-party</span>}
                {row.active && <span className="badge-tag glob">Active</span>}
              </div>
              <div className="provider-url" title={row.baseUrl}>{row.baseUrl || "—"}</div>
              <div className="provider-meta">
                {row.models.length > 0 ? `${row.models.length} model${row.models.length === 1 ? "" : "s"}` : "Models discovered from the endpoint"}
                {row.hasKey && <span className="provider-key-hint"> · key {row.keyHint}</span>}
              </div>
            </div>
            <div className="provider-actions">
              {!row.isSleepy && (
                <>
                  <button className="btn-secondary" onClick={() => { setKeyFor(row.id); setKeyValue(""); }}>
                    {row.hasKey ? "Replace key" : "Set key"}
                  </button>
                  <button className="btn-ghost" onClick={() => openEdit(row)}>Edit</button>
                  <button className="btn-ghost" onClick={() => vscode.postMessage({ type: "deleteProvider", id: row.id })}>Remove</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <button className="btn-secondary" onClick={openNew}>
        <Icon name="plus" size={13} /> Add endpoint
      </button>

      {keyFor && (
        <div className="modal-overlay" onClick={() => setKeyFor(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">API key</div>
            <p className="panel-hint">Stored in the OS secret store, never in settings or sync. Leave empty to remove it.</p>
            <input
              className="field-input"
              type="password"
              autoFocus
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              aria-label="API key"
              placeholder="sk-…"
            />
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setKeyFor(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => { vscode.postMessage({ type: "setProviderKey", id: keyFor, apiKey: keyValue }); setKeyFor(null); }}>Save key</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{editing.id ? "Edit endpoint" : "Add endpoint"}</div>
            <label className="field-label">Name</label>
            <input className="field-input" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="My endpoint" />
            <label className="field-label">Base URL</label>
            <input className="field-input" value={editing.baseURL ?? ""} onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })} placeholder="https://example.com/v1" />
            <label className="field-label">Models (optional)</label>
            <input className="field-input" value={editing.models ?? ""} onChange={(e) => setEditing({ ...editing, models: e.target.value })} placeholder="gpt-4o-mini, llama-3.1-8b" />
            <p className="panel-hint">Separate model ids with commas. Leave empty to discover them from the endpoint.</p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
