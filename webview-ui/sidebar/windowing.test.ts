// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ESTIMATED_GROUP_HEIGHT,
  WINDOW_MIN_GROUPS,
  buildMetrics,
  shiftAbove,
  spacerHeights,
  visibleWindow,
} from "./windowing";

const measuredMap = (entries: Record<number, number>) => new Map(Object.entries(entries).map(([key, value]) => [Number(key), value]));

describe("buildMetrics", () => {
  it("uses measured heights and estimates the rest", () => {
    const metrics = buildMetrics(3, measuredMap({ 1: 120 }));
    expect(metrics.heights).toEqual([ESTIMATED_GROUP_HEIGHT, 120, ESTIMATED_GROUP_HEIGHT]);
    expect(metrics.offsets).toEqual([0, ESTIMATED_GROUP_HEIGHT, ESTIMATED_GROUP_HEIGHT + 120]);
    expect(metrics.total).toBe(ESTIMATED_GROUP_HEIGHT * 2 + 120);
  });

  it("treats an unlaid-out group as the estimate instead of collapsing the spacer", () => {
    const metrics = buildMetrics(2, measuredMap({ 0: 0, 1: -5 }));
    expect(metrics.heights).toEqual([ESTIMATED_GROUP_HEIGHT, ESTIMATED_GROUP_HEIGHT]);
    expect(metrics.total).toBe(ESTIMATED_GROUP_HEIGHT * 2);
  });

  it("handles an empty transcript", () => {
    expect(buildMetrics(0, new Map())).toEqual({ offsets: [], heights: [], total: 0 });
  });
});

describe("visibleWindow", () => {
  const long = () => buildMetrics(500, new Map());

  it("renders a short transcript whole", () => {
    const metrics = buildMetrics(WINDOW_MIN_GROUPS, new Map());
    expect(visibleWindow({ scrollTop: 4000, viewport: 800, metrics })).toEqual({ start: 0, end: WINDOW_MIN_GROUPS });
  });

  it("renders a band around the viewport for a long transcript", () => {
    const metrics = long();
    const window = visibleWindow({ scrollTop: ESTIMATED_GROUP_HEIGHT * 100, viewport: 800, metrics });
    // ~800px viewport covers ~3 groups at the estimate; overscan adds 8 on each side.
    expect(window.end - window.start).toBeLessThan(30);
    expect(window.start).toBeLessThanOrEqual(100);
    expect(window.end).toBeGreaterThan(100);
  });

  it("clamps at both ends", () => {
    const metrics = long();
    expect(visibleWindow({ scrollTop: 0, viewport: 800, metrics }).start).toBe(0);
    const atEnd = visibleWindow({ scrollTop: metrics.total, viewport: 800, metrics });
    expect(atEnd.end).toBe(500);
    expect(atEnd.start).toBeGreaterThan(480);
  });

  it("always renders at least one group", () => {
    const metrics = long();
    for (const scrollTop of [0, 1, metrics.total / 2, metrics.total * 2]) {
      const window = visibleWindow({ scrollTop, viewport: 0, metrics });
      expect(window.end).toBeGreaterThan(window.start);
    }
  });

  it("handles an empty transcript", () => {
    expect(visibleWindow({ scrollTop: 0, viewport: 800, metrics: buildMetrics(0, new Map()) })).toEqual({ start: 0, end: 0 });
  });
});

describe("spacerHeights", () => {
  it("accounts for every group outside the window", () => {
    const metrics = buildMetrics(400, measuredMap({ 5: 900 }));
    const window = visibleWindow({ scrollTop: ESTIMATED_GROUP_HEIGHT * 200, viewport: 800, metrics });
    const { before, after } = spacerHeights(metrics, window);
    let renderedTotal = 0;
    for (let index = window.start; index < window.end; index += 1) renderedTotal += metrics.heights[index]!;
    // Spacers plus rendered groups must reproduce the full document height, or the
    // scrollbar lies about the transcript length.
    expect(before + renderedTotal + after).toBe(metrics.total);
  });

  it("emits no spacers when the whole transcript renders", () => {
    const metrics = buildMetrics(10, new Map());
    expect(spacerHeights(metrics, { start: 0, end: 10 })).toEqual({ before: 0, after: 0 });
  });
});

describe("shiftAbove", () => {
  it("sums only the height changes above the anchor", () => {
    const before = buildMetrics(4, new Map());
    const after = buildMetrics(4, measuredMap({ 1: ESTIMATED_GROUP_HEIGHT + 150, 3: 10 }));
    // Group 1 grew by 150; group 3 is at or below the anchor and must not count.
    expect(shiftAbove(before, after, 3)).toBe(150);
    expect(shiftAbove(before, after, 1)).toBe(0);
  });

  it("is zero when nothing above the anchor moved", () => {
    const metrics = buildMetrics(3, new Map());
    expect(shiftAbove(metrics, metrics, 2)).toBe(0);
  });
});
