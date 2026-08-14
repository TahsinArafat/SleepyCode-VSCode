# SleepyCode — SleepyAI-First Development Plan

## Product boundary

SleepyCode is a first-party commercial SleepyAI product. SleepyAI owns the default onboarding, authentication, model catalog, account state, pricing/limits experience, and primary model route.

External OpenAI-compatible endpoints remain available only as an **advanced compatibility feature**. They are user-added, never built in as third-party defaults, and never selected automatically for a new installation.

## Completed in this pass

- Made SleepyAI the only `DEFAULT_PROVIDERS` entry.
- New installs and **Reset to defaults** now resolve to SleepyAI first.
- Added migration v3: preserves existing user-configured endpoints while ensuring the canonical SleepyAI provider exists first; it no longer creates third-party providers automatically.
- Settings payloads cannot remove or replace the canonical SleepyAI provider.
- SleepyAI logout no longer silently switches to a third-party endpoint.
- Added an explicit **Use SleepyAI** action when a user has temporarily selected an advanced provider.
- Reframed provider UI as **Advanced Providers / Optional compatibility providers**.
- Removed competitor/provider names from marketplace positioning and default documentation.
- Updated repository tests/contracts so they enforce the SleepyAI-first boundary.
- Completed frontend Sprint 1: task-oriented home state, simplified composer, explicit context manager, descriptive agent modes, model metadata, compact approval controls, and persisted per-response Changes cards.
- Changes cards can open modified files, jump to VS Code Source Control, and restore the response checkpoint when Git recovery data is available.
- Completed frontend Sprint 2: structured SleepyAI error states/actions, Usage & Billing with server-authoritative account data, workspace-session-scoped command/edit trust, and the first webview modularization step by extracting the stylesheet from the monolithic renderer.
- Corrected the transport retry path: retryable HTTP/network failures now perform real abort-aware retries instead of only delaying before returning the original failed response.

## Completed in Sprint 3

- Added **local repository intelligence** with bounded file discovery, language/framework detection, exported-symbol/import extraction, important-file detection, test-file hints, workspace-local persistence, change-triggered refresh, and lexical context retrieval.
- Added a real **Project intelligence** surface to the home state and Context panel, including per-request inclusion and manual reindexing. The webview receives summary metadata only; the full local index stays in the extension host.
- Added **SleepyAI Auto** as a first-party-only virtual model and route display. The later product pass finalized its deterministic cheapest-first / A–Z fallback policy; compatibility providers are never auto-routed.
- Enhanced pinned task plans with completed/total progress, a progress bar, and the current/paused step.
- Finished the first Git-native task workflow: per-file diff review, per-file revert to the response checkpoint, stage-all for task paths, generated/editable commit messages, restart-persistent commit metadata, and protection against mixing unrelated staged files or pre-existing edits in task files.
- Added **conversation search, pinning, and rename**, while preserving archive/delete and project scoping.
- Continued frontend modularization by extracting the webview runtime into `src/webview/runtime.ts`; the HTML renderer is now a small shell around runtime + styles.
- Added a **direct production-module test** for repository-index parsing/retrieval in addition to the existing repository tests.
- Added Linux/Windows/macOS GitHub Actions CI, release-metadata validation, clean VSIX packaging workflow, and `.vscodeignore`.
- Corrected `package-lock.json` release version metadata to match `package.json` and made mismatch a release failure.

## Completed in the current UI/product pass

- Changed **SleepyAI Auto** to choose the lowest-cost fully-priced eligible model; zero-cost models win naturally, equal-price ties are A–Z, and missing/incomplete pricing falls back deterministically to the first eligible model A–Z.
- Alphabetized model dropdowns by visible model name and made long names wrap instead of being hidden by ellipsis.
- Improved narrow composer behavior: model and agent selectors stack into full-width rows on compact sidebars, while dropdowns can expand to the available viewport width.
- Reworked user-message editing to use the real composer path, including attachments and context controls, then resend from the edited point in the conversation.
- Changed Skill Marketplace discovery copy from a fixed “Top skills / Results” presentation to **Popular skills** with explicit search guidance.
- Added **Manage account** and **SleepyAI website** actions under Settings → SleepyAI, with the account page URL separated from the API/dashboard gateway base.
- Replaced inherited fork branding assets with simple SleepyCode ASCII terminal-grid / sleeping-cat artwork across extension icons and repository screenshots.
- Added explicit spacing between agent/permission selector titles and their one-line descriptions so the text does not visually concatenate.

## Completed in the SleepyCode corrective pass

- Rebranded extension IDs, commands, settings, docs, notification paths, repository metadata, assets, and release version from the former product name to **SleepyCode**.
- Replaced graphical fork-era branding with simple monospace ASCII sleeping-cat / terminal artwork; removed the stale prebuilt macOS notifier app and use the system `osascript` notification path instead.
- Repaired subagent lifecycle routing: each delegated task now has a unique explicit subagent ID, child tool events carry a `parentId`, the UI nests them under the correct subagent, failures propagate to the parent, and recursive delegation remains unavailable.
- Repaired the chat viewport: the webview root is bounded, the message pane is the dedicated scroll container, the composer is a non-scrolling flex sibling, textarea height is capped responsively, and short-height layouts shed secondary UI.
- Repaired three run-state failure paths found during the broader defect sweep: missing provider configuration now reaches `finally` cleanup, model refresh re-reads the selected model before failing, and an expired/missing SleepyAI token is persisted as a structured assistant error instead of leaving a transient orphaned user turn.
- Enabled unused-local/parameter TypeScript checks, removed stale imports/parameters, and added five dedicated regression tests covering rebrand integrity, subagent parent routing/failure propagation, composer/message scrolling, and run preflight cleanup.

## Next steps

1. **P0 — clean release / Extension Development Host validation**
   - Run `npm ci`, `npm run check`, `npm run build`, and `npm run package` on a clean supported machine or CI runner.
   - Smoke-test project indexing on small/large repositories, index invalidation, Auto routing, task plan updates, file diff/revert, stage/commit, conversation pin/search/rename, cancellation, and restart persistence.
   - Install the generated VSIX into a clean VS Code profile before beta release.

2. **P0 — SleepyAI server routing + entitlement contract**
   - Define a stable server contract for plan/credits/model eligibility and an optional server-side task-routing decision so future Auto routing can use complexity, latency, availability, and plan policy without exposing underlying provider infrastructure.
   - Keep the current catalog-recommended fallback for backward compatibility when that route contract is unavailable.

3. **P1 — repository intelligence v2**
   - Add incremental per-file updates instead of full debounced rebuilds.
   - Add relation scoring between source/tests/importers and optional semantic embeddings only if SleepyAI privacy/product policy explicitly approves code-derived indexing.
   - Add index-size/age diagnostics and a clear/rebuild control in Settings.

4. **P1 — task verification intelligence**
   - Map changed source files to likely tests, compiler/linter commands, and package scripts.
   - Suggest or run the smallest relevant verification set before the full suite.
   - Parse diagnostics into structured failures with **Ask SleepyCode to fix** actions.

5. **P1 — frontend architecture**
   - Split `webview/runtime.ts` further into state, chat, composer/context, conversation, Git changes, account/usage, and settings modules.
   - Add DOM-level tests for Project intelligence, Auto routing display, task progress, Git controls, and conversation management.

6. **P1 — authentication / commercial hardening**
   - Test refresh-token rotation, revoked sessions, offline startup, multi-machine behavior, corrupted gateway state, and entitlement/upgrade failure modes.
   - Finalize the credential-storage/security architecture and privacy-reviewed product telemetry policy.

7. **P1 — observability and supportability**
   - Add privacy-reviewed diagnostics for index failures/performance, routing decisions, Git workflow failures, auth failures, retry/cancellation, and release version.
   - Never log prompts, source contents, credentials, or sensitive tool payloads by default.

8. **P2 — PR workflow and team features**
   - Add optional branch/commit/PR handoff after the local Git task workflow is proven stable.
   - Consider team policy for approved commands, organization-managed skills, and enterprise provider compatibility.

## Decisions still requiring product/legal confirmation

- Whether the repository should remain MIT-licensed/open source. This pass intentionally does **not** change `LICENSE`.
- Whether advanced OpenAI-compatible providers should remain customer-facing long-term or eventually become a developer/enterprise-only feature.
- The final SleepyAI production API domains, telemetry policy, privacy disclosures, subscription/upgrade flows, and support policy.
