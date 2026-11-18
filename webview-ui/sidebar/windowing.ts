/**
 * Turn-list windowing math.
 *
 * The transcript used to mount every turn of a conversation, relying on CSS
 * `content-visibility: auto` to skip off-screen layout. That skips paint, not
 * memory: a 1,000-turn chat still built ~63,000 DOM nodes and blocked the main
 * thread for ~600 ms on open. Windowing renders only the band around the
 * viewport and replaces the rest with height-preserving spacers.
 *
 * Kept pure and React-free so the arithmetic is testable without a DOM: chat
 * groups have wildly variable heights, so a wrong offset silently breaks
 * scroll anchoring and that is the failure this module exists to prevent.
 */

/** Height assumed for a group that has never been rendered, in px. */
export const ESTIMATED_GROUP_HEIGHT = 300;
/** Extra groups rendered on each side so fast scrolling does not flash empty space. */
export const WINDOW_OVERSCAN = 8;
/** Below this many groups the whole transcript renders: windowing costs more than it saves. */
export const WINDOW_MIN_GROUPS = 60;
/**
 * Groups mounted before the first measurement pass.
 *
 * A conversation opens at the bottom, so the tail is what must be on screen. This
 * exists so the first paint never mounts a long transcript in full "just in case":
 * the real window replaces it a frame later, once heights are measured.
 */
export const INITIAL_TAIL_GROUPS = 20;

/** The band to mount when nothing has been measured yet. */
export function initialWindow(count: number): TurnWindow {
  if (count <= WINDOW_MIN_GROUPS) return { start: 0, end: count };
  return { start: Math.max(0, count - INITIAL_TAIL_GROUPS), end: count };
}

export type GroupMetrics = {
  /** Offset of each group's top edge from the top of the transcript. */
  offsets: number[];
  heights: number[];
  total: number;
};

export type TurnWindow = { start: number; end: number };

/** Prefix-sum layout for `count` groups, using measured heights where known. */
export function buildMetrics(
  count: number,
  measured: ReadonlyMap<number, number>,
  estimate = ESTIMATED_GROUP_HEIGHT,
): GroupMetrics {
  const offsets = new Array<number>(Math.max(0, count));
  const heights = new Array<number>(Math.max(0, count));
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const measuredHeight = measured.get(index);
    // A zero/negative measurement is a group that has not laid out yet; falling
    // back keeps the spacer from collapsing and jumping the scroll position.
    const height = measuredHeight && measuredHeight > 0 ? measuredHeight : estimate;
    offsets[index] = total;
    heights[index] = height;
    total += height;
  }
  return { offsets, heights, total };
}

/** Index of the group containing `y`, clamped to the transcript. */
function indexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] ?? 0) <= y) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Groups to render: the ones intersecting the viewport plus overscan.
 *
 * `end` is exclusive. A short transcript renders whole, so small chats keep
 * exactly the behaviour they had before windowing existed.
 */
export function visibleWindow(input: {
  scrollTop: number;
  viewport: number;
  metrics: GroupMetrics;
  overscan?: number;
  minGroups?: number;
}): TurnWindow {
  const { metrics } = input;
  const count = metrics.offsets.length;
  if (count === 0) return { start: 0, end: 0 };
  const minGroups = input.minGroups ?? WINDOW_MIN_GROUPS;
  if (count <= minGroups) return { start: 0, end: count };

  const overscan = input.overscan ?? WINDOW_OVERSCAN;
  const top = Math.max(0, input.scrollTop);
  const bottom = top + Math.max(0, input.viewport);
  const first = indexAt(metrics.offsets, top);
  const last = indexAt(metrics.offsets, bottom);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, Math.max(last + 1, start + 1) + overscan);
  return { start, end };
}

/** Heights of the spacers standing in for the unrendered head and tail. */
export function spacerHeights(metrics: GroupMetrics, window: TurnWindow): { before: number; after: number } {
  const count = metrics.offsets.length;
  const start = Math.max(0, Math.min(window.start, count));
  const end = Math.max(start, Math.min(window.end, count));
  const before = start === 0 ? 0 : metrics.offsets[start] ?? 0;
  const after = end >= count ? 0 : metrics.total - (metrics.offsets[end] ?? metrics.total);
  return { before, after };
}

/**
 * Scroll correction after heights above `anchor` changed.
 *
 * A group that scrolls out of view is replaced by a spacer sized from its last
 * measurement, so the document height only moves when a newly measured group
 * disagrees with the estimate. That disagreement happens above the viewport,
 * which shifts everything the user is reading; adding this delta to `scrollTop`
 * puts it back.
 */
export function shiftAbove(before: GroupMetrics, after: GroupMetrics, anchor: number): number {
  const limit = Math.min(anchor, before.heights.length, after.heights.length);
  let shift = 0;
  for (let index = 0; index < limit; index += 1) shift += (after.heights[index] ?? 0) - (before.heights[index] ?? 0);
  return shift;
}
