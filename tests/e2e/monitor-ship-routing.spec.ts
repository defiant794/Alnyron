/**
 * E2E tests — Monitor subdomain routing (Slice C, Run A)
 * Journey: monitor-ship-routing  SHIP-AC1a..SHIP-AC8e
 *
 * Covers:
 *   SHIP-AC1a..SHIP-AC1g — Monitor host rewrites (/, /login, /dashboard); /admin and /mylife there:
 *                          307 to the Monitor login without a session, 404 with one
 *   SHIP-AC2a..SHIP-AC2c — Main-host /monitor* → 308 to the subdomain, query kept, Cache-Control
 *   SHIP-AC3b..SHIP-AC3c — X-Robots-Tag on the Monitor host
 *   SHIP-AC4a/AC4c/AC4h  — A main-host signup link is forwarded (exact no-store 307) before the
 *                          token is spent, then verifies on the Monitor host; session cookie there only
 *   SHIP-AC5e            — The recovery template's Monitor link → /monitor/reset → new password → dashboard
 *   SHIP-AC6d..SHIP-AC6f — Allowlisted addresses refused by the hook (UI + direct API); non-vacuity probe
 *   SHIP-AC6g            — Onboarding gap, send-interval window only: a signup within the invite's
 *                          send interval is refused (429) and sets no password
 *   SHIP-AC8c..SHIP-AC8e — Absolute main-site links (exact hrefs that answer 200)
 *
 * Email links are never read from an inbox: the e2e project's mailer cannot deliver to the e2e
 * domain and its redirect allow-list is empty, so the links are built from admin generate_link
 * tokens on the URL the email template would use.
 *
 * Responses on the Monitor host are read through the browser (`firstResponse`): Node cannot
 * resolve `monitor.localhost` on every OS, so the API request context only calls the main host
 * and Supabase.
 *
 * Requires the app at http://localhost:3000 AND http://monitor.localhost:3000.
 * Every group that seeds or reads the DB, or calls Supabase with the secret key, skips at
 * describe level unless SUPABASE_E2E_REF names the isolated e2e project (tests/.env.e2e-project):
 * without it the fixtures target production. SECRET_KEY_AVAILABLE also guards the generate_link
 * groups (the secret key is optional in the e2e profile). The routing/header groups touch no DB.
 */
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  SECRET_KEY_AVAILABLE,
  E2E_EMAIL_DOMAIN,
  E2E_MONITOR_SHIP_EMAIL,
  seedE2eMonitorShipUser,
  cleanupE2eMonitorShipUser,
  endPool,
  randomE2ePassword,
  generateAuthLink,
} from "./fixtures/monitor-seed";
import { firstResponse } from "./fixtures/first-response";
import { getClient, type PoolClient } from "../integration/rls/helpers/db";
import messages from "../../messages/da.json";

const { Auth, Monitor, Nav } = messages;

const MAIN = "http://localhost:3000";
const MONITOR = "http://monitor.localhost:3000";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

/** The before-user-created hook's refusal (migration 20261106000400). */
const HOOK_REFUSAL = "Kontoen kan ikke oprettes.";
const SIGNUP_OFF = "signup not enabled on e2e project";
const NEEDS_SECRET_KEY = "Requires DB credentials and SUPABASE_SECRET_KEY";

/** The isolated e2e Supabase project (as in catalog-admin.spec.ts); any other target is production. */
const E2E_PROJECT_REF = "giokcppmmzrrknmllfjc";
const NEEDS_E2E_PROJECT =
  "monitor-ship-routing DB/auth E2E requires tests/.env.e2e-project; without it fixtures target production";

test.afterAll(async () => {
  await endPool();
});

// ── Shared helpers ────────────────────────────────────────────────────────────

/** An e2e-domain address no account or allowlist row holds yet (the global sweep removes leftovers). */
function freshE2eEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@${E2E_EMAIL_DOMAIN}`;
}

/** `auth.users` rows with this address, created at any time. */
async function countAuthUsers(client: PoolClient, email: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0]!.n;
}

/**
 * Runs `check` with a fresh address that has an allowlist row (mylife_user) and no account —
 * the squattable state the hook must refuse — then removes the row and any account.
 */
async function withAllowlistedAddress(check: (email: string, client: PoolClient) => Promise<void>): Promise<void> {
  const email = freshE2eEmail("e2e-ship-allowlisted");
  const client = await getClient();
  try {
    await client.query(`INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'mylife_user')`, [email]);
    expect(await countAuthUsers(client, email)).toBe(0);
    await check(email, client);
  } finally {
    await client.query(`DELETE FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [email]);
    client.release();
  }
}

/** Public signup straight to GoTrue with the publishable key (the path that skips the app). */
async function directSignup(request: APIRequestContext, email: string, password: string) {
  return request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    data: { email, password },
  });
}

/**
 * Whether the e2e project accepts public signups (`GET /auth/v1/settings`). Anything but a
 * 200 with a boolean `disable_signup` fails the calling hook.
 */
async function signupSwitchedOn(): Promise<boolean> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: PUBLISHABLE_KEY } });
  expect(response.status, "GET /auth/v1/settings").toBe(200);
  const settings = (await response.json()) as { disable_signup?: unknown };
  expect(typeof settings.disable_signup, "settings.disable_signup").toBe("boolean");
  return settings.disable_signup === false;
}

/** Names of the Supabase session cookies the browser sends to `url`. */
async function sessionCookieNames(context: BrowserContext, url: string): Promise<string[]> {
  return (await context.cookies(url)).filter((cookie) => cookie.name.startsWith("sb-")).map((cookie) => cookie.name);
}

/** Waits until React has hydrated `locator`, so its handlers receive the events sent to it. */
async function expectHydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

/** Signs in on the Monitor host's /login and waits for the dashboard. */
async function signInToDashboard(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${MONITOR}/login`);
  await page.getByLabel(Auth.login.email).fill(email);
  await page.getByLabel(Auth.login.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: Auth.login.submit, exact: true }).click();
  await expect(page).toHaveURL(`${MONITOR}/monitor/dashboard`);
}

// ── SHIP-AC2a: Main host /monitor → 308 to monitor subdomain ─────────────────

test.describe("SHIP-AC2a: main host /monitor → 308 to Monitor subdomain", () => {
  test("SHIP-AC2a-e1: GET localhost:3000/monitor → 308 (no redirect followed)", async ({ request }) => {
    const response = await request.get(`${MAIN}/monitor`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
  });

  test("SHIP-AC2a-e2: 308 Location is http://monitor.localhost:3000/", async ({ request }) => {
    const response = await request.get(`${MAIN}/monitor`, { maxRedirects: 0 });
    expect(response.headers()["location"]).toBe(`${MONITOR}/`);
  });

  test("SHIP-AC2a-e3: GET localhost:3000/monitor/login → 308 to monitor subdomain", async ({ request }) => {
    const response = await request.get(`${MAIN}/monitor/login`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers()["location"]).toBe(`${MONITOR}/monitor/login`);
  });
});

// ── SHIP-AC2b: 308 preserves query string ─────────────────────────────────────

test.describe("SHIP-AC2b: 308 preserves query string", () => {
  test("SHIP-AC2b-e1: /monitor/login?next=%2Fmonitor%2Fdashboard → 308 to the same path and query on the Monitor host", async ({
    request,
  }) => {
    const response = await request.get(`${MAIN}/monitor/login?next=%2Fmonitor%2Fdashboard`, { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers()["location"]).toBe(`${MONITOR}/monitor/login?next=%2Fmonitor%2Fdashboard`);
  });
});

// ── SHIP-AC2c: 308 Cache-Control ─────────────────────────────────────────────

test.describe("SHIP-AC2c: 308 response has Cache-Control: public, max-age=86400", () => {
  test("SHIP-AC2c-e1: Cache-Control header on 308", async ({ request }) => {
    const response = await request.get(`${MAIN}/monitor`, { maxRedirects: 0 });
    expect(response.headers()["cache-control"]).toBe("public, max-age=86400");
  });
});

// ── SHIP-AC1a: Monitor host / serves Monitor landing ─────────────────────────

test.describe("SHIP-AC1a: monitor.localhost:3000/ serves the Monitor landing page", () => {
  test("SHIP-AC1a-e1: / responds 200 without a redirect", async ({ page }) => {
    const response = await firstResponse(page, `${MONITOR}/`);
    expect(response.status()).toBe(200);
    expect(response.url()).toBe(`${MONITOR}/`);
  });

  test("SHIP-AC1a-e2: the landing heading and the header's signup CTA are visible", async ({ page }) => {
    await page.goto(`${MONITOR}/`);
    await expect(page).toHaveURL(`${MONITOR}/`);
    await expect(page.getByRole("heading", { level: 1, name: Monitor.landing.title, exact: true })).toBeVisible();
    const cta = page.getByRole("banner").getByRole("link", { name: Monitor.landing.ctaSignup, exact: true });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/monitor/signup");
  });
});

// ── SHIP-AC1b: Monitor host /login serves login form ─────────────────────────

test.describe("SHIP-AC1b: monitor.localhost:3000/login serves /monitor/login", () => {
  test("SHIP-AC1b-e1: /login responds 200 and shows the login form at the same URL", async ({ page }) => {
    const response = await page.goto(`${MONITOR}/login`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(`${MONITOR}/login`);
    await expect(page.getByLabel(Auth.login.email)).toBeVisible();
    await expect(page.getByLabel(Auth.login.password, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: Auth.login.submit, exact: true })).toBeVisible();
  });
});

// ── SHIP-AC1c: Monitor host /dashboard (unauthed) → 307 to login ─────────────

test.describe("SHIP-AC1c: monitor.localhost:3000/dashboard (unauthed) → redirect to login", () => {
  test("SHIP-AC1c-e1: /dashboard without a session → 307 to /monitor/login?next=%2Fmonitor%2Fdashboard", async ({
    page,
  }) => {
    const response = await firstResponse(page, `${MONITOR}/dashboard`);
    expect(response.status()).toBe(307);
    // Next sends a same-origin middleware redirect as a path, so the browser stays on the Monitor host.
    expect(await response.headerValue("location")).toBe("/monitor/login?next=%2Fmonitor%2Fdashboard");
    await expect(page).toHaveURL(`${MONITOR}/monitor/login?next=%2Fmonitor%2Fdashboard`);
  });
});

// ── SHIP-AC3b/AC3c: X-Robots-Tag on Monitor host ─────────────────────────────

test.describe("SHIP-AC3b/AC3c: X-Robots-Tag on Monitor host", () => {
  test("SHIP-AC3b-e1: monitor.localhost / response has X-Robots-Tag", async ({ page }) => {
    const response = await firstResponse(page, `${MONITOR}/`);
    // The header is set by the host-matched next.config.mjs rule.
    expect(await response.headerValue("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("SHIP-AC3c-e1: monitor.localhost /login has X-Robots-Tag", async ({ page }) => {
    const response = await firstResponse(page, `${MONITOR}/login`);
    expect(await response.headerValue("x-robots-tag")).toBe("noindex, nofollow");
  });
});

// ── SHIP-AC8c/AC8d/AC8e: Absolute main-site links ────────────────────────────

test.describe("SHIP-AC8: absolute main-site links on the Monitor host", () => {
  test("SHIP-AC8d-e1: the landing lockup links exactly the main site's origin, which answers 200", async ({
    page,
    request,
  }) => {
    await page.goto(`${MONITOR}/`);
    const lockup = page.getByRole("banner").getByRole("link", { name: "Alnyron", exact: true });
    await expect(lockup).toHaveAttribute("href", MAIN);
    expect((await request.get(MAIN)).status()).toBe(200);
  });

  test("SHIP-AC8e-e1: the signup page's privacy link is the main site's /privacy, which answers 200", async ({
    page,
    request,
  }) => {
    await page.goto(`${MONITOR}/signup`);
    const privacy = page.getByRole("main").getByRole("link", { name: Monitor.signup.privacyLinkText, exact: true });
    await expect(privacy).toHaveAttribute("href", `${MAIN}/privacy`);
    expect((await request.get(`${MAIN}/privacy`)).status()).toBe(200);
  });

  test("SHIP-AC8c-e1: the landing footer's privacy link is the main site's /privacy, which answers 200", async ({
    page,
    request,
  }) => {
    await page.goto(`${MONITOR}/`);
    const privacy = page.getByRole("contentinfo").getByRole("link", { name: Nav.privacy, exact: true });
    await expect(privacy).toHaveAttribute("href", `${MAIN}/privacy`);
    expect((await request.get(`${MAIN}/privacy`)).status()).toBe(200);
  });
});

// ── SHIP-AC6d/AC6e/AC6f + SHIP-AC6g: signup gate ───────────────────────────────
// Each worker that runs this block probes the project first (no flag outlives the block):
// the tests skip with SIGNUP_OFF only when GoTrue reports disable_signup=true; any other
// probe answer fails the block.

test.describe("SHIP-AC6/SHIP-AC6g: public signup refuses allowlisted addresses (UI + direct API)", () => {
  // Describe-level skip: no hook or test of the group runs, so no fixture call reaches production.
  test.skip(process.env.SUPABASE_E2E_REF !== E2E_PROJECT_REF, NEEDS_E2E_PROJECT);
  test.skip(!SECRET_KEY_AVAILABLE, NEEDS_SECRET_KEY);

  let signupOn = false;

  test.beforeAll(async () => {
    signupOn = await signupSwitchedOn();
  });

  test.beforeEach(() => {
    test.skip(!signupOn, SIGNUP_OFF);
  });

  test("SHIP-AC6f-e1: non-vacuity — a non-allowlisted address passes the hook and becomes a monitor_user", async () => {
    // generate_link(type=signup) creates the user through the same before-user-created hook and
    // handle_new_user trigger as a public signup, without sending an email.
    const email = freshE2eEmail("e2e-ship-probe");
    const client = await getClient();
    try {
      await generateAuthLink("signup", email, `${MONITOR}/auth/confirm`, "admin", randomE2ePassword());
      const { rows } = await client.query<{ role: string }>(
        `SELECT p.role::text AS role FROM auth.users u JOIN public.profiles p ON p.user_id = u.id
          WHERE lower(u.email) = lower($1)`,
        [email],
      );
      expect(rows).toEqual([{ role: "monitor_user" }]);
    } finally {
      await client.query(`DELETE FROM auth.users WHERE lower(email) = lower($1)`, [email]);
      client.release();
    }
  });

  test("SHIP-AC6e-e1: direct POST /auth/v1/signup with an allowlisted address → 403 hook refusal, no account", async ({
    request,
  }) => {
    await withAllowlistedAddress(async (email, client) => {
      const response = await directSignup(request, email, randomE2ePassword());
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ msg: HOOK_REFUSAL });
      expect(await countAuthUsers(client, email)).toBe(0);
    });
  });

  test("SHIP-AC6d-e1: UI signup on the Monitor host with an allowlisted address → generic confirmation, no account", async ({
    page,
  }) => {
    await withAllowlistedAddress(async (email, client) => {
      await page.goto(`${MONITOR}/signup`);
      const main = page.getByRole("main");
      const emailField = main.getByLabel(Monitor.signup.email);
      await expectHydrated(emailField);
      await emailField.fill(email);
      await main.getByLabel(Monitor.signup.password, { exact: true }).fill(randomE2ePassword());
      await main.getByRole("button", { name: Monitor.signup.submit, exact: true }).click();

      await expect(main.getByRole("heading", { name: Monitor.signup.confirmationTitle, exact: true })).toBeVisible();
      await expect(main.getByText(Monitor.signup.confirmationBody.replace("{email}", email))).toBeVisible();
      expect(await countAuthUsers(client, email)).toBe(0);
    });
  });

  // Between admin.createUser and the invite confirmation the account is unconfirmed and the
  // stranger does not know its password. SCOPE: this covers only a signup within a minute of the
  // invite, which GoTrue's per-address send interval answers with 429 before its existing-user
  // path updates or skips anything; the result (password not set, unconfirmed, allowlisted role
  // kept) holds trivially there. A stranger who waits out the interval is NOT verified here: on
  // the e2e project that path ends in the built-in mailer, which cannot deliver to the e2e domain
  // (and rate_limit_email_sent=2 an hour), so it cannot be exercised. Do not read this test as
  // proof of the onboarding-gap claim in docs/runbooks/area-user-onboarding.md. On a GoTrue upgrade
  // (2.198 release candidates reportedly change this path), re-verify: the 429 may become the hook's 403
  // (docs/runbooks/monitor-go-live.md step 7).
  test("SHIP-AC6g-e1: a signup within the invite's send interval is refused (429) and sets no password", async ({
    request,
  }) => {
    const email = freshE2eEmail("e2e-ship-onboard-gap");
    const attackerPassword = randomE2ePassword();
    const client = await getClient();
    try {
      // Onboarding runbook: allowlist row (mylife_user) + admin.createUser (no hook) + invite link.
      await generateAuthLink("invite", email, `${MAIN}/auth/confirm?next=/mylife/set-password`, "mylife_user");

      const signup = await directSignup(request, email, attackerPassword);
      expect(signup.status()).toBe(429);
      expect(await signup.json()).toMatchObject({ error_code: "over_email_send_rate_limit" });

      const signIn = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
        data: { email, password: attackerPassword },
      });
      expect(signIn.status()).toBe(400);
      expect(await signIn.json()).toMatchObject({ error_code: "invalid_credentials" });

      const { rows } = await client.query<{ role: string; confirmed: boolean }>(
        `SELECT p.role::text AS role, u.email_confirmed_at IS NOT NULL AS confirmed
           FROM auth.users u JOIN public.profiles p ON p.user_id = u.id
          WHERE lower(u.email) = lower($1)`,
        [email],
      );
      expect(rows).toEqual([{ role: "mylife_user", confirmed: false }]);
    } finally {
      await client.query(`DELETE FROM auth.users WHERE lower(email) = lower($1)`, [email]);
      await client.query(`DELETE FROM public.user_allowlist WHERE email = $1`, [email]);
      client.release();
    }
  });
});

// ── SHIP-AC4a/AC4c/AC4h: main-host confirm link forwarded before verification ─

test.describe("SHIP-AC4: a main-host signup confirmation link is forwarded to the Monitor host", () => {
  test.skip(process.env.SUPABASE_E2E_REF !== E2E_PROJECT_REF, NEEDS_E2E_PROJECT);
  test.skip(!SECRET_KEY_AVAILABLE, NEEDS_SECRET_KEY);

  test("SHIP-AC4a-e1/AC4c-e1/AC4h-e1: exact no-store 307 to the Monitor host, the token still verifies there, the session cookie is on monitor.localhost only", async ({
    page,
    context,
    request,
  }) => {
    const email = freshE2eEmail("e2e-ship-signup");
    const client = await getClient();
    try {
      // The confirmation template's Site URL link: <Site URL>/auth/confirm?...&type=signup&next=/monitor/dashboard.
      const link = await generateAuthLink(
        "signup",
        email,
        `${MAIN}/auth/confirm?next=/monitor/dashboard`,
        "admin",
        randomE2ePassword(),
      );

      const forward = await request.get(link, { maxRedirects: 0 });
      expect(forward.status()).toBe(307);
      expect(forward.headers()["location"]).toBe(`${MONITOR}/auth/confirm${new URL(link).search}`);
      expect(forward.headers()["cache-control"]).toBe("private, no-store");

      // The forward spent nothing: the same email link, followed by the browser, verifies on the Monitor host.
      await page.goto(link);
      await expect(page).toHaveURL(`${MONITOR}/monitor/dashboard`);
      await expect(page.getByRole("heading", { level: 1, name: Monitor.dashboard.title, exact: true })).toBeVisible();

      expect(await sessionCookieNames(context, MONITOR)).not.toEqual([]);
      expect(await sessionCookieNames(context, MAIN)).toEqual([]);
      const sessionDomains = (await context.cookies())
        .filter((cookie) => cookie.name.startsWith("sb-"))
        .map((cookie) => cookie.domain);
      expect(new Set(sessionDomains)).toEqual(new Set(["monitor.localhost"]));
    } finally {
      await client.query(`DELETE FROM auth.users WHERE lower(email) = lower($1)`, [email]);
      client.release();
    }
  });
});

// ── SHIP-AC1f/AC1g + SHIP-AC5e: a monitor_user on the Monitor host ───────────

test.describe("SHIP-AC1f/AC1g/AC5e: a monitor_user on the Monitor host", () => {
  // The ref check implies DB credentials (the e2e profile requires them), so no DB_AVAILABLE skip.
  test.skip(process.env.SUPABASE_E2E_REF !== E2E_PROJECT_REF, NEEDS_E2E_PROJECT);

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
  });

  // Every test starts from a freshly seeded account with a known password.
  test.beforeEach(async () => {
    password = randomE2ePassword();
    await cleanupE2eMonitorShipUser(client);
    await seedE2eMonitorShipUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupE2eMonitorShipUser(client);
    client.release();
  });

  const NOT_SERVED = ["/admin", "/admin/login", "/mylife", "/mylife/login"] as const;

  test("SHIP-AC1f-e1/AC1g-e1: /admin and /mylife are 307 to the Monitor login without a session and 404 with one", async ({
    page,
  }) => {
    for (const path of NOT_SERVED) {
      const anonymous = await firstResponse(page, `${MONITOR}${path}`);
      expect(anonymous.status(), path).toBe(307);
      expect(await anonymous.headerValue("location"), path).toBe(
        `/monitor/login?${new URLSearchParams({ next: `/monitor${path}` })}`,
      );
      await expect(page).toHaveURL(`${MONITOR}/monitor/login?${new URLSearchParams({ next: `/monitor${path}` })}`);
    }

    await signInToDashboard(page, E2E_MONITOR_SHIP_EMAIL, password);
    for (const path of NOT_SERVED) {
      const signedIn = await firstResponse(page, `${MONITOR}${path}`);
      expect(signedIn.status(), path).toBe(404);
      await expect(page).toHaveURL(`${MONITOR}${path}`);
    }
  });

  test("SHIP-AC5e-e1: the recovery template's Monitor link → /monitor/reset → new password → /monitor/dashboard", async ({
    page,
    context,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "Requires SUPABASE_SECRET_KEY");
    // The Monitor branch's link: {{ .RedirectTo }}/auth/confirm?token_hash=...&type=recovery&next=/monitor/reset
    // with RedirectTo = http://monitor.localhost:3000.
    const link = await generateAuthLink("recovery", E2E_MONITOR_SHIP_EMAIL, `${MONITOR}/auth/confirm?next=/monitor/reset`);
    await page.goto(link);
    await expect(page).toHaveURL(`${MONITOR}/monitor/reset`);
    expect(await sessionCookieNames(context, MONITOR)).not.toEqual([]);
    expect(await sessionCookieNames(context, MAIN)).toEqual([]);

    const newPassword = randomE2ePassword();
    await page.getByLabel(Auth.setPassword.password, { exact: true }).fill(newPassword);
    await page.getByLabel(Auth.setPassword.confirm, { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: Auth.setPassword.submit, exact: true }).click();
    await expect(page).toHaveURL(`${MONITOR}/monitor/dashboard`);

    // The new password is the account's password now.
    await context.clearCookies();
    await signInToDashboard(page, E2E_MONITOR_SHIP_EMAIL, newPassword);
  });
});
