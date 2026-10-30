// Unit tests for F0.5 home-page — site settings content service
// Acceptance ID: AC-HOME-SETTINGS-01
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the public Supabase client ───────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock("@/lib/supabase/public", () => ({
  getPublicClient: () => ({ from: mockFrom }),
}));

import { getSiteSettings } from "@/services/content/settings";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const settingsRow = {
  company_name: "Alnyron",
  contact_email: "info@alnyron.dk",
};

function mockSettingsRow(row: typeof settingsRow | null) {
  // Chain: .from("site_settings").select("company_name, contact_email") resolves
  // to the row list; the service reads the first row.
  mockSelect.mockResolvedValue({
    data: row ? [row] : [],
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-HOME-SETTINGS-01: returns mapped settings ──────────────────────────────

describe("AC-HOME-SETTINGS-01: getSiteSettings — maps DB row to SiteSettings", () => {
  it("returns companyName from site_settings.company_name", async () => {
    mockSettingsRow(settingsRow);
    const result = await getSiteSettings();
    expect(result.companyName).toBe("Alnyron");
  });

  it("returns contactEmail from site_settings.contact_email", async () => {
    mockSettingsRow(settingsRow);
    const result = await getSiteSettings();
    expect(result.contactEmail).toBe("info@alnyron.dk");
  });

  it("queries the site_settings table", async () => {
    mockSettingsRow(settingsRow);
    await getSiteSettings();
    expect(mockFrom).toHaveBeenCalledWith("site_settings");
  });

  it("selects at minimum company_name and contact_email", async () => {
    mockSettingsRow(settingsRow);
    await getSiteSettings();
    const selectArg: string = mockSelect.mock.calls[0]![0] as string;
    expect(selectArg).toMatch(/company_name/);
    expect(selectArg).toMatch(/contact_email/);
  });
});

// ── Return shape contract ──────────────────────────────────────────────────────

describe("getSiteSettings — return shape", () => {
  it("returns an object with companyName and contactEmail", async () => {
    mockSettingsRow(settingsRow);
    const result = await getSiteSettings();
    expect(result).toHaveProperty("companyName");
    expect(result).toHaveProperty("contactEmail");
  });

  it("companyName is a non-empty string", async () => {
    mockSettingsRow(settingsRow);
    const result = await getSiteSettings();
    expect(typeof result.companyName).toBe("string");
    expect(result.companyName.length).toBeGreaterThan(0);
  });

  it("contactEmail is a non-empty string", async () => {
    mockSettingsRow(settingsRow);
    const result = await getSiteSettings();
    expect(typeof result.contactEmail).toBe("string");
    expect(result.contactEmail.length).toBeGreaterThan(0);
  });
});

// ── AC-HOME-SETTINGS-01: failures throw, never empty company details ──────────
// A thrown read keeps the last good ISR page instead of caching one with an
// empty footer.

describe("AC-HOME-SETTINGS-01: getSiteSettings — failed reads throw", () => {
  it("throws with the query error message when the query fails", async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(getSiteSettings()).rejects.toThrow(
      "Failed to load site settings: permission denied",
    );
  });

  it("throws when the site_settings row is missing", async () => {
    mockSettingsRow(null);
    await expect(getSiteSettings()).rejects.toThrow(
      "Failed to load site settings: no site_settings row",
    );
  });

  it("throws when the query returns no data at all", async () => {
    mockSelect.mockResolvedValue({ data: null, error: null });
    await expect(getSiteSettings()).rejects.toThrow(
      "Failed to load site settings: no site_settings row",
    );
  });
});
