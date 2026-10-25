/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CacheUsage } from "./CacheUsage";
import type { ModelUsage } from "./features";

const render = (patch: Partial<ModelUsage>) => renderToStaticMarkup(<CacheUsage usage={{ promptTokens: 100, completionTokens: 10, requests: 1, lastUsed: 0, ...patch }} />);

it("renders absent counters as unreported rather than zero cache hits", () => {
  const html = render({});
  expect(html).toContain("Cache read: not reported");
  expect(html).toContain("100");
  expect(html).not.toContain("0 cached input");
});

it("separates known cached, known non-cached, and unknown input", () => {
  const html = render({ cachedReadTokens: 30, cacheReadInputTokens: 70 });
  expect(html).toContain("30 cached input");
  expect(html).toContain("40 non-cached input");
  expect(html).toContain("30 input with cache status unknown");
});

it("shows a reported zero as zero and keeps historical fabricated zeros unknown", () => {
  expect(render({ cachedReadTokens: 0, cacheReadInputTokens: 100 })).toContain("0 cached input");
  expect(render({ cachedReadTokens: 0, cacheReadInputTokens: 100 })).not.toContain("unknown");
  expect(render({ cachedReadTokens: 0 })).toContain("Cache read: not reported");
});

it("does not classify the rest of historical input from a positive cache total alone", () => {
  const html = render({ cachedReadTokens: 40 });
  expect(html).toContain("40 cached input");
  expect(html).toContain("60 input with cache status unknown");
});

it("distinguishes reported zero cache writes from unknown historical zeros", () => {
  expect(render({ cachedWriteTokens: 0 })).not.toContain("cache-write tokens reported");
  expect(render({ cachedWriteTokens: 0, cacheWriteReported: true })).toContain("0 cache-write tokens reported");
});
