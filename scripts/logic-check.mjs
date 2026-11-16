import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const providers = read('src/providers.ts');
const agent = read('src/agent.ts');
const reactApp = read('webview-ui/sidebar/App.tsx');
const reactStyles = read('webview-ui/sidebar/sidebar.css');
const reactComposer = read('webview-ui/sidebar/components/Composer.tsx');
const reactAdapter = read('src/webview-adapter.ts');
const reactProviderKeys = read('webview-ui/settings/panels/ProviderKeysPanel.tsx');
const reactAccount = read('webview-ui/settings/panels/AccountPanel.tsx');
const reactIndexPanel = read('webview-ui/settings/panels/IndexPanel.tsx');
const reactMarketplace = read('webview-ui/settings/panels/MarketplacePanel.tsx');
const reactMarkdown = read('webview-ui/shared/markdown.ts');
const devRefs = read('src/dev-refs.ts');
const contextPanel = read('src/context-panel.ts');
const projectIndex = read('src/project-index.ts');
const projectIndexCore = read('src/project-index-core.ts');
const modelRoutingCore = read('src/model-routing-core.ts');
const retryCore = read('src/retry-core.ts');
const retryCoreTest = read('test/run-retry-budget.direct.mjs');
const modelRoutingCoreTest = read('test/model-routing-core.direct.mjs');
const git = read('src/git.ts');
const ci = read('.github/workflows/ci.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const util = read('src/util.ts');
const packageJson = JSON.parse(read('package.json'));

const checks = [];
const check = (condition, message) => {
  checks.push(message);
  assert.ok(condition, message);
  console.log(`ok - ${message}`);
};

const defaultProviderBlock = providers.slice(providers.indexOf('export const DEFAULT_PROVIDERS'), providers.indexOf('export function cloneProviders'));
check(/id:\s*['"]sleepyai['"]/.test(defaultProviderBlock) && /isSleepy:\s*true/.test(defaultProviderBlock), 'SleepyAI is the built-in default provider');
for (const id of ['opencode', 'openrouter', 'groq', 'gemini', 'mistral', 'ollama']) {
  check(!new RegExp(`id:\\s*['"]${id}['"]`).test(defaultProviderBlock), `third-party provider ${id} is not a built-in default`);
}
check(/sleepyApiBase\(\)/.test(defaultProviderBlock), 'SleepyAI default uses the first-party API base');
check(/replace\(\/\\\/\+\$\//.test(providers), 'provider model URL strips trailing slashes');
check(/customHeaders/.test(providers) && /authorization/.test(providers), 'advanced compatibility discovery supports custom headers and bearer auth');

check(/return Boolean\(provider\.baseURL\)/.test(agent), 'explicit compatibility providers can be keyless');
check(/providersMigrationVersion/.test(agent) && /migrationVersion\s*>=\s*3/.test(agent), 'provider migration is versioned for the SleepyAI-first policy');
check(!/globalState\.update\(['"]sleepycode\.providers['"],\s*JSON\.stringify\(\[\]\)\)/.test(agent), 'provider migration does not wipe providers');
check(/oldBuiltInIds/.test(agent) && /providers\.unshift\(\{ id: 'sleepyai'/.test(agent), 'migration preserves compatibility state while restoring SleepyAI first');
check(/providers\.unshift\(\{ id: 'sleepyai', name: 'SleepyAI'/.test(agent), 'settings cannot remove the canonical SleepyAI provider');
check(!/const fallback = this\.getProviders\(\)\.find\(provider => !provider\.isSleepy\)/.test(agent), 'SleepyAI logout does not auto-switch to an external provider');
check(/globalState\.update\('sleepycode\.setupComplete', true\)/.test(agent), 'successful SleepyAI login completes first-run onboarding');
check(/previousProviders/.test(agent) && /context\.secrets\.delete\(`sleepycode\.apiKey\.\$\{removed\.id\}`\)/.test(agent), 'deleting a compatibility provider also removes its saved API key');
check(/activeGroup/.test(agent) && /activeGroup\?\.models\.some/.test(agent), 'selected model is validated against the active provider');
check(!/\/Users\/[^'"]+\/Sleepy\/cli/.test(agent), 'agent prompts do not depend on a developer-machine path');
check(/await this\.refreshModels\(\);\s*\n\s*return;\s*\n\s*}\s*\n\s*if \(message\.type === ['"]sleepyLogin/.test(agent), 'removing an API key refreshes model availability');

check(/Compatibility endpoints are optional/.test(reactProviderKeys) && /Providers/.test(reactProviderKeys), 'external providers are presented as optional compatibility');
check(/signIn/.test(reactAccount) && /signOut/.test(reactAccount), 'the account page lets users explicitly return to the first-party SleepyAI route');
check(/summary\.identity/.test(reactAccount), 'the account page shows the signed-in identity');
check(/handleMentionKeys/.test(reactComposer) && /ArrowDown/.test(reactComposer), 'file mention menu supports keyboard selection and claims its keys');
check(!/providers\.unshift\(\{id:['"]sleepyai['"][^}]*baseURL:\s*['"]['"]/.test(agent), 'the SleepyAI migration does not fabricate an empty provider URL');
check(/Let’s build something/.test(reactApp) && /STARTERS/.test(reactApp) && /STARTERS/.test(read('src/empty-state.ts')), 'empty state offers task-oriented SleepyAI starters');
check(/CONTEXT_TOGGLES/.test(contextPanel) && /includeActiveFile/.test(contextPanel) && /includeSelection/.test(contextPanel), 'composer exposes explicit active-file and selection context controls');
check(/className="review-bar"/.test(reactApp) && /acceptChange/.test(reactApp), 'completed responses expose a workspace changes review bar');
check(/message\.type === 'reviewChanges'/.test(agent) && /workbench\.view\.scm/.test(agent), 'changes review action opens VS Code Source Control');
check(/const runChanges = new Map/.test(agent) && /const finalChanges = await completeRunChanges\(\)/.test(agent) && /assistantItem\.changes = finalChanges/.test(agent) && /gitTreeChanges/.test(agent), 'agent persists authoritative per-response workspace changes');
check(/attachments: item\.attachments/.test(util) && /changes: item\.changes/.test(util) && /errorInfo: item\.errorInfo/.test(util) && /commitHash: item\.commitHash/.test(util) && /commitMessage: item\.commitMessage/.test(util), 'transcript normalization preserves attachments, response changes, structured errors, and Git commit state');
check(/classifyAgentError/.test(util) && /action_denied/.test(util) && /auth_required/.test(util) && /credits_exhausted/.test(util) && /context_too_large/.test(util), 'agent errors are classified into actionable SleepyAI states');
check(/const message = providerErrorMessage\(error\)/.test(agent) && /errorInfo\.message = message/.test(agent), 'generation failures persist the exact provider or server interruption message');
check(/updatePending\(true\)/.test(agent) && /onStepFinish: step =>/.test(agent) && /partialAnswer \|\| resume\?\.partialText/.test(agent), 'partial text, tool activity, and completed tool messages are checkpointed during a local run');
check(/const editedItem = createTranscriptItem\('user', message\.text\.trim\(\)\)/.test(agent) && /promptContext, true\)/.test(agent), 'edited user messages are persisted before their replacement run starts');
check(/errorItem\.errorInfo = errorInfo/.test(agent) && /kind: 'error'/.test(reactAdapter), 'generation failures persist and render structured error actions');
check(/openSleepyDashboard/.test(agent) && /SLEEPY_ACCOUNT_URL/.test(agent), 'billing and error actions can open the first-party SleepyAI account');
check(/QuotaRows/.test(reactAccount) && /billing/.test(reactAccount), 'usage view prioritizes SleepyAI account and billing state over local token counts');
check(/sendSleepyAccountData/.test(agent) && /30_000/.test(agent), 'SleepyAI account usage refresh is throttled while local usage remains live');
check(/sessionAllowedCommands/.test(agent) && /commandKey/.test(agent) && /workspaceRoot\(\)\?\.fsPath/.test(agent) && /Allow this command for session/.test(agent), 'non-destructive exact commands can be trusted for the current workspace session');
check(/sessionAutoApproveEditRoots/.test(agent) && /Allow edits for session/.test(agent), 'non-destructive edits can be trusted for the current workspace session');
check(/risk: destructive \? 'high' : 'medium'/.test(agent), 'approval prompts record a risk level');
// Retries were extracted into src/retry-core.ts (bounded budget + transient classification) with the
// loop staying in agent.ts. Two properties must never regress regardless of the loop's shape: the
// backoff stays abort-aware, and a structured provider error is rethrown rather than flattened.
check(/retryBudget\.take\(/.test(agent) && /await waitForRetry\((?:\w+\.)?backoffMs, run\.controller\.signal\)/.test(agent) && /throw part\.error/.test(agent) && /createRetryBudget/.test(retryCore) && /createRetryBudget/.test(retryCoreTest), 'retry UI is backed by real abort-aware HTTP retries without discarding structured provider errors');
check(/attemptInfo\.retryable/.test(agent) && /attemptInfo\.code !== 'action_denied'/.test(agent) && /MAX_RUN_RETRIES/.test(retryCore) && /Math\.pow\(2/.test(retryCore), 'failed or unexpectedly stopped requests auto-retry with exponential backoff and skip non-transient failures');


check(/ProjectIndexService/.test(agent) && /retrieveProjectContext/.test(agent) && /includeProjectIndex/.test(agent), 'agent uses local repository intelligence in prompt context');
check(/MAX_DISCOVERED_FILES/.test(projectIndex) && /MAX_INDEXED_BYTES/.test(projectIndex) && /storageUri/.test(projectIndex), 'project intelligence is bounded and persisted locally per workspace');
check(/extractSymbols/.test(projectIndexCore) && /extractImports/.test(projectIndexCore) && /retrieveProjectContext/.test(projectIndexCore), 'repository intelligence indexes symbols, dependencies, and query relevance');
check(/type: 'projectIndex'/.test(projectIndex) && /reindexIndex/.test(reactIndexPanel) && /reindexProject/.test(reactApp), 'the UI exposes a real repository-index status and reindex control');
check(/SLEEPY_AUTO_MODEL_ID/.test(providers) && /providerId !== 'sleepyai'/.test(agent) && /chooseAutoModel/.test(agent) && /Cheapest SleepyAI model/.test(modelRoutingCore) && /A–Z fallback/.test(modelRoutingCore), 'Auto routing is first-party SleepyAI-only, cheapest-first, and A-Z deterministic');
check(/sortModelsA2Z/.test(agent) && /chooseAutoModel/.test(agent), 'Auto routing sorts deterministically and reports the concrete SleepyAI Auto route');
check(/Popular/.test(reactMarketplace) && /marketplaceTop/.test(reactMarketplace), 'marketplace defaults to Popular skills and invites search');
check(/openSleepyWebsite/.test(agent) && /SLEEPY_ACCOUNT_URL/.test(agent), 'SleepyAI settings expose account management and website actions');
const sleepyCodeMark = read('media/sleepycode-mark.svg');
const sleepyCodePromptIcon = read('media/sleepycode-o.svg');
check(/font-family="monospace"/.test(sleepyCodeMark) && sleepyCodeMark.includes('/\\_/\\') && /\$ sleepycode_/.test(sleepyCodeMark), 'repository branding uses simple SleepyCode ASCII terminal art');

check(packageJson.name === 'sleepycode-agent' && packageJson.displayName === 'SleepyCode' && /^\d+\.\d+\.\d+$/.test(packageJson.version), 'package identity is fully rebranded and versioned as SleepyCode');
check(!new RegExp(['Sleepy', 'IDE'].join('') + '|' + ['sleepy', 'ide'].join('')).test([providers, agent, reactApp, reactStyles, util, read('README.md'), read('plan.md'), read('src/extension.ts'), JSON.stringify(packageJson)].join('\n')), 'core source, docs, and manifest contain no retired product branding');
check(/subagentSequence/.test(agent) && /type: 'subagent'/.test(agent) && /parentId: subagentId/.test(agent) && /Subagent \(\$\{role\}\) failed/.test(agent), 'subagents use explicit unique lifecycle/parent metadata and propagate failures');
check(/delete roleTools\.delegate_task/.test(agent) && /isolated context window/.test(agent) && /Subagents cannot recursively delegate/.test(read('src/tools.ts')), 'subagent context is isolated and recursive delegation is disabled');
check(/classifySubagentStep/.test(agent) && /harvestSubagentText/.test(agent) && /rememberVisibleText/.test(agent) && /export function harvestSubagentText/.test(read('src/subagent-core.ts')), 'subagent results harvest leftover visible text instead of returning empty');
check(/skillsmp_list_installed \/ skillsmp_read_installed/.test(agent) && /inspect the Installed skills inventory included in your instructions/.test(agent) && /Installed skills inventory \(metadata only/.test(read('src/skills.ts')), 'system prompt actively discovers and loads installed skills before use');
check(/try \{\s*this\.log\('info', 'run\.preflight\.start'[\s\S]*?if \(!providerConfig\) throw new Error/.test(agent), 'provider preflight failures flow through run cleanup instead of leaving a stuck running session');
check(/await this\.refreshModels\(\);\s*configuredModel = this\.selectionFor\(conversation\)\.model/.test(agent), 'model refresh re-reads configuration before declaring that no model is selected');
check(/if \(!sleepyToken\) throw new Error\('SleepyAI session is missing or expired/.test(agent), 'missing SleepyAI sessions persist through structured agent error handling');

check(/stageGitPaths/.test(git) && /commitGit/.test(git) && /restoreGitPath/.test(git), 'Git layer supports per-task stage, commit, and single-file restore operations');
check(/unrelatedStaged/.test(agent) && /avoid mixing unrelated work/.test(agent), 'task commit refuses unrelated pre-existing staged changes');
check(/taskPathsDirtyBeforeRun/.test(agent) && /gitChangedPathsBetween/.test(git) && /already had changes before this SleepyCode task/.test(agent), 'task stage and commit refuse task paths that already contained user changes');
check(/renameConversation/.test(agent) && /togglePinConversation/.test(agent), 'conversation management supports rename, and pinning');
check(packageJson.scripts['test:core']?.includes('test/*.direct.mjs') && /model-routing-core\.ts/.test(modelRoutingCoreTest) && /project-index-core\.ts/.test(read('test/project-index-core.direct.mjs')), 'check suite directly tests production project-index and model-routing core modules');
check(/ubuntu-latest/.test(ci) && /windows-latest/.test(ci) && /macos-latest/.test(ci) && /npm run check/.test(ci) && /npm run build/.test(ci), 'CI validates check and build on Linux, Windows, and macOS');
check(/vsce package/.test(releaseWorkflow) && /upload-artifact@v\d+/.test(releaseWorkflow) && /verify:release/.test(releaseWorkflow), 'release workflow validates metadata and packages a VSIX artifact');
check(packageJson.version === JSON.parse(read('package-lock.json')).version, 'package and lockfile versions match');

check(/fileChangeStats/.test(agent) && /additions: live\.additions/.test(agent), 'file changes persist plus/minus counts for the review bar');
check(/DEFAULT_PERSISTED_REASONING = 32_000/.test(read('src/reasoning-core.ts')) && /attachReasoningToLatestAssistant\(runMessages/.test(agent) && /maxPersistedReasoning/.test(JSON.stringify(packageJson.contributes.configuration.properties)), 'previous thinking is persisted onto later model requests and the budget is configurable');
check(/type: 'changed', path: filePath, action: exists \? 'Modified' : 'Created', before, after: content/.test(read('src/tools.ts')) && /type: 'changed', path: filePath, action: 'Deleted', before, after: ''/.test(read('src/tools.ts')), 'create, edit, and delete tools post before/after text so line stats can be computed');

check(/code\s*!==\s*['"]ENOENT['"]/.test(util), 'workspace path resolution uses filesystem error codes rather than localized messages');
check(/throw new Error\(['"]Path escapes the workspace\./.test(util), 'workspace path resolution rejects real paths outside the root');

check(!Object.prototype.hasOwnProperty.call(packageJson.contributes.configuration.properties, 'sleepycode.provider'), 'deprecated sleepycode.provider setting is absent');
check(!packageJson.keywords.some(keyword => ['openrouter', 'groq', 'gemini', 'mistral', 'ollama'].includes(keyword)), 'marketplace keywords do not advertise third-party providers');
check(packageJson.contributes.commands.some(command => command.command === 'sleepycode.usage' && command.title === 'SleepyCode: Usage & Billing'), 'command palette presents the commercial Usage & Billing surface');
check(packageJson.scripts.check.includes('scripts/logic-check.mjs') && packageJson.scripts.check.includes('npm test'), 'npm check executes repository contracts and tests');

// --- Inline approvals: the trust-critical invariants -------------------------------
// Approvals moved into the transcript for legibility. These pin the properties that make that safe,
// because "the card looks like the modal" is not evidence that it behaves like one.
const types = read('src/types.ts');
check(/if\s*\(!this\.view\)\s*return ['"]cancel['"]/.test(agent) && /if \(choice !== 'ok'\) throw new Error\('User denied this action\.'\)/.test(agent) && /if \(choice !== 'ok'\) throw new Error\('User rejected the proposed edit\.'\)/.test(agent),
  'approval still blocks on an explicit decision, and both non-ok outcomes still throw before anything executes');
check(/private async recordApproval/.test(agent) && /sessionAllowedCommands\.add/.test(agent) && /sessionAutoApproveEditRoots\.add/.test(agent),
  'session-scoped grants still go through the existing allow-lists rather than a new path');
// Recording the decision must never become authorising it: nothing may read item.approval back.
check(!/item\.approval\b[^\n]*\?\s*(sessionAllowedCommands|sessionAutoApproveEditRoots)\.add/.test(agent)
  && !/approval\.decision\s*===\s*['"]once['"][\s\S]{0,120}sessionAllowedCommands\.add/.test(agent),
  'the recorded approval decision is never read back to grant anything');
check(/kind\s*\?\s*:\s*['"]error['"]\s*\|\s*['"]divider['"]\s*\|\s*['"]approval['"]/.test(types)
  && /decision:\s*['"]once['"]\s*\|\s*['"]session['"]\s*\|\s*['"]rejected['"]/.test(types),
  'the approval record carries the full three-way decision vocabulary, so history can show what was granted');

// --- Keyboard-first shell & accessibility --------------------------------------------------
// The chat shell is reachable without a mouse. These pin the shape, not the styling.
const extensionHost = read('src/extension.ts');
const bindings = (packageJson.contributes && packageJson.contributes.keybindings) || [];
check(Array.isArray(bindings) && bindings.length >= 4, 'the chat view contributes keyboard shortcuts, so the shell is not mouse-only');
check(bindings.every(b => /sleepycode/.test(b.when || ''))
  && bindings.some(b => /chat\.stop$/.test(b.command))
  && bindings.some(b => /chat\.clearComposer$/.test(b.command)),
  'contributed shortcuts are scoped to the chat view, and stop/clear are actually bound');
check(/for \(const action of \['stop', 'clearComposer'/.test(extensionHost) && /provider\.shortcut\(action\)/.test(extensionHost) && /sleepycode\.chat\.\$\{action\}/.test(extensionHost),
  'every contributed shortcut command is registered by the extension host and forwarded to the webview');
check(/shortcut\(action: 'stop' \| 'clearComposer'/.test(agent), 'the chat provider exposes the shortcut forwarder the commands call');
// --- Findability: developer references in prose ------------------------------------------------
// The classic transcript made a model's file references clickable. The React markdown pipeline
// linkifies them through the shared pure module src/dev-refs.ts; the anchor it emits carries the
// position the host needs, and the chat surface activates it with Enter and Space like a link.
check(/linkifyDevRefs/.test(reactMarkdown) && (reactMarkdown.match(/linkifyDevRefs\(/g) ?? []).length >= 2,
  'prose developer references are linkified in the React markdown pipeline');
check(/REF_RE/.test(devRefs) && /class="dev-ref"/.test(devRefs) && /data-open-path=/.test(devRefs) && /data-line=/.test(devRefs) && /role="link"/.test(devRefs) && /tabindex="0"/.test(devRefs),
  'a file reference carries its position and is a focusable link');
check(/type: 'openFile'; path: string; line\?: number; column\?: number/.test(types)
  && /\.\.\.\(line \? \{ startLine: line \} : \{\}\)/.test(reactApp)
  && /case 'openFile'/.test(reactAdapter)
  && /new vscode\.Range\(row, col, row, col\)/.test(agent),
  'a file reference carries its position from the webview to the editor');
check(/event\.key !== "Enter" && event\.key !== " "/.test(reactApp),
  'prose references answer Enter and Space as well as a click, because a role=link must');
check(/Copy error/.test(reactApp),
  'an error card still offers a Copy action');

// --- Density -------------------------------------------------------------------------------------
// The round trip has three legs: webview payload -> host globalState -> config() -> webview restore.
// A gap in any one of them is a setting that silently forgets itself on the next launch, which is the
// failure mode users describe as "the toggle doesn't work" rather than "the setting isn't saved".
// Compact density was a pre-React setting stored as its own boolean. The React UI replaced it
// with the three-way `chatTextSize` in `uiPrefs`, but the host kept reading and writing
// `sleepycode.compact`, so the preference silently stopped working after the switch. These
// three checks follow the replacement: the value must still round-trip, must apply without a
// reload, and must clamp rather than hide.
const featurePrefs = read('src/feature-prefs.ts');
check(featurePrefs.includes('chatTextSize: TEXT_SIZES.includes(input.chatTextSize as ChatTextSize)')
  && agent.includes('uiPrefs: this.readChatPrefs()')
  && /private readChatPrefs\(\): featurePrefs\.ChatPrefs \{[\s\S]{0,200}normalizePrefs\(stored\?\.prefs\)/.test(agent),
  'text size round-trips through the chat preferences and comes back on the next session');
// It is a view preference, so it must not wait for a settings round trip to become visible.
check(/uiPrefs\.chatTextSize !== "default" \? ` text-\$\{uiPrefs\.chatTextSize\}` : ""/.test(reactApp)
  && /\.app\.text-compact \{/.test(reactStyles),
  'text size applies to the rendered tree rather than after a reload');
// Clamped, not removed. A density preference that hides text the user cannot get back is a content
// preference wearing a disguise, and this one has to survive someone who never opens settings again.
check(/\.thinking-card \.thinking-body \{[^}]*max-height: 220px;[^}]*overflow: auto;/.test(reactStyles)
  && !/\.thinking-card \.thinking-body \{[^}]*display:\s*none/.test(reactStyles),
  'compact reasoning is scrollable rather than hidden');
// The legacy boolean is still read once, so a user who set it before the switch keeps the choice.
check(/input\.compact === true/.test(featurePrefs),
  'the pre-React compact flag migrates into the text size that replaced it');

console.log(`LOGIC CHECK OK (${checks.length} checks)`);
