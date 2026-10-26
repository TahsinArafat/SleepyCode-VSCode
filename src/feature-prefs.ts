/*
 * Where the settings window's toggles actually land.
 *
 * The window posts one `saveFeatures` payload carrying every kind of choice it
 * offers: MCP servers, chat preferences, configuration, an approval policy. The
 * host applied `mcpServers` and returned, so the rest looked like it saved and
 * existed nowhere — the toggles reset on the next open.
 *
 * This module is the mapping between that payload and SleepyCode's real storage:
 * per-workspace chat preferences, VS Code configuration, and the single approval
 * mode SleepyCode's engine actually gates on. Pure, so the round trip — what the
 * window sends must read back as what it displays — is testable.
 */

export type ChatTextSize = 'compact' | 'default' | 'large';
export type MotionPreference = 'full' | 'system' | 'reduced';

/** Chat preferences that belong to the workspace they were set in. */
export interface ChatPrefs {
  chatTextSize: ChatTextSize;
  motion: MotionPreference;
  submitWithCtrlEnter: boolean;
  maxTabCount: number;
  completionSound: boolean;
  perTabDrafts: boolean;
  /** Whether a finished request is written to the local usage log. */
  trackUsage: boolean;
}

export const DEFAULT_CHAT_PREFS: ChatPrefs = {
  chatTextSize: 'default',
  motion: 'system',
  submitWithCtrlEnter: false,
  maxTabCount: 6,
  completionSound: false,
  perTabDrafts: false,
  trackUsage: true,
};

/** A tab count is read from disk, so it is bounded rather than trusted. */
export const MAX_TAB_COUNT_CEILING = 24;

const TEXT_SIZES: readonly ChatTextSize[] = ['compact', 'default', 'large'];
const MOTIONS: readonly MotionPreference[] = ['full', 'system', 'reduced'];

function clampTabCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_TAB_COUNT_CEILING, Math.max(1, Math.floor(value)));
}

/** Read stored preferences, replacing anything unusable with the default. */
export function normalizePrefs(value: unknown): ChatPrefs {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CHAT_PREFS };
  const input = value as Record<string, unknown>;
  const tabs = clampTabCount(input.maxTabCount);
  return {
    chatTextSize: TEXT_SIZES.includes(input.chatTextSize as ChatTextSize)
      ? (input.chatTextSize as ChatTextSize)
      : DEFAULT_CHAT_PREFS.chatTextSize,
    motion: MOTIONS.includes(input.motion as MotionPreference)
      ? (input.motion as MotionPreference)
      : DEFAULT_CHAT_PREFS.motion,
    submitWithCtrlEnter: typeof input.submitWithCtrlEnter === 'boolean'
      ? input.submitWithCtrlEnter
      : DEFAULT_CHAT_PREFS.submitWithCtrlEnter,
    maxTabCount: tabs ?? DEFAULT_CHAT_PREFS.maxTabCount,
    completionSound: typeof input.completionSound === 'boolean'
      ? input.completionSound
      : DEFAULT_CHAT_PREFS.completionSound,
    perTabDrafts: typeof input.perTabDrafts === 'boolean'
      ? input.perTabDrafts
      : DEFAULT_CHAT_PREFS.perTabDrafts,
    trackUsage: typeof input.trackUsage === 'boolean'
      ? input.trackUsage
      : DEFAULT_CHAT_PREFS.trackUsage,
  };
}

/**
 * The preference keys a feature payload actually carries.
 *
 * Only the keys present are returned: an MCP edit posts the whole feature set
 * minus the preferences, and treating that as "reset everything to default"
 * would wipe the user's chat preferences on an unrelated save.
 */
export function prefsFromFeatures(features: unknown): Partial<ChatPrefs> {
  if (!features || typeof features !== 'object') return {};
  const input = features as Record<string, unknown>;
  const patch: Partial<ChatPrefs> = {};
  if (TEXT_SIZES.includes(input.chatTextSize as ChatTextSize)) patch.chatTextSize = input.chatTextSize as ChatTextSize;
  if (MOTIONS.includes(input.motion as MotionPreference)) patch.motion = input.motion as MotionPreference;
  if (typeof input.submitWithCtrlEnter === 'boolean') patch.submitWithCtrlEnter = input.submitWithCtrlEnter;
  if (typeof input.completionSound === 'boolean') patch.completionSound = input.completionSound;
  if (typeof input.perTabDrafts === 'boolean') patch.perTabDrafts = input.perTabDrafts;
  if (typeof input.trackUsage === 'boolean') patch.trackUsage = input.trackUsage;
  const tabs = clampTabCount(input.maxTabCount);
  if (tabs !== undefined) patch.maxTabCount = tabs;
  return patch;
}

/** A validated, complete record with the patch applied. */
export function applyPrefs(current: ChatPrefs, patch: Partial<ChatPrefs>): ChatPrefs {
  return normalizePrefs({ ...current, ...patch });
}

/** The configuration keys a feature payload maps onto. */
export interface ConfigPatch {
  systemNotifications?: boolean;
  maxSteps?: number;
  repoIndex?: boolean;
}

/**
 * SleepyCode's own settings, for the features that have one. Anything the window
 * offers without a counterpart is deliberately absent rather than invented.
 */
export function configPatchFromFeatures(features: unknown): ConfigPatch {
  if (!features || typeof features !== 'object') return {};
  const input = features as Record<string, unknown>;
  const patch: ConfigPatch = {};
  if (typeof input.notifyOnComplete === 'boolean') patch.systemNotifications = input.notifyOnComplete;
  // 0 means "unlimited" in SleepyCode, so it is meaningful; negatives are not.
  if (typeof input.maxAgentSteps === 'number' && Number.isFinite(input.maxAgentSteps) && input.maxAgentSteps >= 0) {
    patch.maxSteps = Math.floor(input.maxAgentSteps);
  }
  if (typeof input.indexingEnabled === 'boolean') patch.repoIndex = input.indexingEnabled;
  return patch;
}

/** The feature fields to show, taken from what is stored rather than defaulted. */
export function featuresFromHost(input: { prefs: ChatPrefs; settings: { systemNotifications?: boolean; maxSteps?: number; repoIndex?: boolean } }): Record<string, unknown> {
  const { prefs, settings } = input;
  return {
    chatTextSize: prefs.chatTextSize,
    motion: prefs.motion,
    submitWithCtrlEnter: prefs.submitWithCtrlEnter,
    maxTabCount: prefs.maxTabCount,
    completionSound: prefs.completionSound,
    perTabDrafts: prefs.perTabDrafts,
    trackUsage: prefs.trackUsage,
    notifyOnComplete: settings.systemNotifications !== false,
    maxAgentSteps: settings.maxSteps ?? 200,
    indexingEnabled: settings.repoIndex !== false,
  };
}

/** SleepyCode's approval modes. `agent` acts; the other two are read-only. */
export type ApprovalMode = 'ask' | 'edits' | 'autonomous';

/**
 * Project a per-action policy back onto SleepyCode's single mode.
 *
 * SleepyCode gates by kind — edits versus commands — not per action type, so the
 * window's policy cannot be stored as given. The edit rule decides the mode,
 * because that is what the mode selects: `edits` applies changes while still
 * asking before a command, which is precisely "edits allowed, shell asks". A
 * uniform policy maps straight across. Anything mixed in a way the single mode
 * cannot express, or malformed, yields nothing rather than a guess.
 */
export function approvalModeFromPolicy(policy: unknown): ApprovalMode | undefined {
  if (!policy || typeof policy !== 'object') return undefined;
  const rules = Object.values(policy as Record<string, { mode?: unknown } | undefined>);
  const modes = rules.map(rule => (rule && typeof rule === 'object' ? rule.mode : undefined));
  if (!modes.length) return undefined;
  const known = modes.filter(mode => mode === 'allow' || mode === 'ask' || mode === 'review');
  if (!known.length) return undefined;
  const every = (mode: string) => known.every(entry => entry === mode);
  if (every('allow')) return 'autonomous';
  if (every('ask')) return 'ask';
  if (every('review')) return 'edits';
  const edits = (policy as Record<string, { mode?: unknown }>).edits?.mode;
  const shell = (policy as Record<string, { mode?: unknown }>).shell?.mode;
  if (edits === 'allow' && shell === 'ask') return 'edits';
  return undefined;
}
/**
 * Split one `saveFeatures` payload into the stores it belongs in.
 *
 * The window posts a single payload carrying every kind of choice it offers.
 * Routing it in one pure step is what makes "was this toggle actually saved?"
 * answerable without a VS Code window: the handler applies each part and this
 * function decides which parts exist.
 *
 * `connections` is deliberately `undefined` rather than `[]` for a payload with
 * no `mcpServers`, because an empty array means "delete every server" — and a
 * chat-preference save must never do that.
 */
export function routeFeatureSave(features: unknown): {
  connections: unknown[] | undefined;
  prefs: Partial<ChatPrefs>;
  config: ConfigPatch;
  approvalMode: ApprovalMode | undefined;
} {
  const input = features && typeof features === 'object' ? (features as Record<string, unknown>) : {};
  return {
    connections: Array.isArray(input.mcpServers) ? input.mcpServers : undefined,
    prefs: prefsFromFeatures(features),
    config: configPatchFromFeatures(features),
    approvalMode: approvalModeFromPolicy(input.approvalPolicy),
  };
}
