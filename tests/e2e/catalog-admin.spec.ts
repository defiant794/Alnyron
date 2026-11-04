/**
 * E2E tests — admin catalog editors (F2.3 catalog-admin)
 * Journey: catalog-admin
 * Acceptance IDs: AC-CATADM-01 through AC-CATADM-50
 *
 * Runs against the ISOLATED e2e Supabase project (giokcppmmzrrknmllfjc).
 * Guard: describe-level SUPABASE_E2E_REF check prevents any DB/bucket call from
 * reaching prod when tests/.env.e2e-project is absent.
 *
 * Prerequisites:
 *   - Dev server at PLAYWRIGHT_BASE_URL against the e2e project (`npm run dev:e2e`)
 *   - tests/.env.e2e-project with SUPABASE_E2E_REF + DB credentials
 *   - tests/.env.e2e-project SUPABASE_SECRET_KEY for signed-upload and storage cleanup
 *
 * Test-data rules:
 *   - All test item DA slugs use the `e2e-cat-adm-` prefix so the shared
 *     `removeCatalogTestItems()` (sweeps `e2e-cat-%`) picks them up automatically.
 *   - Category status is snapshot + restored in afterAll; text edits (AC-11)
 *     are snapshot + restored via snapshotCategoryTranslations.
 *   - Uploaded bucket objects are tracked in `uploadedPaths` and removed in afterAll.
 *   - Non-admin access tests use a seeded, signed-in non-allowlisted user.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { PoolClient } from "../integration/rls/helpers/db";
import {
  SECRET_KEY_AVAILABLE,
} from "./fixtures/admin-auth-seed";
import {
  getClient,
  endPool,
  randomE2ePassword,
  E2E_CAT_ADMIN_EMAIL,
  seedCatalogAdmin,
  cleanupCatalogAdmin,
  E2E_CAT_NONADMIN_EMAIL,
  randomE2ePassword as randomNonAdminPassword,
  seedCatalogNonAdmin,
  cleanupCatalogNonAdmin,
  snapshotCategoryTranslations,
  restoreCategoryTranslations,
  removeStorageObjects,
  getUploadedMediaPaths,
  deleteTestItem,
  type CategoryTranslationSnapshot,
} from "./fixtures/catalog-admin-seed";
import {
  addCatalogTestItem,
  removeCatalogTestItems,
  setCategoryStatus,
  snapshotCategoryStatuses,
  restoreCategoryStatuses,
  type CategoryStatusSnapshot,
} from "./fixtures/db-state";
import { revalidateSite } from "./fixtures/revalidate";

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAs(page: Page, email: string, password: string, path = "/admin"): Promise<void> {
  // Pass ?next= so signIn redirects straight to `path` — no extra goto needed.
  // safeNext requires the path to start with /admin/ (trailing slash), so the
  // bare /admin home is sent without next= and relies on the action's default.
  const loginUrl =
    path === "/admin"
      ? "/admin/login"
      : `/admin/login?next=${encodeURIComponent(path)}`;
  await page.goto(loginUrl);
  await page.getByLabel(/E-mail/i).fill(email);
  await page.getByLabel(/Adgangskode/i).fill(password);
  await page.getByRole("button", { name: /Log ind/i }).click();
  // For the non-admin path (/admin/no-access) the server redirects there
  // directly; for admin paths signIn → redirect(safeNext(next)) → page.
  await page.waitForURL(path, { timeout: 10_000 });
}

async function loginAdmin(page: Page, password: string, path = "/admin"): Promise<void> {
  await loginAs(page, E2E_CAT_ADMIN_EMAIL, password, path);
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

// ── Outer describe — E2E project guard ────────────────────────────────────────

test.describe("Catalog admin editors (DB fixture, serial)", () => {
  test.describe.configure({ mode: "serial" });

  // Describe-level skip: prevents afterAll from running when e2e project is absent,
  // so no fixture call can reach prod. Individual test.skip(!DB_AVAILABLE) is
  // redundant here — the REF check implies DB credentials are present.
  test.skip(
    process.env.SUPABASE_E2E_REF !== "giokcppmmzrrknmllfjc",
    "catalog-admin E2E requires tests/.env.e2e-project (SUPABASE_E2E_REF=giokcppmmzrrknmllfjc). " +
      "Without it DB fixtures would target production. See User Setup U2.1.",
  );

  let pgClient: PoolClient;
  let adminPassword: string;
  let nonAdminPassword: string;
  let catStatusSnapshots: CategoryStatusSnapshot[] = [];
  let appsTranslationSnapshots: CategoryTranslationSnapshot[] = [];

  test.beforeAll(async () => {
    pgClient = await getClient();
    adminPassword = randomE2ePassword();
    nonAdminPassword = randomNonAdminPassword();

    // Sweep any rows from an aborted prior run.
    await removeCatalogTestItems();
    // Sweep any items whose DA slug escaped the 'e2e-cat-%' pattern due to a prefillSlug
    // race in Playwright (title blur fires during fill(), prepending slugify(title) to the
    // intended slug). Only the two known orphan prefixes are targeted to avoid touching
    // 'e2e-home-' rows owned by other specs running under fullyParallel.
    await pgClient.query(
      `DELETE FROM public.items WHERE id IN (
         SELECT item_id FROM public.item_translations
         WHERE locale = 'da'
           AND (slug LIKE 'e2e-komplet-app%' OR slug LIKE 'e2e-slug-clash%')
       )`,
    );


    // Seed the DEDICATED catalog-admin user (UUID …0008 — never races admin-auth.spec).
    await cleanupCatalogAdmin(pgClient);
    await seedCatalogAdmin(pgClient, adminPassword);

    // Seed the non-admin user (no allowlist entry).
    await cleanupCatalogNonAdmin(pgClient);
    await seedCatalogNonAdmin(pgClient, nonAdminPassword);

    // Snapshot all four category statuses for afterAll restore.
    const kinds = ["apps", "websites", "services", "models3d"] as const;
    const allSnapshots = await Promise.all(kinds.map((k) => snapshotCategoryStatuses(k)));
    catStatusSnapshots = allSnapshots.flat();

    // Snapshot Apps category translations (AC-11 edits the DA title).
    appsTranslationSnapshots = await snapshotCategoryTranslations(pgClient, "apps");

    await revalidateSite();
  });

  test.afterAll(async () => {
    if (pgClient) {
      // Collect bucket paths BEFORE item rows are deleted (the JOIN needs them).
      const bucketPaths = await getUploadedMediaPaths(pgClient);
      await removeCatalogTestItems();
      await restoreCategoryStatuses(catStatusSnapshots);
      await restoreCategoryTranslations(pgClient, appsTranslationSnapshots);
      await revalidateSite();
      // Remove bucket objects after rows are gone.
      await removeStorageObjects(bucketPaths);
      await cleanupCatalogNonAdmin(pgClient);
      await cleanupCatalogAdmin(pgClient);
      pgClient.release();
    }
  });

  // ── AC-CATADM-06: Kataloger nav group in AdminShell ──────────────────────

  test("AC-CATADM-06: AdminShell sidebar nav contains a 'Kataloger' group with four kind links", async ({
    page,
  }) => {
    await loginAdmin(page, adminPassword);
    const nav = page.getByRole("navigation", { name: "Administration" });
    await expect(nav.getByText("Kataloger")).toBeVisible();
    await expect(nav.getByRole("link", { name: "Apps" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Hjemmesider" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Ydelser" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "3D-modeller" })).toBeVisible();
  });

  // ── AC-CATADM-01: catalog overview ────────────────────────────────────────

  test("AC-CATADM-01: /admin/catalog shows four section rows", async ({ page }) => {
    await loginAdmin(page, adminPassword, "/admin/catalog");
    await expect(page.getByRole("main")).toContainText("Apps");
    await expect(page.getByRole("main")).toContainText("Hjemmesider");
    await expect(page.getByRole("main")).toContainText("Ydelser");
    await expect(page.getByRole("main")).toContainText("3D-modeller");
  });

  // ── AC-CATADM-04: Skjult badge (draft category) ───────────────────────────

  test("AC-CATADM-04: a draft category shows 'Skjult' badge on the overview", async ({ page }) => {
    await setCategoryStatus("services", "draft");
    await revalidateSite();
    await loginAdmin(page, adminPassword, "/admin/catalog");
    const servicesRow = page.getByRole("row").filter({ hasText: /Ydelser/i }).first();
    await expect(servicesRow.getByText("Skjult")).toBeVisible();
  });

  // ── AC-CATADM-03: Vises ved første udgivne element (published, 0 published items) ──

  test("AC-CATADM-03: published category with no published items shows 'Vises ved første udgivne element'", async ({
    page,
  }) => {
    await setCategoryStatus("services", "published");
    await revalidateSite();
    await loginAdmin(page, adminPassword, "/admin/catalog");
    const servicesRow = page.getByRole("row").filter({ hasText: /Ydelser/i }).first();
    await expect(servicesRow.getByText("Vises ved første udgivne element")).toBeVisible();
  });

  // ── AC-CATADM-02: Synlig badge (published + has published items) ──────────

  test("AC-CATADM-02: published category with published items shows 'Synlig' badge", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("services", "published", {
      daSlug: "e2e-cat-adm-services-pub",
      daTitle: "E2E Ydelse",
      enSlug: "e2e-cat-adm-services-pub-en",
      enTitle: "E2E Service",
    });
    await revalidateSite();

    await loginAdmin(page, adminPassword, "/admin/catalog");
    const servicesRow = page.getByRole("row").filter({ hasText: /Ydelser/i }).first();
    await expect(servicesRow.getByText("Synlig")).toBeVisible();

    // Delete only this item — do NOT call removeCatalogTestItems() which would
    // wipe items created by later tests in the same serial run.
    await deleteTestItem(pgClient, itemId);
    await revalidateSite();
  });

  // ── AC-CATADM-05: Rediger links to section editor ─────────────────────────

  test("AC-CATADM-05: 'Rediger' on a section row navigates to the section editor", async ({
    page,
  }) => {
    await loginAdmin(page, adminPassword, "/admin/catalog");
    const row = page.getByRole("row").filter({ hasText: /Apps/i }).first();
    await row.getByRole("link", { name: "Rediger" }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/categories\//);
  });

  // ── AC-CATADM-10: section editor loads ────────────────────────────────────

  test("AC-CATADM-10: section editor loads with DA/EN tabs and read-only slug", async ({ page }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);

    await expect(page.getByRole("tab", { name: /DA|Dansk/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /EN|Engelsk/i })).toBeVisible();

    const slugField = page.locator('input[name*="slug"]').first();
    const isDisabled = await slugField.isDisabled().catch(() => false);
    const isReadonly = await slugField.getAttribute("readonly").then((v) => v !== null).catch(() => false);
    expect(isDisabled || isReadonly).toBe(true);
  });

  // ── AC-CATADM-11: edit DA title, save, restore ────────────────────────────

  test("AC-CATADM-11: editing DA title and saving shows success notice", async ({ page }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);

    const titleField = page.getByLabel(/Titel \(DA\)/i).first();
    await titleField.fill("Apps — E2E test");
    await page.getByRole("button", { name: /Gem/i }).click();

    await expect(page.getByRole("status")).toContainText(/gemt/i);
    // afterAll restores appsTranslationSnapshots — no manual restore needed here.
    await revalidateSite();
  });

  // ── AC-CATADM-12: da-title-required error ────────────────────────────────

  test("AC-CATADM-12: clearing DA title and saving shows da-title-required error", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);

    await page.getByLabel(/Titel \(DA\)/i).first().fill("");
    await page.getByRole("button", { name: /Gem/i }).click();

    await expect(page.getByRole("alert").first()).toContainText(/da.?title|titel|påkrævet/i);
  });

  // ── AC-CATADM-13: slug-taken on the section editor (BLOCKED) ─────────────

  // The section editor shows its slug read-only and never sends it (AC-10 and
  // the approved mock), so a save cannot return slug-taken there. Reported as
  // blocked with this reason instead of a failure. (The item editor's slug
  // errors, AC-24, show at its URL-slug field.)
  const AC13_BLOCKED = "section slug is read-only by design (AC-10), slug-taken unreachable";
  test.fixme(
    "AC-CATADM-13: saving with a taken slug shows slug-taken error",
    { annotation: { type: "blocked", description: AC13_BLOCKED } },
    async () => {
      throw new Error(AC13_BLOCKED);
    },
  );

  // ── AC-CATADM-14: visibility toggle ─────────────────────────────────────

  test("AC-CATADM-14: toggling category to draft removes it from the public site", async ({
    page,
  }) => {
    await setCategoryStatus("services", "published");
    await addCatalogTestItem("services", "published", {
      daSlug: "e2e-cat-adm-vis-pub",
      daTitle: "E2E Vis Test",
      enSlug: "e2e-cat-adm-vis-pub-en",
      enTitle: "E2E Vis Test EN",
    });
    await revalidateSite();

    const visible = await page.goto("/ydelser");
    expect(visible?.status()).not.toBe(404);

    const servicesId = await getCategoryId(pgClient, "services");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${servicesId}`);
    const toggle = page.getByRole("checkbox", { name: /synlig|offentlig|publice/i }).first();
    if (await toggle.isChecked()) {
      await toggle.click();
      await page.getByRole("button", { name: /Gem/i }).click();
      // Wait for the save success notice before revalidating — matches AC-11
      // pattern and prevents setCategoryStatusAction from racing revalidateSite().
      await expect(page.getByRole("status")).toContainText(/gemt/i);
    }
    await revalidateSite();

    const hidden = await page.goto("/ydelser");
    expect(hidden?.status()).toBe(404);

    // Restore done by afterAll (catStatusSnapshots + removeCatalogTestItems).
    await removeCatalogTestItems();
    await revalidateSite();
  });

  // ── AC-CATADM-15: items table row display ────────────────────────────────

  test("AC-CATADM-15: items table shows each item row with title, status badge, Udvalgt flag, price, and action buttons", async ({
    page,
  }) => {
    // Seed a featured, priced, published item so every column is populated.
    const { itemId } = await addCatalogTestItem("apps", "published", {
      daSlug: "e2e-cat-adm-ac15-item",
      daTitle: "E2E AC15 Row Test",
      enSlug: "e2e-cat-adm-ac15-item-en",
      enTitle: "E2E AC15 Row Test EN",
      featured: true,
      priceType: "fixed",
      priceAmount: 1500,
    });

    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);

    const row = page.getByRole("row").filter({ hasText: "E2E AC15 Row Test" });
    await expect(row).toBeVisible();

    // Status badge — "Offentlig" for a published item
    await expect(row).toContainText("Offentlig");
    // Udvalgt / featured indicator (★ rendered by CatalogItemsTable)
    await expect(row).toContainText("★");
    // Formatted fixed price (1 500 kr. / 1.500 kr. — exact format is locale-dependent)
    await expect(row).toContainText(/1[.,\s]500/);
    // "Rediger" link to the item editor
    await expect(row.getByRole("link", { name: "Rediger" })).toBeVisible();
    // "Skjul" button for a published item
    await expect(row.getByRole("button", { name: /Skjul/i })).toBeVisible();

    await deleteTestItem(pgClient, itemId);
  });

  // ── AC-CATADM-16: empty items table ─────────────────────────────────────

  test("AC-CATADM-16: section editor shows 'Ingen elementer endnu, opret et' when empty", async ({
    page,
  }) => {
    const modelsId = await getCategoryId(pgClient, "models3d");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${modelsId}`);
    await expect(page.getByRole("main")).toContainText("Ingen elementer endnu, opret et");
  });

  // ── AC-CATADM-17: + Nyt element link ─────────────────────────────────────

  test("AC-CATADM-17: '+ Nyt element' navigates to item editor with category param", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);
    await page.getByRole("link", { name: "+ Nyt element" }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/new/);
    await expect(page).toHaveURL(new RegExp(`category=${appsId}`));
  });

  // ── AC-CATADM-18: reorder items persists via reorderItemsAction ──────────
  //
  // Both accessibility keyboard buttons (Flyt op / Flyt ned) and the native
  // HTML5 drag-and-drop handle call the same `reorderItemsAction`. We test via
  // the accessible buttons — robust in Playwright, same server call.

  test("AC-CATADM-18: moving an item with the reorder button persists the new order via reorderItemsAction", async ({
    page,
  }) => {
    // Seed two items. Because both get sort_order=9998 they are ordered by
    // created_at: itemA comes first, itemB second.
    const { itemId: itemA } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac18-first",
      daTitle: "E2E AC18 First",
      enSlug: "e2e-cat-adm-ac18-first-en",
      enTitle: "E2E AC18 First EN",
    });
    const { itemId: itemB } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac18-second",
      daTitle: "E2E AC18 Second",
      enSlug: "e2e-cat-adm-ac18-second-en",
      enTitle: "E2E AC18 Second EN",
    });

    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/categories/${appsId}`);

    const rows = page.getByRole("row").filter({ hasText: /E2E AC18/ });
    await expect(rows).toHaveCount(2);
    // Initial order: First before Second (created_at ascending)
    await expect(rows.first()).toContainText("E2E AC18 First");

    // Click ↑ ("Flyt op") on the second item — accessible name: "Flyt op: E2E AC18 Second"
    await page.getByRole("button", { name: "Flyt op: E2E AC18 Second" }).click();

    // Wait for the DOM to reflect the new order (reorderItemsAction settles)
    await expect(rows.first()).toContainText("E2E AC18 Second", { timeout: 10_000 });
    await expect(rows.last()).toContainText("E2E AC18 First");

    // Reload to verify persistence in the DB
    await page.reload();
    const reloaded = page.getByRole("row").filter({ hasText: /E2E AC18/ });
    await expect(reloaded.first()).toContainText("E2E AC18 Second");
    await expect(reloaded.last()).toContainText("E2E AC18 First");

    await deleteTestItem(pgClient, itemA);
    await deleteTestItem(pgClient, itemB);
  });

  // ── AC-CATADM-19: non-admin category-action auth guard ───────────────────
  //
  // requireAdmin() on the category editor page redirects to /admin/no-access
  // before any content renders.

  test("AC-CATADM-19: non-admin visiting the category editor is redirected to /admin/no-access", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    // Sign in as the non-admin (no allowlist entry).
    await loginAs(page, E2E_CAT_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
    // Direct navigation to the category editor must redirect away.
    await page.goto(`/admin/catalog/categories/${appsId}`);
    await expect(page).toHaveURL(/\/admin\/no-access/);
  });

  // ── AC-CATADM-20: new item form ──────────────────────────────────────────

  test("AC-CATADM-20: new item form loads with DA/EN tabs and all required fields", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);

    await expect(page.getByRole("tab", { name: /DA|Dansk/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /EN|Engelsk/i })).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /fast/i }).or(page.getByLabel(/fast/i)),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Udvalgt/i })).toBeVisible();
    // MediaManager save-first prompt (unsaved item has no id yet)
    await expect(page.getByRole("main")).toContainText(/Gem elementet/i);
  });

  // ── AC-CATADM-23: da-title-required on new item ───────────────────────────

  test("AC-CATADM-23: saving a new item without DA title shows da-title-required error", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("alert").first()).toContainText(/da.?title|titel|påkrævet/i);
  });

  // ── AC-CATADM-24: slug-taken on the language that clashed ─────────────────
  //
  // A real clash on item_translations_locale_slug_key. RLS drops the key detail, so
  // admin_save_item names the locale as HINT (migration 20261103000600); the editor then opens
  // that language's tab with the error under its URL-slug, focused (approved item-editor mock).

  test("AC-CATADM-24: saving a new item with a taken EN slug opens Engelsk with slug-taken under URL-slug (EN)", async ({
    page,
  }) => {
    await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-slug-owner",
      daTitle: "E2E Slug Owner",
      enSlug: "e2e-cat-adm-slug-owner-en",
      enTitle: "E2E Slug Owner EN",
    });
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);

    const daTab = page.getByRole("tab", { name: "Dansk", exact: true });
    const enTab = page.getByRole("tab", { name: "Engelsk", exact: true });
    const daSlug = page.getByLabel("URL-slug (DA)", { exact: true });
    const enSlug = page.getByLabel("URL-slug (EN)", { exact: true });
    // Fill slug BEFORE title: prefillSlug (onBlur of title) only sets the slug when it is
    // empty, so filling the slug first prevents a concatenation race in Playwright.
    await daSlug.fill("e2e-cat-adm-slug-clash");
    await page.getByLabel("Titel (DA)", { exact: true }).fill("E2E Slug Clash");
    await enTab.click();
    // Fill EN slug BEFORE EN title for the same prefillSlug-race reason as DA above.
    await enSlug.fill("e2e-cat-adm-slug-owner-en");
    await page.getByLabel("Titel (EN)", { exact: true }).fill("E2E Slug Clash EN");
    // Save from the Dansk tab: the EN tab has to open because of the server's answer.
    await daTab.click();
    await expect(enSlug).toBeHidden();
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(enTab).toHaveAttribute("aria-selected", "true");
    await expect(enSlug).toBeVisible();
    await expect(enSlug).toHaveAttribute("aria-invalid", "true");
    await expect(enSlug).toHaveAccessibleDescription(/Denne URL-slug er allerede i brug/);
    await expect(enSlug).toBeFocused();
    await expect(daSlug).not.toHaveAttribute("aria-invalid", "true");
    // Nothing saved: still the new-item form.
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/new/);
  });

  // ── AC-CATADM-25: price-invalid ───────────────────────────────────────────

  test("AC-CATADM-25: selecting fixed price type without amount shows price-invalid error", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);
    await page.getByLabel(/Titel \(DA\)/i).first().fill("E2E Price Test");
    await page.getByRole("radio", { name: /fast/i }).check();
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("alert").first()).toContainText(/pris|price|beløb/i);
  });

  // ── AC-CATADM-26: links-invalid ───────────────────────────────────────────

  test("AC-CATADM-26: entering a non-https link shows links-invalid error", async ({ page }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);
    await page.getByLabel(/Titel \(DA\)/i).first().fill("E2E Link Test");
    const linkField = page
      .getByLabel(/Website/i)
      .or(page.getByPlaceholder(/https:\/\//i))
      .first();
    await linkField.fill("http://not-https.example.com");
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("alert").first()).toContainText(/link|adresse|https/i);
  });

  // ── AC-CATADM-21: DA title prefills DA slug ──────────────────────────────

  test("AC-CATADM-21: typing a DA title and blurring prefills the DA URL-slug", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);

    const titleField = page.getByLabel("Titel (DA)", { exact: true });
    const slugField = page.getByLabel("URL-slug (DA)", { exact: true });

    // Slug starts empty on a new item
    await expect(slugField).toHaveValue("");

    // Fill the title then blur (Tab) — prefillSlug fires on onBlur
    await titleField.fill("E2E Slug Prefill Test");
    await titleField.press("Tab");

    // slugify("E2E Slug Prefill Test") = "e2e-slug-prefill-test"
    await expect(slugField).toHaveValue("e2e-slug-prefill-test");
  });

  // ── AC-CATADM-22: complete save redirects to item editor ─────────────────

  test("AC-CATADM-22: saving a complete item redirects to the item editor", async ({ page }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);
    // Fill slug BEFORE title so prefillSlug (title onBlur) finds a non-empty field
    // and skips its override, preventing 'e2e-komplet-app' + slug concatenation.
    const slugField = page.getByLabel(/URL-slug \(DA\)/i).first();
    // e2e-cat-adm- prefix so removeCatalogTestItems sweeps it
    await slugField.fill("e2e-cat-adm-komplet-app");
    await page.getByLabel(/Titel \(DA\)/i).first().fill("E2E Komplet App");

    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/items\/[0-9a-f-]{36}/);
    // afterAll's removeCatalogTestItems sweeps e2e-cat-adm-komplet-app
  });

  // ── AC-CATADM-27: publish attempt with missing EN translation shows error ──

  test("AC-CATADM-27: publishing a draft item with no EN translation shows missing-translations error", async ({
    page,
  }) => {
    // Seed a draft item with both translations (addCatalogTestItem always inserts both),
    // then immediately remove the EN row so the item has only a DA translation.
    const { itemId } = await addCatalogTestItem("services", "draft", {
      daSlug: "e2e-cat-adm-ac27-no-en",
      daTitle: "E2E AC27 No EN Translation",
      // enSlug must be explicit: when daSlug is supplied the random suffix is "" so the
      // default would become "e2e-cat-services-en-" (trailing hyphen → slug check violation).
      enSlug: "e2e-cat-adm-ac27-no-en-en",
      enTitle: "E2E AC27 No EN (placeholder, deleted below)",
    });
    await pgClient.query(
      `DELETE FROM public.item_translations WHERE item_id = $1 AND locale = 'en'`,
      [itemId],
    );

    // Navigate to the item editor and attempt to publish.
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    await page.getByRole("button", { name: /Udgiv/i }).click();

    // The DB raises P0001 missing_translations → the form shows the error alert.
    // Filter by text to avoid ambiguity with the Next.js __next-route-announcer__ div.
    await expect(
      page.getByRole("alert").filter({ hasText: /Elementet skal have en dansk og en engelsk version/i }),
    ).toBeVisible({ timeout: 10_000 });

    // DB ground-truth: item must remain draft with no published_at stamp.
    const { rows: itemRows } = await pgClient.query<{ status: string; published_at: string | null }>(
      `SELECT status, published_at FROM public.items WHERE id = $1`,
      [itemId],
    );
    expect(itemRows[0]?.status).toBe("draft");
    expect(itemRows[0]?.published_at).toBeNull();
    // Confirm the EN translation row is still absent (saveItemAction must not have re-created it).
    const { rows: enRows } = await pgClient.query(
      `SELECT 1 FROM public.item_translations WHERE item_id = $1 AND locale = 'en'`,
      [itemId],
    );
    expect(enRows).toHaveLength(0);

    // Cleanup — deleteTestItem cascades to item_translations.
    await deleteTestItem(pgClient, itemId);
  });


  // ── AC-CATADM-28: publish / hide flow ────────────────────────────────────

  test("AC-CATADM-28: publishing a draft item makes it visible; hiding it removes it", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("services", "draft", {
      daSlug: "e2e-cat-adm-pub-hide",
      daTitle: "E2E Publish Hide",
      enSlug: "e2e-cat-adm-pub-hide-en",
      enTitle: "E2E Publish Hide EN",
    });
    await setCategoryStatus("services", "published");
    await revalidateSite();

    await page.goto("/ydelser");
    expect(await page.content()).not.toContain("E2E Publish Hide");

    // Publish via item editor
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    await page.getByRole("button", { name: /Udgiv/i }).click();
    // Wait for the publish action to complete before revalidating — same race as AC-14.
    await expect(page.getByRole("status")).toContainText(/udgivet/i, { timeout: 10_000 });
    await revalidateSite();
    await page.goto("/ydelser");
    await expect(page.getByRole("main")).toContainText("E2E Publish Hide");

    // Hide again
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    await page.getByRole("button", { name: /Skjul/i }).click();
    // Wait for the hide action to complete before revalidating.
    await expect(page.getByRole("status")).toContainText(/skjult/i, { timeout: 10_000 });
    await revalidateSite();
    await page.goto("/ydelser");
    expect(await page.content()).not.toContain("E2E Publish Hide");

    await deleteTestItem(pgClient, itemId);
    await revalidateSite();
  });

  // ── AC-CATADM-29: hiding a published item removes it from the public page ─

  test("AC-CATADM-29: hiding a published item removes it from the public section page", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("services", "published", {
      daSlug: "e2e-cat-adm-ac29-hide",
      daTitle: "E2E AC29 Hide Test",
      enSlug: "e2e-cat-adm-ac29-hide-en",
      enTitle: "E2E AC29 Hide Test EN",
    });
    await setCategoryStatus("services", "published");
    await revalidateSite();

    // Item should be visible on the public section page
    await page.goto("/ydelser");
    await expect(page.getByRole("main")).toContainText("E2E AC29 Hide Test");

    // Hide the item via the item editor
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    await page.getByRole("button", { name: /Skjul/i }).click();
    await expect(page.getByRole("status")).toContainText(/skjult/i, { timeout: 10_000 });
    await revalidateSite();

    // Item must no longer appear on the public section page
    await page.goto("/ydelser");
    expect(await page.content()).not.toContain("E2E AC29 Hide Test");

    await deleteTestItem(pgClient, itemId);
    await revalidateSite();
  });

  // ── AC-CATADM-30: "Forhåndsvis" preview link ─────────────────────────────
  //
  // previewHref is set only when item AND section are both published.
  // A link (<a target="_blank">) renders instead of a disabled button.

  test("AC-CATADM-30: 'Forhåndsvis' is a new-tab link to the public item page (published item + section)", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("services", "published", {
      daSlug: "e2e-cat-adm-ac30-preview",
      daTitle: "E2E AC30 Preview",
      enSlug: "e2e-cat-adm-ac30-preview-en",
      enTitle: "E2E AC30 Preview EN",
    });
    await setCategoryStatus("services", "published");
    await revalidateSite();

    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    // "Forhåndsvis" must be a real link (not a disabled button) for a published item in a published section
    const previewLink = page.getByRole("link", { name: /Forhåndsvis/i });
    await expect(previewLink).toBeVisible();
    await expect(previewLink).toHaveAttribute("target", "_blank");
    // The href must include the DA item slug
    await expect(previewLink).toHaveAttribute("href", /e2e-cat-adm-ac30-preview/);

    await deleteTestItem(pgClient, itemId);
    await revalidateSite();
  });

  // ── AC-CATADM-31: Slet + confirm ─────────────────────────────────────────

  test("AC-CATADM-31: Slet + confirm removes item from the editor", async ({ page }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-delete-me",
      daTitle: "E2E To Delete",
      enSlug: "e2e-cat-adm-delete-me-en",
      enTitle: "E2E To Delete EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /Slet/i }).click();
    await expect(page).not.toHaveURL(new RegExp(itemId));
  });

  // ── AC-CATADM-32: Slet + cancel ───────────────────────────────────────────

  test("AC-CATADM-32: Slet + cancel keeps item intact", async ({ page }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-no-delete",
      daTitle: "E2E No Delete",
      enSlug: "e2e-cat-adm-no-delete-en",
      enTitle: "E2E No Delete EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: /Slet/i }).click();
    await expect(page).toHaveURL(new RegExp(itemId));
    // afterAll sweeps this row via removeCatalogTestItems (e2e-cat-adm- prefix)
  });

  // ── AC-CATADM-07: non-admin is redirected to /admin/no-access ─────────────
  //
  // The non-admin user (signed in, NOT in user_allowlist) triggers requireAdmin()
  // which redirects to /admin/no-access rather than serving the page.

  test("AC-CATADM-07: non-admin signed-in user is redirected to /admin/no-access", async ({
    page,
  }) => {
    // Sign in as the non-admin user (no allowlist entry).
    await loginAs(page, E2E_CAT_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
    // Confirm we are on no-access, not the catalog page.
    await expect(page).toHaveURL(/\/admin\/no-access/);
    // A subsequent direct navigation to the catalog also redirects.
    await page.goto("/admin/catalog");
    await expect(page).toHaveURL(/\/admin\/no-access/);
  });

  // ── AC-CATADM-33: non-admin item-action auth guard ───────────────────────
  //
  // requireAdmin() on the item editor page redirects to /admin/no-access
  // before any content renders.

  test("AC-CATADM-33: non-admin visiting the item editor is redirected to /admin/no-access", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac33-item",
      daTitle: "E2E AC33 Auth Guard",
      enSlug: "e2e-cat-adm-ac33-item-en",
      enTitle: "E2E AC33 Auth Guard EN",
    });
    // Sign in as the non-admin (no allowlist entry).
    await loginAs(page, E2E_CAT_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
    // Direct navigation to the item editor must redirect away.
    await page.goto(`/admin/catalog/items/${itemId}`);
    await expect(page).toHaveURL(/\/admin\/no-access/);
    // afterAll sweeps the item row via removeCatalogTestItems (e2e-cat-adm- prefix)
  });

  // ── AC-CATADM-50: non-admin signed-upload-URL request is refused ────────────
  //
  // The app uses @supabase/ssr with cookie-only sessions; localStorage has no token.
  // Read the JWT from the `sb-<ref>-auth-token` cookie (unchunked or .0/.1 chunks;
  // value may be `base64-<b64(JSON)>` or URL-encoded JSON). Then call the Supabase
  // Storage `upload/sign` endpoint — the same route that `createMediaUpload` calls —
  // on a valid path `items/<item-uuid>/<file-uuid>.webp`. Expect ≥400 for the
  // non-admin JWT. Positive control: the admin JWT for the same path returns 200.

  test("AC-CATADM-50: storage upload/sign refused for non-admin JWT; succeeds for admin JWT (positive control)", async ({
    page,
  }) => {
    test.skip(
      !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_E2E_REF,
      "NEXT_PUBLIC_SUPABASE_URL + SUPABASE_E2E_REF required",
    );

    // Seed a real item so the path passes `media_path_valid` on both calls.
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac50-item",
      daTitle: "E2E AC50 Item",
      enSlug: "e2e-cat-adm-ac50-item-en",
      enTitle: "E2E AC50 Item EN",
    });
    // Use a deterministic file UUID so the path is reproducible.
    const fileUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const objectPath = `media/items/${itemId}/${fileUuid}.webp`;
    const signUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/upload/sign/${objectPath}`;

    /** Read `access_token` from the `sb-<ref>-auth-token` cookie.
     *  The value is either `base64-<b64-encoded-json>` or URL-encoded JSON.
     *  The cookie may be chunked as `.0`, `.1`, … — chunks are concatenated in order. */
    async function getAccessToken(ctx: BrowserContext): Promise<string | null> {
      const cookies = await ctx.cookies();
      const base = `sb-${process.env.SUPABASE_E2E_REF}-auth-token`;

      // Collect raw value: unchunked or concatenated chunks.
      let raw: string | null = null;
      const single = cookies.find((c) => c.name === base);
      if (single) {
        raw = single.value;
      } else {
        const chunks: string[] = [];
        for (let i = 0; ; i++) {
          const chunk = cookies.find((c) => c.name === `${base}.${i}`);
          if (!chunk) break;
          chunks.push(chunk.value);
        }
        if (chunks.length > 0) raw = chunks.join("");
      }
      if (!raw) return null;

      // Decode: strip `base64-` prefix and base64-decode, or URL-decode directly.
      let jsonStr: string;
      if (raw.startsWith("base64-")) {
        jsonStr = Buffer.from(raw.slice(7), "base64").toString("utf8");
      } else {
        jsonStr = decodeURIComponent(raw);
      }
      try {
        const parsed: unknown = JSON.parse(jsonStr);
        if (parsed !== null && typeof parsed === "object" && "access_token" in parsed) {
          const record = parsed as Record<string, unknown>;
          const token = record["access_token"];
          return typeof token === "string" ? token : null;
        }
        return null;
      } catch {
        return null;
      }
    }

    // ── Non-admin: sign in and grab cookie JWT ────────────────────────────
    await loginAs(page, E2E_CAT_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
    const nonAdminToken = await getAccessToken(page.context());
    expect(nonAdminToken, "non-admin cookie JWT must be readable").not.toBeNull();

    const nonAdminResponse = await page.request.post(signUrl, {
      headers: {
        Authorization: `Bearer ${nonAdminToken}`,
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
      },
      data: "{}",
      failOnStatusCode: false,
    });
    expect(
      nonAdminResponse.status(),
      "upload/sign must be refused (≥400) for a non-admin JWT",
    ).toBeGreaterThanOrEqual(400);

    // ── Admin positive control: same path, admin JWT → 200 ───────────────
    await loginAdmin(page, adminPassword);
    const adminToken = await getAccessToken(page.context());
    expect(adminToken, "admin cookie JWT must be readable").not.toBeNull();

    const adminResponse = await page.request.post(signUrl, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
      },
      data: "{}",
      failOnStatusCode: false,
    });
    expect(
      adminResponse.status(),
      "upload/sign must succeed (200) for an admin JWT — proving refusal is is_admin() RLS, not path format",
    ).toBe(200);

    // afterAll sweeps the item row; no bucket object was written.
  });


  // ── AC-CATADM-41: MediaManager save-first prompt ─────────────────────────

  test("AC-CATADM-41: MediaManager shows save-first prompt on unsaved new item", async ({
    page,
  }) => {
    const appsId = await getCategoryId(pgClient, "apps");
    await loginAdmin(page, adminPassword, `/admin/catalog/items/new?category=${appsId}`);
    await expect(page.getByRole("main")).toContainText(/Gem elementet/i);
  });

  // ── AC-CATADM-40: MediaManager empty state ────────────────────────────────

  test("AC-CATADM-40: MediaManager shows upload zone for a saved item with no images", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-media-empty",
      daTitle: "E2E Media Empty",
      enSlug: "e2e-cat-adm-media-empty-en",
      enTitle: "E2E Media Empty EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);
    await expect(page.getByRole("main")).toContainText(/0 af 8/);
    // afterAll sweeps this item (e2e-cat-adm- prefix)
  });

  // ── AC-CATADM-43: file too large ─────────────────────────────────────────

  test("AC-CATADM-43: uploading a file >5 MiB shows size error in MediaManager", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-media-size",
      daTitle: "E2E Media Size",
      enSlug: "e2e-cat-adm-media-size-en",
      enTitle: "E2E Media Size EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    const FIVE_MIB_PLUS = 5 * 1024 * 1024 + 1;
    await page.evaluate((size) => {
      const bytes = new Uint8Array(size);
      const file = new File([bytes], "huge.webp", { type: "image/webp" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (input) {
        Object.defineProperty(input, "files", { value: dt.files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, FIVE_MIB_PLUS);

    await expect(page.getByRole("main")).toContainText(/for stor/i);
    // afterAll sweeps via removeCatalogTestItems
  });

  // ── AC-CATADM-44: unsupported file type shows type error ─────────────────

  test("AC-CATADM-44: picking an unsupported file type shows the type-error without uploading", async ({
    page,
  }) => {
    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac44-item",
      daTitle: "E2E AC44 Type Error",
      enSlug: "e2e-cat-adm-ac44-item-en",
      enTitle: "E2E AC44 Type Error EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    // Inject a file with an unsupported MIME type (PDF) via the hidden input.
    // checkMediaFile returns "unsupported-type" because "application/pdf" is not
    // in MEDIA_MIME_TYPES; no upload request is ever sent.
    // Node-side counter; must be zero after the inject (the rejection is fully client-side).
    let signHits44 = 0;
    page.on("request", (r) => {
      if (r.url().includes("/storage/v1/object/upload/sign/")) signHits44++;
    });

    await page.evaluate(() => {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic bytes
      const file = new File([bytes], "document.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (input) {
        Object.defineProperty(input, "files", { configurable: true, value: dt.files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Filter past the Next.js route-announcer (also role=alert); assert the type-error.
    await expect(
      page.getByRole("alert").filter({ hasText: /Filtypen understøttes ikke/i }),
    ).toBeVisible({ timeout: 5_000 });
    expect(signHits44, "no upload/sign request must be sent for an unsupported type").toBe(0);
    // afterAll sweeps via removeCatalogTestItems
  });

  // ── AC-CATADM-45: upload loading indicator ───────────────────────────────

  test("AC-CATADM-45: an in-progress upload shows the loading indicator and disables further uploads", async ({
    page,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac45-item",
      daTitle: "E2E AC45 Upload Indicator",
      enSlug: "e2e-cat-adm-ac45-item-en",
      enTitle: "E2E AC45 Upload Indicator EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    // Tiny 1×1 white PNG — valid image, well under 5 MiB.
    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    // Gate: intercept the signed-upload PUT so the upload hangs long enough to
    // observe the loading state and the disabled button.
    const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
    await page.route("**/storage/v1/object/upload/sign/**", async (route) => {
      await gate;
      await route.continue();
    });

    // Start upload; because the PUT is gated, the MediaManager stays in "uploading" state.
    await page.locator('input[type="file"]').setInputFiles({
      name: "indicator-test.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_B64, "base64"),
    });

    // The uploading skeleton has role="status" with the "Uploader" label.
    await expect(
      page.getByRole("status").filter({ hasText: /Uploader/i }),
    ).toBeVisible({ timeout: 10_000 });
    // The "Tilføj billede" button must be disabled while an upload is in progress.
    await expect(page.getByRole("button", { name: /Tilføj billede/i })).toBeDisabled();

    // Release the gate so the upload can complete; thumbnail must appear.
    releaseGate();
    await page.unroute("**/storage/v1/object/upload/sign/**");
    await expect(page.getByRole("main").locator("img")).toHaveCount(1, { timeout: 15_000 });
    // afterAll sweeps item + bucket object via removeCatalogTestItems + removeStorageObjects
  });

  // ── AC-CATADM-46: 9th image upload is refused (too-many-media) ───────────

  test("AC-CATADM-46: uploading an 8th image fills the gallery; the too-many-media indicator appears", async ({
    page,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac46-item",
      daTitle: "E2E AC46 Max Images",
      enSlug: "e2e-cat-adm-ac46-item-en",
      enTitle: "E2E AC46 Max Images EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(TINY_PNG_B64, "base64");
    const MEDIA_MAX = 8;

    // Upload 8 images one by one; wait for each thumbnail before starting the next.
    for (let i = 1; i <= MEDIA_MAX; i++) {
      await page.locator('input[type="file"]').setInputFiles({
        name: `img${i}.png`,
        mimeType: "image/png",
        buffer: pngBuffer,
      });
      await expect(page.getByRole("main").locator("img")).toHaveCount(i, { timeout: 15_000 });
    }

    // Gallery is full; the drop zone shows the too-many-media notice and the button is disabled.
    await expect(page.getByRole("main")).toContainText(
      "Elementet har allerede det højeste antal billeder",
    );
    await expect(page.getByRole("button", { name: /Tilføj billede/i })).toBeDisabled();

    // 9th attempt: inject a file on the disabled input (bypassing `disabled` so the
    // React onChange handler fires and executes the client-side `full` guard).
    // No upload/sign request must be sent.
    // Node-side counter to prove no upload/sign request fires for the 9th attempt.
    let signHits46 = 0;
    page.on("request", (r) => {
      if (r.url().includes("/storage/v1/object/upload/sign/")) signHits46++;
    });

    await page.evaluate(() => {
      const bytes = new Uint8Array(100);
      const file = new File([bytes], "9th.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (input) {
        input.disabled = false; // bypass disabled so React fires onChange
        Object.defineProperty(input, "files", { configurable: true, value: dt.files });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    // Client guard sets error immediately — no network round-trip needed.
    await expect(
      page.getByRole("alert").filter({ hasText: /Elementet har allerede det højeste antal billeder/i }),
    ).toBeVisible({ timeout: 5_000 });

    // DB must still have exactly 8 media rows — no 9th was inserted.
    const { rows } = await pgClient.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.media WHERE item_id = $1`,
      [itemId],
    );
    expect(rows[0]?.count, "DB must have exactly 8 media rows — no 9th uploaded").toBe(8);
    expect(signHits46, "no upload/sign request must be sent for the 9th attempt").toBe(0);
    // afterAll sweeps all 8 bucket objects via getUploadedMediaPaths + removeStorageObjects
  });

  // ── AC-CATADM-47: clearing DA alt text and saving shows alt-required error ─

  test("AC-CATADM-47: clearing the DA alt text and saving shows the alt-required error", async ({
    page,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac47-item",
      daTitle: "E2E AC47 Alt Required",
      enSlug: "e2e-cat-adm-ac47-item-en",
      enTitle: "E2E AC47 Alt Required EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await page.locator('input[type="file"]').setInputFiles({
      name: "alt-test.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_B64, "base64"),
    });
    // Wait for the thumbnail so the image row is in the DOM
    await expect(page.getByRole("main").locator("img")).toHaveCount(1, { timeout: 15_000 });

    // Clear the DA alt text field for the uploaded image
    await page.getByLabel(/Alt-tekst \(DA\)/i).first().fill("");

    // Submit the form — saveItemAction returns alt-required
    await page.getByRole("button", { name: /Gem kladde/i }).click();

    // The route-announcer div is also role=alert; filter past it.
    // Both the form-level notice ("Alle billeder…") and the field-level notice
    // ("Skriv en alt-tekst…") confirm alt-required was returned — accept either.
    await expect(
      page.getByRole("alert").filter({ hasText: /alt-tekst/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // afterAll sweeps item + bucket object
  });

  // ── AC-CATADM-48: "Fjern" + confirm removes the image from the list ───────

  test("AC-CATADM-48: 'Fjern' + confirm removes the image from the MediaManager list", async ({
    page,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac48-item",
      daTitle: "E2E AC48 Fjern",
      enSlug: "e2e-cat-adm-ac48-item-en",
      enTitle: "E2E AC48 Fjern EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await page.locator('input[type="file"]').setInputFiles({
      name: "fjern-test.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_B64, "base64"),
    });
    await expect(page.getByRole("main").locator("img")).toHaveCount(1, { timeout: 15_000 });

    // Confirm the native window.confirm dialog that "Fjern" triggers
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /Fjern/i }).click();

    // The image list must become empty
    await expect(page.getByRole("main").locator("img")).toHaveCount(0, { timeout: 10_000 });
    // The detachMediaAction also removes the bucket object; afterAll bucket sweep is a no-op here
  });

  // ── AC-CATADM-49: image reorder persists via saveItemAction ──────────────

  test("AC-CATADM-49: reordering images and saving persists the new order", async ({ page }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-ac49-item",
      daTitle: "E2E AC49 Reorder",
      enSlug: "e2e-cat-adm-ac49-item-en",
      enTitle: "E2E AC49 Reorder EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(TINY_PNG_B64, "base64");

    // Upload first image
    await page.locator('input[type="file"]').setInputFiles({
      name: "reorder1.png",
      mimeType: "image/png",
      buffer: pngBuffer,
    });
    await expect(page.getByRole("main").locator("img")).toHaveCount(1, { timeout: 15_000 });

    // Upload second image
    await page.locator('input[type="file"]').setInputFiles({
      name: "reorder2.png",
      mimeType: "image/png",
      buffer: pngBuffer,
    });
    await expect(page.getByRole("main").locator("img")).toHaveCount(2, { timeout: 15_000 });

    // Label the two images with distinct DA alt texts so we can track order after reload.
    // getByLabel returns them in DOM order (image 1 first, image 2 second).
    await page.getByLabel(/Alt-tekst \(DA\)/i).nth(0).fill("Reorder Image A");
    await page.getByLabel(/Alt-tekst \(DA\)/i).nth(1).fill("Reorder Image B");

    // Click ↑ ("Flyt op: 2") to move the second image to position 1
    await page.getByRole("button", { name: "Flyt op: 2" }).click();

    // After the move image B is now at position 1 in the DOM
    await expect(page.getByLabel(/Alt-tekst \(DA\)/i).nth(0)).toHaveValue("Reorder Image B");

    // Save the item — saveItemAction writes the new sort_order values
    await page.getByRole("button", { name: /Gem kladde/i }).click();
    await expect(page.getByRole("status")).toContainText(/gemt/i, { timeout: 10_000 });

    // Reload — SSR returns images sorted by the persisted sort_order
    await page.reload();
    await expect(page.getByLabel(/Alt-tekst \(DA\)/i).nth(0)).toHaveValue("Reorder Image B");
    await expect(page.getByLabel(/Alt-tekst \(DA\)/i).nth(1)).toHaveValue("Reorder Image A");
    // afterAll sweeps item + 2 bucket objects
  });

  // ── AC-CATADM-42: real signed-URL upload ─────────────────────────────────
  //
  // Uses page.locator('input[type="file"]').setInputFiles(...) — works on hidden
  // inputs and fails loudly if the element is missing. Asserts on the DB row, not
  // just a rendered <img>. Bucket paths are collected in afterAll via
  // getUploadedMediaPaths (DB JOIN) — no RSC response-body parsing needed.

  test("AC-CATADM-42: uploading a valid image adds a media row and thumbnail to the list", async ({
    page,
  }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY required for signed upload URLs");

    const { itemId } = await addCatalogTestItem("apps", "draft", {
      daSlug: "e2e-cat-adm-media-upload",
      daTitle: "E2E Media Upload",
      enSlug: "e2e-cat-adm-media-upload-en",
      enTitle: "E2E Media Upload EN",
    });
    await loginAdmin(page, adminPassword, `/admin/catalog/items/${itemId}`);

    // Tiny 1×1 white PNG — well under 5 MiB, valid image/png.
    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    await page.locator('input[type="file"]').setInputFiles({
      name: "test.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_B64, "base64"),
    });

    // Wait for the thumbnail to appear (signed upload → PUT → attachMedia complete).
    await expect(page.getByRole("main").locator("img")).toHaveCount(1, { timeout: 15_000 });

    // Assert the media row was persisted in the DB.
    const { rows } = await pgClient.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.media WHERE item_id = $1`,
      [itemId],
    );
    expect(rows[0]?.count, "media row must exist in DB after upload").toBe(1);

    // afterAll collects this path via getUploadedMediaPaths (DB JOIN) and
    // removes the bucket object via removeStorageObjects.
  });
});
