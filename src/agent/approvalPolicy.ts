/**
 * Approval policy shape shared with the React webview.
 *
 * The type surface is ported from OpenCursor (`src/agent/approvalPolicy.ts`,
 * MIT) because its `ApprovalPicker` and `approvalPreset` read exactly these
 * fields. The *engine* is not ported: SleepyCode already has a shipped, tested
 * approval path (`requiresApproval` + session grants + hooks) and swapping it
 * would change behaviour users rely on. Only the data the UI needs lives here,
 * so the picker can show the preset that matches SleepyCode's approval mode.
 */

export type ApprovalMode = 'allow' | 'ask' | 'review' | 'deny';

export interface ApprovalRule {
  mode: ApprovalMode;
  /** Patterns that always allow (command prefix/wildcard, or path glob). */
  allowlist: string[];
  /** Patterns that always deny. */
  denylist: string[];
}

export type ApprovalActionType = 'shell' | 'edits' | 'delete' | 'mcp' | 'web' | 'outside';

export type ApprovalPolicy = Record<ApprovalActionType, ApprovalRule>;

const rule = (mode: ApprovalMode): ApprovalRule => ({ mode, allowlist: [], denylist: [] });

/** Safe defaults: everything prompts until the user loosens it. */
export const DEFAULT_APPROVAL: ApprovalPolicy = {
  shell: rule('ask'),
  edits: rule('ask'),
  delete: rule('ask'),
  mcp: rule('ask'),
  web: rule('ask'),
  outside: rule('ask'),
};