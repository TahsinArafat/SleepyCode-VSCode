/*
 * The project index, as this build actually works.
 *
 * The ported page was about embeddings: a vector index, chunk counts, an embedding
 * model and the runtime it ran on. SleepyCode builds a lexical index — files,
 * symbols, imports, languages, frameworks — from which it answers context
 * questions, and none of the embedding machinery exists. Every control on that
 * page either wrote nowhere or described something that was not there.
 *
 * What is shown comes from `src/index-report.ts`, where it is tested without a
 * browser.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import { indexReport, type IndexReport } from "../../../src/index-report.ts";

export function IndexPanel() {
  const [report, setReport] = React.useState<IndexReport | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "indexStatus") return;
      // The host formats, this renders. Deriving the report again from a report
      // would read `indexedFileCount` off an object that only carries `files`, and
      // quietly report "none read" for an index that is fine. The snapshot itself
      // never crosses the boundary: it carries every indexed file.
      const status = message.status;
      setReport(status && typeof status.files === "string" ? (status as IndexReport) : indexReport(undefined));
      setBusy(false);
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getIndexStatus" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const rebuild = () => {
    setBusy(true);
    vscode.postMessage({ type: "reindexIndex" });
  };

  return (
    <>
      <h1 className="page-title">Indexing</h1>
      <p className="panel-hint">
        A local, on-disk index of this workspace: files, the symbols they declare and the modules they import. The agent
        consults it before reading files, so it can find the right ones without scanning the tree. Nothing leaves your
        machine.
      </p>

      <div className="section-label">Codebase</div>
      <div className="feature-card">
        <div className="fc-head">
          <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="database" size={14} />
            <span>{report ? report.files : "Reading the index…"}</span>
          </div>
          <button className="btn-secondary" disabled={busy} onClick={rebuild}>
            <Icon name="reset" /> {busy ? "Rebuilding…" : "Rebuild index"}
          </button>
        </div>
        {report && (
          <div className="fc-body">
            {report.age}
            {report.stale && report.state === "ready" ? " · will rebuild on the next request" : ""}
            {report.state === "empty"
              ? " Nothing is indexed yet, so the agent falls back to reading files as it needs them."
              : ""}
          </div>
        )}
      </div>

      {report && report.languages.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 24 }}>Languages</div>
          <div className="feature-card">
            {report.languages.slice(0, 12).map((entry) => (
              <div key={entry.language} className="fc-head" style={{ alignItems: "baseline", padding: "3px 0" }}>
                <span>{entry.language}</span>
                <span className="panel-hint" style={{ margin: 0 }}>{entry.files} file{entry.files === 1 ? "" : "s"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {report && report.frameworks.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 24 }}>Detected</div>
          <div className="feature-card">
            <div className="fc-body">{report.frameworks.join(" · ")}</div>
          </div>
        </>
      )}

      {report && report.importantFiles.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 24 }}>Key files</div>
          <div className="feature-card">
            <div className="fc-body" style={{ fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}>
              {report.importantFiles.slice(0, 12).map((file) => (
                <div key={file} style={{ padding: "1px 0" }}>{file}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}