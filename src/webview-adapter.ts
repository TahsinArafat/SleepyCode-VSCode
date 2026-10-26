/**
 * Adapter between SleepyCode's backend message protocol (`WebMessage`, see
 * `src/types.ts`) and the OpenCursor React webview protocol
 * (`webview-ui/sidebar/types.ts`).
 *
 * Two directions:
 *   - `toSleepyMessage` — webview -> host. Unknown/React-only messages return
 *     `null` so the host drops them instead of failing on an unrecognised type.
 *   - `toReactMessage`  — host -> webview. Untranslatable internal messages also
 *     return `null`; the host drops them rather than leaking SleepyCode-only
 *     payloads the React reducer would not understand.
 *
 * Pure functions only: no `vscode`, no DOM. That keeps the mapping unit-testable
 * without an extension host (see `test/webview-adapter.direct.mjs`).
 */

import { MENTION_TAG_RE, parseMentionTokens } from "./shared/turns.ts";

export type SleepyMsg = { type: string; [key: string]: any };
export type ReactMsg = { type: string; [key: string]: any };

type Turn = Record<string, any>;
type Block = Record<string, any>;

// ---------------------------------------------------------------- host <- webview

/**
 * Translate a React webview message into the SleepyCode `WebMessage` the
 * extension host understands. Returns `null` when there is no counterpart.
 */
export function toSleepyMessage(message: ReactMsg): SleepyMsg | null {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return null;

  switch (message.type) {
    case 'ready':
      return { type: 'ready' };

    case 'sendMessage': {
      // OpenCursor carries context as inline <attached /> tags in the message
      // text. SleepyCode takes it as file attachments and sends the text alone,
      // so the tags are lifted out here.
      const mentions = splitMentions(message.text ?? '');
      const out: SleepyMsg = { type: 'send', text: mentions.text };
      if (message.convId) out.conversationId = message.convId;
      if (message.model) out.model = message.model;
      // The webview keeps its optimistic turn in a placeholder session until the
      // host says which conversation it actually landed in.
      if (message.requestId) out.requestId = message.requestId;
      // Attachments stay in the React shape here; the host owns the filesystem
      // and materialises images into temp files it can actually read.
      const attachments = [
        ...(Array.isArray(message.attachments) ? message.attachments : []),
        ...mentions.files,
      ];
      if (attachments.length) out.attachments = attachments;
      return out;
    }

    case 'stop':
      return { type: 'stop' };

    case 'newConversation':
      return { type: 'newConversation' };

    case 'openConversation':
      return { type: 'openConversation', id: message.id ?? message.convId };

    case 'loadConversation':
      return { type: 'openConversation', id: message.convId ?? message.activeId };

    case 'archiveConversation':
      return { type: 'archiveConversation', id: message.id };

    case 'forkConversation':
      return { type: 'branchConversation', conversationId: message.id, itemId: '' };

    case 'selectModel':
      return { type: 'selectModel', model: message.model };

    case 'selectReasoningEffort':
      return { type: 'selectReasoningEffort', effort: message.effort };

    case 'refreshModels':
      return { type: 'refreshModels' };

    case 'requestSettings':
      return { type: 'requestSettings' };

    case 'requestUsage':
      return { type: 'requestUsage' };

    case 'requestMarketplace':
      return { type: 'requestMarketplace' };

    case 'undoLastTurn':
      return { type: 'undoLastTurn', conversationId: message.convId };

    case 'redoLastTurn':
      return { type: 'redoLastTurn', conversationId: message.convId };

    case 'compact':
      return { type: 'compact', conversationId: message.convId };

    case 'openMemory':
      return { type: 'openMemory' };

    case 'openPanel':
      return { type: 'openPanel', panel: message.panel };

    case 'requestPanel':
      return { type: 'requestPanel', panel: message.panel };

    case 'copyText':
      return { type: 'copyText', text: message.text };

    case 'reindexProject':
      return { type: 'reindexProject' };

    case 'notifyResponse':
      return { type: 'notifyResponse', id: message.id, choice: message.choice };

    case 'resolveApproval':
      return { type: 'notifyResponse', id: Number(message.requestId), choice: message.approve ? 'ok' : 'cancel' };

    case 'revertToMessage':
      return { type: 'undoLastTurn', conversationId: message.convId };

    case 'startReview':
      return { type: 'reviewChanges', conversationId: message.target?.conversationId ?? '', itemId: message.target?.itemId ?? '' };

    case 'steerMessage':
      // SleepyCode steers by queueing the text onto the running conversation.
      return { type: 'send', text: message.text, conversationId: message.convId };

    case 'queueAction':
      if (message.action === 'remove') return { type: 'removeQueued', conversationId: message.convId, id: message.id };
      if (message.action === 'steer') return { type: 'steerQueued', conversationId: message.convId, id: message.id };
      // Reordering and editing queued rows have no SleepyCode counterpart.
      return null;

    case 'cancelRun':
      return { type: 'stop' };

    case 'fetchModels':
      return { type: 'refreshModels' };

    case 'openFile': {
      const out: SleepyMsg = { type: 'openFile', path: message.path };
      if (typeof message.startLine === 'number') out.line = message.startLine;
      return out;
    }

    case 'openMention':
      return { type: 'openFile', path: message.path };

    case 'browseAttachments':
      return { type: 'requestFilePicker' };

    case 'openSettings':
      return { type: 'requestSettings' };

    case 'openLog':
      return { type: 'requestExtensionLogs' };

    case 'searchFiles':
      return { type: 'fileMentionQuery', query: message.query };

    case 'selectConversation':
      return { type: 'openConversation', id: message.id };

    case 'deleteConversation':
      return { type: 'deleteConversation', id: message.id };

    default:
      // React-only messages (persistTurns, queue actions, steering, goals,
      // personas, teams, worktrees, file icons) have no SleepyCode counterpart.
      return null;
  }
}

// ---------------------------------------------------------------- host -> webview

/** Translate a SleepyCode host message into the React webview protocol. */
export function toReactMessage(message: SleepyMsg): ReactMsg | null {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return null;

  switch (message.type) {
    case 'delta':
      return agentEvent(message.conversationId, { type: 'text-delta', text: message.text });

    case 'reasoningDelta':
      return agentEvent(message.conversationId, { type: 'thinking-delta', text: message.text });

    case 'tool': {
      const name = reactToolName(message.tool ?? message.name);
      const input = parseToolArgs(message.input ?? message.args);
      return message.phase === 'start'
        ? agentEvent(message.conversationId, { type: 'tool-call-started', callId: message.id, name, input })
        : agentEvent(message.conversationId, {
            type: 'tool-call-completed',
            callId: message.id,
            name,
            status: message.failed ? 'error' : 'completed',
            result: message.result ?? message.text ?? '',
            input,
          });
    }

    case 'error':
      return agentEvent(message.conversationId, { type: 'error', message: message.text ?? message.message ?? 'Unknown error' });

    case 'generationError':
      return agentEvent(message.conversationId, { type: 'error', message: message.text ?? message.message ?? 'Generation failed' });

    case 'state':
      return agentEvent(message.conversationId, { type: 'run-status', status: message.running ? 'running' : 'finished' });

    case 'done':
      return agentEvent(message.conversationId, { type: 'run-result', text: message.text ?? '', durationMs: message.durationMs ?? 0 });

    case 'models':
      return modelsFetched(message);

    case 'modelsError':
      return agentEvent(undefined, { type: 'error', message: message.text ?? 'No models available.' });

    case 'conversations':
      return conversationsPayload(message);

    case 'conversation':
      return conversationPayload(message);

    case 'config':
    case 'configState':
      // React has no personas or teams; SleepyCode's approval mode travels
      // alongside so the composer's picker can reflect it.
      return {
        type: 'configState',
        personas: [],
        activePersonaId: '',
        hasProviders: true,
        uiPrefs: message.uiPrefs,
        // The picker reads the policy shape, so the current approval mode is
        // projected onto it rather than sending an undefined policy.
        approvalPolicy: message.approvalPolicy ?? approvalPolicyForMode(message.approvalMode),
        approvalMode: message.approvalMode,
      };

    case 'modelSelected':
      return { type: 'modelSelected', model: message.model ?? '' };

    case 'showPanel':
      return { type: 'showPanel', panel: message.panel };

    case 'panel':
      return { type: 'panel', panel: message.panel, rows: message.rows ?? [], hint: message.hint };

    case 'toast':
      return { type: 'toast', id: message.id, title: message.title, message: message.message, kind: message.kind };

    case 'notify':
      return approvalRequest(message);

    case 'permission':
      return {
        type: 'approvalRequest',
        convId: message.conversationId ?? '',
        request: {
          requestId: String(message.permissionId ?? message.id ?? ''),
          convId: message.conversationId ?? '',
          toolName: 'command',
          actionType: 'shell',
          subject: message.title ?? '',
          detail: message.detail ?? '',
        },
      };

    case 'retry':
      return agentEvent(message.conversationId, {
        type: 'retry',
        attempt: message.attempt,
        max: message.max,
        delayMs: message.backoffMs,
        error: message.error ?? '',
      });

    case 'retryEnd':
      // Both outcomes are already visible: a recovered run keeps streaming, and
      // a run that ran out of retries reports through its `error` event. Emitting
      // anything here would add an empty error card.
      return null;

    case 'steered':
      return agentEvent(message.conversationId, { type: 'user-steering' });

    case 'liveUsage':
      return agentEvent(message.conversationId, {
        type: 'usage',
        promptTokens: message.inputTokens ?? 0,
        completionTokens: message.outputTokens ?? 0,
        totalTokens: (message.inputTokens ?? 0) + (message.outputTokens ?? 0),
        model: message.model,
        cachedReadTokens: message.cacheReadTokens,
        cachedWriteTokens: message.cacheWriteTokens,
      });

    case 'workPhase':
      return agentEvent(message.conversationId, { type: 'shell-notify', message: message.first ?? '' });

    case 'restoreDraft':
      return { type: 'queueDraft', convId: message.conversationId ?? '', draft: { text: message.text ?? '', attachments: [] } };

    case 'initialState':
    case 'requestAccepted':
      // Already in React shape.
      return message;

    default:
      return null;
  }
}

/**
 * SleepyCode asks for consent with one generic `notify` card. React expects a
 * typed approval request, so the tool kind picks the action type and the
 * numeric prompt id becomes the request id the webview echoes back.
 */
function approvalRequest(message: SleepyMsg): ReactMsg {
  const approval = message.approval ?? {};
  const isEdit = approval.kind === 'edit';
  return {
    type: 'approvalRequest',
    convId: approval.conversationId ?? '',
    request: {
      requestId: String(message.id),
      convId: approval.conversationId ?? '',
      // With a tool call id the prompt renders on that tool's card; without one
      // it falls back to the bottom stack, so it is always reachable.
      callId: message.toolCallId,
      toolName: isEdit ? 'edit' : 'command',
      actionType: isEdit ? 'edits' : 'shell',
      subject: message.title ?? '',
      detail: message.detail ?? '',
      suggestion: message.secondaryLabel,
    },
  };
}

/**
 * SleepyCode tool ids are snake_case; the React tool cards are keyed by the
 * OpenCursor names (icons, labels and the plan card all switch on them).
 */
const TOOL_NAMES: Record<string, string> = {
  plan: 'WritePlan',
  read_file: 'Read',
  write_file: 'Write',
  replace_text: 'StrReplace',
  delete_file: 'Delete',
  list_files: 'Glob',
  search_files: 'Grep',
  get_diagnostics: 'ReadLints',
  run_command: 'Shell',
  obs_recall: 'Read',
  browser_navigate: 'BrowserNavigate',
  browser_click: 'BrowserInteract',
  browser_type: 'BrowserInteract',
  browser_evaluate: 'BrowserInteract',
  browser_snapshot: 'BrowserInspect',
  browser_screenshot: 'BrowserScreenshot',
  browser_close: 'BrowserClose',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  delegate: 'Task',
  use_skill: 'Read',
  search_skills: 'FileSearch',
  install_skill: 'Write',
  list_skills: 'ListDir',
};

/** Map a SleepyCode tool id onto the React tool name it renders as. */
export function reactToolName(tool: string | undefined): string {
  if (!tool) return 'Tool';
  return TOOL_NAMES[tool] ?? tool;
}

function agentEvent(conversationId: string | undefined, event: Record<string, any>): ReactMsg {
  return { type: 'agentEvent', convId: conversationId ?? '', event };
}

// ---------------------------------------------------------------- models

/**
 * SleepyCode groups models per provider; the React picker takes one flat list.
 * Model entries may be either `{ id, name }` objects or bare id strings.
 */
function modelsFetched(message: SleepyMsg): ReactMsg {
  const groups: any[] = Array.isArray(message.groups) ? message.groups : [];
  const models: string[] = [];
  const modelList: any[] = [];
  for (const group of groups) {
    for (const model of group?.models ?? []) {
      const id = typeof model === 'string' ? model : model?.id;
      if (!id || models.includes(id)) continue;
      models.push(id);
      modelList.push({
        id,
        name: typeof model === 'string' ? model : model?.name ?? id,
        kind: group?.providerId ?? 'unknown',
        providerName: group?.providerName,
        providerId: group?.providerId,
        options: [],
      });
    }
  }
  return { type: 'modelsFetched', models, modelList };
}

// ---------------------------------------------------------------- conversations

function conversationsPayload(message: SleepyMsg): ReactMsg {
  const conversations: any[] = Array.isArray(message.conversations) ? message.conversations : [];
  const list = conversations.map(conversation => ({
    id: conversation.id,
    title: conversation.title || 'New conversation',
    updatedAt: conversation.updatedAt ?? 0,
    archivedAt: conversation.archived ? conversation.updatedAt : undefined,
    excerpt: conversation.excerpt,
  }));
  const runningConvIds = conversations.filter(conversation => conversation.running).map(conversation => conversation.id);
  return { type: 'conversations', list, activeId: message.activeId, runningConvIds };
}

function conversationPayload(message: SleepyMsg): ReactMsg {
  return {
    type: 'loadConversation',
    activeId: message.id,
    turns: itemsToTurns(message.items),
    usedTokens: message.usedTokens ?? contextTokensOf(message.items),
    running: message.running === true,
    workspaceRoot: message.workspaceRoot,
    changes: pendingChangesOf(message.items),
  };
}

/** The React change-review message for a transcript's latest edits. */
export function pendingChangesMessage(items: readonly any[] | undefined): ReactMsg {
  return { type: 'pendingChanges', changes: pendingChangesOf(items) };
}

/**
 * Files the latest turn edited, in the shape React's change review uses.
 * Reverted files are dropped: they are no longer pending anything, and listing
 * them would offer a "keep/reject" for a change that has already been undone.
 */
export function pendingChangesOf(items: readonly any[] | undefined): { path: string; existedBefore: boolean; added?: number; removed?: number }[] {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const changes = items?.[i]?.changes;
    if (!Array.isArray(changes) || !changes.length) continue;
    return changes
      .filter(change => change && !change.reverted)
      .map(change => {
        const out: { path: string; existedBefore: boolean; added?: number; removed?: number } = {
          path: String(change.path ?? ''),
          existedBefore: change.action !== 'Created',
        };
        if (typeof change.additions === 'number') out.added = change.additions;
        if (typeof change.deletions === 'number') out.removed = change.deletions;
        return out;
      });
  }
  return [];
}

/**
 * Context-window usage for the composer ring: SleepyCode records it on the
 * assistant item of each turn, so the last one that has it is current.
 */
function contextTokensOf(items: readonly any[] | undefined): number {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const value = items?.[i]?.contextTokens;
    if (typeof value === 'number' && value > 0) return value;
  }
  return 0;
}

// ---------------------------------------------------------------- transcript -> turns

/**
 * Convert SleepyCode transcript items into React turns.
 *
 * SleepyCode keeps one `TranscriptItem` per user/assistant message plus
 * `kind: 'divider'` markers for compaction. React wants user turns and
 * assistant turns made of typed blocks, so work items are split into
 * thinking/tool blocks and an error item becomes an error block.
 */
export function itemsToTurns(items: readonly any[] | undefined): Turn[] {
  const turns: Turn[] = [];
  for (const item of items ?? []) {
    if (!item || item.kind === 'divider') continue;

    if (item.role === 'user') {
      const turn: Turn = { role: 'user', text: item.text ?? '' };
      if (item.attachments?.length) turn.attachments = item.attachments;
      if (item.model) turn.model = item.model;
      turns.push(turn);
      continue;
    }

    const blocks: Block[] = [];
    for (const work of item.work ?? []) {
      if (work?.kind === 'reasoning') {
        if (work.text) blocks.push({ kind: 'thinking', text: work.text });
        continue;
      }
      if (work?.kind === 'plan') {
        blocks.push(planBlock(work, blocks.length));
        continue;
      }
      blocks.push({
        kind: 'tool',
        callId: work?.tool ?? `tool-${blocks.length}`,
        name: reactToolName(work?.tool) || work?.title || work?.kind || 'tool',
        input: undefined,
        status: work?.interrupted ? 'error' : work?.done === false ? 'running' : 'completed',
        result: work?.text,
      });
    }

    if (item.kind === 'error') {
      blocks.push({ kind: 'error', message: item.errorInfo?.message ?? item.text ?? 'The turn failed.' });
    } else if (item.text) {
      blocks.push({ kind: 'text', text: item.text });
    }

    turns.push({
      role: 'assistant',
      blocks,
      startedAt: item.timestamp,
      endedAt: item.timestamp,
      durationMs: item.seconds ? item.seconds * 1000 : undefined,
      finalText: item.text || undefined,
    });
  }
  return turns;
}

/**
 * SleepyCode stores the plan as a work item with ordered steps plus the
 * completed/active indices. The React plan card renders a title and Markdown
 * body, so the steps become a checklist and the status follows the active step.
 */
function planBlock(work: any, index: number): Block {
  const steps: string[] = Array.isArray(work?.steps) ? work.steps : [];
  const doneSteps: number[] = Array.isArray(work?.doneSteps) ? work.doneSteps : [];
  const content = steps
    .map((step, i) => `${doneSteps.includes(i) ? '- [x]' : '- [ ]'} ${step}`)
    .join('\n');
  const finished = steps.length > 0 && doneSteps.length >= steps.length;
  return {
    kind: 'tool',
    callId: `plan-${index}`,
    name: 'WritePlan',
    input: { title: work?.title || 'Plan', content },
    status: work?.interrupted ? 'error' : finished ? 'completed' : 'running',
    result: work?.text,
  };
}

// ---------------------------------------------------------------- bootstrap

/** Build the React `initialState` message the webview waits for on `ready`. */
export function buildInitialState(input: {
  activeId?: string;
  workspaceRoot?: string;
  selectedModel?: string;
  turns?: Turn[];
  usedTokens?: number;
  approvalMode?: string;
}): ReactMsg {
  return {
    type: 'initialState',
    mode: 'agent',
    selectedModel: input.selectedModel ?? '',
    activeId: input.activeId,
    turns: input.turns ?? [],
    personas: [],
    activePersonaId: '',
    hasProviders: true,
    usedTokens: input.usedTokens ?? 0,
    workspaceRoot: input.workspaceRoot,
    approvalPolicy: approvalPolicyForMode(input.approvalMode),
  };
}

// ---------------------------------------------------------------- panels

const PANEL_TITLES: Record<string, string> = {
  worktrees: 'Worktrees',
  index: 'Project Index',
  agents: 'Agents',
  tasks: 'Scheduled Tasks',
  checkpoints: 'Undo History',
};

/** Human title for a SleepyCode panel id. */
export function panelTitle(panel: string): string {
  return PANEL_TITLES[panel] ?? panel;
}

/**
 * SleepyCode's side panels (worktrees, index, agents, tasks, checkpoints) have
 * no React screen yet. Their rows become QuickPick items so the commands keep
 * working until those panels are ported.
 */
export function panelToQuickPickItems(message: SleepyMsg): { label: string; description?: string }[] {
  const rows: any[] = Array.isArray(message?.rows) ? message.rows : [];
  return rows.map(row => {
    const item: { label: string; description?: string } = { label: String(row?.title ?? '') };
    if (row?.detail) item.description = String(row.detail);
    return item;
  });
}

// ---------------------------------------------------------------- streaming

/**
 * SleepyCode republishes the whole active transcript whenever state changes.
 * Replaying one mid-run would replace the webview's live turns and erase text
 * that has streamed but not been committed yet, so snapshots wait until the
 * run settles while every streaming event still goes straight through.
 */
export function toReactMessageWhileStreaming(message: SleepyMsg, streaming: boolean): ReactMsg | null {
  if (streaming && message?.type === 'conversation') return null;
  return toReactMessage(message);
}

// ---------------------------------------------------------------- sign-in

/**
 * SleepyCode's sign-in banner lives in the vanilla webview, which the React
 * base replaces. Rather than leave a signed-out user with no way to sign in,
 * the host offers it once when the account status comes back signed out.
 */
export function shouldOfferSignIn(message: SleepyMsg | null | undefined): boolean {
  if (!message || message.type !== 'sleepyStatus') return false;
  if (message.busy) return false;
  return message.loggedIn === false;
}

// ---------------------------------------------------------------- change review

/**
 * SleepyCode identifies a turn's edits by conversation + assistant item id,
 * which the React change-review actions do not carry. The host remembers the
 * newest assistant item so `diffChange`/`acceptChange`/`rejectChange` can be
 * routed back to the right turn.
 */
export function latestAssistantItemId(items: readonly any[] | undefined): string | undefined {
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const item = items?.[i];
    if (item?.role === 'assistant' && item.id) return String(item.id);
  }
  return undefined;
}

// ---------------------------------------------------------------- attachments

/**
 * Split React's composer attachments into the two things SleepyCode can act on
 * without guessing. Images carry a data URL the host writes to a temp file;
 * text attachments have no on-disk path, so they are not forwarded as file
 * context (a fabricated path would make the agent read the wrong file).
 */
export function reactAttachmentsOf(attachments: unknown): { images: { name: string; mimeType: string; dataUrl: string }[]; files: { path: string }[] } {
  const images: { name: string; mimeType: string; dataUrl: string }[] = [];
  const files: { path: string }[] = [];
  if (!Array.isArray(attachments)) return { images, files };
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    const a = attachment as { kind?: string; name?: string; mime?: string; data?: string; path?: string };
    if (a.kind === 'image' && typeof a.data === 'string' && a.data.startsWith('data:image/')) {
      images.push({
        name: a.name || 'image.png',
        mimeType: a.mime || a.data.slice(5, a.data.indexOf(';')) || 'image/png',
        dataUrl: a.data,
      });
      continue;
    }
    if (typeof a.path === 'string' && a.path) files.push({ path: a.path });
  }
  return { images, files };
}

// ---------------------------------------------------------------- mentions

/**
 * Pull OpenCursor's inline context tags out of a message. The tags remain the
 * source of truth for the model in OpenCursor; here they become file
 * attachments, which is how SleepyCode supplies the same context.
 */
export function splitMentions(text: string): { text: string; files: { kind: 'file'; path: string }[] } {
  const files: { kind: 'file'; path: string }[] = [];
  if (!text || !text.includes('<attached')) return { text, files };
  for (const mention of parseMentionTokens(text)) {
    if (mention.path) files.push({ kind: 'file', path: mention.path });
  }
  const stripped = text.replace(MENTION_TAG_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: stripped, files };
}

// ---------------------------------------------------------------- fallbacks

const REACT_FALLBACKS: Record<string, string> = {
  showUsage: 'Usage & Billing',
  showMarketplace: 'Skill Marketplace',
};

/**
 * Screens SleepyCode has but the React base does not. They cannot be rendered,
 * and silently doing nothing reads as a broken command, so the host names the
 * surface and points at the classic UI.
 */
export function reactFallbackFor(message: SleepyMsg | null | undefined): string | null {
  if (!message) return null;
  return REACT_FALLBACKS[message.type] ?? null;
}

// ---------------------------------------------------------------- approval preset

const APPROVAL_PRESETS: Record<string, string> = {
  ask: 'ask',
  // "Review" still applies edits automatically but asks before commands, which
  // is exactly SleepyCode's "edits" mode.
  review: 'edits',
  allow: 'autonomous',
};

/** Map the React composer's approval preset onto a SleepyCode approval mode. */
export function approvalModeForPreset(preset: unknown): string | undefined {
  return typeof preset === 'string' ? APPROVAL_PRESETS[preset] : undefined;
}

/**
 * Tool arguments arrive either as an object or as the raw JSON string the model
 * streamed. React's cards read fields like `path` and `command`, so a partial
 * or malformed payload degrades to an empty object instead of throwing.
 */
export function parseToolArgs(args: unknown): Record<string, any> {
  if (args && typeof args === 'object') return args as Record<string, any>;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- continue

/**
 * React's "continue" names no target, but SleepyCode resumes a specific
 * assistant turn. The newest one is what the user is looking at.
 */
export function continueTarget(conversationId: string | undefined, items: readonly any[] | undefined): { conversationId: string; itemId: string } | null {
  if (!conversationId) return null;
  const itemId = latestAssistantItemId(items);
  return itemId ? { conversationId, itemId } : null;
}

// ---------------------------------------------------------------- approval policy

const ACTION_TYPES = ['shell', 'edits', 'delete', 'mcp', 'web', 'outside'] as const;

/**
 * Project SleepyCode's approval mode onto the action-type policy the React
 * picker renders. SleepyCode gates by *kind* (edits vs commands), so every
 * action type takes the same mode and nothing is ever a "custom" rule set.
 *
 *   ask        -> ask      (prompt for everything)
 *   edits      -> review   (SleepyCode applies edits, still asks for commands)
 *   autonomous -> allow    (no prompts)
 */
export function approvalPolicyForMode(mode: unknown): Record<string, { mode: string; allowlist: string[]; denylist: string[] }> {
  const mapped = mode === 'autonomous' ? 'allow' : mode === 'edits' ? 'review' : 'ask';
  const policy: Record<string, { mode: string; allowlist: string[]; denylist: string[] }> = {};
  for (const action of ACTION_TYPES) policy[action] = { mode: mapped, allowlist: [], denylist: [] };
  return policy;
}
