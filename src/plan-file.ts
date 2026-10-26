/**
 * Where a plan file lives, and what goes in it.
 *
 * Kept dependency-free and pure so the extension host can use it and the direct
 * test runner can prove the path is safe: the tool derives the path from a
 * model-chosen title, so traversal must be impossible by construction rather
 * than by trusting the input.
 */

/** Folder holding plan documents, alongside `.sleepycode/memory.md`. */
export const PLAN_DIR = '.sleepycode/plans';

/**
 * A title reduced to a file name.
 *
 * Everything outside `[a-z0-9-]` is dropped rather than replaced, so no path
 * separator, drive letter or `..` can survive. A title with no usable characters
 * falls back to `plan`.
 */
export function planSlug(title: string | undefined): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'plan';
}

/** Workspace-relative path for a plan, always inside `PLAN_DIR`. */
export function planRelativePath(title: string | undefined): string {
  return `${PLAN_DIR}/${planSlug(title)}.md`;
}

/** The document written to that path. */
export function planDocument(title: string | undefined, body: string): string {
  const heading = (title ?? '').trim() || 'Plan';
  const day = new Date().toISOString().slice(0, 10);
  return `# ${heading}\n\n_Written ${day}_\n\n${body.trim()}\n`;
}