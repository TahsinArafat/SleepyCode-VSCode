/*
 * Hook rules, as the host actually evaluates them.
 *
 * This replaces a ported page that edited `{ event, command }` shell commands.
 * Nothing ran those: the host has no command runner for hooks, and the values were
 * not persisted at all — so every control on that page wrote nowhere. What is
 * edited here is the rule shape `evaluateHooks` reads, so a rule saved in this
 * window fires on the next request.
 *
 * The rules, their validation and the field list come from `src/hook-rules.ts`,
 * where they are tested without a browser.
 */

import * as React from "react";
import { Select } from "../../shared/Select";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import { Toggle } from "./Toggle";
import {
  HOOK_ACTIONS,
  HOOK_ACTION_HINTS,
  HOOK_ACTION_LABELS,
  HOOK_EVENT_LABELS,
  HOOK_EVENT_NAMES,
  hookRuleProblem,
  hookRuleSummary,
  matcherFields,
  newHookRule,
  normalizeHookRules,
} from "../../../src/hook-rules.ts";
import type { HookRule } from "../../../src/hooks.ts";

type MatcherField = "tool" | "pathGlob" | "contains";

const MATCHER_LABELS: Record<MatcherField, { label: string; hint: string; placeholder: string }> = {
  tool: { label: "Tool", hint: "Only this tool, e.g. writeFile.", placeholder: "writeFile" },
  pathGlob: { label: "Path", hint: "Glob the edit path must match.", placeholder: "**/*.env" },
  contains: { label: "Contains", hint: "Text the command or message must contain.", placeholder: "rm -rf" },
};

export function HooksPanel() {
  const [rules, setRules] = React.useState<HookRule[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [notice, setNotice] = React.useState<string>();

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "hooks") return;
      setRules(normalizeHookRules(message.hooks));
      setLoaded(true);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getHooks" });
    return () => window.removeEventListener("message", handler);
  }, []);

  /** Save, unless a rule is incomplete — then say which and leave the list alone. */
  const save = (next: HookRule[]) => {
    const problem = next.map(hookRuleProblem).find(Boolean);
    if (problem) {
      setNotice(problem);
      return;
    }
    setNotice(undefined);
    setRules(next);
    vscode.postMessage({ type: "saveHooks", hooks: next });
  };

  const patch = (index: number, change: Partial<HookRule>) => {
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...change } : rule)));
  };

  return (
    <>
      <h1 className="page-title">Hooks</h1>
      <p className="panel-hint">
        Rules checked on agent lifecycle events. A matching rule can log, warn, block, or ask before continuing. Rules
        are evaluated in order, and the first one that blocks stops the action.
      </p>

      {loaded && rules.length === 0 && (
        <div className="empty-card">No hook rules yet. Add one to warn, log or block on a lifecycle event.</div>
      )}

      {rules.map((rule, index) => {
        const fields = matcherFields(rule.event);
        return (
          <div className="feature-card" key={rule.id}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="infinity" size={14} />
                <span>{hookRuleSummary(rule)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle checked={rule.enabled !== false} onChange={(enabled) => save(rules.map((item, i) => (i === index ? { ...item, enabled } : item)))} />
                <button
                  className="btn-ghost sm"
                  title="Remove this rule"
                  onClick={() => save(rules.filter((_, i) => i !== index))}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>

            <div className="fc-body" style={{ display: "grid", gap: 10 }}>
              <label>
                Name
                <input value={rule.name} onChange={(event) => patch(index, { name: event.target.value })} onBlur={() => save(rules)} />
              </label>
              <label>
                Event
                <Select
                  aria-label="Hook event"
                  value={rule.event}
                  onChange={(event) => {
                    const next = event.target.value as HookRule["event"];
                    // Matchers an event cannot carry would look active and never fire.
                    const allowed = matcherFields(next);
                    const matcher = rule.matcher
                      ? Object.fromEntries(Object.entries(rule.matcher).filter(([key]) => allowed.includes(key as MatcherField)))
                      : undefined;
                    save(rules.map((item, i) => (i === index ? { ...item, event: next, matcher: matcher && Object.keys(matcher).length ? (matcher as HookRule["matcher"]) : undefined } : item)));
                  }}
                >
                  {HOOK_EVENT_NAMES.map((name) => (
                    <option key={name} value={name}>{HOOK_EVENT_LABELS[name]}</option>
                  ))}
                </Select>
              </label>
              {fields.map((field) => (
                <label key={field}>
                  {MATCHER_LABELS[field].label}
                  <input
                    value={rule.matcher?.[field] ?? ""}
                    placeholder={MATCHER_LABELS[field].placeholder}
                    title={MATCHER_LABELS[field].hint}
                    onChange={(event) => {
                      const matcher = { ...(rule.matcher ?? {}) };
                      const value = event.target.value.trim();
                      if (value) matcher[field] = value;
                      else delete matcher[field];
                      patch(index, { matcher: Object.keys(matcher).length ? matcher : undefined });
                    }}
                    onBlur={() => save(rules)}
                  />
                </label>
              ))}
              <label>
                Action
                <Select
                  aria-label="Hook action"
                  value={rule.action}
                  onChange={(event) => save(rules.map((item, i) => (i === index ? { ...item, action: event.target.value as HookRule["action"] } : item)))}
                >
                  {HOOK_ACTIONS.map((action) => (
                    <option key={action} value={action}>{HOOK_ACTION_LABELS[action]}</option>
                  ))}
                </Select>
              </label>
              <p className="row-desc" style={{ margin: 0 }}>{HOOK_ACTION_HINTS[rule.action]}</p>
              <label>
                Message
                <input
                  value={rule.message ?? ""}
                  placeholder={rule.action === "block" || rule.action === "requireApproval" ? "Required: what is wrong and what to do instead" : "Shown or logged when the rule matches"}
                  onChange={(event) => patch(index, { message: event.target.value })}
                  onBlur={() => save(rules)}
                />
              </label>
            </div>
          </div>
        );
      })}

      {notice && <p className="row-desc" role="alert">{notice}</p>}

      <div className="index-actions">
        <button className="btn-secondary" onClick={() => save([...rules, newHookRule(rules)])}>
          <Icon name="plus" /> Add a rule
        </button>
      </div>
    </>
  );
}