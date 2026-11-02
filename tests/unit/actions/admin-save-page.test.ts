/**
 * Unit tests — savePage server action (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-01, 01b, 02, 03, 04, 04b, 05, 06, 08, 09, 10
 *
 * Expected module: src/app/admin/(panel)/pages/actions.ts
 * Pattern mirrors F1.1 auth-actions.test.ts and require-admin.test.ts.
 *
 * Key DB facts (from migrations):
 *  - admin_save_page reads payload->>'id' (NOT 'page_id') for the row lookup.
 *    core.sql:271: `v_id uuid := nullif(payload ->> 'id', '')::uuid`
 *  - admin_save_page replaces `content` WHOLESALE per locale (no merge).
 *    The action must use a PER-SYSTEM-KEY strict zod write schema (separate
 *    from the lenient read schema in services/content/pages.ts that uses
 *    .prefault({}) — that leniency is correct for reads, but the write path
 *    must require all blocks and keys so a partial save can never wipe siblings.
 *  - 23514 has multiple sources, distinguished by error message:
 *      "system pages have fixed routes" → routes_guard
 *      "page_translations_da_title"    → CHECK on page_translations
 *  - missing_slugs / P0001 is in admin_set_page_status, NOT here.
 *
 * Contact page seeded content (20261101000300_seed_system_content.sql):
 *   content: { eyebrow: "Kontakt", responseTime: "Typisk inden for 1-2 hverdage",
 *              languages: "Dansk / English" }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRequireAdmin, mockRpc, mockRevalidate, mockMaybeSingle, mockFrom } = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn();
  const mockFrom = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: mockMaybeSingle,
      })),
    })),
  }));
  return {
    mockRequireAdmin: vi.fn(),
    mockRpc: vi.fn(),
    mockRevalidate: vi.fn(),
    mockMaybeSingle,
    mockFrom,
  };
});

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({
    rpc: mockRpc,
    from: mockFrom,
  })),
}));

vi.mock("@/lib/revalidate", () => ({
  revalidatePublicContent: mockRevalidate,
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { savePage } from "@/app/admin/(panel)/pages/actions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_USER = {
  userId: "00000000-0000-0000-0000-000000000099",
  email: "admin@alnyron.dk",
  role: "owner" as const,
};

/**
 * Seeded contact-page content shape (seed migration 20261101000300).
 * Using real field names so the per-page zod write schema can be tested.
 */
const CONTACT_FULL_CONTENT = {
  eyebrow: "Kontakt",
  responseTime: "Typisk inden for 1-2 hverdage",
  languages: "Dansk / English",
};

/**
 * Minimal valid payload for the contact system page.
 * The RPC reads `payload->>'id'` (core.sql:271), NOT 'page_id'.
 * System pages have fixed routes so no `slug` field is sent.
 */
const CONTACT_PAYLOAD = {
  id: "a1b2c3d4-0000-0000-0000-000000000001",
  system_key: "contact" as const,
  show_in_nav: true,
  translations: {
    da: {
      title: "Lad os tale om dit projekt",
      lead: "Skriv til os, så vender vi hurtigt tilbage.",
      body_md: "",
      content: CONTACT_FULL_CONTENT,
      seo_title: "",
      seo_description: "",
    },
    en: {
      title: "",
      lead: "",
      body_md: "",
      content: {} as typeof CONTACT_FULL_CONTENT,
      seo_title: "",
      seo_description: "",
    },
  },
};

/** Full home-page content (both required blocks). */
const HOME_FULL_CONTENT = {
  whatWeDo: { eyebrow: "Hvad vi laver", title: "Én samarbejdspartner", intro: "Vi arbejder:", note: "" },
  ctaBand: { title: "Klar til at komme i gang?", text: "Skriv til {email}." },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function rpcSuccess(returnedId = "a1b2c3d4-0000-0000-0000-000000000001") {
  mockRpc.mockResolvedValue({ data: returnedId, error: null });
}

function rpcError(code: string, message: string) {
  mockRpc.mockResolvedValue({ data: null, error: { code, message } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN_USER);
  mockRevalidate.mockResolvedValue(undefined);
  // Default: pages lookup finds the contact page's system_key
  mockMaybeSingle.mockResolvedValue({ data: { system_key: "contact" }, error: null });
});

// ── AC-PAGES-01: requireAdmin gate ────────────────────────────────────────────

describe("AC-PAGES-01: savePage — requireAdmin called before RPC", () => {
  it("AC-PAGES-01: requireAdmin() is called before admin_save_page", async () => {
    rpcSuccess();
    await savePage(CONTACT_PAYLOAD);
    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    const requireOrder = mockRequireAdmin.mock.invocationCallOrder[0]!;
    const rpcOrder = mockRpc.mock.invocationCallOrder[0]!;
    expect(requireOrder).toBeLessThan(rpcOrder);
  });

  it("AC-PAGES-01b: unauthenticated caller (requireAdmin throws) — RPC never called", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT:/admin/login"));
    await expect(savePage(CONTACT_PAYLOAD)).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── AC-PAGES-02: full content object sent to RPC ──────────────────────────────

describe("AC-PAGES-02: savePage — full content object passed to admin_save_page", () => {
  it("AC-PAGES-02: payload to admin_save_page includes id (not page_id) and complete content for each locale", async () => {
    rpcSuccess();
    await savePage(CONTACT_PAYLOAD);
    // RPC reads payload->>'id', not 'page_id'
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_save_page",
      expect.objectContaining({
        payload: expect.objectContaining({
          id: "a1b2c3d4-0000-0000-0000-000000000001",
          translations: expect.objectContaining({
            da: expect.objectContaining({ content: CONTACT_FULL_CONTENT }),
          }),
        }),
      }),
    );
  });

  it("AC-PAGES-02b: show_in_nav is included at the top level of the payload", async () => {
    rpcSuccess();
    await savePage(CONTACT_PAYLOAD);
    expect(mockRpc).toHaveBeenCalledWith(
      "admin_save_page",
      expect.objectContaining({
        payload: expect.objectContaining({ show_in_nav: true }),
      }),
    );
  });
});

// ── AC-PAGES-03: strict write schema rejects partial content ──────────────────

describe("AC-PAGES-03: savePage — strict per-system_key write schema rejects partial content", () => {
  /**
   * The READ schema in services/content/pages.ts uses .prefault({}) + .default(""),
   * which fills every missing block/key with blanks.  That leniency is correct
   * for reads; the WRITE path requires a separate strict schema per system_key
   * that requires all blocks and all keys within each block.  Without it a
   * partial save would silently wipe sibling blocks (admin_save_page replaces
   * content wholesale via coalesce(v_tr -> 'content', '{}'::jsonb)).
   */

  it("AC-PAGES-03a: home payload with ctaBand block entirely missing → validation error, RPC not called", async () => {
    const homeMissingBlock = {
      id: "a1b2c3d4-0000-0000-0000-000000000002",
      system_key: "home" as const,
      show_in_nav: true,
      translations: {
        da: {
          title: "Forside",
          lead: "",
          body_md: "",
          // ctaBand entirely absent — would wipe it in the DB
          content: { whatWeDo: HOME_FULL_CONTENT.whatWeDo },
          seo_title: "",
          seo_description: "",
        },
        en: {
          title: "",
          lead: "",
          body_md: "",
          content: { whatWeDo: { eyebrow: "", title: "", intro: "", note: "" } },
          seo_title: "",
          seo_description: "",
        },
      },
    };

    const result = await savePage(homeMissingBlock);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("AC-PAGES-03b: home payload with ctaBand present but missing required key 'text' → validation error, RPC not called", async () => {
    const homeMissingKey = {
      id: "a1b2c3d4-0000-0000-0000-000000000002",
      system_key: "home" as const,
      show_in_nav: true,
      translations: {
        da: {
          title: "Forside",
          lead: "",
          body_md: "",
          // ctaBand present but missing the 'text' key — would zero it out
          content: { whatWeDo: HOME_FULL_CONTENT.whatWeDo, ctaBand: { title: "Klar?" } },
          seo_title: "",
          seo_description: "",
        },
        en: {
          title: "",
          lead: "",
          body_md: "",
          content: {},
          seo_title: "",
          seo_description: "",
        },
      },
    };

    const result = await savePage(homeMissingKey);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("AC-PAGES-03c: contact payload with responseTime key missing → validation error, RPC not called", async () => {
    const contactMissingKey = {
      ...CONTACT_PAYLOAD,
      translations: {
        ...CONTACT_PAYLOAD.translations,
        da: {
          ...CONTACT_PAYLOAD.translations.da,
          // Missing 'languages' key — would wipe it from the stored content
          content: { eyebrow: "Kontakt", responseTime: "1-2 hverdage" },
        },
      },
    };

    const result = await savePage(contactMissingKey);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

// ── AC-PAGES-04: revalidatePublicContent on success ──────────────────────────

describe("AC-PAGES-04: savePage — revalidates public content after successful save", () => {
  it("AC-PAGES-04: revalidatePublicContent() called when admin_save_page succeeds", async () => {
    rpcSuccess();
    await savePage(CONTACT_PAYLOAD);
    expect(mockRevalidate).toHaveBeenCalledOnce();
  });

  it("AC-PAGES-04b: revalidatePublicContent() NOT called when admin_save_page returns an error", async () => {
    rpcError("23505", 'duplicate key value violates unique constraint "routes_pkey"');
    await savePage(CONTACT_PAYLOAD);
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

// ── AC-PAGES-05: 23505 → slug-taken ──────────────────────────────────────────

describe("AC-PAGES-05: savePage — 23505 unique violation → slug-taken field error", () => {
  it("AC-PAGES-05: RPC error code 23505 → result { error: 'slug-taken' }", async () => {
    rpcError("23505", 'duplicate key value violates unique constraint "routes_pkey"');
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toMatchObject({ error: "slug-taken" });
  });
});

// ── AC-PAGES-06: 23514 "system pages have fixed routes" → system-slug ─────────

describe("AC-PAGES-06: savePage — 23514 'system pages have fixed routes' → system-slug error", () => {
  it("AC-PAGES-06: RPC 23514 routes_guard message → result { error: 'system-slug' }", async () => {
    rpcError("23514", "system pages have fixed routes");
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toMatchObject({ error: "system-slug" });
  });
});

// ── AC-PAGES-08: P0002 → not-found ───────────────────────────────────────────

describe("AC-PAGES-08: savePage — P0002 → not-found error", () => {
  it("AC-PAGES-08: RPC error code P0002 → result { error: 'not-found' }", async () => {
    rpcError("P0002", "page_not_found");
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toMatchObject({ error: "not-found" });
  });
});

// ── AC-PAGES-09: 42501 → forbidden ───────────────────────────────────────────

describe("AC-PAGES-09: savePage — 42501 → forbidden error", () => {
  it("AC-PAGES-09: RPC error code 42501 → result { error: 'forbidden' }", async () => {
    rpcError("42501", "forbidden");
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toMatchObject({ error: "forbidden" });
  });
});

// ── AC-PAGES-10: 23514 page_translations_da_title → da-title-required ─────────

describe("AC-PAGES-10: savePage — 23514 page_translations_da_title CHECK → da-title-required", () => {
  it("AC-PAGES-10: RPC 23514 with page_translations_da_title constraint in message → result { error: 'da-title-required' }", async () => {
    // Discriminated from AC-06 by the message string, not just the error code.
    rpcError(
      "23514",
      'new row for relation "page_translations" violates check constraint "page_translations_da_title"',
    );
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toMatchObject({ error: "da-title-required" });
  });
});

// ── L1 security: system_key mismatch, missing row, non-GUID id ───────────────

describe("L1-PAGES-SEC: savePage — GUID validation and system_key guard", () => {
  it("L1-PAGES-SEC-01: stored system_key ≠ client system_key → invalid, admin_save_page NOT called", async () => {
    // DB has system_key 'home' but client sends 'contact' — mismatch → invalid
    mockMaybeSingle.mockResolvedValueOnce({ data: { system_key: "home" }, error: null });
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).toHaveBeenCalledWith("pages");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("L1-PAGES-SEC-02: pages lookup returns no row (data null) → not-found, admin_save_page NOT called", async () => {
    // DB has no row for this id → not-found
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(mockFrom).toHaveBeenCalledWith("pages");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("L1-PAGES-SEC-03: non-GUID id → invalid, no DB call at all", async () => {
    // pageIdSchema = z.guid() — a non-UUID id fails schema parse before any DB call
    const badPayload = { ...CONTACT_PAYLOAD, id: "not-a-uuid" };
    const result = await savePage(badPayload);
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("L1-PAGES-SEC-04: pages lookup returns 42501 error → forbidden, admin_save_page NOT called", async () => {
    // Supabase RLS / permission error on the pages lookup → failure() maps 42501 → forbidden
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "permission denied" } });
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(mockFrom).toHaveBeenCalledWith("pages");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("L1-PAGES-SEC-05: pages lookup returns row with system_key null (custom page) → not-found, admin_save_page NOT called", async () => {
    // Custom pages have system_key:null — treated as not-found to prevent overwriting via system-page path
    mockMaybeSingle.mockResolvedValueOnce({ data: { system_key: null }, error: null });
    const result = await savePage(CONTACT_PAYLOAD);
    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(mockFrom).toHaveBeenCalledWith("pages");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
