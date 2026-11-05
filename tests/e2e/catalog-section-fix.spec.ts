/**
 * E2E tests — new items saved in the chosen section + moving items between sections (catalog-section-fix)
 * Journey: catalog-section-fix
 * Acceptance IDs: AC-CATSEC-1 through AC-CATSEC-15
 *
 * Runs against the ISOLATED e2e Supabase project (giokcppmmzrrknmllfjc).
 * Guard: describe-level SUPABASE_E2E_REF check prevents any DB/bucket call from
 * reaching prod when tests/.env.e2e-project is absent.
 *
 * Prerequisites:
 *   - Production build at PLAYWRIGHT_BASE_URL (`node scripts/next-e2e-project.mjs start -p 3000`)
 *   - tests/.env.e2e-project with SUPABASE_E2E_REF + DB credentials
 *
 * Test-data rules:
 *   - All test item DA slugs use the `e2e-cat-sec-` prefix, and the spec sweeps
 *     only that prefix (`removeCatalogTestItems(ITEM_SLUG_PREFIX)`), never the
 *     `e2e-cat-` rows of a spec running in parallel.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import type { PoolClient } from "../integration/rls/helpers/db";
import {
  getClient,
  endPool,
  randomE2ePassword,
  E2E_CATSEC_ADMIN,
  seedCatalogAdmin,
  cleanupCatalogAdmin,
} from "./fixtures/catalog-admin-seed";
import { loginAs } from "./fixtures/admin-login";
import {
  addCatalogTestItem,
  removeCatalogTestItems,
  snapshotCategoryStatuses,
  restoreCategoryStatuses,
  type CategoryStatusSnapshot,
} from "./fixtures/db-state";

/** DA slug prefix of this spec's test items: the only catalog rows it deletes. */
const ITEM_SLUG_PREFIX = "e2e-cat-sec-";

// ── Pool lifecycle ──────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Waits until React has hydrated `locator`, so a click goes through the
 * client router (a soft navigation) instead of a full page load.
 */
async function expectHydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

type HeldRoute = {
  /** Held RSC requests (`?_rsc=`): the payloads a client-side navigation waits for. */
  rscCount: () => number;
  /** Lets every held request through; later matching requests pass straight on. */
  release: () => void;
};

/**
 * Holds every request of the page whose URL `matches` until `release()`, so a
 * client-side navigation to it stays pending for as long as the test needs.
 * Install it before the page that links there loads: a `<Link>` prefetch then
 * is held too, and a click reuses that in-flight prefetch instead of sending
 * its own request (which, when sent, matches and is held as well).
 *
 * The route stays installed after the release: unrouting the page's last route
 * makes Playwright continue the routes still in flight itself, so the
 * handler's own `route.continue()` would throw "Route is already handled!".
 */
async function holdRoute(page: Page, matches: (url: URL) => boolean): Promise<HeldRoute> {
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  let released = false;
  const held: string[] = [];
  await page.route(matches, async (route) => {
    if (!released) {
      held.push(route.request().url());
      await gate;
    }
    await route.continue();
  });
  return {
    rscCount: () => held.filter((url) => new URL(url).searchParams.has("_rsc")).length,
    release: () => {
      released = true;
      resolve();
    },
  };
}

/** First category id of `kind` from the DB. */
async function getCategoryId(client: PoolClient, kind: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM public.categories WHERE kind = $1::public.catalog_kind ORDER BY nav_order LIMIT 1",
    [kind],
  );
  if (!result.rows[0]) throw new Error(`No category of kind '${kind}' found in e2e project`);
  return result.rows[0].id;
}

/** URL slug of a section (its English `routes` row): the first path segment of its public pages on every locale. */
async function getSectionSlug(client: PoolClient, categoryId: string): Promise<string> {
  const result = await client.query<{ slug: string }>(
    "SELECT slug FROM public.routes WHERE category_id = $1 AND locale = 'en'",
    [categoryId],
  );
  if (!result.rows[0]) throw new Error(`Section ${categoryId} has no EN route in e2e project`);
  return result.rows[0].slug;
}

/** Read the current category_id of an item directly from the DB. */
async function getItemCategoryId(client: PoolClient, itemId: string): Promise<string> {
  const result = await client.query<{ category_id: string }>(
    "SELECT category_id FROM public.items WHERE id = $1",
    [itemId],
  );
  if (!result.rows[0]) throw new Error(`Item ${itemId} not found`);
  return result.rows[0].category_id;
}

/** Read the current sort_order of an item directly from the DB. */
async function getItemSortOrder(client: PoolClient, itemId: string): Promise<number> {
  const result = await client.query<{ sort_order: number }>(
    "SELECT sort_order FROM public.items WHERE id = $1",
    [itemId],
  );
  if (!result.rows[0]) throw new Error(`Item ${itemId} not found`);
  return result.rows[0].sort_order;
}

/** Max sort_order in a category, 0 when empty. */
async function getCategoryMaxSortOrder(client: PoolClient, categoryId: string): Promise<number> {
  const result = await client.query<{ max: number | null }>(
    "SELECT MAX(sort_order) AS max FROM public.items WHERE category_id = $1",
    [categoryId],
  );
  return result.rows[0]?.max ?? 0;
}

// ── Outer describe — E2E project guard ────────────────────────────────────────

test.describe("Catalog section fix (DB fixture, serial)", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(
    process.env.SUPABASE_E2E_REF !== "giokcppmmzrrknmllfjc",
    "catalog-section-fix E2E requires tests/.env.e2e-project (SUPABASE_E2E_REF=giokcppmmzrrknmllfjc). " +
      "Without it DB fixtures would target production.",
  );

  let pgClient: PoolClient;
  let adminPassword: string;
  let catStatusSnapshots: CategoryStatusSnapshot[] = [];

  test.beforeAll(async () => {
    pgClient = await getClient();
    adminPassword = randomE2ePassword();

    await removeCatalogTestItems(ITEM_SLUG_PREFIX);

    await cleanupCatalogAdmin(pgClient, E2E_CATSEC_ADMIN);
    await seedCatalogAdmin(pgClient, adminPassword, E2E_CATSEC_ADMIN);

    const kinds = ["apps", "websites", "services", "models3d"] as const;
    const allSnapshots = await Promise.all(kinds.map((k) => snapshotCategoryStatuses(k)));
    catStatusSnapshots = allSnapshots.flat();
  });

  test.afterAll(async () => {
    if (pgClient) {
      await removeCatalogTestItems(ITEM_SLUG_PREFIX);
      await restoreCategoryStatuses(catStatusSnapshots);
      await cleanupCatalogAdmin(pgClient, E2E_CATSEC_ADMIN);
      pgClient.release();
    }
  });

  // ── Regression: AC-CATSEC-1 ────────────────────────────────────────────────
  // Scenario (a): the new-item editor opened with ?category=websites selects Hjemmesider

  test("AC-CATSEC-1-a: new item loaded with ?category=websites has Hjemmesider selected in section select", async ({
    page,
  }) => {
    const websitesId = await getCategoryId(pgClient, "websites");
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/new?category=${websitesId}`);

    // The section select should show Hjemmesider (or the websites section title)
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeVisible();
    const selectedValue = await sectionSelect.inputValue();
    expect(selectedValue).toBe(websitesId);
  });

  // ── Regression: AC-CATSEC-2 ────────────────────────────────────────────────
  // Scenario (a) full: open Apps new-item → change select to Hjemmesider → save → DB check

  test("AC-CATSEC-2-a: changing section select on new item to Hjemmesider saves under Hjemmesider (regression)", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/new?category=${appsId}`);

    // Fill slug before title to avoid prefillSlug concatenation race
    const slugField = page.getByLabel("URL-slug (DA)", { exact: true });
    await slugField.fill("e2e-cat-sec-new-a");
    await page.getByLabel("Titel (DA)", { exact: true }).fill("E2E SecFix New A");

    // Change the section select to Hjemmesider
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeVisible();

    // The select starts at the section the editor was opened for
    expect(await sectionSelect.inputValue()).toBe(appsId);

    await sectionSelect.selectOption(websitesId);
    expect(await sectionSelect.inputValue()).toBe(websitesId);

    // Save
    await page.getByRole("button", { name: /Gem kladde/i }).click();

    // Should redirect to the item editor
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Extract itemId from URL
    const url = page.url();
    const itemId = url.match(/\/items\/([0-9a-f-]{36})/)?.[1];
    if (!itemId) throw new Error(`Could not extract item id from URL: ${url}`);

    // DB ground-truth: the item must be in Hjemmesider, not Apps
    const storedCategoryId = await getItemCategoryId(pgClient, itemId);
    expect(
      storedCategoryId,
      `item must be saved under Hjemmesider (${websitesId}), not Apps (${appsId})`,
    ).toBe(websitesId);

    // The saved editor's section select must reflect Hjemmesider
    expect(await page.getByLabel(/Sektion/i).inputValue()).toBe(websitesId);
  });

  // ── Regression: AC-CATSEC-3-b ──────────────────────────────────────────────
  // Scenario (b): sidebar-click chain (pure client navigation — no page.goto after login)
  // Apps section editor → "+ Nyt element" → sidebar "Hjemmesider" → "+ Nyt element"
  // The new-item editor is keyed by its section, so its section select starts at
  // Hjemmesider even when the router renders the new page into the mounted screen.

  test("AC-CATSEC-3-b: sidebar client-nav chain — Apps new-item → sidebar Hjemmesider → new-item shows Hjemmesider select (regression)", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    // Start: Apps section editor (loginAs uses goto — only full load allowed here)
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/categories/${appsId}`);

    // Click-nav 1: Apps section editor → Apps new-item
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    // Wait specifically for new?category=appsId so we're sure we're on the Apps form
    await page.waitForURL(new RegExp(`items/new.*category=${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    const selectStep1 = page.getByLabel(/Sektion/i);
    await expect(selectStep1).toBeVisible();
    expect(await selectStep1.inputValue()).toBe(appsId);

    // Click-nav 2: sidebar "Hjemmesider" → Hjemmesider section editor
    // Must wait for websitesId in URL (goes via /admin/catalog/websites → redirect)
    const sidebar = page.getByRole("navigation", { name: "Administration" });
    await sidebar.getByRole("link", { name: "Hjemmesider", exact: true }).click();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Click-nav 3: Hjemmesider section editor → Hjemmesider new-item
    // Must wait for new?category=websitesId specifically — prevents accepting Apps cache
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // The section select MUST show Hjemmesider BEFORE touching anything
    const selectStep3 = page.getByLabel(/Sektion/i);
    await expect(selectStep3).toBeVisible();
    const websitesValue = await selectStep3.inputValue();
    const urlAtAssertion = page.url();
    const breadcrumbText = await page.getByRole("navigation", { name: "Brødkrummesti" }).textContent();
    expect(
      websitesValue,
      `select must show Hjemmesider, not Apps, after the sidebar chain: URL=${urlAtAssertion} breadcrumb="${breadcrumbText}"`,
    ).toBe(websitesId);

    // Breadcrumb must also show Hjemmesider
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).toContainText(/Hjemmesider/i);

    // Fill + save + DB verify
    await page.getByLabel("URL-slug (DA)", { exact: true }).fill("e2e-cat-sec-chain-b");
    await page.getByLabel("Titel (DA)", { exact: true }).fill("E2E SecFix Chain B");
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/[0-9a-f-]{36}/, { timeout: 15_000 });

    const itemId = page.url().match(/\/items\/([0-9a-f-]{36})/)?.[1];
    if (!itemId) throw new Error(`Could not extract item id from URL: ${page.url()}`);
    const storedCat = await getItemCategoryId(pgClient, itemId);
    expect(storedCat, "item must be saved under Hjemmesider after the sidebar chain").toBe(websitesId);
  });

  // ── Regression: AC-CATSEC-3-c ──────────────────────────────────────────────
  // Scenario (c): back/forward — click chain via back then sidebar (pure client nav)

  test("AC-CATSEC-3-c: browser back then sidebar nav — Hjemmesider new-item shows correct section (regression)", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    // Start: Apps section editor
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/categories/${appsId}`);

    // Click-nav 1: Apps section editor → Apps new-item
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    // Wait for new?category=appsId specifically
    await page.waitForURL(new RegExp(`items/new.*category=${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    expect(await page.getByLabel(/Sektion/i).inputValue()).toBe(appsId);

    // Browser back → back to Apps section editor
    await page.goBack();
    // After goBack() we're already on /categories/<appsId> — wait for appsId specifically
    await page.waitForURL(new RegExp(`categories/${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // Click-nav 2: sidebar "Hjemmesider" → Hjemmesider section editor
    // Goes via /admin/catalog/websites → redirect → /categories/<websitesId>
    // Must wait for websitesId in URL, NOT just any /categories/ (would resolve on Apps page)
    const sidebar = page.getByRole("navigation", { name: "Administration" });
    await sidebar.getByRole("link", { name: "Hjemmesider", exact: true }).click();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Click-nav 3: Hjemmesider section editor → Hjemmesider new-item
    // Must wait for new?category=websitesId — not just any /items/new/
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    const selectFinal = page.getByLabel(/Sektion/i);
    await expect(selectFinal).toBeVisible();
    const finalVal = await selectFinal.inputValue();
    const urlAtAssertion = page.url();
    const breadcrumbText = await page.getByRole("navigation", { name: "Brødkrummesti" }).textContent();
    expect(
      finalVal,
      `select must show Hjemmesider (${websitesId}), not Apps (${appsId}), after back + sidebar: URL=${urlAtAssertion} breadcrumb="${breadcrumbText}"`,
    ).toBe(websitesId);

    // Breadcrumb must also show Hjemmesider
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).toContainText(/Hjemmesider/i);

    // Fill + save + DB verify
    await page.getByLabel("URL-slug (DA)", { exact: true }).fill("e2e-cat-sec-back-c");
    await page.getByLabel("Titel (DA)", { exact: true }).fill("E2E SecFix Back C");
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/[0-9a-f-]{36}/, { timeout: 15_000 });

    const itemId = page.url().match(/\/items\/([0-9a-f-]{36})/)?.[1];
    if (!itemId) throw new Error(`Could not extract item id: ${page.url()}`);
    const storedCat = await getItemCategoryId(pgClient, itemId);
    expect(storedCat, "item must be saved under Hjemmesider after back + sidebar").toBe(websitesId);
  });

  // ── Regression: AC-CATSEC-3-d2 (via overview) ──────────────────────────────
  // "via overview" path: Apps new-item → breadcrumb Katalog → overview → Hjemmesider Rediger → + Nyt element

  test("AC-CATSEC-3-d2: via overview — Apps new-item → catalog overview → Hjemmesider Rediger → new-item shows Hjemmesider", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    // Start: Apps section editor, then click "+ Nyt element" to seed router cache
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/categories/${appsId}`);
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    expect(await page.getByLabel(/Sektion/i).inputValue()).toBe(appsId);

    // Click "Katalog" breadcrumb → catalog overview
    await page.getByRole("navigation", { name: "Brødkrummesti" }).getByRole("link", { name: "Katalog" }).click();
    await page.waitForURL(/\/admin\/catalog$/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // Find Hjemmesider row → click "Rediger"
    const websitesRow = page.getByRole("row").filter({ hasText: /Hjemmesider/i }).first();
    await websitesRow.getByRole("link", { name: "Rediger" }).click();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Click "+ Nyt element"
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    const selectVal = await page.getByLabel(/Sektion/i).inputValue();
    const urlAt = page.url();
    const bcText = await page.getByRole("navigation", { name: "Brødkrummesti" }).textContent();
    expect(
      selectVal,
      `select must show Hjemmesider, not Apps, via the overview: URL=${urlAt} breadcrumb="${bcText}"`,
    ).toBe(websitesId);
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).toContainText(/Hjemmesider/i);
  });

  // ── Regression: AC-CATSEC-3-e (goForward variant) ──────────────────────────
  // Forward cache: Apps new-item → back → Hjemmesider new-item → back → forward → check select

  test("AC-CATSEC-3-e: goForward to Hjemmesider new-item — select still shows Hjemmesider", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    // Build history: Apps section → Apps new-item → back → Hjemmesider section → Hjemmesider new-item
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/categories/${appsId}`);
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    await page.goBack();
    await page.waitForURL(new RegExp(`categories/${appsId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    const sidebar = page.getByRole("navigation", { name: "Administration" });
    await sidebar.getByRole("link", { name: "Hjemmesider", exact: true }).click();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await page.waitForURL(new RegExp(`items/new.*category=${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    expect(await page.getByLabel(/Sektion/i).inputValue()).toBe(websitesId);

    // Now: Back → Hjemmesider section, then Forward → Hjemmesider new-item
    await page.goBack();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    await page.goForward();
    await page.waitForURL(new RegExp(`items/new.*category=${websitesId}`), { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    const fwdVal = await page.getByLabel(/Sektion/i).inputValue();
    const urlAt = page.url();
    const bcText = await page.getByRole("navigation", { name: "Brødkrummesti" }).textContent();
    expect(
      fwdVal,
      `select must show Hjemmesider, not Apps, after goForward: URL=${urlAt} breadcrumb="${bcText}"`,
    ).toBe(websitesId);
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).toContainText(/Hjemmesider/i);
  });

  // ── Regression: AC-CATSEC-4 ────────────────────────────────────────────────
  // Scenario (d): /admin/catalog/items/new with missing or unknown ?category
  // → must redirect to /admin/catalog (not silently preselect first section)

  test("AC-CATSEC-4-d-i: new item with no ?category redirects to /admin/catalog", async ({
    page,
  }) => {
    // Must be logged in first; use a plain goto to the catalog overview
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, "/admin/catalog");

    // Navigate directly to new-item with no ?category
    await page.goto("/admin/catalog/items/new");
    await page.waitForURL(/\/admin\/catalog$/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/admin\/catalog$/);
  });

  test("AC-CATSEC-4-d-ii: new item with unknown uuid ?category redirects to /admin/catalog", async ({
    page,
  }) => {
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, "/admin/catalog");

    const unknownUuid = "00000000-0000-0000-0000-000000000000";
    await page.goto(`/admin/catalog/items/new?category=${unknownUuid}`);
    await page.waitForURL(/\/admin\/catalog$/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/admin\/catalog$/);
  });

  // ── PENDING-NAVIGATION RACE: AC-CATSEC-15 ─────────────────────────────────
  // The App Router keeps the outgoing page mounted until the navigation's
  // first RSC response is in. While the Hjemmesider response is held, the
  // stale Apps "+ Nyt element" (pointing at appsId) must make way for a
  // loading status. Holding the route makes the race window deterministic —
  // no reliance on real network timing.

  test("AC-CATSEC-15-race-1: pending navigation from Apps section → no stale 'Nyt element' and loading status visible", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    // Hold both legs of the kind redirect (/admin/catalog/websites →
    // /admin/catalog/categories/<websitesId>) from before login, so the
    // sidebar link's prefetch is held as well.
    const hold = await holdRoute(
      page,
      (url) =>
        url.pathname === "/admin/catalog/websites" ||
        url.pathname.startsWith(`/admin/catalog/categories/${websitesId}`),
    );

    // Start: Apps section editor
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/categories/${appsId}`);

    const staleNewItem = page.locator(`a[href*="category=${appsId}"]`).filter({ hasText: /Nyt element/i });
    await expect(staleNewItem).toBeVisible();

    // Click sidebar "Hjemmesider" once hydrated, so it is a soft navigation
    const websitesLink = page
      .getByRole("navigation", { name: "Administration" })
      .getByRole("link", { name: "Hjemmesider", exact: true });
    await expectHydrated(websitesLink);
    await websitesLink.click();

    // The race window is open once a Hjemmesider RSC request is held: the
    // prefetch the click reuses (sent before the click) or the navigation's own.
    await expect.poll(hold.rscCount, { timeout: 10_000 }).toBeGreaterThan(0);

    // Soft so both are always checked.
    // 1. The stale Apps "+ Nyt element" must not be visible/clickable during the navigation
    await expect.soft(staleNewItem).not.toBeVisible({ timeout: 3_000 });
    // 2. A loading status ("Indlæser …") must be announced. Scoped to /Indlæser/
    //    to avoid matching the item/category editor's save notices.
    await expect.soft(page.getByRole("status").filter({ hasText: /Indlæser/i })).toBeVisible({ timeout: 3_000 });

    // The held response is what the navigation waits for: it has not committed.
    expect(page.url(), "navigation must stay pending while its RSC response is held").toContain(
      `categories/${appsId}`,
    );

    // Release: let the navigation complete
    hold.release();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // After navigation: the "+ Nyt element" must link to Hjemmesider, not Apps
    const websitesNewItem = page.getByRole("link", { name: "+ Nyt element" });
    await expect(websitesNewItem).toBeVisible();
    const href = await websitesNewItem.getAttribute("href");
    expect(href, "Nyt element must point to websitesId after navigation").toContain(`category=${websitesId}`);
    expect(href, "Nyt element must not point to appsId after navigation").not.toContain(`category=${appsId}`);
  });

  test("AC-CATSEC-15-race-2: pending navigation from catalog overview via Rediger → loading status visible", async ({
    page,
  }) => {
    const websitesId = await getCategoryId(pgClient, "websites");

    // Hold the Hjemmesider section editor from before login, so the Rediger
    // link's prefetch is held as well.
    const hold = await holdRoute(page, (url) => url.pathname.startsWith(`/admin/catalog/categories/${websitesId}`));

    // Start: catalog overview (no `networkidle` wait: a held prefetch keeps the network busy)
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, "/admin/catalog");

    // Click the Hjemmesider row's "Rediger" link once hydrated, so it is a soft navigation
    const websitesRow = page.getByRole("row").filter({ hasText: /Hjemmesider/i }).first();
    const editLink = websitesRow.getByRole("link", { name: "Rediger" });
    await expectHydrated(editLink);
    await editLink.click();

    // Race window: a Hjemmesider RSC request (the reused prefetch or the navigation's own) is held
    await expect.poll(hold.rscCount, { timeout: 10_000 }).toBeGreaterThan(0);

    await expect.soft(page.getByRole("status").filter({ hasText: /Indlæser/i })).toBeVisible({ timeout: 3_000 });

    // The held response is what the navigation waits for: it has not committed.
    expect(page.url(), "navigation must stay pending while its RSC response is held").toMatch(/\/admin\/catalog$/);

    // Release and verify the Hjemmesider section editor is shown
    hold.release();
    await page.waitForURL(new RegExp(`categories/${websitesId}`), { timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "+ Nyt element" })).toHaveAttribute(
      "href",
      new RegExp(`category=${websitesId}`),
    );
  });

  // ── MOVE FEATURE: AC-CATSEC-5 ──────────────────────────────────────────────
  // A saved item's section select is enabled, so the item can be moved

  test("AC-CATSEC-5: saved item — section select is ENABLED", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-sec-move-enabled",
      daTitle: "E2E SecFix Move Enabled",
      enSlug: "e2e-cat-sec-move-enabled-en",
      enTitle: "E2E SecFix Move Enabled EN",
    });

    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/${itemId}`);

    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeVisible();

    await expect(sectionSelect).toBeEnabled();
  });

  // ── MOVE FEATURE: AC-CATSEC-6 / AC-CATSEC-7 ──────────────────────────────
  // Uses the item move of admin_save_item (migration 20261105000100_catalog_item_move.sql)

  test("AC-CATSEC-6-7: moving saved item from Apps to Hjemmesider — editor and DB reflect new section", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-sec-move-aw",
      daTitle: "E2E SecFix Move AW",
      enSlug: "e2e-cat-sec-move-aw-en",
      enTitle: "E2E SecFix Move AW EN",
    });

    const maxSortBefore = await getCategoryMaxSortOrder(pgClient, websitesId);
    const expectedSortOrder = maxSortBefore + 10;

    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/${itemId}`);

    // The select must be enabled (AC-CATSEC-5 prerequisite)
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeEnabled();

    // Move to Hjemmesider
    await sectionSelect.selectOption(websitesId);
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("status")).toContainText(/gemt/i, { timeout: 10_000 });

    // Editor select must reflect Hjemmesider
    await expect(sectionSelect).toHaveValue(websitesId);

    // DB: category_id updated
    const storedCategoryId = await getItemCategoryId(pgClient, itemId);
    expect(storedCategoryId).toBe(websitesId);

    // DB: sort_order = target max + 10
    const storedSortOrder = await getItemSortOrder(pgClient, itemId);
    expect(storedSortOrder).toBe(expectedSortOrder);

    // Hjemmesider items table must show the item
    await page.goto(`/admin/catalog/categories/${websitesId}`);
    await expect(page.getByRole("main")).toContainText("E2E SecFix Move AW");

    // Apps items table must NOT show the item
    await page.goto(`/admin/catalog/categories/${appsId}`);
    expect(await page.content()).not.toContain("E2E SecFix Move AW");
  });

  // ── MOVE FEATURE: AC-CATSEC-8 ──────────────────────────────────────────────
  // Reverse direction: Hjemmesider → Apps. Checks breadcrumb + both section tables,
  // then that "Slet element" in the same editor returns to the new section.

  test("AC-CATSEC-8: moving saved item from Hjemmesider to Apps — breadcrumb, editor select, tables and delete reflect Apps", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const websitesId = await getCategoryId(pgClient, "websites");

    const { itemId } = await addCatalogTestItem("websites", "draft", {
      daSlug: "e2e-cat-sec-move-wa",
      daTitle: "E2E SecFix Move WA",
      enSlug: "e2e-cat-sec-move-wa-en",
      enTitle: "E2E SecFix Move WA EN",
    });

    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/${itemId}`);

    // The select must be enabled (AC-CATSEC-5 prerequisite)
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeEnabled();

    // Move to Apps
    await sectionSelect.selectOption(appsId);
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("status")).toContainText(/gemt/i, { timeout: 10_000 });

    // Editor: select must reflect Apps
    await expect(sectionSelect).toHaveValue(appsId);

    // Editor: breadcrumb must show Apps, not Hjemmesider
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).toContainText(/Apps/i);
    await expect(page.getByRole("navigation", { name: "Brødkrummesti" })).not.toContainText(/Hjemmesider/i);

    // DB: category_id updated to Apps
    const storedCategoryId = await getItemCategoryId(pgClient, itemId);
    expect(storedCategoryId).toBe(appsId);

    // Both section tables, in a second tab: the editor stays as the move left it.
    const tables = await page.context().newPage();

    // Apps items table must show the item
    await tables.goto(`/admin/catalog/categories/${appsId}`);
    await expect(tables.getByRole("main")).toContainText("E2E SecFix Move WA");

    // Hjemmesider items table must NOT show the item
    await tables.goto(`/admin/catalog/categories/${websitesId}`);
    expect(await tables.content()).not.toContain("E2E SecFix Move WA");
    await tables.close();

    // Deleting from the editor the move left returns to the new section (Apps)
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Slet element", exact: true }).click();
    await page.waitForURL(new RegExp(`/admin/catalog/categories/${appsId}$`), { timeout: 15_000 });
    const remaining = await pgClient.query("SELECT 1 FROM public.items WHERE id = $1", [itemId]);
    expect(remaining.rowCount, "the deleted item must be gone from the DB").toBe(0);
  });

  // ── MOVE FEATURE: AC-CATSEC-10 ─────────────────────────────────────────────
  // Saving with the same section → sort_order unchanged

  test("AC-CATSEC-10: saving with same category_id keeps sort_order unchanged", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-sec-same-cat",
      daTitle: "E2E SecFix Same Cat",
      enSlug: "e2e-cat-sec-same-cat-en",
      enTitle: "E2E SecFix Same Cat EN",
    });

    const sortBefore = await getItemSortOrder(pgClient, itemId);

    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/${itemId}`);

    // Select is enabled (AC-CATSEC-5)
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeEnabled();
    // Keep the same section — do not change the select
    expect(await sectionSelect.inputValue()).toBe(appsId);

    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("status")).toContainText(/gemt/i, { timeout: 10_000 });

    // sort_order must not change
    const sortAfter = await getItemSortOrder(pgClient, itemId);
    expect(sortAfter).toBe(sortBefore);
    // category_id must not change
    const catAfter = await getItemCategoryId(pgClient, itemId);
    expect(catAfter).toBe(appsId);
  });

  // ── MOVE FEATURE: AC-CATSEC-9 ──────────────────────────────────────────────
  // Before the move the old public URL serves the item; after it, the old URL
  // 404s and the new one serves it (the save revalidates every public page)

  test("AC-CATSEC-9: after moving a published item, old section URL 404s and new section URL serves it", async ({
    page,
  }) => {
    const servicesId = await getCategoryId(pgClient, "services");
    const websitesId = await getCategoryId(pgClient, "websites");
    const oldSectionSlug = await getSectionSlug(pgClient, servicesId);
    const newSectionSlug = await getSectionSlug(pgClient, websitesId);

    // A slug of its own per run: the server's ISR cache may still hold an earlier
    // run's 200 or 404 for a fixed slug and would answer instead of this run.
    const itemSlug = `e2e-cat-sec-pub-move-${Date.now().toString(36)}`;
    const title = "E2E SecFix Pub Move";
    const { itemId } = await addCatalogTestItem("services", "published", {
      daSlug: itemSlug,
      daTitle: title,
      enSlug: `${itemSlug}-en`,
      enTitle: `${title} EN`,
    });

    // Both sections must be published for their public item pages to exist
    await pgClient.query("UPDATE public.categories SET status = 'published' WHERE id = ANY($1::uuid[])", [
      [servicesId, websitesId],
    ]);

    // The item's URL slug is its EN slug, on every locale.
    const oldUrl = `/${oldSectionSlug}/${itemSlug}-en`;
    const newUrl = `/${newSectionSlug}/${itemSlug}-en`;
    const itemHeading = page.getByRole("heading", { level: 1, name: title, exact: true });

    // Baseline: before the move the old section URL serves the item
    const beforeResp = await page.goto(oldUrl);
    expect(beforeResp?.status(), `${oldUrl} must serve the item before the move`).toBe(200);
    await expect(itemHeading).toBeVisible();

    // Move to Hjemmesider
    await loginAs(page, E2E_CATSEC_ADMIN.email, adminPassword, `/admin/catalog/items/${itemId}`);
    const sectionSelect = page.getByLabel(/Sektion/i);
    await expect(sectionSelect).toBeEnabled();
    await sectionSelect.selectOption(websitesId);
    // A published item's editor saves with "Gem" (it has no "Gem kladde").
    await page.getByRole("button", { name: "Gem", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(/gemt/i, { timeout: 10_000 });

    // The old section URL no longer serves the item
    const oldResp = await page.goto(oldUrl);
    expect(oldResp?.status(), `${oldUrl} must 404 after the move`).toBe(404);

    // The new section URL serves it
    const newResp = await page.goto(newUrl);
    expect(newResp?.status(), `${newUrl} must serve the item after the move`).toBe(200);
    await expect(itemHeading).toBeVisible();
  });
});
