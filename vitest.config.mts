/**
 * Vitest is for the React component suites in `webview-ui/` only.
 *
 * The host-side `test/*.test.mjs` files use `node:test` and are run by
 * `npm test`; vitest must never pick them up (it cannot see their suites,
 * and half of them shell out to `vsce` — running them twice from two
 * runners would double the gate for zero signal).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["webview-ui/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    // The suites stub timers and IS_REACT_ACT_ENVIRONMENT per-file; no
    // global setup is needed.
    globals: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
