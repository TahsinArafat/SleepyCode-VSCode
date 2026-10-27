/*
 * Subagents & Teams: who a run may delegate to, and what each one is.
 *
 * Three built-in roles are the shapes a delegation takes — research, critique,
 * bounded implementation. A project usually needs names for its own jobs, with
 * their own instructions and optionally their own cheaper model; a team is a
 * roster of those names, so the parent delegates to a defined group instead of
 * inventing one.
 *
 * Everything here is backed: definitions are stored, the roster is injected into
 * the parent's system prompt, the model addresses a definition by name, a
 * read-only definition cannot gain write tools, and the per-role models are the
 * ones the host consults when a subagent starts. The rules live in
 * `src/subagents.ts` and `src/subagent-roles.ts`, tested without a browser.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { Select } from "../../shared/Select";
import { vscode } from "../../shared/vscode";
import {
  ROLE_META,
  SUBAGENT_ROLES,
  normalizeSubagentModels,
  roleModelProblem,
  roleOptions,
  type SubagentModels,
} from "../../../src/subagent-roles.ts";
import { validateSubagentDraft, validateTeamDraft, type SubagentDef, type TeamDef } from "../../../src/subagents.ts";

interface SubagentsState {
  models: SubagentModels;
  catalog: string[];
  subagents: SubagentDef[];
  teams: TeamDef[];
  activeTeamIds: string[];
}

const EMPTY: SubagentsState = { models: {}, catalog: [], subagents: [], teams: [], activeTeamIds: [] };

type SubagentDraft = { id: string; name: string; description: string; prompt: string; role: SubagentDef["role"]; readonly: boolean; model: string };
type TeamDraft = { id: string; name: string; description: string; subagentIds: string[] };

const newSubagent = (): SubagentDraft => ({ id: "", name: "", description: "", prompt: "", role: "reviewer", readonly: true, model: "" });
const newTeam = (): TeamDraft => ({ id: "", name: "", description: "", subagentIds: [] });

export function SubagentsPanel() {
  const [state, setState] = React.useState<SubagentsState>(EMPTY);
  const [loaded, setLoaded] = React.useState(false);
  const [subDraft, setSubDraft] = React.useState<{ value: SubagentDraft; isNew: boolean } | null>(null);
  const [teamDraft, setTeamDraft] = React.useState<{ value: TeamDraft; isNew: boolean } | null>(null);
  const [error, setError] = React.useState("");
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);

  // Disarm on a timer, not on pointer-leave: the label changes on the first press,
  // so the button re-renders between mousedown and mouseup.
  React.useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  const adopt = (message: Record<string, unknown>) => {
    setState({
      models: normalizeSubagentModels(message.models),
      catalog: Array.isArray(message.catalog) ? message.catalog.filter((id: unknown): id is string => typeof id === "string") : [],
      subagents: Array.isArray(message.subagents) ? (message.subagents as SubagentDef[]) : [],
      teams: Array.isArray(message.teams) ? (message.teams as TeamDef[]) : [],
      activeTeamIds: Array.isArray(message.activeTeamIds) ? (message.activeTeamIds as string[]) : [],
    });
    setLoaded(true);
  };

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (!message || (message.type !== "subagents" && message.type !== "subagentSaved" && message.type !== "teamSaved")) return;
      if (message.type !== "subagents") {
        // A refused save leaves the dialog open with the reason; the host is the
        // last word on what may be stored.
        if (message.error) { setError(String(message.error)); return; }
        setSubDraft(null);
        setTeamDraft(null);
      }
      adopt(message);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getSubagents" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const custom = state.subagents.filter((def) => !def.builtin);
  const builtIns = state.subagents.filter((def) => def.builtin);
  const nameOf = (ids: string[]) => ids.map((id) => state.subagents.find((def) => def.id === id)?.name).filter(Boolean).join(", ");

  const chooseModel = (role: (typeof SUBAGENT_ROLES)[number], model: string) => {
    const next: SubagentModels = { ...state.models };
    if (model) next[role] = model;
    else delete next[role];
    setState({ ...state, models: next });
    vscode.postMessage({ type: "saveSubagentModels", models: next });
  };

  const saveSubagent = () => {
    if (!subDraft) return;
    const problem = validateSubagentDraft(
      { ...subDraft.value, model: subDraft.value.model || undefined },
      // Built-ins take part: the model picks by name, so a custom one may not
      // take a name it already knows.
      [...state.subagents.filter((def) => def.id !== subDraft.value.id)],
      { isNew: subDraft.isNew },
    );
    if (problem) { setError(problem); return; }
    setError("");
    vscode.postMessage({ type: "saveSubagent", draft: subDraft.value });
  };

  const saveTeam = () => {
    if (!teamDraft) return;
    const problem = validateTeamDraft(teamDraft.value, state.teams, { isNew: teamDraft.isNew });
    if (problem) { setError(problem); return; }
    setError("");
    vscode.postMessage({ type: "saveTeam", draft: teamDraft.value });
  };

  const toggleTeam = (id: string, assigned: boolean) => {
    const next = assigned ? [...state.activeTeamIds, id] : state.activeTeamIds.filter((teamId) => teamId !== id);
    setState({ ...state, activeTeamIds: next });
    vscode.postMessage({ type: "setActiveTeams", ids: next });
  };

  return (
    <>
      <h1 className="page-title">Subagents</h1>
      <p className="panel-hint">
        A run can delegate one bounded task to an isolated subagent, which works in its own context window and reports
        back. The roster below is what the agent is told it may delegate to.
      </p>

      <div className="section-label">Model per role</div>
      {SUBAGENT_ROLES.map((role) => {
        const meta = ROLE_META[role];
        const problem = roleModelProblem(state.models, role, state.catalog);
        return (
          <div className="feature-card" key={role}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="agent" size={14} />
                <span>{meta.label}</span>
                <span className={"badge-tag " + (meta.writes ? "always" : "glob")}>{meta.writes ? "Can edit" : "Read-only"}</span>
              </div>
              <Select aria-label={`${meta.label} model`} value={state.models[role] ?? ""} onChange={(event) => chooseModel(role, event.target.value)}>
                {roleOptions(state.catalog).map((option) => (
                  <option key={option.id || "inherit"} value={option.id}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div className="fc-body">
              <p className="row-desc" style={{ margin: 0 }}>{meta.description}</p>
              {problem && <p className="row-desc" role="alert" style={{ margin: 0, color: "var(--error)" }}>{problem}</p>}
            </div>
          </div>
        );
      })}

      <div className="section-label" style={{ marginTop: 24 }}>Built in</div>
      <div className="feature-card">
        {builtIns.map((def) => (
          <div key={def.id} className="fc-head" style={{ padding: "5px 0", alignItems: "baseline" }}>
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="agent" size={13} />
              <span>{def.name}</span>
              <span className={"badge-tag " + (def.readonly ? "glob" : "always")}>{def.readonly ? "Read-only" : "Can edit"}</span>
            </div>
            <span className="panel-hint" style={{ margin: 0, textAlign: "right", maxWidth: "55%" }}>{def.description}</span>
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Your subagents</div>
      {loaded && custom.length === 0 && (
        <div className="empty-card">None yet. Add one to give a recurring job its own instructions, capability and model.</div>
      )}
      {custom.map((def) => (
        <div className="feature-card" key={def.id}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="agent" size={13} />
              <span>{def.name}</span>
              <span className={"badge-tag " + (def.readonly ? "glob" : "always")}>{def.readonly ? "Read-only" : "Can edit"}</span>
              {def.model && <span className="badge-tag glob">{def.model}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="btn-ghost" onClick={() => { setError(""); setSubDraft({ value: { ...def, model: def.model ?? "" }, isNew: false }); }}>Edit</button>
              <button
                className={"btn-ghost" + (confirmRemove === def.id ? " danger" : "")}
                title={confirmRemove === def.id ? "Click again to remove this subagent" : "Remove this subagent"}
                onClick={() => {
                  if (confirmRemove === def.id) {
                    vscode.postMessage({ type: "deleteSubagent", id: def.id });
                    setConfirmRemove(null);
                  } else setConfirmRemove(def.id);
                }}
              >
                {confirmRemove === def.id ? "Remove?" : "Remove"}
              </button>
            </div>
          </div>
          <div className="fc-body">
            <p className="row-desc" style={{ margin: "0 0 4px" }}>{def.description}</p>
            <div style={{ whiteSpace: "pre-wrap" }}>{def.prompt}</div>
          </div>
        </div>
      ))}
      <button className="btn-secondary" onClick={() => { setError(""); setSubDraft({ value: newSubagent(), isNew: true }); }}>
        <Icon name="plus" size={13} /> New subagent
      </button>

      <div className="section-label" style={{ marginTop: 28 }}>Teams</div>
      <p className="panel-hint">
        A team is a roster of subagents. Assigning one narrows what the agent may delegate to; with none assigned it may
        use every subagent above.
      </p>
      {loaded && state.teams.length === 0 && <div className="empty-card">No teams yet.</div>}
      {state.teams.map((team) => (
        <div className="feature-card" key={team.id}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="users" size={13} />
              <span>{team.name}</span>
              <span className="panel-hint" style={{ margin: 0, fontSize: 11 }}>{team.subagentIds.length} member{team.subagentIds.length === 1 ? "" : "s"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label className="panel-hint" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  aria-label={`Assign ${team.name}`}
                  checked={state.activeTeamIds.includes(team.id)}
                  onChange={(event) => toggleTeam(team.id, event.target.checked)}
                />
                Use
              </label>
              <button className="btn-ghost" onClick={() => { setError(""); setTeamDraft({ value: { ...team }, isNew: false }); }}>Edit</button>
              <button
                className={"btn-ghost" + (confirmRemove === team.id ? " danger" : "")}
                title={confirmRemove === team.id ? "Click again to remove this team" : "Remove this team"}
                onClick={() => {
                  if (confirmRemove === team.id) {
                    vscode.postMessage({ type: "deleteTeam", id: team.id });
                    setConfirmRemove(null);
                  } else setConfirmRemove(team.id);
                }}
              >
                {confirmRemove === team.id ? "Remove?" : "Remove"}
              </button>
            </div>
          </div>
          <div className="fc-body">
            {team.description && <div className="row-desc" style={{ marginBottom: 4 }}>{team.description}</div>}
            <div className="row-desc">Members: {nameOf(team.subagentIds) || "none"}</div>
          </div>
        </div>
      ))}
      <button className="btn-secondary" onClick={() => { setError(""); setTeamDraft({ value: newTeam(), isNew: true }); }}>
        <Icon name="plus" size={13} /> New team
      </button>

      {subDraft && (
        <div className="modal-overlay" onClick={() => setSubDraft(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">{subDraft.isNew ? "New subagent" : `Edit ${subDraft.value.name || subDraft.value.id}`}</div>
            <label className="field-label">Name</label>
            <input className="field-input" autoFocus value={subDraft.value.name} onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, name: event.target.value } })} placeholder="Threat modeler" />
            <label className="field-label">Id</label>
            <input className="field-input" value={subDraft.value.id} disabled={!subDraft.isNew} onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, id: event.target.value } })} placeholder="threat-modeler" />
            <label className="field-label">Description (how the agent decides to use it)</label>
            <input className="field-input" value={subDraft.value.description} onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, description: event.target.value } })} placeholder="Finds attack surfaces in a change" />
            <label className="field-label">Instructions</label>
            <textarea className="field-input" rows={7} value={subDraft.value.prompt} onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, prompt: event.target.value } })} />
            <label className="field-label">Runs as</label>
            <Select
              aria-label="Subagent role"
              value={subDraft.value.role}
              onChange={(event) => {
                const role = event.target.value as SubagentDef["role"];
                // A read-only capability is the safe default for a new definition;
                // choosing the worker role is what allows edits.
                setSubDraft({ ...subDraft, value: { ...subDraft.value, role, readonly: role !== "worker" ? true : subDraft.value.readonly } });
              }}
            >
              {SUBAGENT_ROLES.map((role) => <option key={role} value={role}>{ROLE_META[role].label}</option>)}
            </Select>
            <label className="panel-hint" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <input
                type="checkbox"
                checked={subDraft.value.readonly}
                disabled={subDraft.value.role !== "worker"}
                onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, readonly: event.target.checked } })}
              />
              Read-only — can explore and report, but cannot edit files or run commands
            </label>
            <label className="field-label">Model (optional)</label>
            <Select aria-label="Subagent model" value={subDraft.value.model} onChange={(event) => setSubDraft({ ...subDraft, value: { ...subDraft.value, model: event.target.value } })}>
              {roleOptions(state.catalog).map((option) => <option key={option.id || "inherit"} value={option.id}>{option.label}</option>)}
            </Select>
            {error && <div className="fc-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setSubDraft(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveSubagent}>Save</button>
            </div>
          </div>
        </div>
      )}

      {teamDraft && (
        <div className="modal-overlay" onClick={() => setTeamDraft(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">{teamDraft.isNew ? "New team" : `Edit ${teamDraft.value.name || teamDraft.value.id}`}</div>
            <label className="field-label">Name</label>
            <input className="field-input" autoFocus value={teamDraft.value.name} onChange={(event) => setTeamDraft({ ...teamDraft, value: { ...teamDraft.value, name: event.target.value } })} placeholder="Feature squad" />
            <label className="field-label">Id</label>
            <input className="field-input" value={teamDraft.value.id} disabled={!teamDraft.isNew} onChange={(event) => setTeamDraft({ ...teamDraft, value: { ...teamDraft.value, id: event.target.value } })} placeholder="feature-squad" />
            <label className="field-label">Description</label>
            <input className="field-input" value={teamDraft.value.description} onChange={(event) => setTeamDraft({ ...teamDraft, value: { ...teamDraft.value, description: event.target.value } })} />
            <label className="field-label">Members</label>
            <div className="feature-card" style={{ maxHeight: 220, overflowY: "auto" }}>
              {state.subagents.map((def) => (
                <label key={def.id} className="fc-head" style={{ padding: "4px 0", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={teamDraft.value.subagentIds.includes(def.id)}
                    onChange={(event) => setTeamDraft({
                      ...teamDraft,
                      value: {
                        ...teamDraft.value,
                        subagentIds: event.target.checked
                          ? [...teamDraft.value.subagentIds, def.id]
                          : teamDraft.value.subagentIds.filter((id) => id !== def.id),
                      },
                    })}
                  />
                  <span>{def.name}</span>
                  <span className={"badge-tag " + (def.readonly ? "glob" : "always")}>{def.readonly ? "Read-only" : "Can edit"}</span>
                </label>
              ))}
            </div>
            {error && <div className="fc-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setTeamDraft(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveTeam}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}