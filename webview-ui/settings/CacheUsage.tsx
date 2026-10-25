/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import type { ModelUsage } from "./features";

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** Never derive a cache miss from an absent provider counter. */
export function CacheUsage({ usage }: { usage: ModelUsage }) {
  const cached = Math.min(usage.promptTokens, Math.max(0, usage.cachedReadTokens ?? 0));
  // Historical positive cache totals are evidence of those reads, but older
  // records have no coverage denominator. Their remaining input stays unknown.
  const known = Math.min(usage.promptTokens, Math.max(cached, usage.cacheReadInputTokens ?? 0));
  const noncached = Math.max(0, known - cached);
  const unknown = Math.max(0, usage.promptTokens - known);
  const reported = usage.cacheReadInputTokens !== undefined || cached > 0;
  return <span>
    {reported
      ? <>{tokens(cached)} cached input · {tokens(noncached)} non-cached input{unknown > 0 && <> · {tokens(unknown)} input with cache status unknown</>}</>
      : <>Cache read: not reported{unknown > 0 && <> for {tokens(unknown)} input tokens</>}</>}
    {(usage.cacheWriteReported || (usage.cachedWriteTokens ?? 0) > 0) && <> · {tokens(usage.cachedWriteTokens ?? 0)} cache-write tokens reported</>}
  </span>;
}
