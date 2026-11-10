/**
 * Workers-runtime unit test: workers/monitor-cron scheduled handler in real workerd
 * Journey: monitor-cron-runtime-fix  CRF-AC18
 *
 * Uses wrangler's `createTestHarness` (wrangler 4.156;
 * `@cloudflare/vitest-pool-workers` 0.23 peers vitest ^4.1 and cannot be used with vitest 5)
 * to run the REAL `workers/monitor-cron/wrangler.jsonc` in local workerd: wrangler's bundle
 * (the react alias included) under its compatibility date and flags, and workerd's
 * Request/Headers/AbortSignal handling. The harness forwards outbound requests through
 * Node's fetch (wrangler 4.156, cli.js `outboundService`), so the edge egress path and
 * `global_fetch_strictly_public` are not covered; those were checked once on the edge
 * (`wrangler dev --remote`, a throwaway Worker) during the incident diagnosis. This test
 * makes no outbound request: SUPABASE_URL is a non-routable value and SUPABASE_SECRET_KEY a
 * malformed key that the SUPABASE_SECRET_KEY check in env.ts rejects.
 *
 * CRF-AC18: a malformed SUPABASE_SECRET_KEY (a valid-looking key wrapped in literal quote
 * characters, one of the forms the SUPABASE_SECRET_KEY check in env.ts rejects) →
 * `scheduled()` returns `outcome: "exception"` and `getLogs()` holds no "monitor-cron run"
 * line (env validation threw before any subrequest was made).
 *
 * Note: wrangler's `createTestHarness` does not expose the exception text through getLogs()
 * (wrangler 4.156); that the error names SUPABASE_SECRET_KEY for a quoted key is pinned by
 * env.test.ts (CRF-AC16env1) and index.test.ts (CRF-AC16idx1).
 *
 * Run as part of `npm test` (vitest unit project).
 * Harness leaves `workers/monitor-cron/.wrangler/tmp` on disk; nothing else.
 * Generous timeouts: harness start + scheduled() ≈ 1.5 s; test timeout 60 s for slow CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// createTestHarness and TestHarness are named exports from the wrangler package (wrangler 4.156).
import { createTestHarness, type TestHarness } from "wrangler";

/** Worker config relative to the project root (CWD for vitest). */
const WRANGLER_CONFIG = "workers/monitor-cron/wrangler.jsonc";

/**
 * SUPABASE_URL that reaches no server: the `.invalid` TLD (RFC 2606) never resolves, so
 * even a request that got past the env check would fail at DNS. Overrides the
 * wrangler.jsonc value (the production URL).
 */
const NON_ROUTABLE_SUPABASE_URL = "https://example.invalid/";

/**
 * A SUPABASE_SECRET_KEY with literal quote characters around a valid-looking key.
 * The SUPABASE_SECRET_KEY check in env.ts rejects this form; parseMonitorCronEnv throws
 * before any subrequest. Not a real credential.
 */
const MALFORMED_SECRET_KEY = '"sb_secret_fakekeyforunittest1234"';

// Shared across all tests in this file; afterAll closes it.
let harness: TestHarness | undefined;

beforeAll(async () => {
  harness = createTestHarness({
    workers: [
      {
        configPath: WRANGLER_CONFIG,
        // Override only the Supabase URL so no production or external service is reached.
        // The malformed secret key is passed as a secret (overrides .dev.vars if present).
        vars: {
          SUPABASE_URL: NON_ROUTABLE_SUPABASE_URL,
        },
        secrets: {
          SUPABASE_SECRET_KEY: MALFORMED_SECRET_KEY,
          RESEND_API_KEY: "re_unit_test_fake_key",
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe("Workers-runtime unit — CRF-AC18: malformed SUPABASE_SECRET_KEY → scheduled() exception", () => {
  it(
    "CRF-AC18rt1: outcome is \"exception\" (env validation threw before any subrequest)", async () => {
      const worker = harness!.getWorker();
      const result = await worker.scheduled({ cron: "* * * * *" });
      // A malformed key causes env validation to throw; the Worker does not start a run.
      expect(result.outcome).toBe("exception");
    },
    60_000,
  );

  it(
    "CRF-AC18rt2: getLogs() holds no 'monitor-cron run' line (no subrequest was made)", async () => {
      harness!.clearLogs();
      const worker = harness!.getWorker();
      await worker.scheduled({ cron: "* * * * *" });
      const logs = harness!.getLogs();
      const runLine = logs.find((entry) => entry.message.includes("monitor-cron run"));
      // A malformed key causes env validation to throw; no run log line is produced.
      expect(runLine).toBeUndefined();
    },
    60_000,
  );
});
