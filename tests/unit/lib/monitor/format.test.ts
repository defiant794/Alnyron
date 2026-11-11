/**
 * Unit tests: src/lib/monitor/format.ts — formatRelative and formatDateTime
 * write in the locale they are given (the Monitor panel's UI language).
 * Journey: monitor-i18n (Monitor UI in the chosen language)
 *
 * The expected strings are the runtime's ICU output (Node ships full ICU);
 * spaces are matched with `\s`, as newer ICU writes a narrow no-break space
 * before "AM"/"PM".
 */
import { describe, it, expect } from "vitest";
import { formatDateTime, formatRelative } from "@/lib/monitor/format";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("formatRelative: a past moment relative to now, in locale", () => {
  it.each([
    ["da", ago(3 * 24 * 3600), "for 3 dage siden"],
    ["da", ago(24 * 3600), "i går"],
    ["da", ago(2 * 3600), "for 2 timer siden"],
    ["da", ago(5 * 60), "for 5 minutter siden"],
    ["da", ago(0), "nu"],
    ["en", ago(3 * 24 * 3600), "3 days ago"],
    ["en", ago(24 * 3600), "yesterday"],
    ["en", ago(2 * 3600), "2 hours ago"],
    ["en", ago(5 * 60), "5 minutes ago"],
    ["en", ago(0), "now"],
  ] as const)("%s: %s → %j", (locale, iso, expected) => {
    expect(formatRelative(iso, locale, NOW)).toBe(expected);
  });

  it("the same moment reads differently per locale (no shared formatter)", () => {
    const iso = ago(30);
    expect(formatRelative(iso, "da", NOW)).toBe("for 30 sekunder siden");
    expect(formatRelative(iso, "en", NOW)).toBe("30 seconds ago");
  });
});

describe("formatDateTime: Copenhagen date and time, in locale", () => {
  const ISO = "2026-11-05T10:00:00Z"; // 11:00 in Copenhagen (CET)

  it("defaults to Danish (the emails and the admin)", () => {
    expect(formatDateTime(ISO)).toBe("5. nov. 2026, 11.00");
  });

  it("da: Danish date and 24-hour time", () => {
    expect(formatDateTime(ISO, "da")).toBe("5. nov. 2026, 11.00");
  });

  it("en: English date and 12-hour time", () => {
    expect(formatDateTime(ISO, "en")).toMatch(/^Nov 5, 2026, 11:00\sAM$/);
  });

  it("en: keeps Copenhagen summer time (UTC+2)", () => {
    expect(formatDateTime("2026-07-05T10:00:00Z", "en")).toMatch(/^Jul 5, 2026, 12:00\sPM$/);
  });
});
