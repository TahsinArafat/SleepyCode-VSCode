/*
 * Personas: the voice a chat runs in.
 *
 * An agent decides what may run — model, tools, instructions for the task. A
 * persona decides how the work reads and what to care about, and it has no tools
 * or model of its own, so it stacks on top of whichever agent the conversation
 * is using.
 *
 * The rules live in `src/personas.ts`, tested without a browser: ids are slugs,
 * the default persona is reserved, a persona with an empty prompt is refused
 * (it would look active and change nothing), and an unknown id resolves to the
 * default instead of leaving a chat pointed at nothing.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { Select } from "../../shared/Select";
import { vscode } from "../../shared/vscode";
import {
  DEFAULT_PERSONA_ID,
  personaFromDraft,
  validatePersonaDraft,
  type Persona,
} from "../../../src/personas.ts";

interface PersonasState {
  personas: Persona[];
  activePersonaId: string;
}

const EMPTY: PersonasState = { personas: [], activePersonaId: DEFAULT_PERSONA_ID };

export function PersonasPanel() {
  const [state, setState] = React.useState<PersonasState>(EMPTY);
  const [loaded, setLoaded] = React.useState(false);
  const [draft, setDraft] = React.useState<{ value: Persona; isNew: boolean } | null>(null);
  const [error, setError] = React.useState("");
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);

  // Two-step remove disarmed on a timer: the label changes on the first press, so
  // a pointer-leave disarm is unreachable between mousedown and mouseup.
  React.useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "personas") return;
      setState({
        personas: Array.isArray(message.personas) ? message.personas : [],
        activePersonaId: typeof message.activePersonaId === "string" ? message.activePersonaId : DEFAULT_PERSONA_ID,
      });
      setLoaded(true);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getPersonas" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const builtIns = state.personas.filter((persona) => persona.builtin);
  const custom = state.personas.filter((persona) => !persona.builtin);
  const active = state.personas.find((persona) => persona.id === state.activePersonaId) ?? state.personas[0];

  const save = () => {
    if (!draft) return;
    const problem = validatePersonaDraft(
      { id: draft.value.id, name: draft.value.name, description: draft.value.description, prompt: draft.value.prompt },
      custom,
      { isNew: draft.isNew },
    );
    if (problem) { setError(problem); return; }
    vscode.postMessage({ type: "savePersona", persona: personaFromDraft(draft.value) });
    setDraft(null);
    setError("");
  };

  return (
    <>
      <h1 className="page-title">Personas</h1>
      <p className="panel-hint">
        A persona is a layer on top of your agent: how it should write, and what to care about. It has no tools and no
        model of its own, so it works with whichever agent the chat is using. The composer can override it per chat.
      </p>

      <div className="section-label">Default persona</div>
      <div className="feature-card">
        <div className="fc-head">
          <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="bot" size={14} />
            <span>New chats start on</span>
          </div>
          <Select
            aria-label="Default persona"
            value={state.activePersonaId}
            onChange={(event) => vscode.postMessage({ type: "setDefaultPersona", id: event.target.value })}
          >
            {state.personas.map((persona) => (
              <option key={persona.id} value={persona.id}>{persona.name}</option>
            ))}
          </Select>
        </div>
        <div className="fc-body">
          <p className="row-desc" style={{ margin: 0 }}>
            {active ? active.description : "Reading the personas this build ships…"}
          </p>
        </div>
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Built in</div>
      <div className="feature-card">
        {builtIns.map((persona) => (
          <div key={persona.id} className="fc-head" style={{ padding: "5px 0", alignItems: "baseline" }}>
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="bot" size={13} />
              <span>{persona.name}</span>
              {persona.id === DEFAULT_PERSONA_ID && <span className="badge-tag glob">no extra instructions</span>}
            </div>
            <span className="panel-hint" style={{ margin: 0, textAlign: "right", maxWidth: "55%" }}>{persona.description}</span>
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 24 }}>Your personas</div>
      {loaded && custom.length === 0 && (
        <div className="empty-card">
          None yet. Add one to give every chat the same voice, or a speciality of your own.
        </div>
      )}
      {custom.map((persona) => (
        <div className="feature-card" key={persona.id}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Icon name="bot" size={13} />
              <span>{persona.name}</span>
              <span className="panel-hint" style={{ margin: 0, fontSize: 11 }}>{persona.id}</span>
              {persona.id === state.activePersonaId && <span className="badge-tag always">default</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button className="btn-ghost" onClick={() => { setError(""); setDraft({ value: persona, isNew: false }); }}>Edit</button>
              <button
                className={"btn-ghost" + (confirmRemove === persona.id ? " danger" : "")}
                title={confirmRemove === persona.id ? "Click again to remove this persona" : "Remove this persona"}
                disabled={persona.id === state.activePersonaId}
                onClick={() => {
                  if (confirmRemove === persona.id) {
                    vscode.postMessage({ type: "deletePersona", id: persona.id });
                    setConfirmRemove(null);
                  } else {
                    setConfirmRemove(persona.id);
                  }
                }}
              >
                {confirmRemove === persona.id ? "Remove?" : "Remove"}
              </button>
            </div>
          </div>
          <div className="fc-body">
            <div className="row-desc" style={{ marginBottom: 4 }}>{persona.description}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{persona.prompt}</div>
          </div>
        </div>
      ))}

      <button
        className="btn-secondary"
        onClick={() => {
          setError("");
          setDraft({ value: { id: "", name: "", description: "", prompt: "" }, isNew: true });
        }}
      >
        <Icon name="plus" size={13} /> New persona
      </button>

      {draft && (
        <div className="modal-overlay" onClick={() => setDraft(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">{draft.isNew ? "New persona" : `Edit ${draft.value.name || draft.value.id}`}</div>
            <label className="field-label">Name</label>
            <input
              className="field-input"
              autoFocus
              value={draft.value.name}
              onChange={(event) => setDraft({ ...draft, value: { ...draft.value, name: event.target.value } })}
              placeholder="Careful reviewer"
            />
            <label className="field-label">Id</label>
            <input
              className="field-input"
              value={draft.value.id}
              disabled={!draft.isNew}
              title={draft.isNew ? "Lowercase letters, numbers and hyphens. It cannot be changed later." : "Ids are how a persona is stored, so they cannot change."}
              onChange={(event) => setDraft({ ...draft, value: { ...draft.value, id: event.target.value } })}
              placeholder="careful-reviewer"
            />
            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={draft.value.description}
              onChange={(event) => setDraft({ ...draft, value: { ...draft.value, description: event.target.value } })}
              placeholder="One line, shown in the list"
            />
            <label className="field-label">Instructions</label>
            <textarea
              className="field-input"
              rows={8}
              value={draft.value.prompt}
              onChange={(event) => setDraft({ ...draft, value: { ...draft.value, prompt: event.target.value } })}
              placeholder="How should chats with this persona think and write?"
            />
            <p className="panel-hint">This is added to the system prompt of every turn in a chat that uses it.</p>
            {error && <div className="fc-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}