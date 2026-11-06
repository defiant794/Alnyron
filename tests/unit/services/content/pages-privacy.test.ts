/**
 * Unit tests — getPrivacyPage content tokens (src/services/content/pages.ts)
 * Acceptance: AC-CVR-02 (`{cvr}` in the policy renders site_settings.cvr),
 *             `{email}` keeps rendering the contact address next to it.
 *
 * The data-controller section comes from 20261106000300_site_cvr.sql; the
 * rest of the policy from 20261101000300_seed_system_content.sql. EN starts
 * blank and shows the Danish policy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIn = vi.fn();

// Chain: .from("page_translations").select(...).eq(...).in("locale", [...])
vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ in: mockIn }) }) }) }),
}));
vi.mock("@/services/content/settings", () => ({ getSiteSettings: vi.fn() }));

import { getPrivacyPage } from "@/services/content/pages";
import { getSiteSettings } from "@/services/content/settings";

const DA_BODY = [
  "Denne politik beskriver, hvordan Alnyron behandler personoplysninger.",
  "## Dataansvarlig",
  "Alnyron, CVR {cvr}, er dataansvarlig for behandlingen af dine personoplysninger.",
  "## Kontakt",
  "Spørgsmål om persondata: {email}.",
].join("\n\n");

const row = (locale: string, body_md: string) => ({
  locale,
  title: locale === "da" ? "Privatlivspolitik" : "",
  lead: "",
  body_md,
  content: locale === "da" ? { eyebrow: "Privatliv" } : {},
  seo_title: "",
  seo_description: "",
  pages: { system_key: "privacy" },
});

function mockSettings(cvr: string | null) {
  vi.mocked(getSiteSettings).mockResolvedValue({ companyName: "Alnyron", contactEmail: "info@alnyron.dk", cvr });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings("46887433");
  mockIn.mockResolvedValue({ data: [row("da", DA_BODY), row("en", "")], error: null });
});

describe("AC-CVR-02: getPrivacyPage — {cvr} in body_md renders site_settings.cvr", () => {
  it("AC-CVR-02a: the DA data-controller line names the CVR from site_settings", async () => {
    const { value } = await getPrivacyPage("da");
    expect(value.body_md).toContain("Alnyron, CVR 46887433, er dataansvarlig");
    expect(value.body_md).not.toContain("{cvr}");
  });

  it("AC-CVR-02b: EN with a blank body shows the Danish policy with the CVR", async () => {
    const { value, fallbackKeys } = await getPrivacyPage("en");
    expect(value.body_md).toContain("Alnyron, CVR 46887433, er dataansvarlig");
    expect(fallbackKeys).toContain("body_md");
  });

  it("AC-CVR-02c: EN's own policy text gets the CVR too", async () => {
    mockIn.mockResolvedValue({
      data: [row("da", DA_BODY), row("en", "## Data controller\n\nAlnyron, CVR {cvr}, is the data controller.")],
      error: null,
    });
    const { value, fallbackKeys } = await getPrivacyPage("en");
    expect(value.body_md).toBe("## Data controller\n\nAlnyron, CVR 46887433, is the data controller.");
    expect(fallbackKeys).not.toContain("body_md");
  });

  it("AC-CVR-02d: follows site_settings.cvr, not a fixed number", async () => {
    mockSettings("12345678");
    const { value } = await getPrivacyPage("da");
    expect(value.body_md).toContain("Alnyron, CVR 12345678, er dataansvarlig");
  });

  it("AC-CVR-02e: replaces every {cvr}, as plain text (no link)", async () => {
    mockIn.mockResolvedValue({ data: [row("da", "CVR {cvr}. Igen: {cvr}.")], error: null });
    const { value } = await getPrivacyPage("da");
    expect(value.body_md).toBe("CVR 46887433. Igen: 46887433.");
  });

  it("AC-CVR-02f: no raw {cvr} token reaches the page while the CVR is not set", async () => {
    mockSettings(null);
    const { value } = await getPrivacyPage("da");
    expect(value.body_md).not.toContain("{cvr}");
  });

  it("keeps rendering {email} as an autolink to site_settings.contact_email", async () => {
    const { value } = await getPrivacyPage("da");
    expect(value.body_md).toContain("Spørgsmål om persondata: <info@alnyron.dk>.");
  });
});
