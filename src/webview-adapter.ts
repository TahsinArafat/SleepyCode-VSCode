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
      const out: SleepyMsg = { type: 'send', text: message.text };
      if (message.convId) out.conversationId = message.convId;
      if (message.model) out.model = message.model;
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

    default:
      // React-only messages (`persistTurns`, queue actions, steering, goals,
      // worktrees, approvals) have no SleepyCode counterpart yet.
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

    case 'tool':
      return message.phase === 'start'
        ? agentEvent(message.conversationId, { type: 'tool-call-started', callId: message.id, name: message.tool ?? message.name, input: undefined })
        : agentEvent(message.conversationId, {
            type: 'tool-call-completed',
            callId: message.id,
            name: message.tool ?? message.name,
            status: message.failed ? 'error' : 'completed',
            result: message.text ?? '',
          });

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

    case 'configState':
      return { type: 'configState', personas: [], activePersonaId: '', hasProviders: true, uiPrefs: message.uiPrefs, approvalPolicy: message.approvalPolicy };

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

    case 'restoreDraft':
      return { type: 'queueDraft', convId: message.conversationId ?? '', draft: { text: message.text ?? '', attachments: [] } };

    case 'initialState':
      // Already in React shape (built by `buildInitialState`).
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
      toolName: isEdit ? 'edit' : 'command',
      actionType: isEdit ? 'edits' : 'shell',
      subject: message.title ?? '',
      detail: message.detail ?? '',
      suggestion: message.secondaryLabel,
    },
  };
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
    usedTokens: message.usedTokens ?? 0,
    running: message.running === true,
    workspaceRoot: message.workspaceRoot,
  };
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
      blocks.push({
        kind: 'tool',
        callId: work?.tool ?? `tool-${blocks.length}`,
        name: work?.tool ?? work?.title ?? work?.kind ?? 'tool',
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

// ---------------------------------------------------------------- bootstrap

/** Build the React `initialState` message the webview waits for on `ready`. */
export function buildInitialState(input: {
  activeId?: string;
  workspaceRoot?: string;
  selectedModel?: string;
  turns?: Turn[];
  usedTokens?: number;
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
  };
}
