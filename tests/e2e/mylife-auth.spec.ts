/**
 * E2E tests — mylife auth (ML-AC1..ML-AC27)
 * Journey: mylife-login
 *
 * Approach: cloud-only (no local Docker / Mailpit).
 *   Login/logout — seed a real password-enabled mylife_user via pg.
 *   Reset — generate_link (type: recovery), confirmUrl on mylife host (no redirectTo
 *     sent to GoTrue — the RedirectTo email-template branch is static-assertion only).
 *   Invite — generate_link (type: invite, role: mylife_user), confirmUrl on the APEX
 *     host with next=/admin/set-password to exercise ML-AC14 roleAwareLanding.
 *   Privilege bleed — seed admin and owner; verify cross-area gates.
 *
 * URL note: signIn redirects to /mylife and the mylife host serves /mylife* as-is,
 * so the browser URL after login is http://mylife.localhost:3000/mylife (not /).
 *
 * Requires dev server at PLAYWRIGHT_BASE_URL (http://localhost:3000) AND the
 * mylife host at http://mylife.localhost:3000 (same process, host-routed).
 * DB_AVAILABLE guards pg-dependent groups; SECRET_KEY_AVAILABLE guards
 * generate_link groups.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  DB_AVAILABLE,
  SECRET_KEY_AVAILABLE,
  E2E_MYLIFE_EMAIL,
  E2E_MYLIFE_RESET_EMAIL,
  E2E_BLEED_ADMIN_EMAIL,
  E2E_OWNER_EMAIL,
  E2E_MYLIFE_INVITE_EMAIL,
  seedE2eMyLifeUser,
  cleanupE2eMyLifeUser,
  seedE2eMyLifeResetUser,
  cleanupE2eMyLifeResetUser,
  seedE2eBleedAdmin,
  cleanupE2eBleedAdmin,
  seedE2eOwner,
  cleanupE2eOwner,
  cleanupE2eMyLifeInviteUser,
  endPool,
  randomE2ePassword,
  generateAuthLink,
} from "./fixtures/mylife-auth-seed";
import { getClient, type PoolClient } from "../integration/rls/helpers/db";
import messages from "../../messages/da.json";

const { Auth, MyLife, SkipLink } = messages;

/** Base URL for the MyLife host (host-routed to /mylife route group). */
const ML = "http://mylife.localhost:3000";

/**
 * Waits until React has hydrated `locator`, so a click or Enter goes through
 * the client router (a soft navigation) instead of a full page load.
 */
async function expectHydrated(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

/** Tags the current document, so a test can tell a soft navigation (same document) from a full load. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as Window & { mlE2eDocument?: true }).mlE2eDocument = true;
  });
}

/**
 * Design review 2026-11-01 (WCAG 2.4.1/2.4.3): after a client-side navigation
 * in the same document, the first Tab from a blurred start must reach the
 * skip link (to `#main`), then `nextStop`, as after a full page load.
 */
async function expectSkipLinkFirstAfterSoftNav(page: Page, nextStop: Locator) {
  expect(
    await page.evaluate(() => (window as Window & { mlE2eDocument?: true }).mlE2eDocument === true),
    "the navigation was client-side (same document)",
  ).toBe(true);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: SkipLink.label });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveAttribute("href", "#main");

  await page.keyboard.press("Tab");
  await expect(nextStop).toBeFocused();
}

test.afterAll(async () => {
  await endPool();
});

// ── ML-AC1: login page renders ────────────────────────────────────────────────

test("ML-AC1j: GET /login (mylife host) renders a labeled email field", async ({ page }) => {
  await page.goto(`${ML}/login`);
  await expect(page.getByRole("textbox", { name: /e-?mail/i })).toBeVisible();
});

test("ML-AC1k: GET /login (mylife host) renders a labeled password field", async ({ page }) => {
  await page.goto(`${ML}/login`);
  const pw = page.getByLabel(Auth.login.password, { exact: true });
  await expect(pw).toBeVisible();
  await expect(pw).toHaveAttribute("type", "password");
});

test("ML-AC1l: GET /login (mylife host) renders a 'Log ind' submit button", async ({ page }) => {
  await page.goto(`${ML}/login`);
  await expect(page.getByRole("button", { name: /log ind/i })).toBeVisible();
});

test("ML-AC1m: GET /login (mylife host) renders a 'Glemt adgangskode?' link pointing to forgot-password", async ({
  page,
}) => {
  await page.goto(`${ML}/login`);
  const resetLink = page.getByRole("link", { name: /glemt adgangskode/i });
  await expect(resetLink).toBeVisible();
  await expect(resetLink).toHaveAttribute("href", "/mylife/forgot-password");
});

test("ML-AC1n: GET /login?error=link_invalid shows a role=alert with the link-invalid DA copy", async ({
  page,
}) => {
  await page.goto(`${ML}/login?error=link_invalid`);
  await expect(
    page.getByRole("alert").filter({ hasText: Auth.login.linkInvalid }),
  ).toBeVisible({ timeout: 6000 });
});

test("ML-AC1ad: after following the reset link with the keyboard, the first Tab on forgot-password reaches the skip link", async ({
  page,
}) => {
  await page.goto(`${ML}/login`);
  const resetLink = page.getByRole("link", { name: /glemt adgangskode/i });
  await expectHydrated(resetLink);
  await markDocument(page);

  await resetLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/mylife\/forgot-password/);
  await expect(page.getByRole("heading", { level: 1, name: Auth.forgotPassword.title })).toBeVisible();

  await expectSkipLinkFirstAfterSoftNav(page, page.getByRole("textbox", { name: /e-?mail/i }));
});

test("ML-AC19: login page has lang=da, <meta name=robots content=noindex>, and x-robots-tag noindex header", async ({
  page,
}) => {
  // Check HTML attributes
  await page.goto(`${ML}/login`);
  await expect(page.locator("html")).toHaveAttribute("lang", "da");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/i);

  // Check x-robots-tag response header on mylife host (browser navigation avoids Node DNS issues)
  const mlResponse = await page.goto(`${ML}/login`);
  expect(mlResponse).not.toBeNull();
  expect(mlResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow");

  // Check x-robots-tag response header via apex host /mylife/login
  const apexResponse = await page.goto("http://localhost:3000/mylife/login");
  expect(apexResponse).not.toBeNull();
  expect(apexResponse?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
});

// ── ML-AC4: wrong credentials → generic error ────────────────────────────────

test("ML-AC4: wrong credentials show a generic Danish error (no enumeration)", async ({
  page,
}) => {
  await page.goto(`${ML}/login`);
  await page.getByRole("textbox", { name: /e-?mail/i }).fill("ghost@alnyron-test.local");
  await page.locator("input[type=password]").fill("wrongpassword123!");
  await page.getByRole("button", { name: /log ind/i }).click();

  const errorEl = page.locator('[data-form-result][role="alert"]');
  await expect(errorEl).toBeVisible({ timeout: 6000 });
  await expect(errorEl).toHaveText(Auth.login.invalidCredentials);
  // Page must NOT navigate away to the panel on failure
  await expect(page).not.toHaveURL(/\/mylife\/?$/);
});

test("ML-AC4g: a failed sign-in moves focus to the error message (a11y)", async ({ page }) => {
  await page.goto(`${ML}/login`);
  await page.getByRole("textbox", { name: /e-?mail/i }).fill("ghost@alnyron-test.local");
  await page.locator("input[type=password]").fill("wrongpassword123!");
  await page.getByRole("button", { name: /log ind/i }).click();

  // Filtered by text to avoid matching Next's empty route-announcer alert.
  await expect(
    page.getByRole("alert").filter({ hasText: Auth.login.invalidCredentials }),
  ).toBeFocused();
});

// ── ML-AC5: unauthenticated protected paths redirect ─────────────────────────

test("ML-AC5b: GET / (mylife host, unauthenticated) → redirected to /mylife/login (no next param)", async ({
  page,
}) => {
  await page.goto(`${ML}/`);
  await expect(page).toHaveURL(/\/mylife\/login/);
  // bare /mylife is rejected by safeNext → no next param in the redirect
  expect(new URL(page.url()).searchParams.get("next")).toBeNull();
});

test("ML-AC5: GET /mylife (apex host, unauthenticated) → /mylife/login (no next param)", async ({
  page,
}) => {
  await page.goto("http://localhost:3000/mylife");
  await expect(page).toHaveURL(/\/mylife\/login/);
  expect(new URL(page.url()).searchParams.get("next")).toBeNull();
});

// ── ML-AC9: /admin on mylife host is not the admin panel ─────────────────────

test("ML-AC9: GET /admin on mylife host (unauthenticated) → redirected to MyLife login with next param", async ({
  page,
}) => {
  // /admin on mylife host is rewritten to /mylife/admin; middleware redirects the
  // unauthenticated request to /mylife/login?next=%2Fmylife%2Fadmin (307), NOT /admin/login
  await page.goto(`${ML}/admin`);
  await expect(page).toHaveURL(`${ML}/mylife/login?next=%2Fmylife%2Fadmin`);
});

// ── ML-AC27: admin login page regression smoke ───────────────────────────────

test("ML-AC27: admin login page is accessible and unaffected (regression smoke)", async ({
  page,
}) => {
  await page.goto("http://localhost:3000/admin/login");
  await expect(page.getByRole("textbox", { name: /e-?mail/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /log ind/i })).toBeVisible();
});

// ── Login + logout flow — ML-AC2, ML-AC3, ML-AC25 (needs DB) ────────────────

test.describe("Login flow — ML-AC2, ML-AC3, ML-AC25 / needs DB", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "SUPABASE_DB_PASSWORD not set — skipping mylife e2e login");

  let pgClient: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    pgClient = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMyLifeUser(pgClient);
    await seedE2eMyLifeUser(pgClient, password);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eMyLifeUser(pgClient);
      pgClient.release();
    }
  });

  test("ML-AC2: valid mylife_user credentials → /mylife landing; auth cookies httpOnly+Lax", async ({
    page,
  }) => {
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();

    // signIn redirects to /mylife; on mylife host the browser URL is ${ML}/mylife
    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });

    const authCookies = (await page.context().cookies()).filter((c) =>
      /^sb-.+-auth-token/.test(c.name),
    );
    expect(authCookies.length).toBeGreaterThan(0);
    for (const cookie of authCookies) {
      expect(cookie, cookie.name).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    }
  });

  test("ML-AC2n: after signing in, the first Tab on the landing reaches the skip link, then 'Log ud'", async ({
    page,
  }) => {
    await page.goto(`${ML}/login`);
    await expectHydrated(page.locator("form"));
    await markDocument(page);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
    const signOut = page.getByRole("button", { name: Auth.signOut, exact: true });
    await expect(signOut).toBeVisible();

    await expectSkipLinkFirstAfterSoftNav(page, signOut);
  });

  test("ML-AC3: logout redirects to /mylife/login", async ({ page }) => {
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();
    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });

    await page.getByRole("button", { name: /log ud/i }).click();
    await expect(page).toHaveURL(/\/mylife\/login/);
  });

  test("ML-AC3c: after logout, / (mylife host) redirects back to /mylife/login", async ({
    page,
  }) => {
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();
    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });

    await page.getByRole("button", { name: /log ud/i }).click();
    await expect(page).toHaveURL(/\/mylife\/login/);

    await page.goto(`${ML}/`);
    await expect(page).toHaveURL(/\/mylife\/login/);
  });

  test("ML-AC25: /login?next=/admin/dashboard → after sign-in stays in /mylife (area guard)", async ({
    page,
  }) => {
    await page.goto(`${ML}/login?next=/admin/dashboard`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();

    // Must land on /mylife (area guard strips cross-area next), not /admin/dashboard
    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/\/admin\/dashboard/);
  });

  test("ML-AC25b: /login?next=https://evil.com → after sign-in lands on /mylife (open-redirect guard)", async ({
    page,
  }) => {
    await page.goto(`${ML}/login?next=https://evil.com`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/evil\.com/);
  });

  test("ML-AC25c: /login?next=/mylife/../admin/x → after sign-in lands on /mylife (path-traversal guard)", async ({
    page,
  }) => {
    await page.goto(`${ML}/login?next=/mylife/../admin/x`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/\/admin/);
  });
});

// ── Privilege bleed — ML-AC6..9 (needs DB) ───────────────────────────────────

test.describe("Privilege bleed — ML-AC6, ML-AC7, ML-AC8, ML-AC9 / needs DB", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "SUPABASE_DB_PASSWORD not set — skipping bleed e2e");

  let pgClient: PoolClient;
  let mylifePassword: string;
  let adminPassword: string;
  let ownerPassword: string;

  test.beforeAll(async () => {
    pgClient = await getClient();
    mylifePassword = randomE2ePassword();
    adminPassword = randomE2ePassword();
    ownerPassword = randomE2ePassword();
    await Promise.all([
      cleanupE2eMyLifeUser(pgClient),
      cleanupE2eBleedAdmin(pgClient),
      cleanupE2eOwner(pgClient),
    ]);
    await seedE2eMyLifeUser(pgClient, mylifePassword);
    await seedE2eBleedAdmin(pgClient, adminPassword);
    await seedE2eOwner(pgClient, ownerPassword);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await Promise.all([
        cleanupE2eMyLifeUser(pgClient),
        cleanupE2eBleedAdmin(pgClient),
        cleanupE2eOwner(pgClient),
      ]);
      pgClient.release();
    }
  });

  test("ML-AC8: mylife_user signing in at apex /admin/login → /admin/no-access", async ({
    page,
  }) => {
    await page.goto("http://localhost:3000/admin/login");
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(mylifePassword);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/admin\/no-access/, { timeout: 8000 });
  });

  test("ML-AC6: plain admin signing in at mylife host /login → /mylife/no-access", async ({
    page,
  }) => {
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_BLEED_ADMIN_EMAIL);
    await page.locator("input[type=password]").fill(adminPassword);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/no-access/, { timeout: 8000 });
    await expect(
      page.getByText(MyLife.noAccess.body.replace("{email}", E2E_BLEED_ADMIN_EMAIL))
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: Auth.signOut, exact: true })
    ).toBeVisible();
  });

  test("ML-AC6f: after signing in, the first Tab on /mylife/no-access reaches the skip link, then 'Log ud'", async ({
    page,
  }) => {
    await page.goto(`${ML}/login`);
    await expectHydrated(page.locator("form"));
    await markDocument(page);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_BLEED_ADMIN_EMAIL);
    await page.locator("input[type=password]").fill(adminPassword);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/no-access/, { timeout: 8000 });
    const signOut = page.getByRole("button", { name: Auth.signOut, exact: true });
    await expect(signOut).toBeVisible();

    await expectSkipLinkFirstAfterSoftNav(page, signOut);
  });

  test("ML-AC7: owner signing in at mylife host → reaches /mylife landing", async ({ page }) => {
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_OWNER_EMAIL);
    await page.locator("input[type=password]").fill(ownerPassword);
    await page.getByRole("button", { name: /log ind/i }).click();

    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/no-access/);
  });

  test("ML-AC9: signed-in mylife_user visiting mylife-host /admin → 404 (not the admin panel)", async ({
    page,
  }) => {
    // Log in as mylife_user on the mylife host
    await page.goto(`${ML}/login`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_MYLIFE_EMAIL);
    await page.locator("input[type=password]").fill(mylifePassword);
    await page.getByRole("button", { name: /log ind/i }).click();
    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });

    // Navigate to /admin on the mylife host — rewritten to /mylife/admin (no route → 404)
    const response = await page.goto(`${ML}/admin`);
    expect(response?.status()).toBe(404);
  });
});

// ── Reset password flow — ML-AC10..13 (needs DB + key) ──────────────────────

test.describe("Reset password flow — ML-AC10..13 / needs DB + SUPABASE_SECRET_KEY", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY not set — skipping mylife reset e2e");

  let pgClient: PoolClient;
  let resetPassword: string;

  test.beforeAll(async () => {
    pgClient = await getClient();
    resetPassword = randomE2ePassword();
    await cleanupE2eMyLifeResetUser(pgClient);
    await seedE2eMyLifeResetUser(pgClient, resetPassword);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eMyLifeResetUser(pgClient);
      pgClient.release();
    }
  });

  test("ML-AC10: forgot-password shows generic confirmation (no enumeration)", async ({
    page,
  }) => {
    await page.goto(`${ML}/forgot-password`);
    await page.getByRole("textbox", { name: /e-?mail/i }).fill("random-ghost@alnyron-test.local");
    await page.getByRole("button", { name: Auth.forgotPassword.submit, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(Auth.forgotPassword.sent, {
      timeout: 6000,
    });
  });

  test("ML-AC11+ML-AC12: recovery link (confirmUrl on mylife host) → /mylife/set-password → /mylife", async ({
    page,
  }) => {
    const newPassword = randomE2ePassword();
    // confirmUrl base is mylife host; no redirectTo is sent to GoTrue.
    const confirmUrl = await generateAuthLink(
      "recovery",
      E2E_MYLIFE_RESET_EMAIL,
      `${ML}/auth/confirm`,
    );

    await page.goto(confirmUrl);
    // mylife-host confirm falls back to /mylife/set-password (no next param; role-aware
    // routing via roleAwareLanding is apex-host only — see ML-AC14)
    await expect(page).toHaveURL(/\/mylife\/set-password/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/\/admin\/set-password/);

    await page.getByLabel(/ny adgangskode|new password/i).fill(newPassword);
    // DA label is "Gentag adgangskode" (messages/da.json Auth.setPassword.confirm)
    await page.getByLabel(/gentag adgangskode/i).fill(newPassword);
    await page.getByRole("button", { name: /gem|opdater|skift/i }).click();

    await expect(page).toHaveURL(/\/mylife\/?$/, { timeout: 8000 });
  });

  test("ML-AC13: invalid token on mylife confirm URL → /mylife/login?error=link_invalid", async ({
    page,
  }) => {
    await page.goto(
      `${ML}/auth/confirm?token_hash=invalid000&type=recovery&next=/mylife/set-password`,
    );
    await expect(page).toHaveURL(/\/mylife\/login.*error=link_invalid/, { timeout: 6000 });
    await expect(page).not.toHaveURL(/\/admin\/login/);
  });
});

// ── Invite flow — ML-AC14 role-aware confirm (needs DB + key) ────────────────

test.describe("Invite flow — ML-AC14 role-aware confirm / needs DB + SUPABASE_SECRET_KEY", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY not set — skipping mylife invite e2e");

  let pgClient: PoolClient;

  test.beforeAll(async () => {
    pgClient = await getClient();
    await cleanupE2eMyLifeInviteUser(pgClient);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eMyLifeInviteUser(pgClient);
      pgClient.release();
    }
  });

  test("ML-AC14: invite with next=/admin/set-password on apex host and mylife_user role → roleAwareLanding lands on /mylife/set-password", async ({
    page,
  }) => {
    // Build confirmUrl on the APEX host so /auth/confirm calls roleAwareLanding.
    // On the mylife host, confirm does NOT call roleAwareLanding; it only uses safeNext
    // (which rejects cross-area /admin/… paths) and falls back to /mylife/set-password —
    // that would pass for the wrong reason.
    // generateAuthLink seeds the allowlist with role='mylife_user' but sends no redirectTo
    // to GoTrue — the email-template RedirectTo branch is covered by static assertions only.
    const confirmUrl = await generateAuthLink(
      "invite",
      E2E_MYLIFE_INVITE_EMAIL,
      "http://localhost:3000/auth/confirm?next=/admin/set-password",
      "mylife_user",
    );

    await page.goto(confirmUrl);
    // ML-AC14: apex roleAwareLanding sees mylife_user + /admin/set-password → /mylife/set-password
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/mylife\/set-password/, { timeout: 8000 });
    await expect(page).not.toHaveURL(/\/admin\/set-password/);
  });
});
