/**
 * Playwright global setup AND teardown (playwright.config.ts): deletes every
 * `@alnyron-test.local` e2e account before the run (leftovers of an aborted
 * run) and after it. It runs once in the runner, outside the parallel workers,
 * so it never removes a user a running block has seeded. No-op without DB
 * credentials.
 */
import { DB_AVAILABLE, endPool, getClient } from "../integration/rls/helpers/db";
import { sweepE2eTestUsers } from "./fixtures/admin-auth-seed";

export default async function sweepTestUsers(): Promise<void> {
  if (!DB_AVAILABLE) return;
  const client = await getClient();
  try {
    await sweepE2eTestUsers(client);
  } finally {
    client.release();
    await endPool();
  }
}
