/**
 * Makes the app show a DB fixture change (tests/e2e/fixtures/db-state.ts).
 *
 * A production build (`next start`) serves the public pages from the ISR
 * cache, refreshed within ~5 minutes, so a fixture row only shows once the
 * cache is revalidated. The test-only `POST /api/test/revalidate`
 * (src/app/api/test/revalidate/route.ts) does that at once,
 * guarded by E2E_REVALIDATE_SECRET: set the same value in the shell
 * environment of both the server (`npm run start`) and the test run. It is
 * kept out of tests/.env.e2e on purpose: the dev server never has it.
 * Without the secret the call is skipped: the dev server renders every
 * request from the DB, so it needs no revalidation.
 *
 * The secret only goes to this machine: the call is also skipped when the
 * target (PLAYWRIGHT_BASE_URL, default http://localhost:3000) is not a
 * loopback host, and a redirect fails the call rather than forward the
 * header elsewhere.
 */
import { test } from "@playwright/test";

/** Hostnames, as `URL#hostname` spells them, that the secret may be sent to. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Revalidates every public page after a fixture change; call it after each DB write. */
export async function revalidateSite(): Promise<void> {
  const secret = process.env.E2E_REVALIDATE_SECRET;
  if (!secret) return;

  const url = new URL("/api/test/revalidate", test.info().project.use.baseURL);
  if (!LOOPBACK_HOSTS.has(url.hostname)) return;

  const response = await fetch(url, {
    method: "POST",
    headers: { "x-revalidate-secret": secret },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `POST ${url.pathname} answered ${response.status}: start the server with the same E2E_REVALIDATE_SECRET as the test run`,
    );
  }
}
