/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { AssistantBlock, AssistantTurn } from "./types";

import { isPlanToolName } from "../../src/webview-adapter.ts";

/**
 * Collapse the plan cards into the one that carries the artefact.
 *
 * SleepyCode has two plan tools: `plan` is stateful and re-called after every
 * step (each call arrives as its own tool event), and `write_plan` saves the
 * Markdown file. Both render as a plan card, so a run showed several cards — and
 * the last one, a progress call that omits `steps`, was empty.
 *
 * Preference order: the file-backed card, then the last card that still has
 * steps. Everything else is dropped.
 */
export function collapsePlanBlocks<T extends { kind: string; name?: string; input?: any; result?: string }>(blocks: T[]): T[] {
  const plans = blocks.filter((block) => block.kind === "tool" && isPlanToolName(block.name));
  if (plans.length < 2) return blocks;
  const fileBacked = [...plans].reverse().find((block) => Boolean(block.result && /\.md\b/.test(block.result)));
  const withSteps = [...plans].reverse().find((block) => Array.isArray(block.input?.steps) && block.input.steps.length);
  const keep = fileBacked ?? withSteps ?? plans[plans.length - 1];
  return blocks.filter((block) => !isPlanToolName(block.kind === "tool" ? block.name : undefined) || block === keep);
}

/**
 * The body a plan card should render.
 *
 * A file-backed plan carries `content`. The stateful `plan` tool carries ordered
 * `steps` instead, so the checklist is synthesised rather than leaving the card
 * blank when the step list is all the model supplied.
 */
export function planBlockContent(input: any): string {
  if (typeof input?.content === "string" && input.content.trim()) return input.content;
  const steps: unknown = input?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const done: number[] = Array.isArray(input?.doneSteps) ? input.doneSteps : [];
  return steps.map((step, index) => `${done.includes(index) ? "- [x]" : "- [ ]"} ${String(step)}`).join("\n");
}

/**
 * Blocks kept out of the folded work history.
 *
 * A plan is an artefact the user has to read and act on, not a step in the work:
 * burying its card under "Worked for 12s" hid the plan and its Implement button.
 */
const isNotice = (block: AssistantBlock) => block.kind === "verification"
  || (block.kind === "error" && !block.retrying)
  || block.kind === "max-steps"
  || (block.kind === "tool" && isPlanToolName(block.name));

/** Keep the final reply and actionable notices outside folded work history. */
export function splitWork(turn: AssistantTurn, running: boolean): { activity: AssistantBlock[]; conclusion: AssistantBlock[] } {
  if (running) return { activity: turn.blocks, conclusion: [] };
  let boundary = turn.blocks.length;
  while (boundary > 0 && (turn.blocks[boundary - 1].kind === "text" || isNotice(turn.blocks[boundary - 1]))) boundary--;
  let activity = turn.blocks.slice(0, boundary);
  let conclusion = turn.blocks.slice(boundary);
  const finalText = turn.finalText?.trim();
  if (finalText) {
    let finalIndex = turn.blocks.length - 1;
    while (finalIndex >= 0 && turn.blocks[finalIndex].kind !== "text") finalIndex--;
    const block = turn.blocks[finalIndex];
    if (finalIndex >= boundary && block?.kind === "text" && block.text.trimEnd().endsWith(finalText)) {
      const prefix = block.text.trimEnd().slice(0, -finalText.length).trimEnd();
      activity = [...turn.blocks.slice(0, finalIndex), ...(prefix ? [{ kind: "text" as const, text: prefix }] : [])];
      conclusion = [{ kind: "text", text: finalText }, ...turn.blocks.slice(finalIndex + 1)];
    } else {
      // Some terminal notices arrive only in the result, without text deltas.
      activity = turn.blocks;
      conclusion = [{ kind: "text", text: finalText }];
    }
  }
  // Recovery and evidence should remain available even if later work follows.
  conclusion = [...activity.filter(isNotice), ...conclusion];
  activity = activity.filter(block => !isNotice(block));
  return { activity, conclusion };
}

export function hasLiveWork(blocks: AssistantBlock[]): boolean {
  return blocks.some(block => block.kind === "tool" && (block.status === "running" || block.subStatus === "running" || hasLiveWork(block.subBlocks ?? [])));
}
