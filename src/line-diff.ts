export type FileChangeLineKind = 'add' | 'del' | 'ctx' | 'meta';

export type FileChangeLine = {
  kind: FileChangeLineKind;
  text: string;
};

export type LineDiff = {
  additions: number;
  deletions: number;
  lines: FileChangeLine[];
};

const LARGE_DIFF_CELLS = 400_000;
const PREVIEW_LINE_CHARS = 180;
const PREVIEW_MAX_LINES = 16;
const PREVIEW_CONTEXT = 1;

/** Git-style line split: a trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function countLines(text: string): number {
  return splitLines(text).length;
}

function clipPreviewText(text: string): string {
  if (text.length <= PREVIEW_LINE_CHARS) return text;
  return `${text.slice(0, PREVIEW_LINE_CHARS - 1)}…`;
}

function diffMiddle(before: string[], after: string[]): FileChangeLine[] {
  if (!before.length) return after.map(text => ({ kind: 'add', text }));
  if (!after.length) return before.map(text => ({ kind: 'del', text }));
  if (before.length * after.length > LARGE_DIFF_CELLS) {
    return [
      ...before.map(text => ({ kind: 'del' as const, text })),
      ...after.map(text => ({ kind: 'add' as const, text })),
    ];
  }

  const dp: Uint32Array[] = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const lines: FileChangeLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'ctx', text: before[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'del', text: before[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: after[j]! });
      j += 1;
    }
  }
  while (i < before.length) {
    lines.push({ kind: 'del', text: before[i]! });
    i += 1;
  }
  while (j < after.length) {
    lines.push({ kind: 'add', text: after[j]! });
    j += 1;
  }
  return lines;
}

export function diffLines(before: string, after: string): LineDiff {
  const previous = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < previous.length - start
    && end < next.length - start
    && previous[previous.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }

  const lines: FileChangeLine[] = [
    ...previous.slice(0, start).map(text => ({ kind: 'ctx' as const, text })),
    ...diffMiddle(previous.slice(start, previous.length - end), next.slice(start, next.length - end)),
    ...previous.slice(previous.length - end).map(text => ({ kind: 'ctx' as const, text })),
  ];
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.kind === 'add') additions += 1;
    else if (line.kind === 'del') deletions += 1;
  }
  return { additions, deletions, lines };
}

export function compactLinePreview(lines: FileChangeLine[], maxLines = PREVIEW_MAX_LINES, context = PREVIEW_CONTEXT): FileChangeLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== 'add' && line.kind !== 'del') return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let cursor = from; cursor <= to; cursor += 1) keep.add(cursor);
  });
  if (!keep.size) return [];

  const ordered = [...keep].sort((left, right) => left - right);
  const preview: FileChangeLine[] = [];
  let last = -2;
  for (const index of ordered) {
    if (preview.length >= maxLines) {
      preview.push({ kind: 'meta', text: '…' });
      break;
    }
    if (last >= 0 && index > last + 1) {
      preview.push({ kind: 'meta', text: '…' });
      if (preview.length >= maxLines) break;
    }
    const line = lines[index];
    if (!line) continue;
    preview.push({ kind: line.kind, text: clipPreviewText(line.text) });
    last = index;
  }
  return preview;
}

export function fileChangeStats(before: string, after: string): { additions: number; deletions: number; preview: FileChangeLine[] } {
  const diff = diffLines(before, after);
  return {
    additions: diff.additions,
    deletions: diff.deletions,
    preview: compactLinePreview(diff.lines),
  };
}
