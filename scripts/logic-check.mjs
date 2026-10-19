import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const providers = read('src/providers.ts');
const agent = read('src/agent.ts');
const webview = read('src/webview.ts');
const webviewRuntime = read('src/webview/runtime.ts');
const webviewCode = webview + '\n' + webviewRuntime;
const webviewStyles = read('src/webview/styles.ts');
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

check(/Advanced Providers/.test(webviewCode) && /Optional compatibility providers/.test(webviewCode), 'external providers are presented as advanced compatibility');
check(/Use SleepyAI/.test(webviewCode), 'UI lets users explicitly return to the first-party SleepyAI route');
check(/startsWith\('Signed in to SleepyAI'\)/.test(webviewCode), 'successful SleepyAI login exits onboarding UI');
check(/id=['"]pf-headers['"]/.test(webviewCode), 'compatibility provider editor exposes custom headers');
check(/mentionSelectedIndex/.test(webviewCode) && /moveMentionSelection/.test(webviewCode), 'file mention menu supports keyboard selection');
check(/stopImmediatePropagation\(\)/.test(webviewCode), 'mention selection prevents Enter from also submitting the prompt');
check(!/providersList\.unshift\(\{id:['"]sleepyai['"][^}]*baseURL:\s*['"]['"]/.test(webviewCode), 'SleepyAI UI does not fabricate an empty provider URL');
check(/What are we working on\?/.test(webviewCode) && /const STARTERS\s*=\s*\[/.test(webviewCode), 'empty state offers task-oriented SleepyAI starters');
check(/id="contextSummaryButton"/.test(webviewCode) && /data-context-toggle="active"/.test(webviewCode) && /const context\s*=\s*\{\s*includeProjectIndex\s*,\s*includeActiveFile\s*,\s*includeSelection/.test(webviewCode), 'composer exposes explicit active-file and selection context controls');
check(/mode:'Build'/.test(webviewCode) && /mode:'Debug'/.test(webviewCode) && /mode:'Review'/.test(webviewCode), 'branded agents expose task-oriented modes');
check(/function modelMeta\(/.test(webviewCode) && /per 1M in\/out/.test(webviewCode), 'model picker surfaces context and SleepyAI pricing metadata');
check(/function changesCard\(/.test(webviewCode) && /Source Control/.test(webviewCode) && /Stage all/.test(webviewCode), 'completed responses expose a workspace changes review card');
check(/message\.type === 'reviewChanges'/.test(agent) && /workbench\.view\.scm/.test(agent), 'changes review action opens VS Code Source Control');
check(/const runChanges = new Map/.test(agent) && /const finalChanges = await completeRunChanges\(\)/.test(agent) && /assistantItem\.changes = finalChanges/.test(agent) && /gitTreeChanges/.test(agent), 'agent persists authoritative per-response workspace changes');
check(/attachments: item\.attachments/.test(util) && /changes: item\.changes/.test(util) && /errorInfo: item\.errorInfo/.test(util) && /commitHash: item\.commitHash/.test(util) && /commitMessage: item\.commitMessage/.test(util), 'transcript normalization preserves attachments, response changes, structured errors, and Git commit state');
check(/classifyAgentError/.test(util) && /action_denied/.test(util) && /auth_required/.test(util) && /credits_exhausted/.test(util) && /context_too_large/.test(util), 'agent errors are classified into actionable SleepyAI states');
check(/const message = providerErrorMessage\(error\)/.test(agent) && /errorInfo\.message = message/.test(agent), 'generation failures persist the exact provider or server interruption message');
check(/updatePending\(true\)/.test(agent) && /onStepFinish: step =>/.test(agent) && /partialAnswer \|\| resume\?\.partialText/.test(agent), 'partial text, tool activity, and completed tool messages are checkpointed during a local run');
check(/const editedItem = createTranscriptItem\('user', message\.text\.trim\(\)\)/.test(agent) && /promptContext, true\)/.test(agent), 'edited user messages are persisted before their replacement run starts');
check(/errorItem\.errorInfo = errorInfo/.test(agent) && /structuredErrorCard/.test(webviewCode), 'generation failures persist and render structured error actions');
check(/openSleepyDashboard/.test(agent) && /SLEEPY_ACCOUNT_URL/.test(agent), 'billing and error actions can open the first-party SleepyAI account');
check(/Usage &amp; Billing/.test(webviewCode) && /server-authoritative/.test(webviewCode), 'usage view prioritizes SleepyAI account and billing state over local token counts');
check(/sendSleepyAccountData/.test(agent) && /30_000/.test(agent), 'SleepyAI account usage refresh is throttled while local usage remains live');
check(/sessionAllowedCommands/.test(agent) && /commandKey/.test(agent) && /workspaceRoot\(\)\?\.fsPath/.test(agent) && /Allow this command for session/.test(agent), 'non-destructive exact commands can be trusted for the current workspace session');
check(/sessionAutoApproveEditRoots/.test(agent) && /Allow edits for session/.test(agent), 'non-destructive edits can be trusted for the current workspace session');
check(/risk: destructive \? 'high' : 'medium'/.test(agent) && /notify-risk/.test(webviewStyles), 'approval prompts surface a risk level');
// Retries were extracted into src/retry-core.ts (bounded budget + transient classification) with the
// loop staying in agent.ts. Two properties must never regress regardless of the loop's shape: the
// backoff stays abort-aware, and a structured provider error is rethrown rather than flattened.
check(/retryBudget\.take\(/.test(agent) && /await waitForRetry\((?:\w+\.)?backoffMs, run\.controller\.signal\)/.test(agent) && /throw part\.error/.test(agent) && /createRetryBudget/.test(retryCore) && /createRetryBudget/.test(retryCoreTest), 'retry UI is backed by real abort-aware HTTP retries without discarding structured provider errors');
check(/attemptInfo\.retryable/.test(agent) && /attemptInfo\.code !== 'action_denied'/.test(agent) && /MAX_RUN_RETRIES/.test(retryCore) && /Math\.pow\(2/.test(retryCore), 'failed or unexpectedly stopped requests auto-retry with exponential backoff and skip non-transient failures');
check(webviewCode.indexOf('Reasoning history') < webviewCode.indexOf('SleepyCode CLI') && webviewCode.indexOf('SleepyCode CLI') < webviewCode.indexOf('Danger zone'), 'CLI opt-in is placed at the bottom of Advanced settings above the danger zone');
check(/WEBVIEW_STYLES/.test(webviewCode) && /\.\/webview\/styles/.test(webviewCode), 'webview stylesheet is extracted from the monolithic renderer');


check(/ProjectIndexService/.test(agent) && /retrieveProjectContext/.test(agent) && /includeProjectIndex/.test(agent), 'agent uses local repository intelligence in prompt context');
check(/MAX_DISCOVERED_FILES/.test(projectIndex) && /MAX_INDEXED_BYTES/.test(projectIndex) && /storageUri/.test(projectIndex), 'project intelligence is bounded and persisted locally per workspace');
check(/extractSymbols/.test(projectIndexCore) && /extractImports/.test(projectIndexCore) && /retrieveProjectContext/.test(projectIndexCore), 'repository intelligence indexes symbols, dependencies, and query relevance');
check(/type: 'projectIndex'/.test(projectIndex) && /Project intelligence/.test(webviewCode) && /reindexProject/.test(webviewCode), 'webview exposes real repository-index status and reindex control');
check(/SLEEPY_AUTO_MODEL_ID/.test(providers) && /providerId !== 'sleepyai'/.test(agent) && /chooseAutoModel/.test(agent) && /Cheapest SleepyAI model/.test(modelRoutingCore) && /A–Z fallback/.test(modelRoutingCore), 'Auto routing is first-party SleepyAI-only, cheapest-first, and A-Z deterministic');
check(/sortModelsA2Z/.test(agent) && /modelA2Z/.test(webviewCode) && /Cheapest model first/.test(webviewCode) && /modelRoute/.test(webviewCode), 'model UI is A-Z and reports the concrete SleepyAI Auto route');
check(/composer-edit-bar/.test(webviewStyles) && /startMessageEdit/.test(webviewCode) && /editUserMessage'.*context/.test(webviewCode) && /message\.context/.test(agent), 'message editing reuses the full composer context path instead of an isolated popup');
check(/marketplaceHeading='Popular skills'/.test(webviewCode) && /Search above to discover more skills/.test(webviewCode) && !/Top skills \('/.test(webviewCode), 'marketplace defaults to Popular skills and invites search');
check(/sleepyManageBtn/.test(webviewCode) && /sleepyWebsiteBtn/.test(webviewCode) && /openSleepyWebsite/.test(agent) && /SLEEPY_ACCOUNT_URL/.test(agent), 'SleepyAI settings expose account management and website actions');
check(/max-width:560px/.test(webviewStyles) && /\.composer-tools\{display:flex;align-items:center/.test(webviewStyles) && /\.composer \.actions \.send\{width:28px;height:28px;margin-left:auto/.test(webviewStyles) && /\.dropdown-menu\{[^}]*position:fixed/.test(webviewStyles) && /placeAnchoredMenu/.test(webviewCode) && /headerSafeTop/.test(webviewCode) && /popupCap=320/.test(webviewCode) && /model-option-name\{[^}]*overflow-wrap:anywhere/.test(webviewStyles), 'composer stacks selectors responsively and full model names remain readable in the dropdown');
check(/safety-option-main\{[^}]*flex-direction:column;gap:3px/.test(webviewStyles) && /agent-option-main\{[^}]*flex-direction:column;gap:3px/.test(webviewStyles), 'agent and permission selectors visibly separate title and description text');
const sleepyCodeMark = read('media/sleepycode-mark.svg');
const sleepyCodePromptIcon = read('media/sleepycode-o.svg');
check(/font-family="monospace"/.test(sleepyCodeMark) && sleepyCodeMark.includes('/\\_/\\') && /\$ sleepycode_/.test(sleepyCodeMark), 'repository branding uses simple SleepyCode ASCII terminal art');

check(packageJson.name === 'sleepycode-agent' && packageJson.displayName === 'SleepyCode' && /^\d+\.\d+\.\d+$/.test(packageJson.version), 'package identity is fully rebranded and versioned as SleepyCode');
check(!new RegExp(['Sleepy', 'IDE'].join('') + '|' + ['sleepy', 'ide'].join('')).test([providers, agent, webviewCode, webviewStyles, util, read('README.md'), read('plan.md'), read('src/extension.ts'), JSON.stringify(packageJson)].join('\n')), 'core source, docs, and manifest contain no retired product branding');
check(/subagentSequence/.test(agent) && /type: 'subagent'/.test(agent) && /parentId: subagentId/.test(agent) && /Subagent \(\$\{role\}\) failed/.test(agent), 'subagents use explicit unique lifecycle/parent metadata and propagate failures');
check(/case\s*'subagent'/.test(webviewRuntime) && /const parentId\s*=\s*m\.parentId/.test(webviewRuntime) && !/startsWith\(\s*['"]subagent-['"]/.test(webviewRuntime), 'webview groups subagent tools by explicit parent id instead of fragile id prefixes');
check(/delete subagentTools\.delegate_task/.test(agent) && /isolated context window/.test(agent) && /Subagents cannot recursively delegate/.test(read('src/tools.ts')), 'subagent context is isolated and recursive delegation is disabled');
check(/classifySubagentStep/.test(agent) && /harvestSubagentText/.test(agent) && /rememberVisibleText/.test(agent) && /export function harvestSubagentText/.test(read('src/subagent-core.ts')), 'subagent results harvest leftover visible text instead of returning empty');
check(/html,body\{[^}]*overflow:hidden/.test(webviewStyles) && /#messages\{[^}]*flex:1 1 0[^}]*overflow-y:auto/.test(webviewStyles) && /\.composer\{[^}]*flex:0 0 auto/.test(webviewStyles), 'chat viewport keeps the composer out of the scroll pane and messages independently scroll');
check(/max-height:min\(180px,28vh\)/.test(webviewStyles) && /@media \(max-height:520px\)/.test(webviewStyles) && /ResizeObserver/.test(webviewRuntime), 'composer height is bounded and responds to short/narrow VS Code panels');
check(/const SLASH_COMMANDS=\[/.test(webviewRuntime) && /command:'\/skill'/.test(webviewRuntime) && /command:'\/skills'/.test(webviewRuntime) && /command:'\/reindex'/.test(webviewRuntime), 'composer exposes slash commands for skills and high-value extension actions');
check(/installedSkills\.filter\(skill=>/.test(webviewRuntime) && /skillPickerQuery\(value\)!==null/.test(webviewRuntime) && /if\s*\(skillPickerOpen\)\s*refreshSkillPicker\(\)/.test(webviewRuntime) && /The user explicitly invoked the installed skill/.test(webviewRuntime), 'slash skill autocomplete is driven by installed skills and expands to an explicit skill invocation');
check(/skillsmp_list_installed \/ skillsmp_read_installed/.test(agent) && /inspect the Installed skills inventory included in your instructions/.test(agent) && /Installed skills inventory \(metadata only/.test(read('src/skills.ts')), 'system prompt actively discovers and loads installed skills before use');
check(/try \{\s*this\.log\('info', 'run\.preflight\.start'[\s\S]*?if \(!providerConfig\) throw new Error/.test(agent), 'provider preflight failures flow through run cleanup instead of leaving a stuck running session');
check(/await this\.refreshModels\(\);\s*configuredModel = this\.selectionFor\(conversation\)\.model/.test(agent), 'model refresh re-reads configuration before declaring that no model is selected');
check(/if \(!sleepyToken\) throw new Error\('SleepyAI session is missing or expired/.test(agent), 'missing SleepyAI sessions persist through structured agent error handling');

check(/plan-progress/.test(webviewStyles) && /plan-count/.test(webviewCode) && /Working:/.test(webviewCode), 'task plan UI shows measurable progress and the active step');
check(/stageGitPaths/.test(git) && /commitGit/.test(git) && /restoreGitPath/.test(git), 'Git layer supports per-task stage, commit, and single-file restore operations');
check(/gitReviewFile/.test(webviewCode) && /gitRevertFile/.test(webviewCode) && /gitStageChanges/.test(webviewCode) && /gitCommit/.test(webviewCode), 'changes card exposes diff, revert, stage, and commit actions');
check(/unrelatedStaged/.test(agent) && /avoid mixing unrelated work/.test(agent), 'task commit refuses unrelated pre-existing staged changes');
check(/taskPathsDirtyBeforeRun/.test(agent) && /gitChangedPathsBetween/.test(git) && /already had changes before this SleepyCode task/.test(agent), 'task stage and commit refuse task paths that already contained user changes');
check(/renameConversation/.test(agent) && /togglePinConversation/.test(agent) && /conversation-search/.test(webviewStyles), 'conversation management supports search, rename, and pinning');
check(/getWebviewRuntime/.test(webview) && /\.\/webview\/runtime/.test(webview), 'webview runtime is extracted from the HTML renderer');
check(packageJson.scripts['test:core']?.includes('test/*.direct.mjs') && /model-routing-core\.ts/.test(modelRoutingCoreTest) && /project-index-core\.ts/.test(read('test/project-index-core.direct.mjs')), 'check suite directly tests production project-index and model-routing core modules');
check(/ubuntu-latest/.test(ci) && /windows-latest/.test(ci) && /macos-latest/.test(ci) && /npm run check/.test(ci) && /npm run build/.test(ci), 'CI validates check and build on Linux, Windows, and macOS');
check(/vsce package/.test(releaseWorkflow) && /upload-artifact@v\d+/.test(releaseWorkflow) && /verify:release/.test(releaseWorkflow), 'release workflow validates metadata and packages a VSIX artifact');
check(packageJson.version === JSON.parse(read('package-lock.json')).version, 'package and lockfile versions match');

check(/fileChangeStats/.test(agent) && /additions: live\.additions/.test(agent) && /function changeStatHtml/.test(webviewRuntime) && /className='changed has-preview'/.test(webviewRuntime) && /changeStatHtml\(\s*plus\s*,\s*minus\s*,\s*true\s*\)/.test(webviewRuntime) && /\.change-plus\{/.test(webviewStyles) && /\.change-stat\.totals\{/.test(webviewStyles), 'file changes persist plus/minus counts and render expandable line previews with a completed-turn total');
check(/DEFAULT_PERSISTED_REASONING = 32_000/.test(read('src/reasoning-core.ts')) && /attachReasoningToLatestAssistant\(runMessages/.test(agent) && /maxPersistedReasoning/.test(JSON.stringify(packageJson.contributes.configuration.properties)) && /Persisted thinking characters/.test(webview), 'previous thinking is persisted onto later model requests and the budget is configurable in Settings → Advanced');
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
check(/type\s*:\s*['"]notifyResponse['"]/.test(webviewRuntime) && /case ['"]notify['"]/.test(webviewRuntime)
  && /showInlineApproval/.test(webviewRuntime) && /await showNotifyModal/.test(webviewRuntime),
  'both the inline card and the modal answer over the same notifyResponse channel, so the reply vocabulary cannot drift between paths');
check(/approvalCanRenderInline/.test(webviewRuntime) && /activeConversationId===activeConversationId|conversationId===activeConversationId/.test(webviewRuntime),
  'the inline card is only used when the prompt belongs to the transcript on screen; everything else falls back to the modal');
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

// --- Keyboard-first shell ----------------------------------------------------------
// The bug this phase fixed was "works by mouse, silently not by keyboard". These stop it returning.
check(/function bindMenuKeyboard/.test(webviewRuntime) && /restoreMenuFocus\(trigger\)/.test(webviewRuntime)
  && /function menuNavRows/.test(webviewRuntime),
  'disclosure menus share one keyboard model, and Escape hands focus back to the trigger');
check(/function captureFocus/.test(webviewRuntime) && /function restoreFocus/.test(webviewRuntime)
  && /restoreFocus\(job\.previous\)/.test(webviewRuntime) && /restoreFocus\(previous\)/.test(webviewRuntime),
  'every overlay restores focus when it closes, so a decision cannot strand the keyboard');
check(/function announceTurn/.test(webviewRuntime) && /turnStatus/.test(webviewRuntime) && /id="turnStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(webview),
  'turn progress is announced in a live region rather than only shown with a spinner');
// A focus ring that depends on a bare theme variable vanishes when the variable is undefined.
check(!/:focus-visible\{outline:[^}]*var\(--vscode-focusBorder\)[^,}]/.test(webviewStyles),
  'focus outlines fall back when the theme variable is missing, so the ring cannot silently disappear');
check(/forced-colors: active/.test(webviewStyles) && /outline:2px solid Highlight/.test(webviewStyles),
  'forced-colors mode keeps a visible focus ring');
check(!/id="moreActionsMenu" role="menu"/.test(webview),
  'popovers do not claim role=menu when they do not implement arrow navigation and roving tabindex');
check(/id="modelButton"[^>]*aria-label=/.test(webview) && /id="agentButton"[^>]*aria-label=/.test(webview),
  'the model and agent triggers have accessible names rather than relying on changing text');

// --- Keyboard-first shell & accessibility --------------------------------------------------
// The chat shell is reachable without a mouse. These pin the shape, not the styling.
const webviewMarkup = read('src/webview.ts');
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
check(/id="conversationButton"[^>]*aria-controls="conversationMenu"/.test(webviewMarkup) && /id="moreActionsButton"[^>]*aria-controls="moreActionsMenu"/.test(webviewMarkup),
  'every disclosure trigger names the popover it controls with aria-controls');
check(/aria-activedescendant/.test(webviewRuntime) && /id="slashMenu" role="listbox"/.test(webviewMarkup) && /id="mentionMenu" role="listbox"/.test(webviewMarkup),
  'the slash and mention menus name their highlighted option, because focus stays in the textarea there');
check(/aria-selected/.test(webviewRuntime) && /role','option'/.test(webviewRuntime),
  'composer popover options carry listbox option semantics, not just a CSS highlight class');
check(/else if \(runningSet\.has\(activeConversationId\)\) \{ vscode\.postMessage\(\{ type: 'stop' \}\) \}/.test(webviewRuntime),
  'Escape stops a running turn instead of only blurring the composer');
check(/id="composerCaption"/.test(webviewMarkup) && /Shift\+Enter for a new line/.test(webviewMarkup),
  'the composer states its own Enter and Shift+Enter contract');
// The disclosure popovers move real focus, so claiming role=menu would promise roving tabindex and
// arrow handling they deliberately do not implement. Guard against that regression.
check(!/id="(modelMenu|effortMenu|agentMenu|safetyMenu|conversationMenu|moreActionsMenu)"[^>]*role="menu"/.test(webviewMarkup),
  'disclosure popovers do not claim role=menu, because they move real focus instead of roving tabindex');

// --- Findability: developer references in prose ------------------------------------------------
// The ordering here is the whole correctness argument. Inline code is swapped for sentinel
// placeholders *before* the reference pass runs, and every pass writes its HTML into a second
// placeholder channel, so a later pass can never reach inside markup an earlier one generated.
check(/codes\.push\(code\);return tokenStart/.test(webviewRuntime) && /line=linkifyDevRefs\(line,keep\)/.test(webviewRuntime)
  && /const tick=String\.fromCharCode\(96\)/.test(webviewRuntime),
  'inline code is placeholder-protected before the developer-reference pass runs, so code spans stay inert');
check(webviewRuntime.includes('const keep=html=>{safe.push(html);return safeStart+(safe.length-1)+safeEnd}')
  && webviewRuntime.includes("new RegExp(safeStart+'") && webviewRuntime.includes("+safeEnd,'g')"),
  'generated anchors are stashed in their own placeholder channel and restored last');
// A false link is worse than a missed one: it turns a sentence into something clickable that opens
// the wrong file. The extension list is what keeps i.e. / and\/or / foo\/bar\/baz out of the DOM.
check(webviewRuntime.includes("const DEV_REF_EXT='ts|tsx|mts|cts|js")
  && webviewRuntime.includes('function splitRefPosition')
  && webviewRuntime.includes('const two=/^(.*):(\\d+):(\\d+)$/.exec(text)||/^(.*):(\\d+)$/.exec(text)'),
  'references are matched against an explicit extension list and only a trailing numeric position is split off');
check(webviewRuntime.includes('const DEV_FILE_RE=/(?<!')
  && webviewRuntime.includes('const DEV_URL_RE=/(?<!')
  && webviewRuntime.includes("new RegExp('(?<!"),
  'each reference pass is guarded by a lookbehind so it cannot fire inside generated markup or the tail of a URL');
// A reference must actually reach the editor at the right position, not just look clickable.
check(/type: 'openFile'; path: string; line\?: number; column\?: number/.test(types)
  && /data-line="'\+line/.test(webviewRuntime)
  && /new vscode\.Range\(row, col, row, col\)/.test(agent),
  'a file reference carries its position from the webview to the editor');
check(/data-devref\b/.test(webviewRuntime) && /role="link" tabindex="0"/.test(webviewRuntime),
  'prose references answer Enter and Space as well as a click, because a role=link must');
// Error cards: extend, never replace. Losing Retry would be a regression, not a cleanup.
check(/function errorActions\(errorText\)/.test(webviewRuntime) && /appendChild\(retryButton\(\)\)/.test(webviewRuntime)
  && /copy\.textContent = 'Copy error'/.test(webviewRuntime) && /logs\.textContent = 'Open logs'/.test(webviewRuntime),
  'an error card still offers Retry and now also Copy error and Open logs');
check(/type: 'requestExtensionLogs'/.test(webviewRuntime) && /getElementById\('extensionLogs'\)/.test(webviewRuntime),
  'Open logs reveals the existing log view instead of adding a second place to read the same thing');

console.log(`LOGIC CHECK OK (${checks.length} checks)`);
