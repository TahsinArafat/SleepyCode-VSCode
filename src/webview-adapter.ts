/**
 * Adapter between SleepyCode's backend message protocol (`WebMessage`, see
 * `src/types.ts`) and the React webview protocol
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
import * as modelOptions from './model-options.ts';
import * as reviewActions from './review-actions.ts';
import * as panelCore from './panel-core.ts';
import { agentOptions } from './agent-options.ts';
import { REASONING_EFFORTS, REASONING_EFFORT_HINTS, REASONING_EFFORT_LABELS, normalizeReasoningEffort } from './reasoning-effort.ts';

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
      // The ported UI carries context as inline <attached /> tags in the message
      // text. SleepyCode takes it as file attachments and sends the text alone,
      // so the tags are lifted out here.
      const mentions = splitMentions(message.text ?? '');
      const out: SleepyMsg = { type: 'send', text: mentions.text };
      // The composer's context switches. Only the ones that are OFF travel: the
      // host reads an absent field as on, so sending `true` for every default
      // would put a context block in every request the user never asked for.
      const context = contextSwitches(message.context);
      if (context) out.context = context;
      if (message.convId) out.conversationId = message.convId;
      if (message.model) out.model = message.model;
      // The composer's mode is what the user is looking at right now, so it
      // travels with the message. Relying on the stored per-conversation mode
      // meant a fresh conversation silently ran as `agent` and wrote files while
      // the UI said Ask.
      if (message.mode === 'agent' || message.mode === 'ask' || message.mode === 'plan') out.mode = message.mode;
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

    case 'requestTranscript': {
      const conversationId = message.conversationId ?? message.convId;
      return conversationId ? { type: 'requestTranscript', conversationId } : null;
    }

    case 'archiveConversation':
      return { type: 'archiveConversation', id: message.id };

    case 'renameConversation':
      // With no title the host opens its own input box, which is the better
      // prompt — native, and it pre-fills the current name. An empty id would
      // rename nothing, so it is refused rather than posted.
      return message.id
        ? { type: 'renameConversation', id: message.id, title: message.title }
        : null;

    case 'togglePinConversation':
      return message.id ? { type: 'togglePinConversation', id: message.id } : null;

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
      return { type: 'undoLastTurn', conversationId: message.conversationId ?? message.convId };

    case 'redoLastTurn':
      return { type: 'redoLastTurn', conversationId: message.conversationId ?? message.convId };

    // The compaction controls and `/compact` name `conversationId`; reading only
    // `convId` dropped it, so the host compacted whichever conversation it
    // happened to consider active.
    case 'compact':
      return { type: 'compact', conversationId: message.conversationId ?? message.convId };

    case 'cancelCompact': {
      const conversationId = message.conversationId ?? message.convId;
      return conversationId ? { type: 'cancelCompact', conversationId } : null;
    }

    case 'openMemory':
      return { type: 'openMemory' };

    case 'openPanel':
      // Only a panel that exists; the host builds rows for whatever it is asked
      // for, so an unknown id would be a request it cannot serve.
      return panelCore.isPanelId(message.panel) ? { type: 'openPanel', panel: message.panel } : null;

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
      return { type: 'undoLastTurn', conversationId: message.conversationId ?? message.convId };

    case 'startReview': {
      // A review is a new read-only conversation about a SCOPE. It used to be
      // translated into `reviewChanges`, which reveals the newest response's
      // tracked files — so "Uncommitted changes" reported "no workspace file
      // changes were recorded for this response" on a workspace that was dirty.
      const start = reviewActions.reviewStart(message.target);
      return start ? { type: 'startReview', title: start.title, prompt: start.prompt } : null;
    }

    case 'steerMessage':
      // Guidance for the task in progress, not a new turn: flagged so the host
      // hands it to the run that is working instead of queueing a follow-up. The
      // request id travels so the `steered` echo can name the row it consumed and
      // the webview drops its optimistic copy instead of showing it twice.
      return {
        type: 'send',
        text: message.text,
        conversationId: message.convId,
        steering: true,
        ...(message.requestId ? { requestId: message.requestId } : {}),
      };

    case 'queueAction':
      if (message.action === 'remove') return { type: 'removeQueued', conversationId: message.convId, id: message.id };
      if (message.action === 'steer') return { type: 'steerQueued', conversationId: message.convId, id: message.id };
      // `run` covers both "Send queued request now" (stops the current run) and
      // "Resume interrupted request"; the host decides which applies. `up` is
      // the row's "Move earlier". Both need the host, because it owns the order
      // the queue actually drains in — reordering only the visible list would
      // show an order that is not the one that runs.
      if (message.action === 'run') return { type: 'promoteQueued', conversationId: message.convId, id: message.id };
      if (message.action === 'up') return { type: 'moveQueued', conversationId: message.convId, id: message.id };
      // `edit` is handled inside the webview: React owns the composer draft and
      // the attachments, so it restores those and posts a plain `remove`.
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

    case 'sleepyStatus':
      // Falls through to the banner condition. `shouldOfferSignIn` reads this
      // shape, so the fields it checks must survive translation.
      return {
        type: 'sleepyStatus',
        loggedIn: message.loggedIn === true,
        busy: message.busy === true,
        text: typeof message.text === 'string' ? message.text : '',
      };

    case 'signIn':
      // The banner's action. Same entry point as the command and the settings
      // window's button.
      return { type: 'signIn' };

    case 'openSettings':
      // The requested section travels with the request; dropping it landed every
      // jump on General, so "Get started" and "Add models" both opened the wrong
      // page. Whether the section exists is the settings window's call.
      return message.section
        ? { type: 'requestSettings', section: message.section }
        : { type: 'requestSettings' };

    case 'openLog':
      return { type: 'requestExtensionLogs' };

    case 'searchFiles':
      return { type: 'fileMentionQuery', query: message.query };

    case 'answerQuestion':
      return { type: 'answerQuestion', callId: message.callId, answers: message.answers ?? {} };

    case 'setMode':
      return { type: 'setMode', mode: message.mode };

    case 'setPersona':
      // Per-chat override of the persona layer. The host stores it on the
      // conversation; it is not a new conversation-wide default.
      return { type: 'setPersona', conversationId: message.convId, personaId: message.personaId };

    case 'cancelSubagent':
      return { type: 'cancelSubagent', callId: message.callId, reason: message.reason };

    case 'exportConversation':
      return { type: 'exportConversation', conversationId: message.convId };

    case 'createWorktreeConversation':
      return { type: 'createWorktreeConversation', title: message.title };

    case 'selectAgent':
      // The Agents panel's row button. An empty id would reset the user's agent
      // choice, so a row with no target never reaches the host.
      return typeof message.agentId === 'string' && message.agentId
        ? { type: 'selectAgent', agentId: message.agentId }
        : null;

    case 'restoreCheckpoint':
      // The Undo History panel's row button. Both ids are required: the host
      // resolves a snapshot through the conversation and the turn.
      return typeof message.conversationId === 'string' && message.conversationId && typeof message.itemId === 'string' && message.itemId
        ? { type: 'restoreCheckpoint', conversationId: message.conversationId, itemId: message.itemId }
        : null;

    case 'saveModelOptions':
      return { type: 'saveModelOptions', modelId: message.modelId, options: message.options };

    case 'resetModelOptions':
      return { type: 'resetModelOptions', modelId: message.modelId };

    case 'persistTurns':
      // Sent while the webview is being torn down, so the host can keep the turns
      // it is showing. Accepted; the host adopts them only into an empty
      // conversation so it can never clobber authoritative state.
      return { type: 'persistTurns', conversationId: message.convId, turns: message.turns };

    case 'setGoal':
      return { type: 'setGoal', conversationId: message.convId, objective: message.objective, tokenBudget: message.tokenBudget };

    case 'setGoalStatus':
      return { type: 'setGoalStatus', conversationId: message.convId, status: message.status };

    case 'resolvePastedCode':
      // The composer holds the paste until the host answers; an unanswered
      // request dropped the paste entirely.
      return { type: 'resolvePastedCode', text: message.text ?? '', requestId: message.requestId };

    case 'getFileIcon':
      // The host resolves the name against the user's icon theme and answers with
      // a `fileIcon` message; there was no handler, so every edit card fell back
      // to a generic icon.
      return { type: 'getFileIcon', filename: message.filename };

    case 'logError':
      // The webview's own failures were invisible; the host log is where a
      // support report can actually be diagnosed.
      return { type: 'logError', message: message.message ?? '', info: message.info };

    case 'openBrowserTab':
      return { type: 'openBrowserTab', url: message.url };

    case 'searchMentions':
      // Only the files category has a SleepyCode equivalent. Answering docs,
      // chats, branch or terminal searches with file hits would insert the wrong
      // mention, so they are dropped instead.
      return message.kind === 'files'
        ? { type: 'fileMentionQuery', query: message.query ?? '' }
        : null;

    case 'updateChatWorkspace':
      // Persisted by the host: drafts and open tabs are the only webview state
      // that would otherwise be lost on reload.
      return { type: 'updateChatWorkspace', state: message.state };

    case 'searchConversations':
      // Answered by the host, which owns the conversation list; the request id
      // comes back so the webview can drop a stale answer.
      return { type: 'searchConversations', query: message.query ?? '', archived: message.archived === true, requestId: message.requestId };

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
            // Carried on completion too: a call whose arguments only resolved at
            // the end (or a CLI row that reports input with its result) would
            // otherwise settle with an empty input and draw a blank card.
            input,
            ...(typeof message.diff === 'string' && message.diff ? { diff: message.diff } : {}),
          });
    }

    case 'error':
      // Without a conversation the event would be filed under the placeholder
      // session, which is not the active one, so it rendered nowhere. React's
      // top-level `error` message falls back to the active session instead.
      //
      // `keepTurn` means the turn is still running and this is a notice about it
      // (a refused mid-run update, a model substitution). It travels: without it
      // the webview marked the live conversation as finished.
      return message.conversationId
        ? agentEvent(message.conversationId, {
            type: 'error',
            message: message.text ?? message.message ?? 'Unknown error',
            ...(message.keepTurn === true ? { keepTurn: true } : {}),
          })
        : { type: 'error', message: message.text ?? message.message ?? 'Unknown error' };

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

    case 'approvalResolved':
      // The host answered a prompt the user did not: a cancelled run, an aborted
      // tool. The card has to say so, or it keeps asking for a decision already
      // taken — the webview marks it resolved and offers nothing further.
      return {
        type: 'approvalResolved',
        convId: message.conversationId ?? '',
        requestId: String(message.requestId ?? ''),
        approved: message.approved === true,
      };

    case 'fileIcon':
      // The IDE's icon for one file, resolved from the active icon theme. Without
      // this every edit card and mention pill falls back to the generic glyph and
      // the webview's waiters are never drained.
      return { type: 'fileIcon', filename: String(message.filename ?? ''), icon: message.icon ?? null };

    case 'pasteResolved':
      // The host's answer to `resolvePastedCode`: whether the pasted text is a file
      // it recognises. Dropping it left the webview's paste request pending forever,
      // so every paste after the first was ignored.
      return { type: 'pasteResolved', requestId: message.requestId, ...(message.mention ? { mention: message.mention } : {}) };

    case 'conversation':
      return conversationPayload(message);

    case 'config':
    case 'configState':
      // SleepyCode's approval mode travels alongside so the composer's picker can
      // reflect it, and personas travel because the composer shows the one in use.
      return {
        type: 'configState',
        personas: Array.isArray(message.personas) ? message.personas : [],
        activePersonaId: typeof message.activePersonaId === 'string' ? message.activePersonaId : '',
        hasProviders: true,
        uiPrefs: message.uiPrefs,
        // The picker reads the policy shape, so the current approval mode is
        // projected onto it rather than sending an undefined policy.
        approvalPolicy: message.approvalPolicy ?? approvalPolicyForMode(message.approvalMode),
        approvalMode: message.approvalMode,
        // The picker needs the level in force, not just the ability to set one.
        // Never undefined: an unset level is `none`, and a picker with nothing
        // selected reads as broken.
        reasoningEffort: normalizeReasoningEffort(message.reasoningEffort),
        reasoningEfforts: effortOptions(),
        // The picker needs the list and the selection together; a list without
        // the current id cannot show which agent is active.
        agentId: message.agentId,
        agentOptions: agentOptions(message.agents),
        // A send cannot work without a folder; say so before the user types.
        workspaceRoot: message.workspaceRoot,
        canSend: Boolean(message.workspaceRoot ?? message.canSend),
      };

    case 'modelSelected':
      return { type: 'modelSelected', model: message.model ?? '' };

    case 'showPanel':
      return { type: 'showPanel', panel: message.panel };

    case 'panel':
      return panelPayload(message);

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
      // The `requestId` is the queue row this guidance consumed: the webview
      // prunes its optimistic steering row by it, and without it the row was
      // re-inserted on every workflow update and never cleared.
      //
      // A rejected one (a CLI-owned chat, which cannot take a mid-run update)
      // must reach the webview as its own message: the composer drew the note
      // optimistically, and this is the only thing that can take it back off.
      // Emitting `user-steering` instead would print a blank quote of the user.
      if (message.rejected) {
        return { type: 'steeringRejected', convId: message.conversationId ?? '', requestId: message.requestId ? String(message.requestId) : undefined, text: message.text ?? '' };
      }
      return agentEvent(message.conversationId, { type: 'user-steering', text: message.text ?? '', ...(message.requestId ? { requestId: String(message.requestId) } : {}) });

    case 'liveUsage': {
      const prompt = message.inputTokens ?? 0;
      const completion = message.outputTokens ?? 0;
      // The latest step's prompt_tokens: the true size of the window in use.
      const contextTokens = typeof message.contextTokens === 'number' && message.contextTokens > 0 ? message.contextTokens : 0;
      // The host zeroes this message when a run ends, to clear its live readout.
      // That is not "usage went to zero" — the conversation still holds what it
      // holds — so carrying it through blanked the context ring after every
      // completed response.
      if (!prompt && !completion && !contextTokens) return null;
      return agentEvent(message.conversationId, {
        type: 'usage',
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        contextTokens,
        model: message.model,
        cachedReadTokens: message.cacheReadTokens,
        cachedWriteTokens: message.cacheWriteTokens,
      });
    }

    case 'workPhase':
      return agentEvent(message.conversationId, { type: 'shell-notify', message: message.first ?? '' });

    case 'questionAnswered':
      return { type: 'questionAnswered', convId: message.conversationId ?? '', callId: message.callId, answers: message.answers ?? {} };

    case 'subagent': {
      // SleepyCode posts its own subagent lifecycle; React renders subagents as
      // Task tool cards, so the two are bridged onto that shape. Without this the
      // UI showed nothing at all while a subagent worked.
      const callId = message.id ?? `subagent-${message.role ?? 'task'}`;
      const input = { role: message.role, task: message.task ?? '', description: message.name };
      if (message.phase !== 'end') {
        return agentEvent(message.conversationId, { type: 'tool-call-started', callId, name: 'Task', input });
      }
      return agentEvent(message.conversationId, {
        type: 'tool-call-completed',
        callId,
        name: 'Task',
        status: message.ok === false ? 'error' : 'completed',
        result: message.ok === false ? (message.error ?? 'The subagent failed.') : (message.result ?? ''),
        input,
      });
    }

    case 'plan': {
      // The host's authoritative plan state. It was dropped, so the only plan
      // card came from history — and a progress-only work item has no steps,
      // which rendered as "(empty plan)".
      //
      // One stable callId per conversation, because the reducer merges input for
      // a repeated callId: progress updates therefore update the card instead of
      // stacking a new one. Fields the host omitted stay omitted so the merge
      // keeps the earlier value.
      const input: Record<string, unknown> = {};
      if (typeof message.title === 'string' && message.title.trim()) input.title = message.title.trim();
      if (Array.isArray(message.steps) && message.steps.length) input.steps = message.steps;
      if (Array.isArray(message.doneSteps)) input.doneSteps = message.doneSteps;
      if (Number.isInteger(message.activeStep)) input.activeStep = message.activeStep;
      input.done = message.done === true;
      return agentEvent(message.conversationId, {
        type: 'tool-call-started',
        callId: `plan:${message.conversationId ?? ''}`,
        name: 'WritePlan',
        input,
      });
    }

    case 'compactProgress':
      return agentEvent(message.conversationId, {
        type: 'compaction',
        // React's compaction block only knows running/done/failed. A cancelled
        // run did not summarize, so it must not read as done.
        status: message.phase === 'done' ? 'done' : message.phase === 'error' || message.phase === 'cancelled' ? 'failed' : 'running',
        ...(message.text ? { summary: message.text } : {}),
      });

    case 'queuedPrompt':
      return queuedPrompts(message);

    case 'sessionStats':
      // Cost is computed host-side: it owns the prices, and shipping rates to the
      // webview would duplicate the cached-vs-uncached split, which is the part
      // that is easy to get wrong.
      return {
        type: 'sessionStats',
        convId: String(message.conversationId ?? ''),
        tokens: message.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: message.cost ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: null },
        speed: message.speed,
        contextLimit: Number(message.contextLimit ?? 0),
      };

    case 'projectIndex':
      // The host has posted this since the index existed; there was no case for
      // it here, so index state never reached the React UI.
      return {
        type: 'projectIndex',
        status: typeof message.status === 'string' ? message.status : '',
        indexed: Number(message.indexed ?? 0),
        total: Number(message.total ?? 0),
        text: typeof message.text === 'string' ? message.text : '',
      };

    case 'workflow':
      // The complete workflow state. React replaces both maps from one message,
      // so this is the only shape that cannot erase half of it.
      return {
        type: 'workflowState',
        queues: queueRows(message.queues),
        goals: message.goals && typeof message.goals === 'object' ? message.goals : {},
      };

    case 'goal':
      // The webview reads goals from `workflowState.goals`, not from a message of
      // their own, so a goal change is delivered as the shape it consumes.
      return { type: 'workflowState', queues: {}, goals: { [message.conversationId ?? '']: message.goal } };

    case 'contextNotice':
      // React has no persistent notice block, but dropping this would hide a
      // real change to what the model can see.
      return agentEvent(message.conversationId, { type: 'shell-notify', message: message.text ?? '' });

    case 'settingsResult':
      // No toast surface in the React base; a failure is the only part that
      // needs to be visible.
      return message.ok === false
        ? agentEvent(undefined, { type: 'error', message: message.text ?? 'Settings could not be saved.' })
        : null;

    case 'modelRoute':
      // A persistent note, not a shell notification. The status-line version was
      // overwritten by the next status — and `shell-notify` is not handled by the
      // reducer at all, so it never even reached the transcript.
      return message.model
        ? agentEvent(message.conversationId, {
            type: 'route-note',
            model: String(message.model),
            requested: typeof message.requested === 'string' ? message.requested : undefined,
            reason: typeof message.reason === 'string' ? message.reason : undefined,
          })
        : null;

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
 * the ported tool names (icons, labels and the plan card all switch on them).
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
  delegate_task: 'Task',
  ask_user: 'AskQuestion',
  use_skill: 'Read',
  search_skills: 'FileSearch',
  install_skill: 'Write',
  list_skills: 'ListDir',
  terminal_start: 'TerminalStart',
  terminal_write: 'TerminalWrite',
  terminal_read: 'TerminalRead',
  terminal_list: 'TerminalList',
  terminal_stop: 'TerminalStop',
  // Every mutating tool whose id was left out fell through to the ported card's
  // generic shape, so a rename or a commit rendered as an unlabelled "tool".
  skillsmp_search: 'SearchSkills',
  skillsmp_get_skill: 'Read',
  skillsmp_install_skill: 'InstallSkill',
  skillsmp_list_installed: 'ListSkills',
  skillsmp_read_installed: 'Read',
  skillsmp_list_repo_skills: 'ListSkills',
  memory_read: 'MemoryRead',
  memory_update: 'MemoryUpdate',
  write_plan: 'WritePlan',
  repo_search: 'SemanticSearch',
  repo_symbol: 'SemanticSearch',
  repo_architecture: 'SemanticSearch',
  repo_memory_record: 'MemoryUpdate',
  repo_memory_list: 'MemoryRead',
  worktree_create: 'WorktreeCreate',
  worktree_list: 'WorktreeList',
  worktree_status: 'WorktreeStatus',
  worktree_compare: 'WorktreeCompare',
  worktree_merge: 'WorktreeMerge',
  worktree_remove: 'WorktreeRemove',
  worktree_run: 'Shell',
  github_list_issues: 'GitHubIssues',
  github_get_issue: 'GitHubIssues',
  github_start_from_issue: 'GitHubBranch',
  github_commit: 'GitHubCommit',
  github_open_pr: 'GitHubPullRequest',
  github_pr_status: 'GitHubPullRequest',
  github_review_comments: 'GitHubPullRequest',
  github_pr_comment: 'GitHubPullRequest',
  obs_recall: 'Read',
  browser_launch: 'BrowserNavigate',
  browser_press: 'BrowserInteract',
  browser_wait: 'BrowserInteract',
  browser_back: 'BrowserNavigate',
  browser_forward: 'BrowserNavigate',
  browser_reload: 'BrowserNavigate',
  browser_new_tab: 'BrowserNavigate',
  browser_list_tabs: 'BrowserInspect',
  browser_switch_tab: 'BrowserNavigate',
  browser_close_tab: 'BrowserClose',
  browser_scroll: 'BrowserInteract',
  browser_geometry: 'BrowserInspect',
};

/** Map a SleepyCode tool id onto the React tool name it renders as. */
export function reactToolName(tool: string | undefined): string {
  if (!tool) return 'Tool';
  return TOOL_NAMES[tool] ?? tool;
}

/**
 * Turn the host's per-conversation queue map into React queue rows. Rows need
 * an id to be moved or removed, so one is derived when the host did not supply
 * ids.
 */
function queueRows(queues: unknown): Record<string, unknown[]> {
  const now = Date.now();
  const out: Record<string, unknown[]> = {};
  if (!queues || typeof queues !== 'object') return out;
  for (const [conversationId, list] of Object.entries(queues as Record<string, unknown>)) {
    const entries = Array.isArray(list) ? list : [];
    out[conversationId] = entries.map((entry, index) => {
      const item = entry as { id?: unknown; text?: unknown; steering?: unknown };
      return {
        id: typeof item?.id === 'string' && item.id ? item.id : `queued-${now}-${index}`,
        text: typeof item?.text === 'string' ? item.text : String(item?.text ?? ''),
        status: 'queued',
        createdAt: now,
        // A steering entry is guidance the running task will apply, so the row
        // shows that state instead of offering to stop the run for it.
        ...(item?.steering === true ? { steering: true } : {}),
      };
    });
  }
  return out;
}

/**
 * SleepyCode reports the queued prompts for a conversation; React keeps them in
 * `workflowState.queues`.
 *
 * React REPLACES its whole map from this message, so the host sends every
 * conversation's rows (`queues`); sending one conversation emptied the others.
 */
function queuedPrompts(message: SleepyMsg): ReactMsg {
  if (message.queues && typeof message.queues === 'object') {
    return { type: 'workflowState', queues: queueRows(message.queues) };
  }
  const prompts: unknown[] = Array.isArray(message.prompts) ? message.prompts : [];
  const ids: unknown[] = Array.isArray(message.ids) ? message.ids : [];
  return {
    type: 'workflowState',
    queues: queueRows({ [message.conversationId ?? '']: prompts.map((prompt, index) => ({ id: ids[index], text: prompt })) }),
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
  return modelOptionsPayload(message.groups as any[], message.overrides as Record<string, any> | undefined);
}

/**
 * The flat model list, with the options each model can be configured with.
 *
 * Shared by the chat's model message and the settings window's Models page: two
 * copies of this mapping is how the picker and the editor start disagreeing about
 * what a model's context window is.
 */
export function modelOptionsPayload(
  inputGroups: readonly any[] | undefined,
  inputOverrides: Record<string, any> | undefined,
): ReactMsg {
  const groups: any[] = Array.isArray(inputGroups) ? (inputGroups as any[]) : [];
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
        // The composer reads `max_context` from here for its context ring and for
        // the model-options editor; sending [] left both with nothing.
        options: modelOptions.optionsFor(
          { contextWindow: typeof model === 'string' ? undefined : model?.contextWindow, maxOutputLimit: typeof model === 'string' ? undefined : model?.maxOutputLimit },
          inputOverrides?.[id],
        ),
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
    // `false`, not `undefined`: the star renders from one shape.
    pinned: conversation.pinned === true,
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
    // Stack state for the compaction controls. `false` rather than undefined:
    // the buttons render from one shape.
    compactionUndoable: message.compactionUndoable === true,
    compactionRedoable: message.compactionRedoable === true,
    // The persona this chat runs on. Without it, switching to a chat with its own
    // override kept showing the previous one.
    ...(typeof message.personaId === 'string' ? { personaId: message.personaId } : {}),
  };
}

/** The React change-review message for a transcript's latest edits. */
export function pendingChangesMessage(items: readonly any[] | undefined): ReactMsg {
  const changes = pendingChangesOf(items);
  // The change actions resolve their files through a conversation and a turn,
  // and turns carry no id in the webview — so the turn that made these changes
  // travels with them. Omitted when there is nothing to act on, which is what
  // keeps the buttons disabled rather than posting a message that cannot work.
  const itemId = changes.length ? latestAssistantItemId(items) : undefined;
  return { type: 'pendingChanges', changes, ...(itemId ? { itemId } : {}) };
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
      // A staged change has been accepted, and a reverted one undone: neither is
      // awaiting review, so neither belongs in the bar. Without the staged case
      // "Keep All" left the bar showing files it had just accepted, and the
      // buttons never closed.
      .filter(change => change && !change.reverted && !change.staged)
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
 *
 * Shared with the host's opening payload, so the ring shows the conversation's
 * real occupancy from the first paint rather than zero until the next response.
 */
export function contextTokensOf(items: readonly any[] | undefined): number {
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
      // The routed model, so the footer can say which one produced this response.
      // Omitted when absent rather than sent as undefined, which would render an
      // empty chip instead of none.
      ...(item.model ? { model: item.model } : {}),
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
    // Carry steps and done-ness as well as the synthesised content, so the card
    // has everything the live path has: a work item with no steps is the one
    // that rendered as "(empty plan)".
    input: { title: work?.title || 'Plan', content, steps, doneSteps, done: finished },
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
  /** Composer mode; `agent` acts, `ask` and `plan` are read-only. */
  mode?: string;
  /** Drafts and open tabs restored from the host's per-workspace storage. */
  workspaceState?: unknown;
  /** Chat preferences, so the first paint uses the stored values. */
  uiPrefs?: unknown;
  /** Reasoning level in force, so the composer's picker starts on the truth. */
  reasoningEffort?: unknown;
  /** Agent in force, and the agents to choose from. */
  agentId?: string;
  agents?: readonly unknown[];
  /** Personas available, and the one new chats start on. */
  personas?: readonly unknown[];
  activePersonaId?: string;
}): ReactMsg {
  return {
    type: 'initialState',
    mode: input.mode === 'ask' || input.mode === 'plan' ? input.mode : 'agent',
    selectedModel: input.selectedModel ?? '',
    activeId: input.activeId,
    turns: input.turns ?? [],
    personas: Array.isArray(input.personas) ? input.personas : [],
    activePersonaId: input.activePersonaId ?? '',
    hasProviders: true,
    usedTokens: input.usedTokens ?? 0,
    workspaceRoot: input.workspaceRoot,
    canSend: Boolean(input.workspaceRoot),
    approvalPolicy: approvalPolicyForMode(input.approvalMode),
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
    reasoningEfforts: effortOptions(),
    agentId: input.agentId,
    agentOptions: agentOptions(input.agents),
    ...(input.workspaceState ? { workspaceState: input.workspaceState } : {}),
    ...(input.uiPrefs ? { uiPrefs: input.uiPrefs } : {}),
  };
}

// ---------------------------------------------------------------- composer context

/**
 * The context switches worth sending, or undefined when there are none.
 *
 * `ComposerContext` fields are additive and default to on host-side, so only the
 * off ones are stated. Booleans only: anything else would reach the prompt
 * builder as a value it has to guess at.
 */
function contextSwitches(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const field of ['includeProjectIndex', 'includeActiveFile', 'includeSelection'] as const) {
    if (input[field] === false) out[field] = false;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- reasoning effort

/**
 * The levels a picker renders, in the model's own scale order.
 *
 * Built from `reasoning-effort.ts` so the composer and the request body cannot
 * disagree about which levels exist or what they are called.
 */
export function effortOptions(): { id: string; label: string; hint: string }[] {
  return REASONING_EFFORTS.map(id => ({ id, label: REASONING_EFFORT_LABELS[id], hint: REASONING_EFFORT_HINTS[id] }));
}

// ---------------------------------------------------------------- panels

/**
 * Titles live in `panel-core` because the React drawer renders the same
 * headings the host does. Re-exported here so the adapter stays the one import
 * the host needs.
 */
export { panelTitle } from './panel-core.ts';

/**
 * A panel payload is already the shape the drawer renders: a title, an optional
 * detail, and — for panels whose rows act on something — an id. The id has to
 * survive the translation or the row's button has no target.
 */
function panelPayload(message: SleepyMsg): { type: 'panel'; panel: string; rows: { id?: string; title: string; detail?: string }[]; hint?: string } {
  const rows = Array.isArray(message.rows) ? message.rows : [];
  return {
    type: 'panel',
    panel: message.panel,
    rows: rows.map(row => {
      const out: { id?: string; title: string; detail?: string } = { title: String(row?.title ?? '') };
      if (row?.id) out.id = String(row.id);
      if (row?.detail) out.detail = String(row.detail);
      return out;
    }),
    hint: message.hint,
  };
}

// ---------------------------------------------------------------- streaming

/**
 * SleepyCode republishes the whole active transcript whenever state changes.
 * Replaying one mid-run would replace the webview's live turns and erase text
 * that has streamed but not been committed yet, so snapshots wait until the
 * run settles while every streaming event still goes straight through.
 */
export function toReactMessageWhileStreaming(message: SleepyMsg, streaming: boolean): ReactMsg | null {
  // The transcript is withheld, not the switch: `activeId` is the only part of the
  // snapshot that is not a replay. Dropping the whole message meant that clicking
  // another tab during a run changed nothing, because the webview never learned
  // which conversation the host had made active.
  if (streaming && message?.type === 'conversation') return { type: 'conversationActive', activeId: message.id };
  return toReactMessage(message);
}

// ---------------------------------------------------------------- sign-in

/**
 * SleepyCode's sign-in banner lives in the vanilla webview, which the React
 * base replaces. Rather than leave a signed-out user with no way to sign in,
 * the host offers it once when the account status comes back signed out.
 */
/**
 * The banner the chat shows when the account is signed out.
 *
 * `shouldOfferSignIn` drives the native notification; the banner must appear on
 * exactly the same condition or one path prompts while the other stays silent.
 * `busy` means a sign-in is in flight, and a banner appearing mid-flow would
 * flicker on top of the flow itself.
 */
export function signInBanner(message: SleepyMsg | null | undefined): { visible: boolean; text: string; actionLabel: string } {
  if (!shouldOfferSignIn(message)) return { visible: false, text: '', actionLabel: '' };
  return {
    visible: true,
    text: 'Sign in to SleepyAI to use models and limits. Compatibility endpoints you added yourself still work without it.',
    actionLabel: 'Sign in',
  };
}

export function shouldOfferSignIn(message: SleepyMsg | null | undefined): boolean {
  if (!message || message.type !== 'sleepyStatus') return false;
  if (message.busy) return false;
  return message.loggedIn === false;
}

// ---------------------------------------------------------------- change review

/**
 * Build the host messages for the change-review bulk actions.
 *
 * React sends `acceptAllChanges` / `rejectAllChanges` with no target, while
 * SleepyCode resolves an edit through a conversation and the assistant turn that
 * made it. Without a target the action is refused: staging or reverting the
 * wrong turn's files is worse than doing nothing.
 *
 * Keep All stages, because staging is the reversible, inspectable step.
 * Undo All reverts each file, which is what the button says.
 */
export function bulkChangeMessages(
  type: 'acceptAllChanges' | 'rejectAllChanges',
  conversationId: string | undefined,
  itemId: string | undefined,
  paths: readonly string[] | undefined,
): SleepyMsg[] {
  if (!conversationId || !itemId) return [];
  const list = (paths ?? []).filter((path) => typeof path === 'string' && path);
  if (!list.length) return [];
  if (type === 'acceptAllChanges') return [{ type: 'gitStageChanges', conversationId, itemId, paths: list }];
  return list.map((path) => ({ type: 'gitRevertFile', conversationId, itemId, path }));
}

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
 * The `@` categories this build can actually answer.
 *
 * Only file and folder search has a SleepyCode source. Docs, terminals and past
 * chats are upstream features whose data SleepyCode does not have, and a
 * mention is not harmless when unanswered: every pill serialises its `path` as a
 * FILE attachment, so a conversation id or terminal name would reach the model as
 * a bogus file path. The composer therefore offers a category only when this
 * returns true.
 */
const ANSWERED_MENTION_CATEGORIES = new Set(['files']);

/** True when the host can answer a `searchMentions` for this category. */
export function isMentionCategoryAnswered(kind: string): boolean {
  return ANSWERED_MENTION_CATEGORIES.has(kind);
}

/**
 * Pull the inline context tags out of a message. The tags remain the
 * source of truth for the model upstream; here they become file
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

// Every command that used to land here now has a real surface: Usage and the
// Skill Marketplace are settings-window sections. Kept as the mechanism for the
// next screen that is not ported yet.
const REACT_FALLBACKS: Record<string, string> = {};

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

// ---------------------------------------------------------------- conversation search

/**
 * Search the conversation list the way the history panel expects.
 *
 * The webview has only summaries, so this runs on the host's real conversations
 * and returns summaries with a matching excerpt, which is what the panel shows
 * under each hit.
 */
export function searchConversationSummaries(
  conversations: readonly any[] | undefined,
  query: string,
  archived = false,
): { id: string; title: string; updatedAt: number; archivedAt?: number; excerpt?: string }[] {
  const needle = (query ?? '').trim().toLowerCase();
  const matches = (conversation: any): { hit: boolean; excerpt?: string } => {
    if (!needle) return { hit: true };
    const title = typeof conversation?.title === 'string' ? conversation.title : '';
    if (title.toLowerCase().includes(needle)) return { hit: true };
    for (const item of conversation?.items ?? []) {
      const text = typeof item?.text === 'string' ? item.text : '';
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      // Show a little context around the hit rather than the whole message.
      const start = Math.max(0, index - 40);
      return { hit: true, excerpt: text.slice(start, start + 160).replace(/\s+/g, ' ').trim() };
    }
    return { hit: false };
  };

  return (conversations ?? [])
    .filter((conversation) => Boolean(conversation) && (conversation.archived === true) === archived)
    .map((conversation) => ({ conversation, match: matches(conversation) }))
    .filter((entry) => entry.match.hit)
    .map(({ conversation, match }) => {
      const summary: { id: string; title: string; updatedAt: number; archivedAt?: number; excerpt?: string } = {
        id: String(conversation.id ?? ''),
        title: conversation.title || 'New conversation',
        updatedAt: conversation.updatedAt ?? 0,
      };
      if (conversation.archived) summary.archivedAt = conversation.updatedAt ?? 0;
      if (match.excerpt) summary.excerpt = match.excerpt;
      return summary;
    });
}

/** The reply the webview's history panel matches on request id. */
export function conversationSearchResults(
  requestId: number,
  conversations: readonly any[] | undefined,
  query: string,
  archived = false,
): ReactMsg {
  return { type: 'conversationSearchResults', requestId, list: searchConversationSummaries(conversations, query, archived) };
}

// ---------------------------------------------------------------- drafts and tabs

/** Drafts plus open tabs, as the webview keeps them. */
interface WorkspaceState {
  openTabs: string[];
  drafts: Record<string, { text: string; attachments: { id?: string; name?: string; mime?: string; data?: string; kind?: string }[] }>;
  /** Chat preferences, stored per workspace because that is where they apply. */
  prefs?: Record<string, unknown>;
}

/**
 * Merge a partial workspace update into the stored state.
 *
 * The webview posts drafts and tabs separately, so a tabs-only update must not
 * wipe drafts. An explicit empty object still clears, which is how "new chat"
 * discards drafts — that is why presence is checked rather than truthiness.
 */
export function mergeWorkspaceState(
  current: Partial<WorkspaceState> | undefined,
  update: Partial<WorkspaceState> | undefined,
): WorkspaceState {
  const base: WorkspaceState = {
    openTabs: Array.isArray(current?.openTabs) ? current!.openTabs : [],
    drafts: current?.drafts && typeof current.drafts === 'object' ? current.drafts : {},
    prefs: current?.prefs && typeof current.prefs === 'object' ? current.prefs : {},
  };
  if (Array.isArray(update?.openTabs)) base.openTabs = update.openTabs;
  if (update?.drafts && typeof update.drafts === 'object') base.drafts = update.drafts;
  // Preferences merge key-by-key: the settings window saves one toggle at a time,
  // and replacing the record would reset the others.
  if (update?.prefs && typeof update.prefs === 'object') base.prefs = { ...base.prefs, ...update.prefs };
  return base;
}

/** Upper bound on persisted draft bytes; `globalState` is not a blob store. */
const MAX_STORED_DRAFT_BYTES = 128 * 1024;

/**
 * Prepare workspace state for storage.
 *
 * Attachments are stripped when the payload would be large — an image draft is
 * megabytes of base64, and writing that to `globalState` on every keystroke would
 * bloat the extension's state. `trimmed` tells the caller so it can say the
 * attachment was not kept instead of silently losing it.
 */
export function toStorableWorkspaceState(state: Partial<WorkspaceState> | undefined): WorkspaceState & { trimmed: boolean } {
  const merged = mergeWorkspaceState(undefined, state);
  const result: WorkspaceState = { openTabs: merged.openTabs, drafts: {}, prefs: merged.prefs };
  let trimmed = false;
  for (const [id, draft] of Object.entries(merged.drafts ?? {})) {
    if (!draft || typeof draft !== 'object') continue;
    const text = typeof draft.text === 'string' ? draft.text : '';
    const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
    const withAttachments = { text, attachments };
    if (JSON.stringify(withAttachments).length <= MAX_STORED_DRAFT_BYTES) {
      result.drafts[id] = withAttachments;
    } else {
      result.drafts[id] = { text, attachments: [] };
      trimmed = true;
    }
  }
  return { ...result, trimmed };
}

/**
 * Convert React turns back into transcript items.
 *
 * Only used to recover a conversation the host has no record of: the projection
 * is lossy (tool payloads and model history are gone), so it must never replace
 * real state.
 */
export function turnsToItems(turns: readonly any[] | undefined): any[] {
  const now = Date.now();
  const items: any[] = [];
  for (const turn of turns ?? []) {
    if (!turn || typeof turn !== 'object') continue;
    // A turn with neither role nor content is junk from a partial persist.
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    if (turn.role === 'user') {
      const item: any = { id: `recovered-${items.length}-${now}`, role: 'user', text: typeof turn.text === 'string' ? turn.text : '', timestamp: now };
      if (turn.attachments?.length) item.attachments = turn.attachments;
      if (turn.model) item.model = turn.model;
      items.push(item);
      continue;
    }
    const blocks: any[] = Array.isArray(turn.blocks) ? turn.blocks : [];
    const text = blocks.filter((block) => block?.kind === 'text').map((block) => block.text).join('');
    const work = blocks
      .filter((block) => block?.kind === 'tool')
      .map((block) => ({ kind: 'task' as const, text: block.result ?? '', tool: block.name, done: block.status !== 'running' }));
    const item: any = { id: `recovered-${items.length}-${now}`, role: 'assistant', text, timestamp: now };
    if (work.length) item.work = work;
    const error = blocks.find((block) => block?.kind === 'error');
    if (error) {
      item.kind = 'error';
      item.errorInfo = { message: error.message };
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------- export

/**
 * Render a conversation as Markdown.
 *
 * Written for reading, not for re-import: internal ids, file snapshots and tool
 * payloads are left out, because an export that leaks them is both noisy and a
 * way to share things the user did not mean to share.
 */
export function conversationToMarkdown(conversation: { title?: string; updatedAt?: number; items?: readonly any[] }): string {
  const title = conversation?.title?.trim() || 'Conversation';
  const lines: string[] = [`# ${title}`, ''];
  if (conversation?.updatedAt) {
    lines.push(`_Exported ${new Date(conversation.updatedAt).toISOString()}_`, '');
  }

  for (const item of conversation?.items ?? []) {
    if (!item || item.kind === 'divider') continue;

    if (item.role === 'user') {
      lines.push('## You', '', item.text ?? '');
      const attachments = item.attachments ?? [];
      if (attachments.length) {
        lines.push('', `_Attached: ${attachments.map((a: any) => a.name || a.path || 'file').join(', ')}_`);
      }
      lines.push('');
      continue;
    }

    lines.push(item.model ? `## Assistant (${item.model})` : '## Assistant', '');

    for (const work of item.work ?? []) {
      if (work?.kind === 'reasoning') {
        if (work.text) lines.push('> ' + String(work.text).split('\n').join('\n> '), '');
        continue;
      }
      if (work?.kind === 'plan') {
        lines.push(`**Plan: ${work.title || 'Plan'}**`, '');
        const done: number[] = Array.isArray(work.doneSteps) ? work.doneSteps : [];
        (work.steps ?? []).forEach((step: string, index: number) => {
          lines.push(`- [${done.includes(index) ? 'x' : ' '}] ${step}`);
        });
        lines.push('');
        continue;
      }
      // Tool work becomes a one-line record; the arguments and results are the
      // agent's working notes, not the outcome.
      const label = work?.tool || work?.title || work?.kind || 'tool';
      const detail = typeof work?.text === 'string' && work.text.trim() ? ` — ${work.text.trim()}` : '';
      lines.push(`- \`${label}\`${detail}`);
    }
    if (item.work?.length) lines.push('');

    if (item.kind === 'error') {
      lines.push(`**Error:** ${item.errorInfo?.message ?? item.text ?? 'The turn failed.'}`, '');
    } else if (item.text) {
      lines.push(item.text, '');
    }

    if (item.changes?.length) {
      lines.push('**Files changed**', '');
      for (const change of item.changes) {
        const delta = [
          typeof change.additions === 'number' ? `+${change.additions}` : '',
          typeof change.deletions === 'number' ? `-${change.deletions}` : '',
        ].filter(Boolean).join(' ');
        lines.push(`- ${change.path} (${change.action}${delta ? `, ${delta}` : ''})`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * A filename derived from a conversation title.
 *
 * Titles are arbitrary user text, and Windows rejects a different character set
 * than POSIX, so the safe set is the intersection. Falls back to a constant
 * rather than producing `.md` for a title made only of symbols.
 */
export function exportFileName(title: string | undefined): string {
  const base = (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .trim();
  return `${base || 'conversation'}.md`;
}

/** The reply React's question card matches on call id. */
export function questionAnswered(conversationId: string | undefined, callId: string, answers: Record<string, string[]>): ReactMsg {
  return { type: 'questionAnswered', convId: conversationId ?? '', callId, answers };
}

/**
 * Why a send did nothing when no folder is open.
 *
 * Says what to do, because "nothing happens" is the least actionable failure a
 * chat can produce.
 */
export function noWorkspaceMessage(): string {
  return 'SleepyCode needs a folder or workspace to work in. Use File → Open Folder, then send your message again.';
}

// ---------------------------------------------------------------- plan files

/**
 * Plan-tool names in every spelling that reaches the webview.
 *
 * `plan` is SleepyCode's stateful plan card, `write_plan` saves a plan file, and
 * `WritePlan` is what `reactToolName` maps the first to. The React plan card
 * answers to all of them.
 */
export function isPlanToolName(name: string | undefined): boolean {
  return name === 'plan' || name === 'write_plan' || name === 'WritePlan';
}

/**
 * The file path a plan tool reported, or `undefined` when the result is not one.
 *
 * This exists because the naive extraction (strip a `wrote plan to ` prefix) left
 * the *whole tool result* as the path whenever the wording differed, and passing
 * that to `openFile` produced `ENAMETOOLONG` with a JSON blob as the filename.
 * A result is only a path if it has a single line, ends in `.md`, contains a
 * separator, and stays inside the workspace.
 */
export function planPathFromResult(result: string | undefined): string | undefined {
  const raw = (result ?? '').trim();
  if (!raw || raw.includes('\n') || raw.startsWith('{') || raw.startsWith('[')) return undefined;
  // Tolerate a prose prefix from either wording, then trailing punctuation.
  const candidate = raw
    .replace(/^.*?wrote (?:the )?plan to\s+/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  if (!candidate.endsWith('.md')) return undefined;
  if (!candidate.includes('/') && !candidate.includes('\\')) return undefined;
  if (/\s/.test(candidate)) return undefined;
  // Stay inside the workspace: an absolute path or a traversal is not a plan file.
  if (candidate.startsWith('/') || candidate.startsWith('~') || /^[a-z]:/i.test(candidate)) return undefined;
  if (candidate.split(/[\\/]/).includes('..')) return undefined;
  return candidate;
}

// ---------------------------------------------------------------- modes

// The mode rules live in `agent-mode.ts` so the host, the webview and the
// direct tests share one definition; re-exported here for existing callers.
export {
  approvalAppliesInMode,
  applyCeiling,
  isMutatingTool,
  isToolAllowedInMode,
  knownMode,
  modeGuidance,
  resolveRunMode,
  subagentGuidance,
  withheldByCeiling,
  type AgentMode,
} from './agent-mode.ts';



// ---------------------------------------------------------------- message footer

/**
 * The display name for a model id.
 *
 * The catalog carries names and the transcript carries ids. A footer showing a raw
 * id is worse than one showing nothing, so the id is only a fallback for a model
 * the catalog does not know — which is normal right after a new model appears.
 */
export function modelLabel(modelList: readonly { id?: string; name?: string }[] | undefined, modelId: string | undefined): string {
  const id = typeof modelId === 'string' ? modelId : '';
  if (!id) return '';
  const entry = (modelList ?? []).find(item => item?.id === id);
  return entry?.name || id;
}
