/*
 * What makes one skill different from another.
 *
 * Two vendors routinely publish a skill under the same name — `review`,
 * `testing`, `docs`. A skill used to be identified by its NAME alone: the
 * repository listing kept the first `review` it found and silently dropped the
 * rest, the installer wrote every `review` into the same folder so the second
 * install overwrote the first, and asking for `review` resolved to whichever one
 * happened to sort first. None of that is visible from the UI, so a user could
 * install two skills and end up with one.
 *
 * Identity is therefore the vendor AND the name:
 *
 *   key     `owner/repo:name`   — what a candidate is, in lists and messages
 *   folder  `name--owner--repo` — where it lives on disk, so vendors coexist
 *   name    `name`              — what the agent calls it, and what the user sees
 *
 * The name stays plain because `/skill <name>` and the system prompt's inventory
 * are read by a model, not by a filesystem. Ambiguity is resolved at the point
 * where a name is used, by listing the candidates instead of guessing.
 */

export interface SkillIdentity {
  owner: string;
  repo: string;
  name: string;
}

/** Lowercase, hyphen-separated, safe as one path segment. */
export function slug(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The stable key for a skill: which vendor, then which skill. */
export function skillKey(identity: SkillIdentity): string {
  const owner = slug(identity.owner);
  const repo = slug(identity.repo);
  const name = slug(identity.name) || 'skill';
  if (!owner || !repo) return name;
  return `${owner}/${repo}:${name}`;
}

/** Read a key back, or undefined when it is not one. */
export function parseSkillKey(key: string | undefined): SkillIdentity | undefined {
  const match = /^([^/:]+)\/([^/:]+):(.+)$/.exec(String(key ?? '').trim());
  if (!match) return undefined;
  return { owner: match[1] ?? '', repo: match[2] ?? '', name: match[3] ?? '' };
}

/**
 * The install folder for a skill.
 *
 * Unique per vendor so two `review` skills can both be installed, and prefixed
 * with the skill's own name so the folder still reads as the thing it holds.
 */
export function skillFolderName(identity: SkillIdentity): string {
  const name = slug(identity.name) || 'skill';
  const owner = slug(identity.owner);
  const repo = slug(identity.repo);
  return owner && repo ? `${name}--${owner}--${repo}` : name;
}

/**
 * Read a vendor out of an install folder.
 *
 * `review--acme--skills` is the skill `review` from `acme/skills`. Slugs cannot
 * contain `--` (every run of non-alphanumerics collapses to one `-`), so the
 * separator is unambiguous and the folder alone is enough to recover identity —
 * no side table that can drift.
 */
export function parseFolderName(folder: string): { name: string; key?: string } {
  const parts = String(folder ?? '').split('--').filter(Boolean);
  const name = parts[0] ?? '';
  if (parts.length >= 3) return { name, key: `${parts[1]}/${parts[2]}:${name}` };
  return { name };
}

/** The name the agent and the user call a skill by. */
export function skillDisplayName(folder: string, declared?: string): string {
  const declaredName = String(declared ?? '').trim();
  if (declaredName) return declaredName;
  // `review--acme--skills` holds a skill called `review`.
  return String(folder ?? '').split('--')[0] || String(folder ?? '');
}

export type SkillLookup<T> =
  | { kind: 'found'; skill: T }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'missing' };

/**
 * Find one skill by folder, key, or plain name.
 *
 * A folder or key is an identity and must match exactly. A plain name is how a
 * person asks, and two vendors may both answer to it — that is reported as a
 * choice rather than resolved by list order, because picking silently is how the
 * wrong vendor's instructions end up steering an agent.
 */
export function findSkill<T extends { folder: string; name: string; key?: string }>(
  skills: readonly T[],
  query: string,
): SkillLookup<T> {
  const wanted = String(query ?? '').trim();
  if (!wanted) return { kind: 'missing' };

  const byFolder = skills.find(skill => skill.folder === wanted);
  if (byFolder) return { kind: 'found', skill: byFolder };

  const byKey = skills.find(skill => skill.key && skill.key.toLowerCase() === wanted.toLowerCase());
  if (byKey) return { kind: 'found', skill: byKey };

  const wantedSlug = slug(wanted);
  const named = skills.filter(skill => slug(skill.name) === wantedSlug || slug(skillDisplayName(skill.folder, skill.name)) === wantedSlug);
  if (named.length === 1 && named[0]) return { kind: 'found', skill: named[0] };
  if (named.length > 1) return { kind: 'ambiguous', candidates: named };
  return { kind: 'missing' };
}

/** The message for a name that more than one vendor publishes. */
export function ambiguousSkillMessage(query: string, candidates: readonly { name: string; key?: string }[]): string {
  const options = candidates.map(skill => skill.key || skill.name).join(', ');
  return `More than one installed skill is called '${query}'. Ask for one of: ${options}.`;
}