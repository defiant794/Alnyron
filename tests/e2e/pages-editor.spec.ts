/**
 * E2E tests — admin pages editor + public page wiring (F1.2)
 * Journey: pages-editor  E2E scenarios
 *
 * Coverage:
 *  - Admin area: Sider list, Rediger editor, save, nav toggle, reorder affordance
 *  - Public: /kontakt reads DB, /privatliv renders sanitized markdown
 *
 * Auth: uses a DEDICATED pages-editor test user (E2E_PAGES_ADMIN_UUID/EMAIL)
 * so this block never races admin-auth.spec.ts which seeds E2E_ADMIN_UUID.
 *
 * Data safety: beforeAll snapshots all system-page rows and their translations;
 * afterAll restores them and calls revalidateSite() so no editor test
 * permanently mutates the live site.
 *
 * DB_AVAILABLE guards every test that touches the admin editor or needs auth.
 * Tests that only check already-published public content (E11, E12, E13) run
 * without DB credentials.
 *
 * Requires: dev server at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 */

import { test, expect, type Page } from "@playwright/test";
import type { PoolClient } from "../integration/rls/helpers/db";
import {
  DB_AVAILABLE,
  E2E_PAGES_ADMIN_EMAIL,
  randomE2ePassword,
  seedE2ePagesAdmin,
  cleanupE2ePagesAdmin,
  snapshotSystemPages,
  restoreSystemPages,
  getClient,
  endPool,
  type SystemPagesSnapshot,
} from "./fixtures/pages-editor-seed";
import { revalidateSite } from "./fixtures/revalidate";

// ── Pool lifecycle ────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginPagesAdmin(page: Page, password: string, path = "/admin"): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_PAGES_ADMIN_EMAIL);
  await page.getByLabel(/adgangskode|password/i).fill(password);
  await page.getByRole("button", { name: /log ind|sign in/i }).click();
  await expect(page).toHaveURL((u) => u.pathname.startsWith("/admin") && !/^\/admin\/(login|no-access)/.test(u.pathname));
  if (path !== "/admin") await page.goto(path);
}

// ── Public pages — no auth or DB needed ──────────────────────────────────────

test("AC-PAGES-E11: GET /kontakt shows the seeded DA title (DB-backed, not placeholder)", async ({
  page,
}) => {
  await page.goto("/kontakt");
  // The seeded DA title (20261101000300_seed_system_content.sql:34) is
  // "Lad os tale om dit projekt".  The current placeholder only renders the
  // nav label "Kontakt" in an h1.  Asserting the seeded text proves the page
  // reads from page_translations rather than the i18n message file.
  await expect(page.locator("h1")).toContainText("Lad os tale om dit projekt");
});

test("AC-PAGES-E11b: GET /en/contact shows the DA fallback title (EN row is blank in seed)", async ({
  page,
}) => {
  await page.goto("/en/contact");
  // EN row is seeded with title="" so the page must fall back to the DA title.
  await expect(page.locator("h1")).toContainText("Lad os tale om dit projekt");
});


test("AC-PAGES-E12: GET /privatliv renders the privacy page (route exists, not 404)", async ({
  page,
}) => {
  const response = await page.goto("/privatliv");
  expect(response?.status()).not.toBe(404);
  await expect(page.locator("h1")).toBeVisible();
});

test("AC-PAGES-E12b: GET /en/privacy renders the privacy page (EN route)", async ({ page }) => {
  const response = await page.goto("/en/privacy");
  expect(response?.status()).not.toBe(404);
});

test("AC-PAGES-E13: /privatliv does not output raw markdown syntax — body_md is converted to HTML", async ({
  page,
}) => {
  await page.goto("/privatliv");
  const body = await page.content();
  // Raw ATX headings and emphasis syntax must not appear — they must be rendered to HTML.
  expect(body).not.toMatch(/^##\s/m);
  expect(body).not.toMatch(/\*\*[^*]+\*\*/);
});

// ── Admin editor block — needs DB + seeded admin user ─────────────────────────

test.describe("Pages editor — needs DB", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "SUPABASE_DB_PASSWORD not set — skipping pages editor e2e");

  let pgClient: PoolClient;
  let password: string;
  let snapshot: SystemPagesSnapshot;

  test.beforeAll(async () => {
    pgClient = await getClient();
    password = randomE2ePassword();

    // Snapshot current system-page state BEFORE any editor test mutates the DB.
    snapshot = await snapshotSystemPages(pgClient);

    // Seed the dedicated pages-editor test user (distinct UUID from admin-auth).
    await cleanupE2ePagesAdmin(pgClient); // sweep any leftover from an aborted run
    await seedE2ePagesAdmin(pgClient, password);
  });

  test.afterAll(async () => {
    if (pgClient) {
      // restoreSystemPages writes back all page/translation rows and calls
      // revalidateSite() internally; we also call it explicitly here so the
      // intent is clear in the spec itself.
      await restoreSystemPages(pgClient, snapshot);
      await revalidateSite();
      await cleanupE2ePagesAdmin(pgClient);
      pgClient.release();
    }
  });

  // ── AC-PAGES-E01: Sider nav item in AdminShell ───────────────────────────

  test("AC-PAGES-E01: AdminShell sidebar nav contains a 'Sider' link pointing to /admin/pages", async ({
    page,
  }) => {
    await loginPagesAdmin(page, password);
    const nav = page.getByRole("navigation", { name: "Administration" });
    await expect(nav.getByRole("link", { name: "Sider" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Sider" })).toHaveAttribute(
      "href",
      "/admin/pages",
    );
  });

  // ── AC-PAGES-E02: Sider list shows the three system pages ────────────────

  test("AC-PAGES-E02: GET /admin/pages lists all three system pages (home/contact/privacy)", async ({
    page,
  }) => {
    await loginPagesAdmin(page, password, "/admin/pages");
    await expect(page.getByRole("main")).toContainText(/Forside|Home/i);
    await expect(page.getByRole("main")).toContainText(/Kontakt|Contact/i);
    await expect(page.getByRole("main")).toContainText(/Privatliv|Privacy/i);
  });

  // ── AC-PAGES-E03: Rediger editor opens with DA/EN tabs ───────────────────

  test("AC-PAGES-E03: clicking Rediger for Contact opens the editor with DA and EN tabs", async ({
    page,
  }) => {
    await loginPagesAdmin(page, password, "/admin/pages");
    const contactRow = page.getByRole("row").filter({ hasText: /Kontakt|Contact/i }).first();
    await contactRow.getByRole("link", { name: /Rediger/i }).click();

    await expect(page).toHaveURL(/\/admin\/pages\//);
    await expect(page.getByRole("tab", { name: /DA|Dansk/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /EN|English/i })).toBeVisible();
  });

  // ── AC-PAGES-E04: save shows success feedback ─────────────────────────────

  test("AC-PAGES-E04: editing the DA Titel and clicking Gem shows success feedback", async ({
    page,
  }) => {
    await loginPagesAdmin(page, password, "/admin/pages");
    const contactRow = page.getByRole("row").filter({ hasText: /Kontakt|Contact/i }).first();
    await contactRow.getByRole("link", { name: /Rediger/i }).click();

    const titleField = page.getByRole("textbox", { name: /Titel/i }).first();
    await titleField.fill("Kontakt os — e2e");
    await page.getByRole("button", { name: /Gem/i }).click();

    // Success feedback: PageEditor renders <Notice role="status"> with the "Gemt" label
    await expect(
      page.getByRole("status").filter({ hasText: /gemt/i }),
    ).toBeVisible();
  });

  // ── AC-PAGES-E05: nav toggle persists ────────────────────────────────────

  test("AC-PAGES-E05: toggling 'Vis i menuen' for Contact and saving persists on reload", async ({
    page,
  }) => {
    await loginPagesAdmin(page, password, "/admin/pages");
    const contactRow = page.getByRole("row").filter({ hasText: /Kontakt|Contact/i }).first();
    await contactRow.getByRole("link", { name: /Rediger/i }).click();

    const navToggle = page.getByRole("checkbox", { name: /Vis i menuen/i });
    const initialChecked = await navToggle.isChecked();
    await navToggle.click();
    await page.getByRole("button", { name: /Gem/i }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /gemt/i }),
    ).toBeVisible();

    // Reload the editor and confirm the toggle state persisted
    await page.reload();
    await expect(page.getByRole("checkbox", { name: /Vis i menuen/i })).toHaveJSProperty(
      "checked",
      !initialChecked,
    );
  });

  // ── AC-PAGES-E06: Forhåndsvis opens the published public URL ─────────────

  test("AC-PAGES-E06: Forhåndsvis button on the Contact editor opens /kontakt in a new tab", async ({
    page,
    context,
  }) => {
    await loginPagesAdmin(page, password, "/admin/pages");
    const contactRow = page.getByRole("row").filter({ hasText: /Kontakt|Contact/i }).first();
    await contactRow.getByRole("link", { name: /Rediger/i }).click();

    const [newTab] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: /Forhåndsvis/i }).click(),
    ]);
    await newTab.waitForLoadState();
    expect(newTab.url()).toMatch(/\/kontakt/);
  });

  // ── AC-PAGES-E07: public /kontakt reflects saved title ───────────────────

  test("AC-PAGES-E07: after saving a DA title, GET /kontakt renders it in the public heading", async ({
    page,
  }) => {
    const uniqueTitle = `Kontakt e2e ${Date.now()}`;

    await loginPagesAdmin(page, password, "/admin/pages");
    const contactRow = page.getByRole("row").filter({ hasText: /Kontakt|Contact/i }).first();
    await contactRow.getByRole("link", { name: /Rediger/i }).click();

    const titleField = page.getByRole("textbox", { name: /Titel/i }).first();
    await titleField.fill(uniqueTitle);
    await page.getByRole("button", { name: /Gem/i }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /gemt/i }),
    ).toBeVisible();

    // Dev server renders from DB on every request — no ISR revalidation needed here.
    await page.goto("/kontakt");
    await expect(page.locator("h1")).toContainText(uniqueTitle);
  });

  // ── AC-PAGES-E08: Sider list has a reorder affordance ────────────────────

  test("AC-PAGES-E08: Sider list renders a reorder affordance (up/down or drag handle) for nav pages", async ({
    page,
  }) => {
    // Scope: verifies that a reorder mechanism is present in the UI.
    // Persistence of the reorder is verified by the server-action unit tests
    // (AC-PAGES-14/15/16) which confirm admin_reorder_nav is called with the
    // correct array and revalidation follows.
    await loginPagesAdmin(page, password, "/admin/pages");

    // A reorder affordance must exist — either explicit up/down controls or
    // drag handles.  Both are valid implementations; the test accepts either.
    const upDownButton = page.getByRole("button", { name: /op|ned|omordre|flyt/i }).first();
    const dragHandle = page.locator("[data-drag-handle], [aria-roledescription='sortable']").first();

    const hasUpDown = await upDownButton.isVisible().catch(() => false);
    const hasDragHandle = await dragHandle.isVisible().catch(() => false);

    expect(hasUpDown || hasDragHandle).toBe(true);
  });
});
