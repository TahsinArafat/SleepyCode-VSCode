/**
 * A worktree name derived from a conversation title.
 *
 * Kept separate and pure because the name becomes a directory and a git branch:
 * a title is arbitrary user text, so traversal and metacharacters must be
 * impossible by construction rather than by trusting the input.
 */

/** Longest generated name; git and file systems both handle this comfortably. */
const MAX_LENGTH = 60;

/** Reduce a title to `[a-z0-9-]`, or a stable fallback when nothing survives. */
export function worktreeNameFor(title: string | undefined): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
  // Deterministic fallback: 'worktree' cannot collide with a slug made only of
  // separators, and a timestamp would make names unpredictable to type.
  return slug || 'worktree';
}
