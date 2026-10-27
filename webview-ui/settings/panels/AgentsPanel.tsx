/*
 * Agents: the ones this build ships and the ones you write.
 *
 * The settings rail has had an "Agents" section from the start, and it was never
 * an agent manager — it rendered text-size and appearance controls. The real list
 * existed all along; the only place to create an agent was elsewhere.
 *
 * The rules — what an id may be, what a draft may not do — live in
 * `src/agent-editor.ts`, where they are tested without a browser. They are checked
 * here before saving, so a mistake shows in the dialog instead of arriving as a
 * notification after it closed.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import { SettingsDialog } from "./SettingsDialog";
import {
  agentFromDraft,
  agentRows,
  draftFromRow,
  emptyAgentDraft,
  validateAgentDraft,
  type AgentDraft,
  type AgentRow,
} from "../../../src/agent-editor.ts";

export function AgentsPanel() {
  const [rows, setRows] = React.useState<AgentRow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState<AgentDraft | null>(null);
  const [isNew, setIsNew] = React.useState(false);
  const [error, setError] = React.useState("");
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);

  // Two-step remove, disarmed on a timer rather than on pointer-leave: the label
  // changes on the first press, which re-renders the button between mousedown and
  // mouseup, so a leave firing in between makes the second click unreachable.
  React.useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "agents") return;
      // `agents` also arrives unprompted when the chat saves one, in the shape
      // `{ agents }`. Both are read here so the list cannot go stale.
      if (Array.isArray(message.builtIn) || Array.isArray(message.custom)) {
        setRows(agentRows(message.builtIn ?? [], message.custom ?? []));
      } else {
        const custom = Array.isArray(message.agents) ? message.agents : [];
        setRows(agentRows([], custom));
      }
      setLoaded(true);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getAgents" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const openNew = () => { setError(""); setIsNew(true); setDraft(emptyAgentDraft()); };
  const openEdit = (row: AgentRow) => { setError(""); setIsNew(false); setDraft(draftFromRow(row)); };

  const save = () => {
    if (!draft) return;
    const problem = validateAgentDraft(draft, rows, { isNew });
    if (problem) { setError(problem); return; }
    vscode.postMessage({ type: "saveAgent", agent: agentFromDraft(draft) });
    setDraft(null);
  };

  const builtIns = rows.filter((row) => row.builtIn);
  const custom = rows.filter((row) => !row.builtIn);

  return (
    <>
      <h1 className="page-title">Agents</h1>
      <p className="panel-hint">
        Who handles a message. The composer&apos;s agent picker chooses one per conversation; an agent is an
        instruction prompt, and optionally a model and a set of tools it may use.
      </p>

      <div className="section-label">Built in</div>
      <div className="feature-card">
        {builtIns.length === 0 && <p className="row-desc" style={{ margin: 0 }}>None reported by the host.</p>}
        {builtIns.map((row) => (
          <div key={row.id} className="fc-head" style={{ padding: "5px 0", alignItems: "baseline" }}>
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="agent" size={14} />
              <span>{row.name}</span>
              <span className="badge-tag glob">{row.role}</span>
            </div>
            <span className="panel-hint" style={{ margin: 0, textAlign: "right", maxWidth: "55%" }}>{row.description}</span>
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Your agents</div>
      {loaded && custom.length === 0 && (
        <div className="empty-card">No agents of your own yet. Add one to give a task its own instructions.</div>
      )}
      {custom.map((row) => (
        <div className="feature-card" key={row.id}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="agent" size={14} />
              <span>{row.name}</span>
              <span className="panel-hint" style={{ margin: 0, fontSize: 11 }}>{row.id}</span>
              {row.model && <span className="badge-tag glob">{row.model}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="btn-ghost" onClick={() => openEdit(row)}>Edit</button>
              <button
                className={"btn-ghost" + (confirmRemove === row.id ? " danger" : "")}
                title={confirmRemove === row.id ? "Click again to remove this agent" : "Remove this agent"}
                onClick={() => {
                  if (confirmRemove === row.id) {
                    vscode.postMessage({ type: "deleteAgent", id: row.id });
                    setConfirmRemove(null);
                  } else {
                    setConfirmRemove(row.id);
                  }
                }}
              >
                {confirmRemove === row.id ? "Remove?" : "Remove"}
              </button>
            </div>
          </div>
          {(row.prompt || row.allow.length > 0 || row.deny.length > 0) && (
            <div className="fc-body">
              {row.prompt && <div style={{ whiteSpace: "pre-wrap" }}>{row.prompt}</div>}
              {row.allow.length > 0 && <div className="row-desc">Allowed tools: {row.allow.join(", ")}</div>}
              {row.deny.length > 0 && <div className="row-desc">Denied tools: {row.deny.join(", ")}</div>}
            </div>
          )}
        </div>
      ))}

      <button className="btn-secondary" onClick={openNew}>
        <Icon name="plus" size={13} /> New agent
      </button>

      {draft && (
        <SettingsDialog title={isNew ? "New agent" : `Edit ${draft.name || draft.id}`} onClose={() => setDraft(null)}>
          <label className="field-label">Name</label>
          <input
            className="field-input"
            data-dialog-autofocus
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="Test runner"
          />
          <label className="field-label">Id</label>
          <input
            className="field-input"
            value={draft.id}
            disabled={!isNew}
            title={isNew ? "Letters, numbers, hyphens and underscores. It cannot be changed later." : "The id is how this agent is stored and cannot be changed."}
            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            placeholder="test-runner"
          />
          <label className="field-label">Instructions</label>
          <textarea
            className="field-input"
            rows={5}
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            placeholder="What this agent should do, and how."
          />
          <label className="field-label">Model (optional)</label>
          <input
            className="field-input"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            placeholder="Leave empty to use the conversation's model"
          />
          <label className="field-label">Allowed tools (optional)</label>
          <input
            className="field-input"
            value={draft.allow}
            onChange={(event) => setDraft({ ...draft, allow: event.target.value })}
            placeholder="readFile, grep"
          />
          <label className="field-label">Denied tools (optional)</label>
          <input
            className="field-input"
            value={draft.deny}
            onChange={(event) => setDraft({ ...draft, deny: event.target.value })}
            placeholder="writeFile"
          />
          <p className="panel-hint">Separate tool names with commas. Use one list or the other, not both.</p>
          {error && <div className="fc-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn-primary" onClick={save}>Save</button>
          </div>
        </SettingsDialog>
      )}
    </>
  );
}