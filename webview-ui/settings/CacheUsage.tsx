/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { cacheSplit } from "../../src/cache-usage.ts";
import type { ModelUsage } from "./features";

function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Cached versus non-cached input. The arithmetic lives in
 * `src/cache-usage.ts`: input a provider never gave a cache status for was
 * billed as ordinary input, so it is counted there rather than reported as a
 * third figure the reader has to combine themselves.
 */
export function CacheUsage({ usage }: { usage: ModelUsage }) {
  const { cached, nonCached, reported } = cacheSplit(usage);
  return <span>
    {reported
      ? <>{tokens(cached)} cached input · {tokens(nonCached)} non-cached input</>
      : <>Cache read: not reported for {tokens(nonCached)} input tokens</>}
    {(usage.cacheWriteReported || (usage.cachedWriteTokens ?? 0) > 0) && <> · {tokens(usage.cachedWriteTokens ?? 0)} cache-write tokens reported</>}
  </span>;
}
