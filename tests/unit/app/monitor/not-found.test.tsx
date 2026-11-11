// @vitest-environment jsdom
/**
 * Unit tests: src/app/monitor/not-found.tsx — Monitor 404 boundary metadata
 * Journey: a11y-polish  A11Y-05
 *
 * generateMetadata() must be exported by the not-found boundary and return
 *   { title: "Siden findes ikke", robots: "noindex, nofollow" }
 * so WCAG 2.4.2 (Page Titled, Level A) is satisfied on the Monitor 404 page.
 */

import { describe, it, expect, vi } from "vitest";
import type { Metadata } from "next";

vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);

// MonitorAuthFrame renders next/link which needs next/navigation.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => "/monitor",
  useRouter: () => ({ push: vi.fn() }),
}));

// Namespace import: generateMetadata is read as an optional export.
import * as NotFoundModule from "@/app/monitor/not-found";
const { generateMetadata } = NotFoundModule as { generateMetadata?: () => Promise<Metadata> };

describe("A11Y-05: MonitorNotFound — generateMetadata export", () => {
  it("A11Y-05a: generateMetadata is a function (export exists)", () => {
    expect(typeof generateMetadata).toBe("function");
  });

  it("A11Y-05b: generateMetadata() resolves title 'Siden findes ikke'", async () => {
    const metadata = await generateMetadata!();
    expect(metadata.title).toBe("Siden findes ikke");
  });

  it("A11Y-05c: generateMetadata() resolves robots 'noindex, nofollow'", async () => {
    const metadata = await generateMetadata!();
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("A11Y-05d: generateMetadata() title is a non-empty string", async () => {
    const metadata = await generateMetadata!();
    expect(typeof metadata.title).toBe("string");
    expect((metadata.title as string).length).toBeGreaterThan(0);
  });
});
