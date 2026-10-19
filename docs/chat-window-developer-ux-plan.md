# Chat window UI/UX — a developer-friendly plan

Status: **proposed** · Scope: the `sleepycode.chat` webview only (no engine/tool-semantics changes)
Host surface: `WebviewViewProvider` in the VS Code **auxiliary bar / sidebar** (`src/extension.ts:18`), narrow by default, `retainContextWhenHidden: true`.

---

## 1. The developer we are designing for

Someone who already lives in VS Code with a terminal, an editor, and a debugger open, and who treats the agent the way they treat a shell:

- They read **diffs and commands**, not prose. If the tool summary is a single squashed line, the UI failed.
- They type fast and expect **shell-grade ergonomics** — history, shortcuts, no modal interruptions.
- They **audit** what ran. An approval they can't re-read later is an approval they can't trust.
- They expect to **click a path** and land on that line.
- They lose trust the moment the UI **hitches**.

Every item below is graded against those five expectations.

---

## 2. Audit — what is actually in the code today

Facts, with citations. All are live today, not hypothetical.

### A. Streaming is O(n²) in the markdown renderer — the UI hitches on long answers

```
src/webview/runtime.ts:1396  case'delta':
  current.dataset.raw += m.text;
  current.innerHTML = markdown(current.dataset.raw);   // ← full re-parse per token
```

`markdown()` (`runtime.ts:547`) re-tokenizes the **entire accumulated answer** on every single delta, then throws away the DOM and rebuilds it. `renderLive()` (`runtime.ts:544`) goes further and rebuilds the *whole live turn* — every reasoning part, tool row, subagent group and file-change preview — from scratch on each call.

For a 5,000-token answer that is ~5,000 full markdown parses of a string that grows to 5,000 tokens. This is the single highest-impact defect in the window, and it is exactly the kind of thing a developer notices and blames on the tool.

### B. Code blocks render unstyled — no highlighting at all

`markdown()` emits a bare `<pre><code>`. `grep -c "highlight|hljs|prism|shiki" src/webview/runtime.ts` → **0**. In a ~380px sidebar, an unhighlighted 40-line fence is a wall of grey.

### C. Tool calls show a label and nothing else

The webview's tool row model is the entire payload:

```
src/agent.ts:461      { type:'tool', conversationId, phase, id, tool, name, failed }
src/webview/runtime.ts:1400   row = { id, name, tool, done, failed, parentId, subagentRole }
```

`name` is `humanToolName(name) + ' · ' + summarizeInput(input)` (`src/util.ts:142`) — the tool *input* is flattened into one summary string. There is **no tool output, no duration, no exit status, no argument structure** anywhere in the model, so a developer cannot see what a command actually printed.

### D. Approvals are a blocking modal rendered as plain text

```
src/webview/runtime.ts:234  notifyBody.textContent = opts.body;
```

`opts.body` is a plain string (`src/agent.ts:4489 prompt(title, detail, ...)`). So the one moment where a developer must make a trust decision — *"run this command?"* — shows unformatted text in a modal that (a) destroys stream context, (b) is **not recorded in the transcript**, and (c) offers only OK / Cancel / secondary, with no "always allow for this session".

### E. File paths in prose are not clickable

```
src/webview/runtime.ts:546  line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
```

Only `http(s)` becomes an anchor. Meanwhile the capability already exists — the changes card wires `data-open-change` → `openFile` (`runtime.ts:665-671`). The gap is that the same affordance is not applied to assistant prose.

### F. No contributed keybindings; composer keys are the whole model

`package.json → contributes.keybindings` is `[]`. Inside the webview the only handled keys are:

```
runtime.ts:895-911  Enter (send) · Shift+Enter (newline) · ArrowUp/ArrowDown (history recall) · Escape (clear/blur)
```

Plus separate `stopImmediatePropagation` handlers for the slash (`:200`) and mention (`:201`) menus. No stop-run shortcut, no multi-line-send escape hatch, no focus movement, no shortcut discoverability.

### G. Dropdowns and streaming are not accessible

- `role` appears just 4× in the whole HTML: one `menu` (conversation), two `dialog`, one `status`. None of the six dropdowns — model / effort / agent / safety / mention / slash — carries a `role="listbox"` or `role="option"`, and no trigger wires `aria-controls` or `aria-activedescendant`, so highlight and selection are invisible to assistive tech.
- `aria-live` appears exactly **once** (compaction overlay). `#messages` is not a `role="log"`, so streamed answers and status changes are never announced.

### H. Observability is one level too deep

"View extension logs" lives only inside **Settings** (`#extensionLogs`). A developer staring at a failing turn cannot get to that turn's logs without leaving the transcript.

---

## 3. Design principles

1. **Progressive disclosure, never truncation.** Never show *less* content to go faster — show the same content, computed once.
2. **Shell-grade input.** If it needs a mouse, a developer will not find it.
3. **Everything that ran stays auditable** — in the transcript, in order, with its inputs and outputs.
4. **Approve in place.** Decisions belong next to the evidence that justified them.
5. **Vanilla-first.** No runtime dependencies in the webview bundle; CSP is `script-src 'nonce-…'` with `default-src 'none'`, and all rendering already escapes through `esc()` *before* HTML is built. Anything added here must keep that ordering.
6. **Degrade, don't break.** Every new surface must render correctly from a persisted transcript item, not only from a live stream.

---

## 4. The plan

Five independently shippable phases. Each names its files, its design, and the test that proves it.

---

### Phase 1 — Streaming performance & live-render fidelity ✅ SHIPPED

**Problem:** §2-A. **Why first:** everything else gets measured on top of this; it is also the top trust-destroyer.

**Files:** `src/webview/stream-render.ts` (new), `src/webview/runtime.ts`, `test/streaming-render.direct.mjs` (new), `test/katex.test.mjs`.

**What landed**

- `src/webview/stream-render.ts` exports `streamBlockCut` as a real, unit-testable function plus `STREAM_RENDER_SOURCE` / `STREAM_FRAME_SOURCE`, which are spliced into the webview template — the same trick `runtime-core.ts` uses for `esc`. Splitting on blank lines is safe because `markdown()` is already context-free at those boundaries.
- `createStreamRenderer(markdown)` settles each finished top-level block once and re-renders only the trailing partial block → linear instead of quadratic.
- `createFrameCoalescer` collapses any number of deltas between frames into one DOM write.
- `scroll()` batches its follow-up measurement behind a single pending handle instead of queueing a frame per token.
- `closeCurrentText()` → `flushStreamPaint()` drains a pending frame before `finish()` nulls the element refs, and `renderConversation()` cancels it — so a `done` event cannot repaint a stale answer into a dead turn.

**Known limit (deliberate):** a fence still open at the tail cannot be settled without changing `markdown()`'s one-`<pre>`-per-fence output, so that tail repaints per frame. It is a bare `esc()` pass with no tokenizing, and coalescing caps it at one repaint per frame.

> The repaint test asserts against a **measured animation-frame count**, not a fixed ratio. Chrome clamps nested `setTimeout(0)` to ~4 ms, so a paced input loop offers only a handful of deltas per frame on any machine; the per-frame contract is the invariant that survives slow CI, with a loose ratio kept as the regression guard.

**Design**

- **Coalesce deltas into one render per frame.** Buffer incoming text in `pendingDelta`; a single `requestAnimationFrame` loop drains it. At most one `innerHTML` write per frame regardless of token rate.
- **Incremental block rendering.** Split the buffer into top-level markdown blocks (paragraph / fence / list / table / math). Cache rendered HTML for *completed* blocks keyed by a cheap content hash. On a delta, only re-render the trailing partial block; completed blocks are reused verbatim. Turns O(n²) into O(n).
- **Keyed live patch.** Replace `renderLive`'s full rebuild with a reconcile that reuses existing `.activity` / `.assistant.streaming` / `.tool` nodes and updates only changed text nodes. Preserve `open/closed` state of `<details>` across reconciles so an expanded tool row does not collapse mid-run.
- **Batch layout reads.** `scroll()` (531) currently does `pinScroll(); updateJump(); rAF(→ pinScroll(); updateJump())`. Move all `scrollHeight`/`offsetHeight` reads to the top of the frame and all writes to the bottom, so a frame never interleaves read→write→read.
- Guard: `markdown()` output must be **byte-identical** to today's for every input, so history replay and streaming agree.

**Verify** — new `test/streaming-render.direct.mjs` using the existing esbuild + Playwright harness (copy `test/composer-history.direct.mjs`):
1. 12,000-token stream completes with **≤ 1 `markdown()` invocation per animation frame**.
2. Total render calls ≤ `frames + 2`, not ≤ tokens.
3. `markdown(partial) + markdown(full)` final HTML === streamed final HTML.
4. No long task > 50 ms observed in `PerformanceObserver` during the stream.

---

### Phase 2 — Code & tool-output legibility ✅ SHIPPED

**Problem:** §2-B, §2-C. This is the core "developer-friendly" payoff.

**Files:** `src/webview/runtime.ts`, `src/webview/styles.ts`, new `src/webview/highlight.ts`, `src/agent.ts:461` (payload), `src/cli-engine.ts:333` (CLI path).

**Design — code blocks**

- A small **dependency-free tokenizer highlighter** for the languages developers actually read here: `ts/js/tsx/jsx`, `json`, `py`, `go`, `rs`, `java`, `c/cpp`, `html/xml`, `css/scss`, `sh/bash/zsh`, `sql`, `yaml`, `diff`, `md`. Unknown language → plain escaped `<pre>`.
- Emit `<span class="tok-kw">…` etc. and colour with **`--vscode-editor-tokenKeyword-*`** / `tokenString` / `tokenNumber` / `tokenComment` / `tokenType` theme variables, so highlighting follows the user's VS Code theme in light and dark with zero extra config.
- Per-block header: language label · line count · **Copy** · **Expand** (fences over 25 lines collapse to 25 + an expander; never truncate the underlying text).
- `tabindex="0"` + `role="region"` + `aria-label="<lang> code, N lines"` so a keyboard user can scroll a long block.
- Tokenizing runs **after** `esc()`, never before.

**Design — tool cards**

- Extend the tool payload with `args` (truncated JSON, ~4 KB), `result` (truncated, ~16 KB, tail-biased so the error survives), `durationMs`, and keep `phase: 'start' | 'end'`. Source: `src/agent.ts:461`, `src/agent.ts:3308/3347/3350`, `src/cli-engine.ts:333`.

**What landed**

- `src/webview/highlight.ts` (new) — dependency-free, single-pass scanner for js/ts, python, json, shell, diff, rust, go, css, html, sql, yaml, toml. One implementation: the browser source is the only copy, and the direct test evaluates that same string, so there is no Node mirror to drift. Every emitted character passes through the injected `esc()`, and token classes are chosen by the scanner, never the input — a code sample cannot become markup. Unknown languages fall through to `esc()` and are byte-identical to the old renderer.
- Fences capture the language from the info string and emit a labelled `.code-block` with a copy button, plus an expand toggle past 24 lines. Copy reads the text back off the `<code>` node (highlighting only inserts spans, so `textContent` is the original source) and goes through the host clipboard. Controls are **delegated from `#messages`**, because streaming rewrites `innerHTML` every frame and per-node listeners would not survive.
- `src/tool-payload-core.ts` (new) — `toolArgsText` / `toolResultText` / `durationMs`. Args are truncated from the head, results from the **tail**: output is long and the failure is at the end, so a head-truncated `stderr` would show the command banner and hide the error.
- Tool cards are one shared builder (`toolRowHtml`) used by live activity, history replay and live updates, so a run looks the same while streaming and after reload. Duration prefers the server-measured value and falls back to a live tick that piggybacks on activity re-renders instead of a per-row interval.
- Tokens are themed from VS Code's own `--vscode-editor-token-*-foreground` variables, so light/dark/high-contrast are correct with no extra work.

**Verify** — `test/highlight.direct.mjs` (9), `test/tool-payload-core.direct.mjs` (8), `test/code-blocks.direct.mjs` (7, real Chromium). The load-bearing properties: stripping spans and unescaping returns the input byte for byte — including unterminated strings/comments/fences, which is the state a half-streamed block renders in — and adversarial payloads come back with no raw `<`/`>` surviving.

**Two bugs found and fixed while building this**

- `verify.mjs` substituted template interpolations with `String.replaceAll(needle, string)`. A string replacement interprets `$'` as "the rest of the input", so any injected source containing `$'` was **silently truncated** and the shipped webview would have been malformed. All substitutions now use function replacers, which are literal.
- `runtime.ts` is one `String.raw` template, so a backtick in a *comment* truncates the entire webview. This bit twice during the work; `test/highlight.direct.mjs` now pins both the stray-backtick and unapproved-`${` cases against `runtime.ts` itself.
- Render as `<details>`: summary row = state icon · `humanToolName` · live duration counter · ok/fail badge; body = **Args** block (syntax-highlighted JSON/shell) and **Result** block (monospace `<pre>`, capped height, Copy button).
- On `phase:'start'` the row appears immediately with a rAF duration counter — a running `npm test` shows elapsed time instead of a static dot.
- Persist `args`/`result` into the transcript item so `renderConversation` (723) replays full tool detail on history load — principle 6.

**Verify**
- `test/webview-escape.direct.mjs` additions: hostile fence content (`<script>`, `</pre>`, `javascript:`) yields no live nodes and no raw `<script>` in `innerHTML`.
- `test/highlight.direct.mjs`: per-language token counts match a fixture table; unknown language falls back cleanly.
- `test/tool-cards.direct.mjs`: emitting `tool` start/end produces one `<details>` whose result text matches the payload, and survives a `conversation` replay.

---

### Phase 3 — Inline, auditable approvals ✅ SHIPPED

**Problem:** §2-D. **Safety constraint: no widening.** The agent must still block on an explicit user decision; only the *presentation* changes.

**Files:** `src/webview/runtime.ts` (`showNotifyModal` 233, `drainNotify` 234), `src/webview.ts` (markup), `src/agent.ts:4489` (`prompt`), `src/agent.ts:461` (payload).

**Design**

- Approvals render **inline in the turn** as a `.approval` card: title, risk badge, and the actual command / diff in a **highlighted monospace block** (currently `textContent`).
- Three actions: **Run once** · **Always allow for this session** · **Reject**. "Always" is session-scoped only and must route through the existing approval-state store, never widen beyond the current `approvalMode` semantics.
- The card is persisted as a transcript item with `decision: 'once' | 'session' | 'rejected'` and renders read-only afterwards, so history shows what was requested and what was granted.
- The modal remains as a **fallback** when the sidebar is hidden or the view is not visible — that is precisely why `notify` exists today.
- Keyboard: focus moves to the card; `Enter` = Run once, `Esc` = Reject. Announce with `aria-live="assertive"` (it is a blocking decision, not chatter).
- In-place permission chips inside the card — "also allow `npm test *` for this session" — reusing the existing `requiresApproval` classifier (`src/util.ts`).

**Verify** — `test/approval.test.mjs` additions + `test/inline-approval.direct.mjs`: rejection still throws `User rejected the proposed edit.` and nothing executes; `once` executes exactly one call; `session` executes subsequent matching calls and stops on restart; the decision persists across `conversation` replay.

---

### Phase 4 — Keyboard-first shell model & accessibility ✅ SHIPPED

**Problem:** §2-F, §2-G.

**Files:** `package.json` (`contributes.keybindings`), `src/webview/runtime.ts`, `src/webview/styles.ts`.

**Design — keybindings** (`when: view == sleepycode.chat`)

| Key | Action |
| --- | --- |
| `Cmd/Ctrl+Enter` | Send (Enter keeps sending; Shift+Enter newline) |
| `Cmd/Ctrl+Shift+Enter` | Force newline |
| `Cmd/Ctrl+.` | Stop the running turn |
| `Cmd/Ctrl+/` | Toggle shortcut cheatsheet |
| `Cmd/Ctrl+K` | Clear composer |
| `Cmd/Ctrl+Shift+C` | Copy last assistant message |
| `Esc` | Dismiss menus → cancel edit → stop |

Add an `Esc`-ladder so the same key degrades gracefully instead of doing nothing, and a one-line caption under the composer (`Enter to send · Shift+Enter for a new line`) that fades after the first send and returns on focus.

**Design — menu semantics** (the skill's combobox pattern, applied consistently)

- `role="listbox"` on `#modelMenu`/`#effortMenu`/`#agentMenu`/`#safetyMenu`/`#mentionMenu`/`#slashMenu`; `role="option"` + `aria-selected` on rows; `aria-controls` from each trigger button; `aria-activedescendant` tracking the highlighted row.
- Roving `tabindex` with real focus on the active option, Home/End, type-ahead, and `role="menu"`/`menuitem` preserved on the conversation and overflow menus.
- Menus already re-place themselves on scroll/resize (`placeOpenComposerMenus`, `runtime.ts:913`) — assert it stays correct at 260px width.

**Design — announcements**

- `#messages` becomes `role="log"` + `aria-live="polite"` + `aria-relevant="additions text"`, `aria-busy="true"` while a turn runs. Announce on **completed** turns, not per-token, so a screen reader is not flooded.
- Visible focus rings on every control (several already exist at `:icon:focus-visible`); add them to message actions, tool cards and approval buttons.

**Verify** — `test/webview-topbar.direct.mjs` for keybinding/ARIA shape assertions; `test/keyboard-nav.direct.mjs` drives real keys through Playwright: full cycle of open menu → arrow → Enter → Escape; `Esc` ladder; Enter/Cmd+Enter send vs newline; stop shortcut posts `{type:'stop'}`.

---

### Phase 5 — Findability, navigation & in-place observability — PARTIAL

**Problem:** §2-E, §2-H.

**Status: linkify, error cards and density have landed. Turn-timeline phase chips have not. The developer-grade empty state was audited and found to already exist.**

**Landed — linkify in prose.** The interesting part was not the regexes, it was the ordering. `inlineMarkdown` already swapped inline-code spans for sentinel placeholders before anything else ran, so a new pass placed after that step simply cannot see code. The second hazard was self-inflicted: a new pass must not reach inside markup an earlier pass generated, or `[see src/a.ts](https://x)` nests an anchor inside an anchor. So generated HTML now goes into a **second** placeholder channel and is substituted back only after every pass has run. The extension list is deliberate rather than "anything with a dot" — prose is full of dotted tokens (`i.e.`, `e.g.`, `and/or`, `foo/bar/baz`), and a false link is worse than a missed one because it turns a sentence into something clickable that opens the wrong file. A reference now carries its position through to the editor: `openFile` grew optional `line`/`column`, and the host opens a `Range` there.

**Landed — error cards, extended not replaced.** `errorActions()` kept its Retry button and gained Copy error and Open logs. "Open logs" deliberately reveals the existing `#extensionLogs` view rather than adding a second place to read the same lines.

**Landed — density.** A `compact` boolean round-tripping through the existing `saveSettings` path (payload → `globalState` → `config()` → restore). It applies to `<body>` on change rather than after a reload, because it is a view preference and waiting for a settings round trip makes the control feel broken. Reasoning is **clamped to two lines with `-webkit-line-clamp`, not `display:none`**: a density preference that deletes text the user cannot get back is not a density preference, and the full text has to survive someone who never opens settings again. A gate contract asserts the clamp rather than asserting that `.reasoning` exists, because the failure mode being prevented is specifically someone later "simplifying" the clamp into a hide.

**Audited, not built — the empty state was already developer-grade.** This item described work that did not exist. `emptyState()` already renders the indexed file count ("137 files indexed"), the index status with its reindex affordance, the detected languages and frameworks, and a set of clickable starters that fill the composer. So `test/density.direct.mjs` pins what is already there rather than adding to it — the point is that a plan item reading "done" is now actually pinned, and a future edit cannot quietly drop the file count without a test failing.

**Not landed:** turn-timeline phase chips. The activity panel already carries a phase label (`<summary>` renders `a.summary`, "Thinking…" / "Working…"), so what remains is a visual Plan → Tools → Answer timeline rather than missing information. It was not started.

**Files:** `src/webview/runtime.ts` (`inlineMarkdown` 546), `src/webview/styles.ts`.

**Design**

- **Linkify developer references in prose:** bare `https?://`, `file://…`, workspace-relative paths, `path:line`, `path:line:col`, and backtick-wrapped `` `src/x.ts:42` `` → a path chip. Clicking posts the existing `{type:'openFile', path, line, column}` and VS Code opens it with the cursor placed.
- **Never linkify inside fences or inline code spans** — a `#` or `:30` in a shell snippet must stay inert.
- **Per-turn observability:** extend the message footer with run duration, tokens, cost, and a **Logs** button that opens the extension output channel filtered to that run — today that data is only reachable through Settings.
- **Run timeline:** compact phase chips (`Plan → Tools → Answer → Done`) with elapsed time per phase, so a long run reads as progress rather than as an indeterminate spinner.
- **Error cards:** always offer **Retry** · **Copy error** · **Open logs** (Retry already exists via `errorActions()` — extend, don't replace).
- **Density toggle** (Comfortable / Compact) persisted in settings: Compact tightens message padding and collapses reasoning blocks by default. Honors `prefers-reduced-motion` for all spinners.
- **Empty state** becomes developer-grade: the workspace file count + index status from `projectIndexState`, plus 3–4 clickable starters (`/review the diff on this branch`, `/explain <file>`, `/test the failing suite`) instead of a static prompt.

**Verify** — `test/linkify.direct.mjs`: table-driven cases asserting which strings linkify and which do not (inside fences, inside `code`, `#issue` false positives, `http://` in a diff hunk); `test/layout.direct.mjs`: no horizontal overflow and no off-screen elements at 260/380/720 px via the existing `viewportBox` / `headerSafeTop` helpers.

---

## 5. Sequencing, risk, and what "done" means

| Phase | Ships | Risk | Rollback |
| --- | --- | --- | --- |
| 1 Performance ✅ | Perf only, no visual change | Renderer divergence vs. history replay | Pure revert; `streamBlockCut`'s fixture suite pins the old boundaries |
| 2 Legibility | Highlighter + tool cards | Bundle size; payload growth | Payload fields are additive & optional |
| 3 Approvals | **Trust-critical** | Regressing the safety gate | Keep the modal path alive; gate by flag |
| 4 Keyboard & a11y | Shortcuts + ARIA | Shortcut conflicts with VS Code | Bind only under `when: view == sleepycode.chat` |
| 5 Findability | Linkify + observability | Over-eager linkify | Linkifier is allow-list + fence-aware by construction |

**Rules of engagement**

- Phases 1 and 4 are additive to the renderer and carry no engine change. Phase 3 is the only one that touches the trust boundary, and it must keep the modal fallback until the inline path is proven.
- The existing headless harness (esbuild `runtime.ts` → Chromium, stub `acquireVsCodeApi`, `window.__emit`) makes every phase in this plan testable without launching VS Code. Reuse it rather than building new infrastructure.
- Every phase must keep `npm run check` green: `tsc --noEmit`, `scripts/verify.mjs`, `scripts/logic-check.mjs`, `npm test`, `npm run test:core`.

**Out of scope:** engine/tool semantics, model routing, compaction policy, persistence format (except the additive tool fields in Phase 2 and the approval decision in Phase 3).

---

## 6. Next slice

Phase 1 shipped: two runtime files plus its suite, no engine change, no visual change, and it removes the one defect that made the window feel broken under load. Frame timings are now trustworthy, which is what makes Phase 2 measurable.

Phase 2 shipped: `src/webview/highlight.ts` (dependency-free tokenizer for js/ts, python, json, shell, diff, rust, go, css, html, sql, yaml, toml, themed from `--vscode-editor-token*`), per-block copy/expand past 24 lines, and `src/tool-payload-core.ts` feeding one shared `toolRowHtml` used by live activity, history replay and live updates, so a run looks identical while streaming and after reload. Duration prefers the server-measured value and falls back to a tick piggybacked on activity re-renders rather than a per-row interval. The load-bearing property is that stripping spans and unescaping returns the input byte-for-byte, including unterminated strings/comments/fences, which is exactly what a half-streamed block renders in.

Two latent webview-injection bugs surfaced and were fixed on the way. `scripts/verify.mjs` substituted template interpolations with a string replacement, and a string replacement interprets `$'` as "the rest of the input", so any injected source containing that sequence was silently truncated before it was syntax-checked; all substitutions now use function replacers. And `runtime.ts` is a single `String.raw` template, so a backtick in a *comment* truncates the entire webview, which is now pinned by a test against `runtime.ts` itself.

Phase 3 shipped, and the design goal that mattered was that it could not widen what runs. That was made structural rather than reviewed: the inline card answers over the *same* `notifyResponse` channel the modal already used, and `Agent.approve` / `reviewEdit` are unchanged, so the three-way decision vocabulary is literally the same code path in both. The card is only used when the prompt belongs to the transcript currently on screen; a different conversation, a collapsed sidebar or a hidden view keeps the modal, because that is the case the modal exists for. The real command is rendered through the Phase 2 highlighter instead of a label, focus moves to the card, Escape rejects, and it announces with `aria-live="assertive"` — a blocking decision is not chatter.
The decision is recorded on the transcript item (`decision: 'once' | 'session' | 'rejected'`) and replays read-only, so history shows what was requested *and* what was granted. Recording and authorising are deliberately separate concerns: `recordApproval` writes to `conversation.items` and nothing anywhere reads `item.approval` back, which is pinned as a gate contract so a future edit cannot quietly turn the record into a grant. Session-scoped grants still go through the pre-existing `sessionAllowedCommands` / `sessionAutoApproveEditRoots` allow-lists rather than a new path.
Verified in `test/inline-approval.direct.mjs` against the real webview in Chromium, not a stub — the seam is exactly what is under test. It asserts the card renders the actual command, that each of the three buttons answers with the modal's own vocabulary, that a decided card exposes no buttons, that a double click resolves the promise once, that Escape rejects, that a mismatched conversation falls back to the modal, and that replaying a recorded approval posts *nothing* back to the host.
Phase 4 shipped, but the first thing worth recording is that the plan was wrong about the starting line. It proposed rebuilding menu keyboard semantics — roving tabindex, `role="listbox"`/`option`, `aria-activedescendant` on the disclosure popovers. Auditing before writing code showed `bindMenuKeyboard` already implements Arrow/Home/End/Escape/Tab with *real* focus, `focusRowAt`/`menuNavRows`/`restoreMenuFocus` already exist, and all six disclosure menus are already wired — and a pre-existing contract deliberately **forbids** `role="menu"` on them, because moving real focus is not the pattern that role promises. Following the plan literally would have regressed a decision someone had already reasoned out. The rebuilt helper was deleted before it was written.
What was genuinely still open, and shipped instead:
- **`contributes.keybindings` was empty.** Not "unbound" — absent, so every shell action was mouse-only. Five shortcuts are now contributed and scoped with `when: view == sleepycode.chat`. They are forwarded from the extension host through `provider.shortcut()` rather than read off the DOM, because VS Code owns several of these chords (`Ctrl/Cmd+K` is a prefix for its own) and would swallow them before the webview saw a keydown at all.
- **`Esc` had no ladder.** It cleared the composer, then blurred. It now degrades: clear a draft, else stop the running turn, else blur. Ordering is the point — a draft the user may still want beats stopping a run, and blurring (which discards the caret) is last.
- **`aria-controls` was missing** on `conversationButton` and `moreActionsButton`, so two of seven triggers never named their popover.
- **The slash and mention menus hid their selection in a CSS class.** These *are* the one place `aria-activedescendant` is correct, because focus stays in the textarea and only a selection index moves. They now carry `role="listbox"`/`option`/`aria-selected` and name the active option. The bug underneath was real: `syncSlashSelection` was called on arrow keys but **never on open**, so the ARIA had to be wired into the render path too.
- **The composer now states its Enter/Shift+Enter contract**, fading once a draft exists and returning on focus.
One bug was found by a contract the user added concurrently rather than by this work: nine focus rings used a bare `var(--vscode-focusBorder)`, which silently vanish when a theme omits the variable. All nine now fall back to `currentColor`.
**Phase 5 is next — findability, navigation & in-place observability.**