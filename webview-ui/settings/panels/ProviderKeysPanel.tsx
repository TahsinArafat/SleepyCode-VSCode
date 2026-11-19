/*
 * Providers: the endpoints this extension can talk to, and their keys.
 *
 * Written for SleepyCode rather than reusing the ported panel, because
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
import { activateHint, canActivateProvider, parseHeaderBlock, validateProviderDraft, type ProviderDraft, type ProviderRow } from "../../../src/providers-core";
import { SettingsDialog } from "./SettingsDialog";

export function ProviderKeysPanel({ providers }: { providers: ProviderRow[] }) {
  const [editing, setEditing] = React.useState<ProviderDraft | null>(null);
  const [keyFor, setKeyFor] = React.useState<string | null>(null);
  const [keyValue, setKeyValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [discovering, setDiscovering] = React.useState(false);
  const [discoverNote, setDiscoverNote] = React.useState<{ text: string; error?: boolean } | null>(null);

  // The host answers discovery with a `providerModels` message. The settings App owns
  // the single window listener, so it re-broadcasts that reply as a DOM event rather
  // than this panel adding a second listener to the same channel.
  React.useEffect(() => {
    const onModels = (event: Event) => {
      const detail = (event as CustomEvent).detail as { models?: string[]; ok?: boolean; text?: string } | undefined;
      setDiscovering(false);
      if (!detail) return;
      if (detail.ok && detail.models?.length) {
        setEditing((current) => (current ? { ...current, models: detail.models!.join(", ") } : current));
        setDiscoverNote({ text: `Found ${detail.models.length} model${detail.models.length === 1 ? "" : "s"}.` });
        return;
      }
      setDiscoverNote({ text: detail.text || (detail.ok ? "The endpoint returned no models." : "Could not reach the endpoint."), error: !detail.ok });
    };
    window.addEventListener("sleepycode:providerModels", onModels as EventListener);
    return () => window.removeEventListener("sleepycode:providerModels", onModels as EventListener);
  }, []);
  // Two-step remove: a misclick deleted the endpoint and its secret outright.
  // Disarmed on a timer, not on pointer-leave: the label changes on the first
  // press, which re-renders the button between mousedown and mouseup, so a leave
  // that fires in between zeroes the count and the gesture becomes unreachable.
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  const openNew = () => { setError(""); setDiscoverNote(null); setEditing({ name: "", baseURL: "", models: "", apiKey: "", headers: "" }); };
  const openEdit = (row: ProviderRow) => {
    setError("");
    setDiscoverNote(null);
    setEditing({
      id: row.id,
      name: row.name,
      baseURL: row.baseUrl,
      models: row.models.join(", "),
      isSleepy: row.isSleepy,
      // Left empty on purpose: the host holds the key and never sends it back, so an
      // edit that leaves this blank keeps whatever is already stored.
      apiKey: "",
      headers: row.customHeaders && Object.keys(row.customHeaders).length
        ? JSON.stringify(row.customHeaders, null, 2)
        : "",
    });
  };

  /**
   * Ask the host what models this endpoint serves.
   *
   * Uses whatever is currently typed, so it works before the endpoint is saved. The
   * reply arrives as a `providerModels` message, which the settings App listens for
   * and forwards here.
   */
  const discoverModels = () => {
    if (!editing) return;
    const problem = validateProviderDraft(editing);
    if (problem) { setError(problem); return; }
    setError("");
    setDiscovering(true);
    setDiscoverNote(null);
    const headers = parseHeaderBlock(editing.headers).headers;
    vscode.postMessage({
      type: "fetchProviderModels",
      id: editing.id,
      name: editing.name,
      baseURL: editing.baseURL,
      apiKey: editing.apiKey,
      ...(headers ? { customHeaders: headers } : {}),
    });
  };

  const save = () => {
    if (!editing) return;
    // Validate here as well as host-side: the host's refusal arrives as a notice
    // after the dialog has closed, which reads as "nothing happened".
    const problem = validateProviderDraft(editing);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
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
              {canActivateProvider(row) && (
                <button
                  className="btn-ghost"
                  title={activateHint(row)}
                  onClick={() => vscode.postMessage({ type: "setActiveProvider", id: row.id })}
                >
                  Use by default
                </button>
              )}
              {!row.isSleepy && (
                <>
                  <button className="btn-secondary" onClick={() => { setKeyFor(row.id); setKeyValue(""); }}>
                    {row.hasKey ? "Replace key" : "Set key"}
                  </button>
                  <button className="btn-ghost" onClick={() => openEdit(row)}>Edit</button>
                  <button
                    className={"btn-ghost" + (confirmRemove === row.id ? " danger" : "")}
                    title={confirmRemove === row.id ? "Click again to remove this endpoint and its stored key" : "Remove this endpoint"}
                    onClick={() => {
                      if (confirmRemove === row.id) {
                        vscode.postMessage({ type: "deleteProvider", id: row.id });
                        setConfirmRemove(null);
                      } else {
                        setConfirmRemove(row.id);
                      }
                    }}
                  >
                    {confirmRemove === row.id ? "Remove?" : "Remove"}
                  </button>
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
        <SettingsDialog title="API key" onClose={() => setKeyFor(null)}>
          <p className="panel-hint">Stored in the OS secret store, never in settings or sync. Leave empty to remove it.</p>
          <input
            className="field-input"
            type="password"
            data-dialog-autofocus
            value={keyValue}
            onChange={(event) => setKeyValue(event.target.value)}
            aria-label="API key"
            placeholder="sk-…"
          />
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => setKeyFor(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => { vscode.postMessage({ type: "setProviderKey", id: keyFor, apiKey: keyValue }); setKeyFor(null); }}>Save key</button>
          </div>
        </SettingsDialog>
      )}

      {editing && (
        <SettingsDialog title={editing.id ? "Edit endpoint" : "Add endpoint"} onClose={() => setEditing(null)}>
            <label className="field-label">Name</label>
            <input className="field-input" data-dialog-autofocus value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="My endpoint" />
            <label className="field-label">Base URL</label>
            <input className="field-input" value={editing.baseURL ?? ""} onChange={(e) => setEditing({ ...editing, baseURL: e.target.value })} placeholder="https://example.com/v1" />
            {/* The key belongs in this form. Saving an endpoint and then hunting for a
                separate "Set key" button made a working setup look like a broken
                provider: the row appeared, listed models, and rejected every call. */}
            <label className="field-label">API key</label>
            <input
              className="field-input"
              type="password"
              value={editing.apiKey ?? ""}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder={editing.id ? "Leave empty to keep the stored key" : "sk-…"}
              autoComplete="off"
            />
            <p className="panel-hint">Stored in the OS secret store, never in settings or sync. Not needed for a local endpoint that accepts unauthenticated calls.</p>

            <details className="provider-advanced" open={Boolean(editing.headers)}>
              <summary>Advanced options</summary>
              <label className="field-label">Models</label>
              <div className="provider-models-row">
                <input className="field-input" value={editing.models ?? ""} onChange={(e) => setEditing({ ...editing, models: e.target.value })} placeholder="gpt-4o-mini, llama-3.1-8b" />
                <button className="btn-ghost" type="button" disabled={discovering} onClick={discoverModels}>
                  {discovering ? "Discovering…" : "Discover"}
                </button>
              </div>
              <p className="panel-hint">Separate model ids with commas, or discover them from the endpoint using the URL and key above.</p>
              {discoverNote && <div className={discoverNote.error ? "fc-error" : "panel-hint"} role={discoverNote.error ? "alert" : undefined}>{discoverNote.text}</div>}
              <label className="field-label">Extra request headers</label>
              <textarea
                className="field-input provider-headers"
                rows={3}
                value={editing.headers ?? ""}
                onChange={(e) => setEditing({ ...editing, headers: e.target.value })}
                placeholder={'{"X-Organization": "acme"}'}
              />
              <p className="panel-hint">Optional JSON object of string values, sent with every request to this endpoint.</p>
            </details>

            {error && <div className="fc-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
        </SettingsDialog>
      )}
    </>
  );
}
