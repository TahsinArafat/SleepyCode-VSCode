/*
 * Skill Marketplace panel.
 *
 * Written for SleepyCode rather than ported: OpenCursor's settings window has no
 * marketplace section, and SleepyCode already has the whole backend (search the
 * SkillsMP catalogue, list a repository's skills, install, uninstall). This panel
 * is only the surface.
 *
 * The protocol matches SleepyCode's existing messages on purpose
 * (`marketplaceSearch`, `marketplaceInstall`, `marketplaceUninstall`,
 * `requestMarketplaceInstalled`), so the host handlers that already exist serve
 * it and no parallel API had to be invented.
 */

import * as identity from "../../../src/skill-identity.ts";
import * as React from 'react';
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import { Select } from "../../shared/Select";

export interface MarketplaceRow {
  name: string;
  description: string;
  author: string;
  stars: number;
  source?: string;
  installed: boolean;
}

export interface InstalledSkillRow {
  name: string;
  description: string;
  folder: string;
  path: string;
  /** `owner/repo:name`, when the folder records a vendor. */
  key?: string;
}

export function MarketplacePanel() {
  const [query, setQuery] = React.useState("");
  const [sortBy, setSortBy] = React.useState<"stars" | "recent">("stars");
  const [rows, setRows] = React.useState<MarketplaceRow[]>([]);
  const [installed, setInstalled] = React.useState<InstalledSkillRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ text: string; error?: boolean }>();
  const [pending, setPending] = React.useState<string>();

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "marketplaceResults") {
        setRows(msg.skills || []);
        setBusy(false);
        setNotice(msg.query ? { text: `Found ${msg.total ?? (msg.skills || []).length} skill(s) for "${msg.query}".` } : undefined);
      } else if (msg?.type === "marketplaceInstalled") {
        setInstalled(msg.skills || []);
      } else if (msg?.type === "marketplaceResult") {
        setPending(undefined);
        setNotice({ text: msg.text || (msg.ok ? "Done." : "That did not work."), error: !msg.ok });
        // The installed list changed either way; refresh it rather than guess.
        if (msg.ok) vscode.postMessage({ type: "requestMarketplaceInstalled" });
      } else if (msg?.type === "marketplaceError") {
        setBusy(false);
        setPending(undefined);
        setNotice({ text: msg.text || "The marketplace is unavailable.", error: true });
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "marketplaceTop", sortBy: "stars" });
    vscode.postMessage({ type: "requestMarketplaceInstalled" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const search = () => {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setNotice(undefined);
    vscode.postMessage({ type: "marketplaceSearch", query: text, limit: 20, sortBy });
  };

  const install = (row: MarketplaceRow) => {
    if (!row.source) return;
    setPending(row.name);
    setNotice(undefined);
    vscode.postMessage({ type: "marketplaceInstall", source: row.source, skill: row.name });
  };

  const uninstall = (row: InstalledSkillRow) => {
    setPending(row.name);
    setNotice(undefined);
    vscode.postMessage({ type: "marketplaceUninstall", folder: row.folder });
  };

  // Identity is the vendor AND the name. Matching on the name alone marked one
  // vendor's skill as installed because another vendor's copy of it was.
  const skillKey = (name: string) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const installedKeys = new Set(installed.map((skill) => skill.key || skillKey(skill.name)));
  const rowKey = (row: { name: string; source?: string }) =>
    row.source ? `${skillKey(row.source).replace(/-/g, "-")}:${skillKey(row.name)}` : skillKey(row.name);

  return (
    <>
      <h1 className="page-title">Skill Marketplace</h1>
      <p className="panel-hint">
        Skills add domain knowledge and workflows the agent can invoke. Installed skills are available in every workspace.
      </p>

      <div className="section-label">Discover</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") search(); }}
          placeholder="Search skills, e.g. react testing, web scraper, seo"
          spellCheck={false}
          aria-label="Search skills"
          style={{ flex: 1 }}
        />
        <Select value={sortBy} onChange={(event) => setSortBy(event.target.value as "stars" | "recent")} aria-label="Sort by">
          <option value="stars">Popular</option>
          <option value="recent">Recently updated</option>
        </Select>
        <button className="btn-primary" onClick={search} disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {notice && <div className={notice.error ? "fc-error" : "row-desc"} role={notice.error ? "alert" : undefined}>{notice.text}</div>}

      {busy ? (
        <div className="empty-card"><span className="spinner" /> Searching the marketplace…</div>
      ) : rows.length === 0 ? (
        <div className="empty-card">No results yet. Search the marketplace to find skills you can install.</div>
      ) : (
        <div className="skill-list">
          {rows.map((row) => {
            const key = rowKey(row);
            const already = row.installed || (key ? installedKeys.has(key) : false);
            return (
              <div className="feature-card" key={row.source ? `${row.source}#${row.name}` : row.name}>
                <div className="fc-head">
                  <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name="link" size={14} />
                    <span>{row.name}</span>
                    {row.author && <span className="row-desc">· {row.author}</span>}
                    {row.stars > 0 && <span className="row-desc">· {row.stars} ★</span>}
                  </div>
                  {already ? (
                    <span className="skill-installed-badge">Installed</span>
                  ) : (
                    <button
                      className="btn-primary sm"
                      disabled={!row.source || pending === row.name}
                      title={row.source ? `Install ${row.name}` : "This entry has no repository to install from"}
                      onClick={() => install(row)}
                    >
                      {pending === row.name ? "Installing…" : "Install"}
                    </button>
                  )}
                </div>
                {row.description && <div className="fc-body"><div className="row-desc">{row.description}</div></div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="section-label" style={{ marginTop: 24 }}>Installed</div>
      {installed.length === 0 ? (
        <div className="empty-card">No skills installed yet.</div>
      ) : (
        <div className="skill-list">
          {installed.map((row) => (
            <div className="feature-card" key={row.folder || row.name}>
              <div className="fc-head">
                <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="link" size={14} />
                  <span>{row.name}</span>
                  {row.key && <span className="panel-hint" style={{ margin: 0, fontSize: 11 }}>{row.key.split(":")[0]}</span>}
                </div>
                <button
                  className="btn-ghost sm"
                  disabled={pending === row.name}
                  title={`Uninstall ${row.name}`}
                  onClick={() => uninstall(row)}
                >
                  {pending === row.name ? "Removing…" : "Uninstall"}
                </button>
              </div>
              {(row.description || row.path) && (
                <div className="fc-body">
                  {row.description && <div className="row-desc">{row.description}</div>}
                  {row.path && <div className="row-desc" title={row.path}>{row.path}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}