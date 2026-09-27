# CLI harness adoption

Status: approved design. Do not implement until this document is accepted as the working spec.

Goal: one agent engine, one history store. The VS Code sidebar stays. The Sleepy CLI owns the live loop, tools, permissions, compaction, resume, and `sleepy.db`. The extension becomes a client when `sleepy` is available, and keeps a repaired local `ToolLoopAgent` only as an offline fallback.

## Decisions

1. Adopt the CLI harness (approach A), not a second VS Code-shaped store.
2. Use the CLI when `sleepy` can be started or attached. Fall back to the local agent only when the CLI is missing.
3. A conversation belongs to one engine. Never continue a CLI session with the local loop, or a local chat with the CLI, mid-flight.
4. After leftover local chats are imported, this workspace writes only through the CLI.
5. Fix local-loop session state first. The fallback is still the live engine today, and it cannot be imported until undo, redo, retry, continue, and incomplete turns persist as one record.

## Architecture

```
CLI found? ──yes──► sleepy serve (loopback) ──► ~/.local/share/sleepy/sleepy.db
     │                      ↑
     │               CLI / TUI / desktop
     no
     ▼
local ToolLoopAgent ──► VS Code globalState     (offline only)
```

- On activate, look for `sleepy` on `PATH` and `~/.local/bin/sleepy`. Start or attach to `sleepy serve` on loopback for the open folder.
- CLI mode talks to the existing HTTP API: `session.list`, `session.create`, `session.prompt_async`, `GET /event`, `permission.respond`, plus resume/revert when needed.
- Only the CLI process writes `sleepy.db`. The extension never opens SQLite.
- `ToolLoopAgent` and `src/tools.ts` stay for local mode only. They leave the send path in CLI mode.
- The webview stays. It renders a projection of CLI sessions/parts, or the repaired local conversation record.
- If the server dies, show that and retry. Do not silently swap engines on an open chat.

VS Code still owns editor chrome: composer, diffs, notifications, focus, and editor-only settings. Permissions, tools, compaction, resume, and history stay in the CLI when CLI mode is active.

## Phase 1 — local-loop session state

The fallback engine already has the pieces. They are not one state. That is why undo, retry, and continue look like they work and then lose context.

### One session record

A local conversation is one record, not two lists:

- `items` — what the sidebar shows
- `messages` — what the next model call sees
- `pending` — the unfinished turn, including incomplete assistant text and tool work
- workspace snapshot — git tree or file snapshots for that turn

Every mutation must cut or restore all four. If only the transcript changes, the next send replays the undone turn.

Incomplete turns stay in this same record. Stop, error, step-limit pause, and reload must leave a retryable assistant item plus `pending`. Nothing that the user can still continue is discarded.

### Required fixes

1. Undo, redo, restore, edit, and compact must slice `messages` with the transcript. Stop setting `messages = undefined`. Cut at the same user-turn boundary. Redo restores that slice. Compaction undo/redo restore the pre/post `messages`, not just `items`.
2. Persist undo/redo. `undoStacks` is memory-only today, so reload kills redo. Store the last few turn snapshots next to compaction snapshots. Redo must also restore files, not only the transcript.
3. `pending` survives reload. `recoverPendingHistory` currently throws away an in-progress turn if older `messages` exist. Fold `pending` onto the tail instead. A reload should leave a retryable interrupted item, not a silent drop.
4. Retry and Continue keep the original user text. They currently call `run('Continue')`, so structured history stores a fake user turn. Resume must reuse the last real user item and append only new assistant/tool messages.
5. Stopped and failed turns are the same shape. Stop, error, and step-limit pause all leave one assistant item with `partialText`, `work`, `changes`, and `fileSnapshot`. Continue/retry use that item. No special `Stopped.` dead end.
6. Checkpoint the dirty conversation, not the whole project index every 3s. Write `pending` after each completed tool iteration for that chat. Force-flush on stop, error, and done.

### Out of scope for phase 1

CLI server, `sleepy.db`, and the thin-client switch. This slice only makes the local fallback a session that can later be imported once.

### Verify phase 1

Direct tests around `iteration-core` plus new session-state helpers:

- undo then next send does not replay the undone turn
- redo restores transcript and files
- reload keeps `pending` and shows a retryable interrupted item
- retry after error reuses the original user text
- continue after pause appends to the same turn
- compact undo/redo restore both `items` and `messages`
- no `messages = undefined` on those paths

## Phase 2 — CLI client

### Live path

```
composer send
  → POST /session/{id}/prompt_async
  → GET /event (SSE)
  → webview renders parts
  → CLI writes sleepy.db
```

The extension never writes SQLite. It holds a projection of the open session for the sidebar.

### Session identity

A VS Code conversation maps to one CLI session for this workspace `directory`. List, create, and open go through `session.list` / `session.create`. Local-only chats stay in `globalState` until imported.

### UI mapping

Keep the current cards. Drive them from CLI parts:

| CLI | Sidebar |
|---|---|
| user `text` / `file` | user bubble + attachments |
| assistant `text` | assistant bubble |
| `reasoning` | activity reasoning |
| `tool` pending/running/completed/error | task rows |
| `step-start` / `step-finish` | live activity + usage |
| `retry` | reconnect row |
| `compaction` | compact divider |
| assistant `error` / aborted tool | error card + Continue |
| `permission.asked` | existing approval prompt |
| `session.status` busy/idle | running state |

Incomplete turns stay as the last assistant message plus its unfinished tool parts. Continue/retry call CLI `session.resume` / `session.prompt_async` on that session. Never invent a `"Continue"` user message.

Undo, redo, and restore in CLI mode use CLI revert, unrevert, and checkpoint. The local-loop persistence work stays for offline chats only.

### CLI tool-loop contract

The CLI already has a full harness. VS Code must not grow a second one beside it.

Source of truth is SQLite `session` / `message` / `part` rows, not a display transcript. `SessionPrompt.runLoop` in `cli/packages/opencode/src/session/prompt.ts` reloads that slice every step (`contextFrom` / `contextWatermark`). Tools, permissions, compaction, and resume all mutate those rows. The sidebar is a projector.

**Send**

```
POST /session                     → session.create (directory = workspace)
POST /session/{id}/prompt_async   → SessionPrompt.prompt
                                    creates the real user message
                                    then runLoop
GET  /event                       → live parts
```

`prompt()` also sweeps orphan assistants and running tool parts left by a crash, then starts the loop. The client does not invent a user turn named `Continue`.

**Stream**

Consume SSE, do not poll SQLite:

- `message.updated` / `message.part.updated` — text, reasoning, tool rows
- `permission.asked` — block the tool until the user answers
- `permission.replied` — hide the prompt
- `session.idle` — run finished
- `session.error` — show the error card

Tool parts already carry `pending` → `running` → `completed` | `error`. Map those onto the existing activity rows. Do not keep a parallel `WorkItem[]` as the model-visible history.

**Permissions**

`Permission.ask()` publishes `permission.asked` and waits on a deferred. The loop is blocked until:

```
POST /session/{id}/permissions/{permissionID}
body: { reply: "once" | "always" | "reject", message?: string }
```

Reject can include feedback (`CorrectedError`). `always` writes a rule; forced-ask permissions stay once. There is no VS Code-side approval cache in CLI mode.

**Stop / retry / continue**

| User action | Client call | CLI behavior |
|---|---|---|
| Stop | `POST /session/{id}/abort` | `SessionPrompt.cancel` + process-group kill. Incomplete assistant and tool parts stay on disk. |
| Continue interrupted assistant | `GET /session/{id}/recovery` then `POST /session/{id}/turn/{assistantMessageID}/resume` | Resumes that assistant. No new user message. |
| Continue trailing user | `POST /session/{id}/resume` (`userMessageID` optional) | Starts the next assistant from that user. |
| New prompt | `prompt_async` | Creates a new user message, then loops. |

A turn is recoverable when the assistant is unfinished: `finish` is `tool-calls` or `length`, there is an error, or there is no terminal `stop`. Empty residue assistants are swept; error shells are kept. After tools completed, a retryable transport failure auto-continues the outer step (`shouldAutoResumeAfterTools`) instead of stamping a fake user turn.

**Undo / files**

`POST /session/{id}/revert` and `/unrevert` (`SessionRevert`) restore snapshot/patch parts and remember the revert point on the session. Do not pop local `items` and hope `messages` catch up.

### Sync hazards if VS Code keeps its own loop

These are the later-breakage cases. They are out of spec if they happen on a CLI session.

1. **Two histories.** Local `items` + `messages` vs CLI `message` + `part`. Dual-write will drift on the first undo or crash.
2. **Fake `Continue` user turns.** CLI resume is id-based (`assistantMessageID` / `userMessageID`). A synthetic user message becomes a new turn and orphans the interrupted assistant.
3. **Memory-only undo.** CLI revert is persisted. A local stack dies on reload and cannot unrevert a CLI session.
4. **Permission race.** Answering in the webview without `permission.respond` leaves `ask()` blocked forever, or a local allow lets a tool run that the CLI would have denied.
5. **Pending drop on reload.** CLI parts stay in SQLite. Local `recoverPendingHistory` currently discards in-flight work if older `messages` exist. Importing that state loses the half-turn.
6. **Engine swap mid-chat.** Feeding a CLI session into `ToolLoopAgent`, or a local chat into `runLoop`, mixes tool ids, permission rules, and compaction watermarks.

Rule: if `sleepy` is available, only `SessionPrompt` executes tools for that workspace. The extension renders events and posts replies. Local `src/tools.ts` runs only in offline mode.

## Phase 3 — conversations with leftover history stay local (import not adopted)

**Decision: do not import.** The step above assumed the CLI could accept history
we cannot hand-write. It cannot. Auditing every route in the CLI shows the only
message-creating paths — `POST /session/{id}/message` and `prompt_async` — both
call `SessionPrompt.prompt` and run the model, and `/import/run` only reads
Claude Code, Codex, and opencode's own on-disk formats. There is no route that
writes message rows without starting the loop.

The only way to "import" would be replaying each old turn as a fresh prompt.
That re-runs the model on work the user already paid for, spends real tokens, and
invents a transcript that never happened. Rejected. Adding a write route to the
CLI is possible but is a change to a separate repository, and nothing else in
this design depends on import.

What ships instead, in `src/engine-routing-core.ts`:

- A conversation with **no history yet** uses the CLI.
- A conversation **already bound to a CLI session** stays there, and its items
  are a display mirror of CLI rows rather than local history.
- A conversation holding **leftover local history** stays local for good, so a
  CLI server starting up later never silently moves an existing chat.

This is still the hard rule the design turns on: never continue one engine's
session with the other. A workspace simply holds both kinds of chat, and routing
is decided per conversation rather than per workspace.

## Fallback rule

- CLI found: CLI sessions.
- CLI missing: local `ToolLoopAgent` + `globalState`.
- Never continue one engine's session with the other.
- Local mode remains an install/offline fallback, not a second source of truth after import.

## Implementation order

1. Phase 1 local session-state fixes and tests.
2. Phase 2 CLI attach/serve client and part-to-UI projection.
3. Phase 3 routing, so only conversations with no history of their own are handed to the CLI.

## Non-goals

- Embedding Effect, Drizzle, or native SQLite in the extension host.
- Two-way merge of live VS Code `TranscriptItem`s into `sleepy.db` while the local loop is still the writer.
- Keeping `ToolLoopAgent` as a silent backup for CLI chats.
- Reimplementing `SessionPrompt.runLoop`, permission deferreds, or revert snapshots inside the extension.
