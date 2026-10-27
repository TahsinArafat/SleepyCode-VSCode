/*
 * Transient notices.
 *
 * Written for SleepyCode: the ported base has no toast component, so every
 * `toast` message the host posted was dropped — MCP authorization results and
 * hook warnings had no visible surface at all.
 *
 * Deliberately minimal: a stack in the corner, dismiss on click, auto-dismiss on
 * a timer that pauses while the pointer is over the toast (so a notice cannot
 * disappear while being read).
 */

import * as React from 'react';

export interface ToastItem {
  id: number;
  title: string;
  message: string;
  kind: 'info' | 'attention';
}

/** How long a notice stays before dismissing itself. */
const DURATION: Record<ToastItem['kind'], number> = {
  info: 6000,
  // Attention notices are the ones worth reading; give them longer.
  attention: 12000,
};

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = React.useState(false);
  // Title and message are dependencies, not just the id: a notice whose text is
  // replaced under the same id (an approval result reusing the row) is new
  // reading, and the old timer would dismiss it mid-sentence.
  React.useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), DURATION[toast.kind] ?? DURATION.info);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.kind, toast.title, toast.message, onDismiss]);

  return (
    <div
      className={"toast toast-" + toast.kind}
      role={toast.kind === 'attention' ? 'alert' : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => onDismiss(toast.id)}
      title="Dismiss"
    >
      <div className="toast-title">{toast.title}</div>
      {toast.message && <div className="toast-body">{toast.message}</div>}
    </div>
  );
}