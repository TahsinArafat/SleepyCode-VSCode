/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { closeTrailingThinking, forceSettleOpenWork, type Mode, type Turn, type Attachment } from "./turns";

/** The queued message retains its destination and execution settings across tab changes. */
export function sendMessageIntent(convId: string | undefined, text: string, attachments?: Attachment[], model?: string, mode?: Mode) {
  return { type: "sendMessage" as const, convId: convId ?? null, text, attachments, model, mode };
}

/** Live snapshots come from the host and must retain pending interactions. */
export function restoreTurns(turns: Turn[], running: boolean): Turn[] {
  return running ? turns : forceSettleOpenWork(closeTrailingThinking(turns), "cancelled");
}

export type GoalStatus = "active" | "paused" | "blocked" | "budgetLimited" | "complete";
export interface ConversationGoal {
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  updatedAt: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: Attachment[];
  model?: string;
  mode?: Mode;
  status: "queued" | "running" | "interrupted" | "failed";
  createdAt: number;
  startedAt?: number;
  error?: string;
  /** Explicit resume reconciles possibly committed work before taking new actions. */
  resume?: boolean;
}

export interface ChatWorkspaceState {
  openTabs: string[];
  drafts: Record<string, { text: string; attachments: Attachment[] }>;
}

// The prompt a review starts with lives in `src/review-actions.ts` beside the
// other review logic, so the scope the menu offers and the prompt the agent gets
// cannot drift apart.
export type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; commit: string }
  | { type: "custom"; instructions: string };
