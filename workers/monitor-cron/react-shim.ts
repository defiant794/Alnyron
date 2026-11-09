/**
 * Stand-in for `react` in the cron Worker bundle only (the `alias` in
 * wrangler.jsonc; Next.js and vitest keep the real package). `use-intl/core`,
 * which formats the Danish email copy, imports these two for rich-text
 * messages: it calls them only on what a function-valued (rich-text) argument
 * returns (`isValidElement`, then `cloneElement` for an element). The engine's
 * emails pass only string and number arguments, so neither is ever called; if
 * one were, "not an element" is the safe answer and the clone path refuses.
 * This keeps React out of a Worker that renders nothing. Pinned by
 * tests/unit/workers/monitor-cron/react-shim.test.ts.
 */

export function isValidElement(): boolean {
  return false;
}

export function cloneElement(): never {
  throw new Error("React elements are not supported in the monitor cron Worker");
}
