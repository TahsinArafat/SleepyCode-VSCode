# Phase 1 Local Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local `ToolLoopAgent` fallback one persisted session record so undo, redo, retry, continue, and incomplete turns survive reload and can later be imported into the CLI.

**Architecture:** Keep the existing sidebar and `ToolLoopAgent`. A conversation is one record (`items`, `messages`, `pending`, workspace snapshot). Pure helpers live in `src/session-core.ts`. `src/agent.ts` is the only writer. Do not start `sleepy serve` or open `sleepy.db` in this slice.

**Tech Stack:** TypeScript, VS Code `globalState`, Node test runner (`node --test`, `node --experimental-strip-types --test test/*.direct.mjs`).

**Spec:** `docs/cli-harness-adoption.md` — Phase 1 only.

## Global Constraints

- One conversation belongs to one engine. This slice is local-loop only.
- Never set `conversation.messages = undefined`.
- Incomplete turns stay on disk: stop, error, step-limit pause, and reload must leave a retryable assistant item plus structured history.
- Retry / Continue reuse the last real user text. No fake `"Continue"` user turn in structured history.
- Persist the dirty conversation, not the whole project index on a 3s timer.
- Tests stay at public helper seams (`session-core`, `iteration-core`) plus source contracts in `test/sleepycode-regressions.test.mjs`.

## Already in the tree (do not redo)

These are present as uncommitted work and should be kept:

- `src/session-core.ts` + `test/session-core.direct.mjs`
- `recoverPendingHistory` folds `pending` onto existing history
- undo / redo / restore / edit / branch slice `messages` with `items`
- `turnUndo` / `turnRedo` live on the conversation and persist with it
- retry / continue call `resumeFromLastAssistant` and `run(..., originalUserText)`
- compaction undo/redo restore `beforeMessages` / `afterMessages`
- mid-run `conversation.pending` checkpoint after each completed tool iteration
- `assert.doesNotMatch(agent, /conversation\.messages = undefined;/)`

## Remaining holes

1. `checkpointConversation()` still calls `persistProjects()`, which rewrites every project on every flush.
2. Abort still creates an assistant item whose visible text is `'Stopped.'` instead of the same retryable interrupted shape used on error / reload.
3. Uncommitted Phase 1 files are not verified as a set.

---

### Task 1: Persist only the dirty project

**Files:**
- Modify: `src/agent.ts` (`persistProjects`, `checkpointConversation`)
- Test: `test/sleepycode-regressions.test.mjs`

**Interfaces:**
- Consumes: existing `persistChain`, `MAX_PERSISTED_CONVERSATIONS`, conversation id
- Produces: `persistProject(project)` writes only `sleepycode.project.${project.id}`

- [ ] **Step 1: Write the failing contract**

In `test/sleepycode-regressions.test.mjs`, add to the interrupted-run test:

```js
assert.match(agent, /private persistProject\(/);
assert.match(agent, /checkpointConversation\(conversation, force = false\)[\s\S]{0,500}this\.persistProject\(/);
assert.doesNotMatch(agent, /checkpointConversation\(conversation, force = false\)[\s\S]{0,500}this\.persistProjects\(\)/);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/sleepycode-regressions.test.mjs`

Expected: FAIL — `persistProject` is not defined.

- [ ] **Step 3: Write the minimal implementation**

Add next to `persistProjects()`:

```ts
private persistProject(project: Project): Promise<void> {
  this.persistChain = this.persistChain.then(async () => {
    const conversations = project.conversations.slice(0, MAX_PERSISTED_CONVERSATIONS);
    await this.context.globalState.update(`sleepycode.project.${project.id}`, {
      conversations,
      activeConversationId: project.activeConversationId,
    });
  });
  return this.persistChain;
}

private projectForConversation(conversationId: string): Project | undefined {
  return this.projects.find(project => project.conversations.some(item => item.id === conversationId));
}
```

Change `checkpointConversation` to:

```ts
private checkpointConversation(conversation: Conversation, force = false): Promise<void> {
  const now = Date.now();
  const last = this.checkpointAtByConversation.get(conversation.id) ?? 0;
  if (!force && now - last < AgentViewProvider.CHECKPOINT_INTERVAL_MS) return this.persistChain;
  this.checkpointAtByConversation.set(conversation.id, now);
  conversation.updatedAt = now;
  const project = this.projectForConversation(conversation.id);
  if (!project) return this.persistChain;
  project.updatedAt = now;
  return this.persistProject(project);
}
```

Keep `persistProjects()` for activate / rename / delete / project-index writes.

- [ ] **Step 4: Run the contract to verify it passes**

Run: `node --test test/sleepycode-regressions.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit with the rest of Task 2** (single Phase 1 commit after Task 2).

---

### Task 2: Stopped turns use the same interrupted shape

**Files:**
- Modify: `src/agent.ts` (abort branch around the `'Stopped.'` item)
- Modify: `src/session-core.ts` only if `interruptedAssistantFields` must carry visible text
- Test: `test/session-core.direct.mjs`, `test/sleepycode-regressions.test.mjs`

**Interfaces:**
- Consumes: `interruptedAssistantFields({ reason: 'stop', partialText, work, changes, fileSnapshot, gitTree })`
- Produces: abort item text is the partial answer, or `Response interrupted — retry continues from this point.` Never a dead-end `'Stopped.'` as the only visible text.

- [ ] **Step 1: Write the failing tests**

In `test/session-core.direct.mjs` (already has stop/error/pause shape). Add:

```js
test('stop uses the same retryable assistant as error', () => {
  const stopped = interruptedAssistantFields({
    userText: 'do it',
    reason: 'stop',
    message: 'Response interrupted — retry continues from this point.',
    partialText: 'halfway',
    work: [{ kind: 'task' }],
  });
  const failed = interruptedAssistantFields({
    userText: 'do it',
    reason: 'error',
    message: 'Model failed',
    partialText: 'halfway',
  });
  assert.equal(stopped.kind, 'error');
  assert.equal(failed.kind, 'error');
  assert.equal(stopped.partialText, 'halfway');
});
```

In `test/sleepycode-regressions.test.mjs`:

```js
assert.doesNotMatch(agent, /createTranscriptItem\('assistant', 'Stopped\.'/);
assert.match(agent, /Response interrupted — retry continues from this point\./);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --experimental-strip-types --test test/session-core.direct.mjs` and `node --test test/sleepycode-regressions.test.mjs`

Expected: FAIL on the `'Stopped.'` source contract.

- [ ] **Step 3: Write the minimal implementation**

In the abort branch, replace the `'Stopped.'` item with:

```ts
const interruptedText = partialAnswer.trim()
  || resume?.partialText?.trim()
  || 'Response interrupted — retry continues from this point.';
const stoppedItem = createTranscriptItem('assistant', interruptedText, 'error', runGitTree, work.slice(-80), workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0);
```

Keep `interruptedAssistantFields({ reason: 'stop', ... })` so `partialText` / `work` / `changes` / `fileSnapshot` stay on the same item. Retry / continue already read that item through `resumeFromLastAssistant`.

- [ ] **Step 4: Run tests**

```
node --experimental-strip-types --test test/session-core.direct.mjs test/iteration-core.direct.mjs
node --test test/sleepycode-regressions.test.mjs
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-core.ts src/agent.ts src/iteration-core.ts src/types.ts src/util.ts \
  test/session-core.direct.mjs test/iteration-core.direct.mjs test/sleepycode-regressions.test.mjs \
  docs/cli-harness-adoption.md docs/superpowers/plans/2026-09-27-phase-1-local-session-state.md
git commit -m "$(cat <<'EOF'
Persist local chats as one session record.

Undo, redo, retry, continue, and incomplete turns now share items, messages, pending, and workspace snapshots so a reload can resume the same turn.
EOF
)"
```

---

## Spec coverage

- One session record: Task 1 + existing `session-core` / agent wiring.
- Undo/redo persist: already on `conversation.turnUndo` / `turnRedo`.
- `pending` survives reload: already folded by `recoverPendingHistory`.
- Retry/Continue reuse original user text: already `resumeFromLastAssistant`.
- Stopped/failed same shape: Task 2.
- Dirty-conversation checkpoint: Task 1.
- No `messages = undefined`: already contracted.

## Out of scope

CLI attach/serve, `sleepy.db`, import, thin-client switch.
