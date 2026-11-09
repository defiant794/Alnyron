/**
 * Guard that the current environment targets a known non-production Supabase project.
 * Prevents integration tests that call the live GoTrue API or postgres from accidentally
 * running against production.
 *
 * assertE2eTarget() throws unless:
 *   1. SUPABASE_E2E_REF is set (and non-empty)
 *   2. it is NOT the production project ref (xmgpixhxecamtryohgmk)
 *   3. NEXT_PUBLIC_SUPABASE_URL hostname === `${SUPABASE_E2E_REF}.supabase.co`
 *
 * Call it in the beforeAll of every test file that calls createClient() (supabase-js),
 * before the first createClient() call, so a misconfigured environment can never target
 * the wrong project.
 *
 * Accepts an optional `env` parameter (defaults to process.env) so unit tests can supply
 * synthetic env objects without reading or setting real environment variables.
 */

const PROD_REF = "xmgpixhxecamtryohgmk";

/**
 * Throws if the current environment does not point at a known non-production e2e project.
 * Pass a synthetic `env` in unit tests; production callers rely on the default (process.env).
 */
export function assertE2eTarget(
  env: Readonly<NodeJS.Dict<string>> = process.env,
): void {
  const ref = env.SUPABASE_E2E_REF;
  if (!ref) {
    throw new Error(
      "assertE2eTarget: SUPABASE_E2E_REF is not set — refusing to run against an unknown target",
    );
  }
  if (ref === PROD_REF) {
    throw new Error(
      `assertE2eTarget: SUPABASE_E2E_REF matches the production project — refusing to run`,
    );
  }
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!URL.canParse(rawUrl)) {
    throw new Error(
      `assertE2eTarget: NEXT_PUBLIC_SUPABASE_URL is not a parsable URL — refusing to run`,
    );
  }
  const parsed = new URL(rawUrl);
  const expected = `${ref}.supabase.co`;
  if (parsed.hostname !== expected) {
    throw new Error(
      `assertE2eTarget: NEXT_PUBLIC_SUPABASE_URL hostname does not match SUPABASE_E2E_REF — refusing to run`,
    );
  }
}
