/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Select } from "../shared/Select";
import { Icon, IconName } from "../shared/icons";
import { vscode } from "../shared/vscode";
import { ApprovalActionType, ApprovalMode, ApprovalPolicy, DEFAULT_APPROVAL, EMPTY_FEATURES, FeatureConfig, LlamacppStatus, McpStatus, ModelDef, ModelUsage, OAUTH_LABEL, OAuthStatus, OllamaModel, OllamaStatus, Persona, RuleInfo, SkillInfo, uid } from "./features";
import { HooksPanel, LlamacppPanel, McpPanel, ModelsPanel, OAuthAccountCard, OllamaPanel, PersonasPanel, ProvidersPanel, RulesPanel, SubagentsPanel } from "./FeaturePanels";
import { ModelSelect } from "../shared/ModelSelect";
import { CacheUsage } from "./CacheUsage";
import { DocsSection, type DocSourceInfo, type DocsStatus } from "./DocsSection";
import { ControlLabelContext, Toggle } from "./panels/Toggle";
import { setMotionPreference, type MotionPreference } from "../shared/motionPreference";
import { filterSections, isSectionHidden } from "../shared/featureFlags";
import { shouldShowAccountQuota, visibleSection } from "../../src/settings-adapter.ts";
import { ProviderKeysPanel } from "./panels/ProviderKeysPanel";
import {
  FIRST_RUN_ACTION,
  FIRST_RUN_BODY,
  FIRST_RUN_DISMISS,
  FIRST_RUN_TITLE,
  RESET_CONSEQUENCE,
  RESET_ARM_TIMEOUT_MS,
  isResetArmed,
  logEmptyText,
  logLines,
  logTally,
  nextResetClicks,
  resetLabel,
} from "../../src/settings-extras.ts";
import { MarketplacePanel } from "./panels/MarketplacePanel";

interface Settings {
  model: string;
  maxResponseLength: number;
  enableWorkspaceContext: boolean;
  enableFileReading: boolean;
  enableTerminalSuggestions: boolean;
  systemPrompt: string;
}

const DEFAULTS: Settings = {
  model: "",
  maxResponseLength: 0,
  enableWorkspaceContext: true,
  enableFileReading: true,
  enableTerminalSuggestions: true,
  systemPrompt: "",
};

type Section = "general" | "usage" | "agents" | "providers" | "models" | "llamacpp" | "ollama" | "behavior" | "personas" | "rules" | "marketplace" | "subagents" | "mcp" | "hooks" | "indexing" | "advanced" | "about";

interface IndexStatus {
  indexing: boolean;
  done: number;
  total: number;
  files: number;
  chunks: number;
  model: string;
  backend?: "local" | "remote";
  device?: string | null;
  accelerator?: "gpu" | "cpu" | "remote" | "pending";
  deviceLabel?: string;
  modelRepo?: string;
  modelDtype?: string;
  modelPooling?: string;
  modelDim?: number;
  remoteBaseUrl?: string;
  runtime?: string;
  platform?: string;
  limitReason?: string;
}
interface EmbedModel {
  id: string;
  name: string;
}

// Group connection, agent, and workspace settings in the navigation rail.
const NAV: { id: Section; label: string; icon: IconName; sep?: boolean }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "providers", label: "Providers", icon: "globe", sep: true },
  { id: "llamacpp", label: "llama.cpp", icon: "database" },
  { id: "ollama", label: "Ollama", icon: "database" },
  { id: "usage", label: "Usage & Quota", icon: "history", sep: true },
  { id: "agents", label: "Agents", icon: "agent" },
  { id: "models", label: "Models", icon: "model" },
  { id: "behavior", label: "Behavior", icon: "tools" },
  { id: "personas", label: "Personas", icon: "bot", sep: true },
  { id: "rules", label: "Rules & Skills", icon: "ruler" },
  { id: "marketplace", label: "Skill Marketplace", icon: "book" },
  { id: "subagents", label: "Subagents & Teams", icon: "agent" },
  { id: "mcp", label: "Tools & MCPs", icon: "task" },
  { id: "hooks", label: "Hooks", icon: "infinity" },
  { id: "indexing", label: "Indexing & Docs", icon: "database" },
  { id: "advanced", label: "Advanced", icon: "fileCode", sep: true },
  { id: "about", label: "About", icon: "book" },
];

/** Built-in tool hard timeouts (seconds). Keep in sync with src/agent/tools/shared.ts. */
const TOOL_TIMEOUT_DEFAULTS: { name: string; sec: number }[] = [
  { name: "Shell", sec: 45 },
  { name: "AwaitShell", sec: 60 },
  { name: "Grep", sec: 20 },
  { name: "Glob", sec: 20 },
  { name: "FileSearch", sec: 15 },
  { name: "SemanticSearch", sec: 30 },
  { name: "SearchDocs", sec: 25 },
  { name: "ListDir", sec: 10 },
  { name: "Read", sec: 15 },
  { name: "ReadLints", sec: 15 },
  { name: "WebSearch", sec: 20 },
  { name: "WebFetch", sec: 25 },
  { name: "StrReplace", sec: 20 },
  { name: "Write", sec: 20 },
  { name: "Delete", sec: 10 },
  { name: "EditNotebook", sec: 20 },
  { name: "CallMcpTool", sec: 45 },
  { name: "FetchMcpResource", sec: 30 },
  { name: "ListMcpResources", sec: 15 },
  { name: "TodoWrite", sec: 15 },
  { name: "TodoRead", sec: 15 },
  { name: "WritePlan", sec: 10 },
  { name: "SwitchMode", sec: 5 },
];

/** Search terms per section so the nav filter finds settings inside pages too. */
const SECTION_KEYWORDS: Partial<Record<Section, string>> = {
  general: "editor settings keyboard shortcuts notifications privacy chat titles auto judge model completion sound reset animations motion reduced system",
  usage: "tokens quota limits plan usage oauth account rate limit",
  agents: "text size submit ctrl enter max tab count web search fetch context conversation tool timeout shell grep",
  models: "enable disable model catalog reasoning effort thinking context",
  providers: "api key openai anthropic google openrouter oauth custom base url connect",
  behavior: "workspace context file reading terminal tools auto edits approval allow deny ask review policy allowlist denylist commands mcp web",
  personas: "persona system prompt custom",
  rules: "rules skills agents.md always apply glob",
  subagents: "subagents teams squad project mode delegate task tool members roster subagent model",
  mcp: "mcp tools servers",
  hooks: "hooks events commands",
  indexing: "codebase index embedding docs semantic sync",
  advanced: "system prompt custom instructions",
  about: "about version license author github repository open source mit pawan osman",
};

/** A group of related settings separated by subtle rules. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

function NumInput({
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: string;
  min?: string;
  max?: string;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={value == null ? "" : value}
      onChange={(e) => {
        const t = e.target.value.trim();
        onChange(t === "" ? null : Number(t));
      }}
    />
  );
}

function Row({
  title,
  desc,
  stacked,
  children,
}: {
  title: string;
  desc: string;
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={"row" + (stacked ? " stacked" : "")}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        <div className="row-desc">{desc}</div>
      </div>
      <ControlLabelContext.Provider value={title}>
        {stacked ? children : <div className="row-control">{children}</div>}
      </ControlLabelContext.Provider>
    </div>
  );
}

// ---- Approval policy editor ----

const APPROVAL_ACTIONS: { type: ApprovalActionType; label: string; desc: string; listHint: string; listsSupported: boolean }[] = [
  { type: "shell", label: "Terminal Commands", desc: "Shell commands the agent runs.", listHint: "command or prefix, e.g. git status, pnpm *, rm *", listsSupported: true },
  { type: "edits", label: "File Edits", desc: "Creating and modifying files (Write, StrReplace, notebooks).", listHint: "path glob, e.g. src/**, *.md, package.json", listsSupported: true },
  { type: "delete", label: "File Deletes", desc: "Deleting files.", listHint: "path glob, e.g. dist/**, *.log", listsSupported: true },
  { type: "mcp", label: "MCP Tools", desc: "Tools exposed by connected MCP servers.", listHint: "tool name or prefix, e.g. mcp__github__*", listsSupported: true },
  { type: "web", label: "Web Access", desc: "Web search and URL fetches.", listHint: "url or query pattern, e.g. https://github.com/*", listsSupported: true },
  { type: "outside", label: "Outside Workspace", desc: "Reading or writing files outside the workspace folder.", listHint: "absolute path glob, e.g. C:/Users/me/notes/**", listsSupported: true },
];

const APPROVAL_MODES: { id: ApprovalMode; label: string; desc: string }[] = [
  { id: "allow", label: "Allow", desc: "Run without asking" },
  { id: "review", label: "Auto Review", desc: "Ask only when it looks risky" },
  { id: "ask", label: "Ask", desc: "Prompt every time" },
  { id: "deny", label: "Deny", desc: "Always block" },
];

/** Comma/newline-separated pattern list editor. */
function PatternList({ label, values, hint, onChange }: { label: string; values: string[]; hint: string; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = React.useState("");
  const add = () => {
    const items = draft.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).filter((x) => !values.includes(x));
    if (items.length) onChange([...values, ...items]);
    setDraft("");
  };
  return (
    <div className="fc-field">
      <span>{label}</span>
      {values.length > 0 && (
        <div className="pattern-chips">
          {values.map((v) => (
            <span key={v} className="pattern-chip">
              <code>{v}</code>
              <button className="icon-btn" title="Remove" onClick={() => onChange(values.filter((x) => x !== v))}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="fc-inline-row">
        <input
          type="text"
          value={draft}
          placeholder={hint}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <button className="btn-ghost sm" disabled={!draft.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function ApprovalCard({
  action,
  policy,
  onChange,
}: {
  action: (typeof APPROVAL_ACTIONS)[number];
  policy: ApprovalPolicy;
  onChange: (p: ApprovalPolicy) => void;
}) {
  const r = policy[action.type] ?? DEFAULT_APPROVAL[action.type];
  const [open, setOpen] = React.useState(false);
  const patch = (p: Partial<typeof r>) => onChange({ ...policy, [action.type]: { ...r, ...p } });
  const hasLists = (r.allowlist?.length ?? 0) + (r.denylist?.length ?? 0) > 0;
  return (
    <div className="feature-card">
      <div className="fc-head" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name={open ? "chevD" : "chevR"} size={14} />
          <span>{action.label}</span>
          {hasLists && <span className="badge-tag glob">{(r.allowlist?.length ?? 0) + (r.denylist?.length ?? 0)} rules</span>}
        </div>
        <Select
          aria-label={`${action.label} approval`}
          value={r.mode}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => patch({ mode: e.target.value as ApprovalMode })}
          className={"approval-mode " + r.mode}
        >
          {APPROVAL_MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </Select>
      </div>
      {open && (
        <div className="fc-body">
          <p className="panel-hint" style={{ margin: 0 }}>
            {action.desc} Currently: <strong>{APPROVAL_MODES.find((m) => m.id === r.mode)?.desc}</strong>.
            Deny list always blocks; allow list always runs — both override the mode.
          </p>
          {action.listsSupported && (
            <>
              <PatternList label="Allow list (always run)" values={r.allowlist ?? []} hint={action.listHint} onChange={(v) => patch({ allowlist: v })} />
              <PatternList label="Deny list (always block)" values={r.denylist ?? []} hint={action.listHint} onChange={(v) => patch({ denylist: v })} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function UsagePanel({
  usage,
  oauthStatus,
  features,
  setFeatures,
}: {
  usage: Record<string, ModelUsage>;
  oauthStatus: OAuthStatus;
  features: FeatureConfig;
  setFeatures: (p: Partial<FeatureConfig>) => void;
}) {
  const [pending, setPending] = React.useState<"refresh" | "reset">();
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean }>();
  const [quotaRefresh, setQuotaRefresh] = React.useState(0);
  const actionRef = React.useRef<{ requestId: string; action: "refresh" | "reset"; timer: number } | undefined>(undefined);
  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      const active = actionRef.current;
      if (message?.type !== "usageActionResult" || !active || message.requestId !== active.requestId || message.action !== active.action) return;
      if (!["success", "cancelled", "error"].includes(message.status)) return;
      window.clearTimeout(active.timer);
      actionRef.current = undefined;
      setPending(undefined);
      setNotice(message.status === "error"
        ? { text: message.error || "The usage action failed. Try again.", error: true }
        : { text: message.status === "cancelled" ? "Usage reset cancelled." : active.action === "reset" ? "Recorded usage reset." : "Local usage refreshed. Account quota results are shown below." });
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (actionRef.current) window.clearTimeout(actionRef.current.timer);
      actionRef.current = undefined;
    };
  }, []);
  const runAction = (action: "refresh" | "reset") => {
    if (actionRef.current) return;
    const requestId = uid("usage");
    const timer = window.setTimeout(() => {
      if (actionRef.current?.requestId !== requestId) return;
      actionRef.current = undefined;
      setPending(undefined);
      setNotice({ text: "No response received. Refresh to check the current usage before trying again.", error: true });
    }, 30_000);
    actionRef.current = { requestId, action, timer };
    setPending(action);
    setNotice(undefined);
    if (action === "refresh") setQuotaRefresh(value => value + 1);
    vscode.postMessage({ type: action === "refresh" ? "getUsage" : "resetUsage", requestId });
  };
  const rows = Object.entries(usage).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
  const totals = rows.reduce(
    (t, [, u]) => ({ p: t.p + u.promptTokens, c: t.c + u.completionTokens, r: t.r + u.requests }),
    { p: 0, c: 0, r: 0 }
  );
  const max = Math.max(1, ...rows.map(([, u]) => u.promptTokens + u.completionTokens));
  return (
    <>
      <h1 className="page-title">Usage &amp; Quota</h1>

      <div className="section-label">Token Usage</div>
      <div className="index-card">
        <div className="index-card-title">Total</div>
        <p className="row-desc">
          {fmtTokens(totals.p)} input · {fmtTokens(totals.c)} output tokens across {totals.r} request attempt{totals.r === 1 ? "" : "s"} with reported usage. Includes billed retries. Tracked locally on this machine.
        </p>
        {rows.length === 0 ? (
          <div className="empty-card" style={{ marginTop: 12 }}>No usage recorded yet. Start chatting to see per-model token usage.</div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {rows.map(([model, u]) => {
              const total = u.promptTokens + u.completionTokens;
              return (
                <div key={model} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 12 }}>
                    <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</span>
                    <span className="row-desc" style={{ flex: "0 0 auto" }}>
                      {fmtTokens(u.promptTokens)} in · {fmtTokens(u.completionTokens)} out · {u.requests} req
                    </span>
                  </div>
                  <div className="row-desc" style={{ marginBottom: 4 }}><CacheUsage usage={u} /></div>
                  <div className="index-bar"><div className="index-bar-fill" style={{ width: `${Math.max(2, Math.round((total / max) * 100))}%` }} /></div>
                </div>
              );
            })}
          </div>
        )}
        <div className="index-actions">
          <button className="btn-secondary" disabled={!!pending} onClick={() => runAction("refresh")}>
            <Icon name="reset" /> {pending === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="btn-secondary danger"
            disabled={rows.length === 0 || !!pending}
            onClick={() => runAction("reset")}
          >
            <Icon name="trash" /> {pending === "reset" ? "Awaiting reset…" : "Reset Usage"}
          </button>
        </div>
        {notice && <p className="row-desc" role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      </div>

      <Group>
        <Row title="Track Usage" desc="Record per-model token usage locally. No data ever leaves your machine.">
          <Toggle checked={features.trackUsage !== false} onChange={(v) => setFeatures({ trackUsage: v })} />
        </Row>
      </Group>

      {/*
        Hidden unless there is an account to show. SleepyCode has one first-party
        account and optional key-based endpoints — no OAuth provider accounts at
        all — so this block could only ever be empty, and its empty state pointed
        at a Providers page this build does not include. An empty block reads as
        broken; absent reads as absent.
      */}
      {shouldShowAccountQuota(oauthStatus) && (
        <>
          <div className="section-label">Account Quota</div>
          <p className="panel-hint">Rate-limit windows for your connected OAuth accounts ({oauthStatus.accounts.map((a) => OAUTH_LABEL[a.kind]).join(", ")}).</p>
          {oauthStatus.accounts.map((a) => <OAuthAccountCard key={a.id} account={a} defaultOpen refreshToken={quotaRefresh} />)}
        </>
      )}
    </>
  );
}

/** Provider models usable for embeddings (id mentions embed/embedding). */
const isEmbeddingModel = (id: string) => /embed/i.test(id);

function IndexingPanel({
  status,
  models,
  modelList,
  docs,
  docsStatus,
  features,
  setFeatures,
}: {
  status: IndexStatus;
  models: EmbedModel[];
  modelList: ModelDef[];
  docs: DocSourceInfo[];
  docsStatus: DocsStatus;
  features: FeatureConfig;
  setFeatures: (p: Partial<FeatureConfig>) => void;
}) {
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : status.files > 0 ? 100 : 0;
  const remoteEmbed = modelList.filter((m) => isEmbeddingModel(m.id));
  const accel = status.accelerator || "pending";
  const accelClass =
    accel === "gpu" ? "gpu" : accel === "cpu" ? "cpu" : accel === "remote" ? "remote" : "pending";
  const accelText =
    accel === "gpu" ? "GPU" : accel === "cpu" ? "CPU" : accel === "remote" ? "Remote" : "Loading...";
  return (
    <>
      <h1 className="page-title">Indexing &amp; Docs</h1>
      <div className="section-label">Codebase</div>
      <div className="index-card">
        <div className="index-card-title">Codebase Indexing</div>
        <p className="row-desc">
          Embed codebase for improved contextual understanding and knowledge. Embeddings and metadata are
          stored locally on your machine - your code never leaves your computer. The index persists across
          restarts; only new or changed files are re-embedded.
        </p>
        <div className="index-divider" />
        <Row title="Enable Indexing" desc="When off, background embedding stops. Existing index files stay on disk; text search remains available.">
          <Toggle
            checked={features.indexingEnabled !== false}
            onChange={(v) => setFeatures({ indexingEnabled: v })}
          />
        </Row>
        <div className="index-progress" style={{ opacity: features.indexingEnabled === false ? 0.5 : 1 }}>
          <div className="index-progress-pct">{pct}%</div>
          <div className="index-bar">
            <div className="index-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="index-progress-meta">
            {features.indexingEnabled === false
              ? `Disabled - ${status.files} files on disk`
              : status.indexing
              ? `Indexing ${status.done} / ${status.total} files...`
              : `${status.files} files / ${status.chunks || 0} chunks`}
          </div>
          {status.limitReason && <div className="index-progress-meta" role="status">{status.limitReason}</div>}
        </div>
        <div className="index-divider" />
        <div className="index-runtime">
          <div className="index-runtime-head">
            <span className={`index-accel-badge ${accelClass}`}>{accelText}</span>
            <span className="index-runtime-device">{status.deviceLabel || "-"}</span>
          </div>
          <dl className="index-tech">
            <div>
              <dt>Model</dt>
              <dd>
                <code>{status.model}</code>
              </dd>
            </div>
            {status.modelRepo && (
              <div>
                <dt>Repo</dt>
                <dd>
                  <code>{status.modelRepo}</code>
                </dd>
              </div>
            )}
            {status.modelDtype && (
              <div>
                <dt>Dtype</dt>
                <dd>
                  <code>{status.modelDtype}</code>
                </dd>
              </div>
            )}
            {status.modelPooling && (
              <div>
                <dt>Pooling</dt>
                <dd>
                  <code>{status.modelPooling}</code>
                </dd>
              </div>
            )}
            {status.modelDim != null && (
              <div>
                <dt>Dimensions</dt>
                <dd>
                  <code>{status.modelDim}</code>
                </dd>
              </div>
            )}
            {status.device != null && status.device !== "" && (
              <div>
                <dt>ONNX EP</dt>
                <dd>
                  <code>{status.device}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Backend</dt>
              <dd>
                <code>{status.backend || "local"}</code>
              </dd>
            </div>
            {status.remoteBaseUrl && (
              <div>
                <dt>Endpoint</dt>
                <dd>
                  <code>{status.remoteBaseUrl}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Runtime</dt>
              <dd>
                <code>{status.runtime || "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>
                <code>{status.platform || "—"}</code>
              </dd>
            </div>
          </dl>
        </div>
        <div className="index-divider" />
        <div className="index-model-row">
          <span className="index-model-label">Embedding model</span>
          <ModelSelect
            models={remoteEmbed}
            value={status.model}
            onChange={(id) => !status.indexing && features.indexingEnabled !== false && vscode.postMessage({ type: "setEmbedModel", modelId: id })}
            customItems={models.map((m) => ({ value: m.id, label: m.name, desc: "local - runs on your machine" }))}
            style={{ maxWidth: 260 }}
          />
          <div className="index-actions" style={{ marginTop: 0, marginLeft: "auto" }}>
            <button className="btn-secondary" disabled={status.indexing || features.indexingEnabled === false} onClick={() => vscode.postMessage({ type: "syncIndex" })}>
              <Icon name="reset" /> {status.indexing ? "Syncing..." : "Sync"}
            </button>
            <button className="btn-secondary danger" disabled={status.indexing} onClick={() => vscode.postMessage({ type: "deleteIndex" })}>
              <Icon name="trash" /> Delete Index
            </button>
          </div>
        </div>
      </div>
      <div className="index-card rows-card">
        <Row title="Index New Folders" desc="Automatically index any new folders added to the workspace">
          <Toggle checked={features.indexNewFolders !== false} onChange={(v) => setFeatures({ indexNewFolders: v })} disabled={features.indexingEnabled === false} />
        </Row>
        <Row title="Ignore Files in .cursorignore" desc="Files to exclude from indexing in addition to .gitignore">
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openCursorignore" })}>Edit</button>
        </Row>
        <Row title="Index Repositories for Instant Grep" desc="Automatically index repositories to speed up Grep searches. All data is stored locally.">
          <Toggle checked={features.indexForGrep !== false} onChange={(v) => setFeatures({ indexForGrep: v })} disabled={features.indexingEnabled === false} />
        </Row>
      </div>
      <DocsSection docs={docs} status={docsStatus} />
    </>
  );
}

export function App() {
  const [section, setSection] = React.useState<Section>("general");
  // Set when a jump asked for a section this build does not serve, so the
  // reason for landing elsewhere is on screen rather than only in the log.
  const [sectionNotice, setSectionNotice] = React.useState("");
  // Result of a rule/skill action. The host can refuse (a path that is not an
  // installed skill, a name already taken), and a refusal that shows nowhere
  // reads as a button that did nothing.
  const [panelNotice, setPanelNotice] = React.useState<{ text: string; error: boolean } | null>(null);
  // First-run setup, the danger-zone counter, and the log viewer.
  const [firstRun, setFirstRun] = React.useState(false);
  const [resetClicks, setResetClicks] = React.useState(0);
  // Derived, not tracked: two sources for "is it armed" is how they disagree.
  const resetArmed = isResetArmed(resetClicks);
  const [logs, setLogs] = React.useState<unknown[]>([]);
  // Provider rows from the host. Keys are never included: only whether one is set
  // and its tail.
  const [version, setVersion] = React.useState("");
  const [providers, setProviders] = React.useState<{ id: string; name: string; baseUrl: string; models: string[]; isSleepy: boolean; active: boolean; hasKey: boolean; keyHint: string }[]>([]);
  const contentRef = React.useRef<HTMLElement>(null);
  const [s, setS] = React.useState<Settings>(DEFAULTS);
  const [apiKey, setApiKey] = React.useState("");
  const [models, setModels] = React.useState<string[]>([]);
  const [modelList, setModelList] = React.useState<ModelDef[]>([]);
  const [features, setFeaturesState] = React.useState<FeatureConfig>(EMPTY_FEATURES);
  const [mcpStatus, setMcpStatus] = React.useState<McpStatus[]>([]);
  const [rules, setRules] = React.useState<RuleInfo[]>([]);
  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [builtinPersonas, setBuiltinPersonas] = React.useState<Persona[]>([]);
  const [modelCatalog, setModelCatalog] = React.useState<ModelDef[]>([]);
  const [indexStatus, setIndexStatus] = React.useState<IndexStatus>({ indexing: false, done: 0, total: 0, files: 0, chunks: 0, model: "minilm" });
  const [embedModels, setEmbedModels] = React.useState<EmbedModel[]>([]);
  const [docSources, setDocSources] = React.useState<DocSourceInfo[]>([]);
  const [docsStatus, setDocsStatus] = React.useState<DocsStatus>({ done: 0, total: 0 });
  const [llamacppStatus, setLlamacppStatus] = React.useState<LlamacppStatus>({ installed: false, running: {}, loading: {}, errors: {}, logs: {} });
  const [ollamaStatus, setOllamaStatus] = React.useState<OllamaStatus>({ installed: false, pulling: {}, errors: {} });
  const [ollamaModels, setOllamaModels] = React.useState<OllamaModel[]>([]);
  const [oauthStatus, setOauthStatus] = React.useState<OAuthStatus>({ accounts: [], errors: {} });
  const [usage, setUsage] = React.useState<Record<string, ModelUsage>>({});
  const [navQuery, setNavQuery] = React.useState("");

  React.useEffect(() => { setMotionPreference(features.motion); }, [features.motion]);

  React.useLayoutEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
      contentRef.current.scrollLeft = 0;
    }
  }, [section]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  // Patch + persist features immediately.
  const setFeatures = (patch: Partial<FeatureConfig>) => {
    setFeaturesState((prev) => ({ ...prev, ...patch }));
    // Other views can update model options while this settings page stays open.
    vscode.postMessage({ type: "saveFeatures", features: patch });
  };

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "loadSettings") {
        setS({ ...DEFAULTS, ...msg.settings });
      } else if (msg.type === "navigate") {
        if (msg.section) {
          // A hidden or unknown section renders nothing at all, which reads as a
          // broken settings page. Resolve it to one this build serves and say so
          // — silently landing the user somewhere else is worse than the truth.
          const target = visibleSection(msg.section);
          if (target !== msg.section) setSectionNotice(`“${msg.section}” is not part of this build, so ${target === "general" ? "General" : target} is shown instead.`);
          else setSectionNotice("");
          setSection(target as Section);
        }
      } else if (msg.type === "modelsFetched") {
        setModels(msg.models || []);
        if (msg.modelList) setModelList(msg.modelList);
      } else if (msg.type === "features") {
        setFeaturesState({ ...EMPTY_FEATURES, ...msg.features });
        setMcpStatus(msg.mcpStatus || []);
        setRules(msg.rules || []);
        setSkills(msg.skills || []);
        setBuiltinPersonas(msg.builtinPersonas || []);
        setModelCatalog(msg.modelCatalog || []);
      } else if (msg.type === "indexStatus") {
        setIndexStatus(msg.status);
        if (msg.models) setEmbedModels(msg.models);
      } else if (msg.type === "docSources") {
        setDocSources(msg.docs || []);
        if (msg.status) setDocsStatus(msg.status);
      } else if (msg.type === "docsStatus") {
        setDocsStatus(msg.status);
        // Refresh doc list when an indexing run finishes.
        if (!msg.status?.indexing) vscode.postMessage({ type: "getIndexStatus" });
      } else if (msg.type === "llamacppStatus") {
        setLlamacppStatus(msg.status);
      } else if (msg.type === "ollamaStatus") {
        setOllamaStatus(msg.status);
      } else if (msg.type === "ollamaModels") {
        setOllamaModels(msg.models || []);
      } else if (msg.type === "appInfo") {
        setVersion(String(msg.version || ""));
      } else if (msg.type === "providers") {
        setProviders(msg.providers || []);
      } else if (msg.type === "firstRun") {
        setFirstRun(true);
      } else if (msg.type === "logs") {
        setLogs(msg.entries || []);
      } else if (msg.type === "resetDone") {
        setResetClicks(0);
        setPanelNotice({ text: "Every setting is back to its default.", error: false });
      } else if (msg.type === "panelNotice") {
        setPanelNotice({ text: msg.text || "", error: !!msg.error });
      } else if (msg.type === "oauthStatus") {
        setOauthStatus(msg.status);
      } else if (msg.type === "usageData") {
        setUsage(msg.usage || {});
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getSettings" });
    vscode.postMessage({ type: "getFeatures" });
    vscode.postMessage({ type: "getIndexStatus" });
    vscode.postMessage({ type: "getUsage" });
    vscode.postMessage({ type: "oauthGet" });
    return () => window.removeEventListener("message", handler);
  }, []);

  // Refresh usage numbers whenever the Usage & Quota page is opened.
  // A partly-armed reset decays on its own.
  React.useEffect(() => {
    if (resetClicks === 0) return;
    const timer = window.setTimeout(() => setResetClicks(0), RESET_ARM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [resetClicks]);

  React.useEffect(() => {
    if (section === "usage") vscode.postMessage({ type: "getUsage" });
    // Logs are only useful fresh; read them when the page is opened.
    if (section === "advanced") vscode.postMessage({ type: "getLogs" });
    if (section === "providers") vscode.postMessage({ type: "getProviders" });
  }, [section]);

  // Fetch models across every enabled provider (grouped). Disabled providers are skipped.
  const fetchModels = () => vscode.postMessage({ type: "fetchAllModels" });

  const save = () => {
    const payload: any = { type: "saveSettings", settings: s };
    if (apiKey) payload.apiKey = apiKey;
    vscode.postMessage(payload);
  };

  // OpenCursor-only sections stay in NAV so they can be switched back on, but
  // the rail only ever renders sections SleepyCode actually implements.
  const visibleNav = filterSections(NAV);
  const navFiltered = navQuery.trim()
    ? visibleNav.filter((n) => {
        const q = navQuery.trim().toLowerCase();
        return n.label.toLowerCase().includes(q) || (SECTION_KEYWORDS[n.id] || "").includes(q);
      })
    : visibleNav;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-badge" src={document.getElementById("root")?.dataset.icon} alt="" />
          <span>
            <span className="brand-name">Settings</span>
            <span className="brand-sub">SleepyCode</span>
          </span>
        </div>
        <input
          className="nav-search"
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          value={navQuery}
          onChange={(e) => setNavQuery(e.target.value)}
        />
        {navFiltered.map((n) => (
          <React.Fragment key={n.id}>
            {n.sep && !navQuery && <div className="nav-sep" />}
            <button className={"nav-item" + (section === n.id ? " active" : "")} aria-current={section === n.id ? "page" : undefined} onClick={() => { setSectionNotice(""); setSection(n.id); }}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </button>
            {n.id === "general" && !navQuery && (
              <button className="nav-item" onClick={() => vscode.postMessage({ type: "openVsCodeSettings" })}>
                <Icon name="code" />
                <span>VS Code Settings ↗</span>
              </button>
            )}
          </React.Fragment>
        ))}
      </aside>

      <main className="content" ref={contentRef}>
        <div className="settings-page">
        <div className="content-inner" key={section}>
          {sectionNotice && <div className="panel-hint" role="status" style={{ marginTop: 0 }}>{sectionNotice}</div>}
          {firstRun && (
            <div className="first-run" role="dialog" aria-label={FIRST_RUN_TITLE}>
              <div className="first-run-title">{FIRST_RUN_TITLE}</div>
              <p className="first-run-body">{FIRST_RUN_BODY}</p>
              <div className="first-run-actions">
                <button className="btn-primary" onClick={() => { setFirstRun(false); vscode.postMessage({ type: "completeSetup" }); vscode.postMessage({ type: "signIn" }); }}>{FIRST_RUN_ACTION}</button>
                <button className="btn-ghost" onClick={() => { setFirstRun(false); vscode.postMessage({ type: "completeSetup" }); }}>{FIRST_RUN_DISMISS}</button>
              </div>
            </div>
          )}
          {panelNotice?.text && (
            <div className="panel-hint" role={panelNotice.error ? "alert" : "status"} style={{ marginTop: 0 }}>{panelNotice.text}</div>
          )}
          {section === "general" && (
            <>
              <h1 className="page-title">General</h1>

              <Group>
                {/* The Providers section is served now, so this row links to it
                    instead of apologising for its absence. */}
                <Row title="Providers & API Keys" desc="SleepyAI is the built-in provider. Add a compatibility endpoint and its key on the Providers page.">
                  <button className="btn-secondary" onClick={() => { setSectionNotice(""); setSection("providers"); }}>Open</button>
                </Row>
              </Group>

              <div className="section-label">Preferences</div>
              <Group>
                <Row title="Animations" desc="Enable animated loading indicators and transitions, follow your system preference, or reduce motion.">
                  <Select aria-label="Animations" value={features.motion} onChange={(event) => setFeatures({ motion: event.target.value as MotionPreference })}>
                    <option value="full">Enabled</option>
                    <option value="system">Follow system</option>
                    <option value="reduced">Reduced motion</option>
                  </Select>
                </Row>
                <Row title="Editor Settings" desc="Configure font, formatting, minimap and more.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openEditorSettings" })}>Open ↗</button>
                </Row>
                <Row title="Keyboard Shortcuts" desc="Configure keyboard shortcuts.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openKeyboardShortcuts" })}>Open ↗</button>
                </Row>
                <Row title="VS Code Settings" desc="Open the native VS Code settings UI.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openVsCodeSettings" })}>Open ↗</button>
                </Row>
              </Group>

              <div className="section-label">Chat</div>
              <Group>
                {/* Removed: "Auto-Generate Chat Titles". The host generates a title
                    from the conversation with no gate to toggle, so the row saved
                    nowhere and snapped back on the next open. */}
                <Row title="Per-Tab Composer Drafts" desc="Keep a separate unsent message per chat tab. When off, the composer text follows you between tabs.">
                  <Toggle checked={features.perTabDrafts === true} onChange={(v) => setFeatures({ perTabDrafts: v })} />
                </Row>
                {/* Auto model (judge routing) hidden for now — bring back later.
                <Row title="Auto Judge Model" desc="When the chat model is set to Auto, this judge model picks the best enabled model for each task.">
                  <ModelSelect
                    models={modelList.length ? modelList : [...modelCatalog, ...(features.customModels || [])].filter((m) => features.enabledModels.includes(m.id))}
                    value={features.autoJudgeModel}
                    onChange={(id) => setFeatures({ autoJudgeModel: id })}
                    customItems={[{ value: "", label: "First enabled model", desc: "use the first model in the picker" }]}
                    style={{ maxWidth: 240 }}
                  />
                </Row>
                */}
              </Group>

              <div className="section-label">Notifications</div>
              <Group>
                <Row title="System Notifications" desc="Show a notification when the agent finishes responding while the window is unfocused.">
                  <Toggle checked={features.notifyOnComplete !== false} onChange={(v) => setFeatures({ notifyOnComplete: v })} />
                </Row>
                <Row title="Completion Sound" desc="Play a sound when the agent finishes responding.">
                  <Toggle checked={features.completionSound === true} onChange={(v) => setFeatures({ completionSound: v })} />
                </Row>
              </Group>

              <div className="section-label">Privacy</div>
              <p className="panel-hint">
                SleepyCode is fully local and open source. There is no SleepyCode backend - your code,
                keys and conversations stay on your machine and are only ever sent to the AI providers
                you configure yourself.
              </p>
              <Group>
                <Row title="Local-First" desc="Conversations, settings and workspace context are stored on this device (VS Code global storage).">
                  <span className="badge-tag always">Always on</span>
                </Row>
                <Row title="Secure Key Storage" desc="API keys and OAuth tokens are kept in the OS secret store (VS Code SecretStorage), never in plain-text settings or synced files.">
                  <span className="badge-tag always">Encrypted</span>
                </Row>
                <Row title="No Telemetry" desc="SleepyCode collects no analytics, usage metrics or crash reports. The only outbound requests are the AI calls you trigger to your configured providers.">
                  <span className="badge-tag always">None</span>
                </Row>
                <Row title="You Choose the Destination" desc="Every request goes to the exact provider you set up — a hosted API, your own OpenAI/Anthropic-compatible endpoint, or a fully offline model via llama.cpp / Ollama.">
                  <span className="badge-tag">Your providers</span>
                </Row>
                <Row title="Open Source" desc="The full source is public and MIT-licensed, so anyone can audit exactly what the extension does with your data.">
                  <span className="badge-tag glob">MIT</span>
                </Row>
              </Group>
            </>
          )}

          {section === "agents" && (
            <>
              <h1 className="page-title">Agents</h1>

              <Group>
                <Row title="Text Size" desc="Adjust the conversation text size.">
                  <Select
                    aria-label="Text size"
                    value={features.chatTextSize || "default"}
                    onChange={(e) => setFeatures({ chatTextSize: e.target.value as FeatureConfig["chatTextSize"] })}
                  >
                    <option value="compact">Compact</option>
                    <option value="default">Default</option>
                    <option value="large">Large</option>
                  </Select>
                </Row>
                <Row title="Submit with Ctrl + Enter" desc="When enabled, Ctrl + Enter submits chat and Enter inserts a newline.">
                  <Toggle checked={features.submitWithCtrlEnter === true} onChange={(v) => setFeatures({ submitWithCtrlEnter: v })} />
                </Row>
                <Row title="Max Tab Count" desc="Limit how many chat tabs can be open at once (0 = unlimited).">
                  <NumInput value={features.maxTabCount || null} step="1" min="0" placeholder="unlimited" onChange={(v) => setFeatures({ maxTabCount: v ?? 0 })} />
                </Row>
              </Group>

              <div className="section-label">Run Limits</div>
              <Group>
                <Row title="Max Agent Steps" desc="Pause the agent after this many steps in a single run (0 = default 50).">
                  <NumInput value={features.maxAgentSteps || null} step="1" min="0" placeholder="50" onChange={(v) => setFeatures({ maxAgentSteps: v ?? 0 })} />
                </Row>
                <Row title="Auto Continue" desc="Automatically continue when the step limit is reached instead of pausing.">
                  <Toggle checked={features.autoContinue === true} onChange={(v) => setFeatures({ autoContinue: v })} />
                </Row>
              </Group>

              <div className="section-label">Tool Timeouts</div>
              <p className="panel-hint">Hard timeout per tool (seconds). Empty = built-in default. Prevents a hung tool from blocking the agent forever.</p>
              <Group>
                {TOOL_TIMEOUT_DEFAULTS.map(({ name, sec }) => {
                  const overrides = features.toolTimeoutsSec || {};
                  const val = overrides[name];
                  return (
                    <Row key={name} title={name} desc={`Default ${sec}s`}>
                      <NumInput
                        value={val != null && val > 0 ? val : null}
                        step="1"
                        min="1"
                        placeholder={String(sec)}
                        onChange={(v) => {
                          const next = { ...(features.toolTimeoutsSec || {}) };
                          if (v == null || v <= 0) delete next[name];
                          else next[name] = Math.floor(v);
                          setFeatures({ toolTimeoutsSec: next });
                        }}
                      />
                    </Row>
                  );
                })}
              </Group>

              <div className="section-label">Subagents</div>
              <p className="panel-hint">
                Subagents, teams and the default subagent model live in the <button className="link-btn" onClick={() => setSection("subagents")}>Subagents &amp; Teams</button> tab.
              </p>

              <div className="section-label">Context</div>
              <Group>
                <Row title="Web Search Tool" desc="Allow the agent to search the web for relevant information.">
                  <Toggle checked={features.webSearchEnabled !== false} onChange={(v) => setFeatures({ webSearchEnabled: v })} />
                </Row>
                <Row title="Web Fetch Tool" desc="Allow the agent to fetch content from URLs.">
                  <Toggle checked={features.webFetchEnabled !== false} onChange={(v) => setFeatures({ webFetchEnabled: v })} />
                </Row>
              </Group>

              <div className="section-label">Approvals &amp; Execution</div>
              <p className="panel-hint">
                Tool capabilities and approval gates live in the <button className="link-btn" onClick={() => setSection("behavior")}>Behavior</button> tab.
              </p>
            </>
          )}

          {section === "usage" && (
            <UsagePanel usage={usage} oauthStatus={oauthStatus} features={features} setFeatures={setFeatures} />
          )}

          {/* SleepyCode's own provider surface. The ported OpenCursor panel needs
              its own provider store (accounts, OAuth, balances), none of which
              exists here, so this section renders the panel that matches what
              SleepyCode actually supports. */}
          {section === "providers" && <ProviderKeysPanel providers={providers} />}

          {section === "models" && (
            <ModelsPanel
              models={models}
              modelList={modelList}
              features={features}
              setFeatures={setFeatures}
              fetchModels={fetchModels}
              catalog={modelCatalog}
              llamacppStatus={llamacppStatus}
              ollamaModels={ollamaModels}
              oauthStatus={oauthStatus}
            />
          )}

          {section === "llamacpp" && !isSectionHidden("llamacpp") && <LlamacppPanel features={features} status={llamacppStatus} />}

          {section === "ollama" && !isSectionHidden("ollama") && <OllamaPanel status={ollamaStatus} models={ollamaModels} />}

          {section === "personas" && !isSectionHidden("personas") && <PersonasPanel features={features} setFeatures={setFeatures} builtinPersonas={builtinPersonas} />}

          {section === "rules" && <RulesPanel rules={rules} skills={skills} />}

          {section === "marketplace" && <MarketplacePanel />}

          {section === "subagents" && !isSectionHidden("subagents") && <SubagentsPanel features={features} setFeatures={setFeatures} models={models} modelList={modelList} />}

          {section === "mcp" && (
            <McpPanel
              features={features}
              setFeatures={setFeatures}
              status={mcpStatus}
              onSync={() => vscode.postMessage({ type: "syncMcp" })}
            />
          )}

          {section === "hooks" && !isSectionHidden("hooks") && <HooksPanel features={features} setFeatures={setFeatures} />}

          {section === "behavior" && (
            <>
              <h1 className="page-title">Behavior</h1>
              <div className="section-label">Capabilities</div>
              <Group>
                <Row title="Workspace Context" desc="Include workspace info in the agent's context.">
                  <Toggle checked={s.enableWorkspaceContext} onChange={(v) => set("enableWorkspaceContext", v)} />
                </Row>
                {/* Removed: "Terminal Tools". Tool availability is gated by the
                    agent mode, not by a setting, so the toggle could never
                    take effect. */}
              </Group>

              <div className="section-label">Approvals &amp; Execution</div>
              <p className="panel-hint">
                Per-action approval policy. <strong>Allow</strong> runs silently, <strong>Auto Review</strong> only asks
                for risky-looking actions (destructive commands, secrets, deletes), <strong>Ask</strong> prompts every
                time, <strong>Deny</strong> always blocks. Allow/deny lists override the mode per command or file pattern.
              </p>
              {APPROVAL_ACTIONS.map((a) => (
                <ApprovalCard
                  key={a.type}
                  action={a}
                  policy={{ ...DEFAULT_APPROVAL, ...(features.approvalPolicy ?? {}) }}
                  onChange={(p) => setFeatures({ approvalPolicy: p })}
                />
              ))}
              <div className="panel-actions">
                <button
                  className="btn-ghost sm"
                  onClick={() => setFeatures({ approvalPolicy: DEFAULT_APPROVAL })}
                >
                  <Icon name="reset" size={13} /> Reset policy to defaults
                </button>
              </div>
            </>
          )}

          {section === "indexing" && !isSectionHidden("indexing") && (
            <IndexingPanel status={indexStatus} models={embedModels} modelList={modelList} docs={docSources} docsStatus={docsStatus} features={features} setFeatures={setFeatures} />
          )}

          {section === "advanced" && (
            <>
              <h1 className="page-title">Advanced</h1>
              <div className="section-label">Custom Instructions</div>
              <Group>
                <Row title="System Prompt" desc="Prepended to the agent's system prompt for every request." stacked>
                  <textarea rows={6} value={s.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} />
                </Row>
              </Group>

              <div className="section-label">Extension log</div>
              <p className="panel-hint">
                {logTally(logs).total === 0
                  ? logEmptyText()
                  : `${logTally(logs).total} entries · ${logTally(logs).error} error${logTally(logs).error === 1 ? "" : "s"}, ${logTally(logs).warn} warning${logTally(logs).warn === 1 ? "" : "s"}.`}
              </p>
              <div className="log-actions">
                <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "getLogs" })}>Refresh</button>
                <button className="btn-ghost" onClick={() => vscode.postMessage({ type: "clearLogs" })}>Clear</button>
              </div>
              {logLines(logs).length > 0 && (
                <pre className="log-view" aria-label="Extension log">{logLines(logs).join("\n")}</pre>
              )}

              <div className="section-label">Danger zone</div>
              <p className="panel-hint">{RESET_CONSEQUENCE}</p>
              {/* Three clicks, and leaving the button disarms it: a single press
                  that wipes every setting is a trap. */}
              <button
                className={"btn-secondary danger" + (resetArmed ? " armed" : "")}
                onClick={() => {
                  const next = nextResetClicks(resetClicks, "click");
                  setResetClicks(next);
                  if (isResetArmed(next)) {
                    vscode.postMessage({ type: "resetAllSettings" });
                    setResetClicks(0);
                  }
                }}
                onBlur={() => setResetClicks(0)}
              >
                {resetLabel(resetClicks)}
              </button>
            </>
          )}
          {section === "about" && (
            <>
              <h1 className="page-title">About</h1>
              <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "6px 0 18px" }}>
                <img src={document.getElementById("root")?.dataset.icon} alt="" style={{ width: 48, height: 48, borderRadius: 10 }} />
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>SleepyCode</div>
                  <div className="row-desc" style={{ margin: 0 }}>
                    AI coding agent chat inside VS Code — local, open source.
                    {version && <span className="about-version"> · v{version}</span>}
                  </div>
                </div>
              </div>
              <Group>
                <Row title="Author" desc="Created and maintained by Tahsin Arafat.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/TahsinArafat" })}>GitHub ↗</button>
                </Row>
                <Row title="Repository" desc="Source code, issues and contributions.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/TahsinArafat/SleepyCode-VSCode" })}>Open ↗</button>
                </Row>
                <Row title="Report an Issue" desc="Found a bug or have a feature request?">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/TahsinArafat/SleepyCode-VSCode/issues" })}>Issues ↗</button>
                </Row>
                <Row title="License" desc="Free and open source under the MIT License.">
                  <span className="badge-tag glob">MIT</span>
                </Row>
              </Group>
              {/*
                The React chat UI is based on OpenCursor by Pawan Osman, used
                under the MIT License. Crediting it is a licence obligation, so
                this row stays even though it is no longer our product name —
                which is why the branding guard allows the name on an
                attribution line only.
              */}
              <Group>
                <Row title="Based on" desc="This chat UI is based on OpenCursor by Pawan Osman, used under the MIT License.">
                  <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "openExternal", url: "https://github.com/PawanOsman/OpenCursor" })}>Upstream ↗</button>
                </Row>
              </Group>
              <p className="panel-hint">Copyright © 2026 Pawan Osman for the original work, licensed under the MIT License.</p>
            </>
          )}

        </div>
        </div>
        {(section === "behavior" || section === "advanced") && (
          <footer className="settings-actions" aria-label="Settings actions">
            <div className="settings-actions-inner">
              {/* Only where there is something to save: every other page either
                  writes immediately or has nothing to write, and a Save button
                  that does nothing reads as a broken app. */}
              <button className="btn-save" onClick={save}>Save</button>
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}
