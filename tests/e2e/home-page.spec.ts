// E2E tests for F0.5 home-page
// Acceptance IDs: AC-HOME-01 through AC-HOME-15
// Run with: npm run test:e2e
// Requires: the app at PLAYWRIGHT_BASE_URL (default http://localhost:3000),
//           reading the linked Supabase project, and SUPABASE_DB_PASSWORD
//           (environment or tests/.env.e2e) for the DB fixture. Against a
//           production build also E2E_REVALIDATE_SECRET, the same value in
//           the server's environment and the test run.
//
// ── Category visibility (DB fixture) ──────────────────────────────────────────
// Which catalog categories are public depends on DB state: a category shows
// once it holds a published item. The cloud project has categories but no items,
// so the scenarios that need a public category (AC-HOME-06/07/10/11/11b) and
// the one that needs none (AC-HOME-10b) run in one serial block that adds and
// removes marked test items through tests/e2e/fixtures/db-state.ts. Tests
// outside that block never depend on category state, so they run in parallel.
// A production build serves the pages from the ISR cache, so every fixture
// change is followed by `revalidateSite()` (tests/e2e/fixtures/revalidate.ts);
// the dev server renders every request from the DB and needs none.
//
import { test, expect } from "@playwright/test";
import { endPool } from "../integration/rls/helpers/db";
import { addTestItem, hasRealPublicCategory, removeTestItems } from "./fixtures/db-state";
import { revalidateSite } from "./fixtures/revalidate";

// ── Constants ────────────────────────────────────────────────────────────────

/** DA home title from the seed migration (20261101000300_seed_system_content.sql). */
const DA_TITLE = "Moderne apps, hjemmesider og digitale ydelser.";
/** DA home lead from the seed migration. */
const DA_LEAD =
  "Alnyron bygger gennemtænkte digitale produkter, der er enkle, hurtige og tilgængelige. Fortæl om dit projekt, så finder vi den rette løsning.";

// ── AC-HOME-01: DA home renders seeded content ────────────────────────────────

test("AC-HOME-01: GET / renders the DA home title from DB content", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText(DA_TITLE);
});

test("AC-HOME-01b: GET / renders the DA lead text from DB content", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(DA_LEAD.substring(0, 50))).toBeVisible();
});

// ── AC-HOME-02/03: EN home, DA fallback with lang="da" ───────────────────────

test("AC-HOME-02: GET /en renders the DA title with lang='da' (blank EN title falls back)", async ({
  page,
}) => {
  await page.goto("/en");
  // HomeView applies lang="da" to fallback-DA elements
  const titleEl = page.locator("[lang='da']").filter({ hasText: DA_TITLE.substring(0, 20) });
  await expect(titleEl).toBeVisible();
});

test("AC-HOME-03: GET /en DA-fallback lead text carries lang='da'", async ({ page }) => {
  await page.goto("/en");
  const leadEl = page.locator("[lang='da']").filter({ hasText: DA_LEAD.substring(0, 30) });
  await expect(leadEl).toBeVisible();
});

// ── AC-HOME-04: Nav, Forside pinned first, active on / ───────────────────────

test("AC-HOME-04: Header nav on / contains 'Forside' as first link and marks it active", async ({
  page,
}) => {
  await page.goto("/");
  // SiteHeader exposes a named nav landmark (distinct from LanguageSwitcher)
  const nav = page.getByRole("navigation", { name: /navigat/i });
  const firstLink = nav.getByRole("link").first();
  await expect(firstLink).toContainText("Forside");
  await expect(firstLink).toHaveAttribute("aria-current", "page");
});

test("AC-HOME-13: Header nav on /en marks the home link as active", async ({ page }) => {
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: /navigat/i });
  await expect(nav.getByRole("link").first()).toHaveAttribute("aria-current", "page");
});

// ── AC-HOME-05: Nav excludes pages with show_in_nav = false ──────────────────
// Paired with a presence assertion so the toHaveCount(0) checks cannot pass
// vacuously when the nav is missing.

test("AC-HOME-05: Header nav includes Forside but excludes Privatliv (show_in_nav=false)", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: /navigat/i });
  // Presence check: a missing nav fails here instead of passing the toHaveCount(0) checks
  await expect(nav.getByRole("link", { name: /Forside/i })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Privatliv/i })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /Privacy/i })).toHaveCount(0);
});

// ── AC-HOME-09: Footer ────────────────────────────────────────────────────────

test("AC-HOME-09: Footer on / shows © year + company name + email link + Privatliv link", async ({
  page,
}) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText(`© ${new Date().getFullYear()}`);
  await expect(footer).toContainText("Alnyron");
  await expect(
    footer.getByRole("link", { name: /info@alnyron\.dk/i }),
  ).toHaveAttribute("href", "mailto:info@alnyron.dk");
  await expect(
    footer.getByRole("link", { name: /Privatliv/i }),
  ).toHaveAttribute("href", "/privatliv");
});

test("AC-HOME-09b: Footer on /en shows Privacy link to /en/privacy", async ({ page }) => {
  await page.goto("/en");
  await expect(
    page.locator("footer").getByRole("link", { name: /Privacy/i }),
  ).toHaveAttribute("href", "/en/privacy");
});

// ── AC-HOME-12: ISR, locked by the build, not by an HTTP check ───────────────
// GET 200 on / and /en already passes on the F0.3 placeholder; removed.
// src/app/[locale]/layout.tsx exports `dynamic = "error"` (plus
// `revalidate = 300` and generateStaticParams), so a request-time API under
// it fails `next build`. A child segment's own `dynamic`/`revalidate` export
// can still override that, so the proof is the build's route table: /da and
// /en listed under ● /[locale] (SSG, revalidate 5m), not ƒ.

// ── AC-HOME-14/15: Keyboard + SkipLink ───────────────────────────────────────
// SkipLink ships with F0.2; these verify the F0.5 page does not break it.

test("AC-HOME-14: Home page, first Tab focus lands on the SkipLink (href='#main')", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAttribute("href", "#main");
});

test("AC-HOME-15: Home page has a #main landmark as the SkipLink target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#main")).toBeVisible();
});

// ── Mobile nav (DESIGN.md "Nav": hamburger below 768px) ──────────────────────

test("Mobile nav: below 768px the header nav opens from a Menu button and closes on Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const toggle = page.getByRole("button", { name: "Menu" });
  const nav = page.getByRole("navigation", { name: /navigat/i });
  // The toggle is a client island: a click before hydration hits the static
  // HTML and does nothing. React stores the props on each element it hydrates
  // (`__reactProps$<id>`), so the toggle has its click handler once it has them.
  await expect(toggle).toBeVisible();
  await expect
    .poll(() => toggle.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(nav).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "Forside" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(nav).toBeHidden();
});

// WCAG 1.4.10 / design-principles [hard]: no horizontal scroll at 320px.
for (const path of ["/", "/en"]) {
  test(`Reflow: ${path} has no horizontal scroll at a 320px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}

// ── Category visibility: serial DB-fixture block ──────────────────────────────

test.describe("Category visibility (DB fixture)", () => {
  test.describe.configure({ mode: "serial" });

  // Also clears rows left behind by an aborted earlier run.
  test.beforeAll(async () => {
    await removeTestItems();
    await revalidateSite();
  });

  test.afterAll(async () => {
    await removeTestItems();
    await revalidateSite();
    await endPool();
  });

  test.describe("no public category", () => {
    test("AC-HOME-10b: 'Hvad vi laver' section hidden when no public category exists", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCategory(),
        "Real published catalog content exists; the fixture never unpublishes real rows",
      );
      await page.goto("/");
      // Presence first, so an unrendered page cannot pass the absence check.
      await expect(page.locator("h1")).toContainText(DA_TITLE);
      await expect(page.getByText("Hvad vi laver")).toHaveCount(0);
    });
  });

  test.describe("apps public (published item), websites with a draft item only", () => {
    test.beforeAll(async () => {
      await addTestItem("apps", "published");
      await addTestItem("websites", "draft");
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeTestItems();
      await revalidateSite();
    });

    test("AC-HOME-06: Header nav includes the 'apps' category (has a published item)", async ({
      page,
    }) => {
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      await expect(nav.getByRole("link", { name: /^Apps$/i })).toBeVisible();
    });

    test("AC-HOME-07: Header nav excludes 'websites' category (item is draft)", async ({ page }) => {
      test.skip(
        await hasRealPublicCategory("websites"),
        "Real published websites content exists; the category is legitimately public",
      );
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: /navigat/i });
      // Presence first, so an unrendered nav cannot pass the absence check.
      await expect(nav.getByRole("link", { name: /Forside/i })).toBeVisible();
      await expect(nav.getByRole("link", { name: /Hjemmesider/i })).toHaveCount(0);
    });

    test("AC-HOME-10: 'Hvad vi laver' section visible when apps category has a published item", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.getByText("Hvad vi laver")).toBeVisible();
      await expect(page.locator("#main").getByRole("link", { name: "Apps" })).toHaveAttribute(
        "href",
        "/apps",
      );
    });

    test("AC-HOME-10 (EN): DA-fallback 'Hvad vi laver' block carries lang='da' on /en", async ({
      page,
    }) => {
      await page.goto("/en");
      await expect(page.getByText("Hvad vi laver")).toHaveAttribute("lang", "da");
      await expect(page.getByText("Én samarbejdspartner, flere muligheder")).toHaveAttribute(
        "lang",
        "da",
      );
    });

    test("AC-HOME-11: 'Se ydelser' absent when services category has no published items", async ({
      page,
    }) => {
      test.skip(
        await hasRealPublicCategory("services"),
        "Real published services content exists; the button is legitimately shown",
      );
      await page.goto("/");
      // Presence first, so an unrendered page cannot pass the absence check.
      await expect(page.locator("h1")).toContainText(DA_TITLE);
      await expect(page.getByRole("link", { name: /Se ydelser/i })).toHaveCount(0);
    });
  });

  test.describe("services public (published item)", () => {
    test.beforeAll(async () => {
      await addTestItem("services", "published");
      await revalidateSite();
    });

    test.afterAll(async () => {
      await removeTestItems();
      await revalidateSite();
    });

    test("AC-HOME-11b: 'Se ydelser' button visible when services category has a published item", async ({
      page,
    }) => {
      await page.goto("/");
      const btn = page.getByRole("link", { name: /Se ydelser/i });
      await expect(btn).toBeVisible();
      await expect(btn).toHaveAttribute("href", "/ydelser");
    });
  });
});
