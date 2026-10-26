/*
 * The five side panels: Worktrees, Project Index, Agents, Scheduled Tasks and
 * Undo History.
 *
 * These used to reach the user as a QuickPick, which flattened every row to a
 * label and a description and threw away the ids — so a panel could be read but
 * nothing in it could be acted on. The rows, the buttons, and the messages
 * those buttons post all come from `src/panel-core.ts`, which is also what the
 * host uses; this file is only the rendering.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import {
  panelActionMessages,
  panelActions,
  panelHintFor,
  panelRowAction,
  panelRowActionEnabled,
  panelRowActionMessages,
  panelRowKey,
  panelTitle,
  type PanelContext,
  type PanelRow,
} from "../../../src/panel-core";
import type { OutMessage } from "../types";

export interface PanelState {
  id: string;
  rows: PanelRow[];
  hint?: string;
  loading: boolean;
}

export function PanelDrawer({
  panel,
  conversationId,
  running,
  onClose,
  onPost,
}: {
  panel: PanelState | null;
  conversationId?: string;
  running: boolean;
  onClose: () => void;
  onPost: (message: OutMessage) => void;
}) {
  const popupRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!panel) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [panel?.id]);

  if (!panel) return null;

  const ctx: PanelContext = { conversationId, running };
  const rowAction = panelRowAction(panel.id);
  const hint = panel.hint || panelHintFor(panel.id);

  // A row button changes what the list is describing (a new agent, a restored
  // transcript), so the drawer closes instead of showing stale rows.
  const runRowAction = (action: string, row: PanelRow) => {
    const messages = panelRowActionMessages(panel.id, action, row, ctx);
    if (!messages.length) return;
    for (const message of messages) onPost(message as OutMessage);
    onClose();
  };

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div
        className="panel-popup"
        role="dialog"
        aria-modal="true"
        aria-label={panelTitle(panel.id)}
        ref={popupRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = Array.from(popupRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="panel-heading">
          <span className="panel-title">{panelTitle(panel.id)}</span>
          <span className="panel-heading-actions">
            {panelActions(panel.id).map((action) => (
              <button
                key={action.id}
                className="btn-ghost"
                disabled={panel.loading}
                onClick={() => {
                  for (const message of panelActionMessages(panel.id, action.id)) onPost(message as OutMessage);
                  // "New worktree" opens a prompt in the host, so the drawer gets
                  // out of the way; the rest re-read the list it is showing.
                  if (action.id === "newWorktree") onClose();
                }}
              >
                {action.id === "refresh" && <Icon name="reset" size={13} />} {action.label}
              </button>
            ))}
            <button ref={closeRef} className="panel-close" aria-label="Close panel" onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </span>
        </div>

        <div className="panel-list">
          {panel.loading ? (
            <div className="panel-empty">Loading…</div>
          ) : panel.rows.length === 0 ? (
            <div className="panel-empty">Nothing to show yet.</div>
          ) : (
            panel.rows.map((row, index) => (
              <div className="panel-row" key={panelRowKey(row, index)}>
                <div className="panel-row-main">
                  <div className="panel-row-title" title={row.title}>{row.title}</div>
                  {row.detail && <div className="panel-row-detail">{row.detail}</div>}
                </div>
                {rowAction && panelRowActionEnabled(rowAction.id, row, ctx) && (
                  <button
                    className="btn-ghost panel-row-action"
                    onClick={() => runRowAction(rowAction.id, row)}
                    aria-label={`${rowAction.label} ${row.title}`}
                  >
                    {rowAction.label}
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {hint && <div className="panel-hint">{hint}</div>}
      </div>
    </div>
  );
}
