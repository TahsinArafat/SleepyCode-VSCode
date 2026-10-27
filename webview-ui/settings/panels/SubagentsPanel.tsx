/*
 * Subagents: the three roles a run may delegate to, and the model each runs on.
 *
 * The section was called "Subagents & Teams" and edited a feature store that was
 * never persisted and that the host never read. The thing that IS real is the model
 * per role — stored in `sleepycode.subagentModels` and consulted every time a
 * subagent starts. That is what this page changes.
 *
 * Teams are absent because this build has none. A control for them would be the
 * same dead surface this page replaces.
 *
 * The role semantics and the rules live in `src/subagent-roles.ts`, tested without
 * a browser.
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

export function SubagentsPanel() {
  const [models, setModels] = React.useState<SubagentModels>({});
  const [catalog, setCatalog] = React.useState<string[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "subagents") return;
      setModels(normalizeSubagentModels(message.models));
      setCatalog(Array.isArray(message.catalog) ? message.catalog.filter((id: unknown) => typeof id === "string") : []);
      setLoaded(true);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getSubagents" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const choose = (role: (typeof SUBAGENT_ROLES)[number], model: string) => {
    const next: SubagentModels = { ...models };
    if (model) next[role] = model;
    else delete next[role];
    setModels(next);
    vscode.postMessage({ type: "saveSubagentModels", models: next });
  };

  return (
    <>
      <h1 className="page-title">Subagents</h1>
      <p className="panel-hint">
        A run can delegate one bounded task to an isolated subagent, which works in its own context window and reports
        back. Choose which model each role runs on — a cheaper model for research is often the right trade. A role left
        unset uses the conversation&apos;s model.
      </p>

      {loaded && catalog.length === 0 && (
        <div className="empty-card">
          No models are known yet, so there is nothing to choose from. Add an endpoint on the Providers page.
        </div>
      )}

      {SUBAGENT_ROLES.map((role) => {
        const meta = ROLE_META[role];
        const problem = roleModelProblem(models, role, catalog);
        return (
          <div className="feature-card" key={role}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="agent" size={14} />
                <span>{meta.label}</span>
                <span className={"badge-tag " + (meta.writes ? "always" : "glob")}>{meta.writes ? "Can edit" : "Read-only"}</span>
              </div>
            </div>
            <div className="fc-body" style={{ display: "grid", gap: 8 }}>
              <p className="row-desc" style={{ margin: 0 }}>{meta.description}</p>
              <label>
                Model
                <Select
                  aria-label={`${meta.label} model`}
                  value={models[role] ?? ""}
                  onChange={(event) => choose(role, event.target.value)}
                >
                  {roleOptions(catalog).map((option) => (
                    <option key={option.id || "inherit"} value={option.id}>{option.label}</option>
                  ))}
                </Select>
              </label>
              {problem && <p className="row-desc" role="alert" style={{ margin: 0, color: "var(--error)" }}>{problem}</p>}
            </div>
          </div>
        );
      })}

      <p className="panel-hint">
        A subagent can never exceed the run it was started from: in Ask and Plan it gets no tools that change files,
        whatever its role allows, and it cannot delegate further.
      </p>
    </>
  );
}