/*
 * Feature visibility for the SleepyCode React webview.
 *
 * The webview is based on OpenCursor, which ships a much wider surface than
 * SleepyCode exposes (multi-provider accounts, local model runtimes, personas,
 * teams, docs indexing, remote jobs, plugins). Those screens stay in the tree
 * and are only hidden here: nothing is deleted, so a future release can switch
 * a flag back on without restoring code from history.
 */

/** Settings rail sections that belong to OpenCursor-only features. */
export const HIDDEN_SETTINGS_SECTIONS = [
  'providers',
  'llamacpp',
  'ollama',
  'personas',
  'subagents',
  'indexing',
  'hooks',
] as const;

export type HiddenSection = (typeof HIDDEN_SETTINGS_SECTIONS)[number];

const hiddenSections = new Set<string>(HIDDEN_SETTINGS_SECTIONS);

/** True when a settings section is OpenCursor-only and must not be rendered. */
export function isSectionHidden(id: string): boolean {
  return hiddenSections.has(id);
}

/** Drop hidden sections from a nav list while preserving the original order. */
export function filterSections<T extends { id: string }>(sections: readonly T[]): T[] {
  return sections.filter(section => !hiddenSections.has(section.id));
}

/**
 * SleepyCode has one first-party provider plus optional compatibility
 * endpoints, so the composer shows one flat model list instead of grouping
 * models under provider headings.
 */
export const SHOW_PROVIDER_GROUPS = false;

/** OpenCursor-only capabilities that have no SleepyCode implementation yet. */
const HIDDEN_FEATURES = new Set<string>([
  'remoteJobs',
  'plugins',
  'docsIndexing',
  'semanticSearch',
  'localRuntimes',
  'accounts',
  'teams',
]);

/** True when an OpenCursor-only feature should stay out of the UI. */
export function isFeatureHidden(id: string): boolean {
  return HIDDEN_FEATURES.has(id);
}

/**
 * Composer modes SleepyCode implements. Multitask and Project are OpenCursor
 * coordinators that delegate to its team system; SleepyCode has subagents but
 * no team coordinator, so those modes are hidden rather than shown broken.
 */
const HIDDEN_MODES = new Set<string>(['multitask', 'project']);

/** Drop composer modes SleepyCode does not implement, preserving order. */
export function filterModes<T extends { id: string }>(modes: readonly T[]): T[] {
  return modes.filter(mode => !HIDDEN_MODES.has(mode.id));
}
