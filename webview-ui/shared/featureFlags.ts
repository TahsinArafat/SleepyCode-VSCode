/*
 * Feature visibility for the SleepyCode React webview.
 *
 * The webview is based on OpenCursor, which ships a much wider surface than
 * SleepyCode exposes (multi-provider accounts, local model runtimes, personas,
 * teams, docs indexing, remote jobs, plugins). Those screens stay in the tree
 * and are only hidden here: nothing is deleted, so a future release can switch
 * a flag back on without restoring code from history.
 */

// The settings-section rules are the HOST's. The rail shows a section and the
// host routes to it, so two lists that must match are a bug waiting to happen —
// the rail would offer a page the host refuses to open. Re-exported, not copied.
export { HIDDEN_SETTINGS_SECTIONS, isSectionHidden } from '../../src/settings-adapter.ts';

import { isSectionHidden } from '../../src/settings-adapter.ts';

/** Drop hidden sections from a nav list while preserving the original order. */
export function filterSections<T extends { id: string }>(sections: readonly T[]): T[] {
  return sections.filter(section => !isSectionHidden(section.id));
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
