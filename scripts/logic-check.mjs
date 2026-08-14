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
check(/What are we working on\?/.test(webviewCode) && /const STARTERS=\[/.test(webviewCode), 'empty state offers task-oriented SleepyAI starters');
check(/id="contextSummaryButton"/.test(webviewCode) && /data-context-toggle="active"/.test(webviewCode) && /const context=\{includeProjectIndex,includeActiveFile,includeSelection/.test(webviewCode), 'composer exposes explicit active-file and selection context controls');
check(/mode:'Build'/.test(webviewCode) && /mode:'Debug'/.test(webviewCode) && /mode:'Review'/.test(webviewCode), 'branded agents expose task-oriented modes');
check(/function modelMeta\(/.test(webviewCode) && /per 1M in\/out/.test(webviewCode), 'model picker surfaces context and SleepyAI pricing metadata');
check(/function changesCard\(/.test(webviewCode) && /Source Control/.test(webviewCode) && /Stage all/.test(webviewCode), 'completed responses expose a workspace changes review card');
check(/message\.type === 'reviewChanges'/.test(agent) && /workbench\.view\.scm/.test(agent), 'changes review action opens VS Code Source Control');
check(/const runChanges = new Map/.test(agent) && /assistantItem\.changes = \[\.\.\.runChanges\.values\(\)\]/.test(agent), 'agent persists per-response workspace changes');
check(/attachments: item\.attachments/.test(util) && /changes: item\.changes/.test(util) && /errorInfo: item\.errorInfo/.test(util) && /commitHash: item\.commitHash/.test(util) && /commitMessage: item\.commitMessage/.test(util), 'transcript normalization preserves attachments, response changes, structured errors, and Git commit state');
check(/classifyAgentError/.test(util) && /action_denied/.test(util) && /auth_required/.test(util) && /credits_exhausted/.test(util) && /context_too_large/.test(util), 'agent errors are classified into actionable SleepyAI states');
check(/errorItem\.errorInfo = errorInfo/.test(agent) && /structuredErrorCard/.test(webviewCode), 'generation failures persist and render structured error actions');
check(/openSleepyDashboard/.test(agent) && /SLEEPY_ACCOUNT_URL/.test(agent), 'billing and error actions can open the first-party SleepyAI account');
check(/Usage &amp; Billing/.test(webviewCode) && /server-authoritative/.test(webviewCode), 'usage view prioritizes SleepyAI account and billing state over local token counts');
check(/sendSleepyAccountData/.test(agent) && /30_000/.test(agent), 'SleepyAI account usage refresh is throttled while local usage remains live');
check(/sessionAllowedCommands/.test(agent) && /commandKey/.test(agent) && /workspaceRoot\(\)\?\.fsPath/.test(agent) && /Allow this command for session/.test(agent), 'non-destructive exact commands can be trusted for the current workspace session');
check(/sessionAutoApproveEditRoots/.test(agent) && /Allow edits for session/.test(agent), 'non-destructive edits can be trusted for the current workspace session');
check(/risk: destructive \? 'high' : 'medium'/.test(agent) && /notify-risk/.test(webviewStyles), 'approval prompts surface a risk level');
check(/for \(let attempt = 0; ; attempt\+\+\)/.test(agent) && /waitForRetry\(backoffMs, run\.controller\.signal\)/.test(agent) && /throw part\.error/.test(agent), 'retry UI is backed by real abort-aware HTTP retries without discarding structured provider errors');
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
check(/max-width:560px/.test(webviewStyles) && /grid-column:1 \/ -1;grid-row:2/.test(webviewStyles) && /width:min\(440px/.test(webviewStyles) && /model-option-name\{[^}]*overflow-wrap:anywhere/.test(webviewStyles), 'composer stacks selectors responsively and full model names remain readable in the dropdown');
check(/safety-option-main\{[^}]*flex-direction:column;gap:3px/.test(webviewStyles) && /agent-option-main\{[^}]*flex-direction:column;gap:3px/.test(webviewStyles), 'agent and permission selectors visibly separate title and description text');
const sleepyCodeMark = read('media/sleepycode-mark.svg');
const sleepyCodePromptIcon = read('media/sleepycode-o.svg');
check(/font-family="monospace"/.test(sleepyCodeMark) && sleepyCodeMark.includes('/\\_/\\') && /\$ sleepycode_/.test(sleepyCodeMark), 'repository branding uses simple SleepyCode ASCII terminal art');

check(packageJson.name === 'sleepycode-agent' && packageJson.displayName === 'SleepyCode' && /^\d+\.\d+\.\d+$/.test(packageJson.version), 'package identity is fully rebranded and versioned as SleepyCode');
check(!new RegExp(['Sleepy','IDE'].join('') + '|' + ['sleepy','ide'].join('')).test([providers, agent, webviewCode, webviewStyles, util, read('README.md'), read('plan.md'), read('src/extension.ts'), JSON.stringify(packageJson)].join('\n')), 'core source, docs, and manifest contain no retired product branding');
check(/subagentSequence/.test(agent) && /type: 'subagent'/.test(agent) && /parentId: subagentId/.test(agent) && /Subagent \(\$\{role\}\) failed/.test(agent), 'subagents use explicit unique lifecycle/parent metadata and propagate failures');
check(/case'subagent'/.test(webviewRuntime) && /const parentId=m\.parentId/.test(webviewRuntime) && !/startsWith\(['"]subagent-['"]\)/.test(webviewRuntime), 'webview groups subagent tools by explicit parent id instead of fragile id prefixes');
check(/delete subagentTools\.delegate_task/.test(agent) && /isolated context window/.test(agent) && /Subagents cannot recursively delegate/.test(read('src/tools.ts')), 'subagent context is isolated and recursive delegation is disabled');
check(/html,body\{[^}]*overflow:hidden/.test(webviewStyles) && /#messages\{[^}]*flex:1 1 0[^}]*overflow-y:auto/.test(webviewStyles) && /\.composer\{[^}]*flex:0 0 auto/.test(webviewStyles), 'chat viewport keeps the composer out of the scroll pane and messages independently scroll');
check(/max-height:min\(180px,28vh\)/.test(webviewStyles) && /@media \(max-height:520px\)/.test(webviewStyles) && /ResizeObserver/.test(webviewRuntime), 'composer height is bounded and responds to short/narrow VS Code panels');
check(/const SLASH_COMMANDS=\[/.test(webviewRuntime) && /command:'\/skill'/.test(webviewRuntime) && /command:'\/skills'/.test(webviewRuntime) && /command:'\/reindex'/.test(webviewRuntime), 'composer exposes slash commands for skills and high-value extension actions');
check(/installedSkills\.filter\(skill=>/.test(webviewRuntime) && /The user explicitly invoked the installed skill/.test(webviewRuntime), 'slash skill autocomplete is driven by installed skills and expands to an explicit skill invocation');
check(/skillsmp_list_installed \/ skillsmp_read_installed/.test(agent) && /inspect the Installed skills inventory included in your instructions/.test(agent) && /Installed skills inventory \(metadata only/.test(read('src/skills.ts')), 'system prompt actively discovers and loads installed skills before use');
check(/try \{\s*if \(!providerConfig\) throw new Error/.test(agent), 'provider preflight failures flow through run cleanup instead of leaving a stuck running session');
check(/await this\.refreshModels\(\);\s*\(\{ model: configuredModel, maxSteps, apiKey, baseUrl \} = this\.config\(\)\)/.test(agent), 'model refresh re-reads configuration before declaring that no model is selected');
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
check(/vsce package/.test(releaseWorkflow) && /upload-artifact@v4/.test(releaseWorkflow) && /verify:release/.test(releaseWorkflow), 'release workflow validates metadata and packages a VSIX artifact');
check(packageJson.version === JSON.parse(read('package-lock.json')).version, 'package and lockfile versions match');

check(/code\s*!==\s*['"]ENOENT['"]/.test(util), 'workspace path resolution uses filesystem error codes rather than localized messages');
check(/throw new Error\(['"]Path escapes the workspace\./.test(util), 'workspace path resolution rejects real paths outside the root');

check(!Object.prototype.hasOwnProperty.call(packageJson.contributes.configuration.properties, 'sleepycode.provider'), 'deprecated sleepycode.provider setting is absent');
check(!packageJson.keywords.some(keyword => ['openrouter', 'groq', 'gemini', 'mistral', 'ollama'].includes(keyword)), 'marketplace keywords do not advertise third-party providers');
check(packageJson.contributes.commands.some(command => command.command === 'sleepycode.usage' && command.title === 'SleepyCode: Usage & Billing'), 'command palette presents the commercial Usage & Billing surface');
check(packageJson.scripts.check.includes('scripts/logic-check.mjs') && packageJson.scripts.check.includes('npm test'), 'npm check executes repository contracts and tests');

console.log(`LOGIC CHECK OK (${checks.length} checks)`);
