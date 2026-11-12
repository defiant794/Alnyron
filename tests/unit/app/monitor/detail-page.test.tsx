// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(panel)/monitors/[id]/page.tsx — monitor detail + history,
 * multi-line change summaries kept on their lines.
 * Journey: monitor-web-area  MON-AC39, MON-AC40, MON-AC41; monitor-engine  ENG-AC1
 * Journey: payments-slice1-foundation  PAY1-AC2i, PAY1-AC2j
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { notFound } from "next/navigation";
import type * as NextNavigation from "next/navigation";
import type * as MonitorLocaleModule from "@/i18n/monitor-locale";
import { getMonitorLocale } from "@/i18n/monitor-locale";

const { mockRequireMonitor, mockGetMonitor, mockListMonitorEvents } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockGetMonitor: vi.fn(),
  mockListMonitorEvents: vi.fn(),
}));

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
// Partial: the locale-aware frontpage link builds on next-intl's navigation, which needs the real module.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  usePathname: () => "/monitor/monitors/aaa",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMonitor: mockRequireMonitor }));
vi.mock("@/services/monitor/monitors", () => ({
  getMonitor: mockGetMonitor,
  listMonitorEvents: mockListMonitorEvents,
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signOut: vi.fn() }));
// MonitorShell links the footer's privacy page on the main site (NEXT_PUBLIC_SITE_URL).
vi.mock("@/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/env")>()),
  parseSiteEnv: () => ({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }),
}));
vi.mock("@/components/site/SiteFooter", () => ({
  default: ({ locale }: { locale: string }) => (
    <footer data-testid="site-footer" data-locale={locale} />
  ),
}));
vi.mock("@/components/monitor/MonitorMainNav", () => ({
  default: () => <nav aria-label="Hovednavigation" data-testid="monitor-main-nav" />,
}));
// SiteMenu (the shell's small-screen "Menu" disclosure) reads the App Router's
// current route, which a page test has no context for; render its contents.
vi.mock("@/components/site/SiteMenu", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The page reads the visitor's Monitor language from a cookie; there is no request here: Danish.
vi.mock("@/i18n/monitor-locale", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorLocaleModule>()),
  getMonitorLocale: vi.fn(async () => "da" as const),
}));

import MonitorDetailPage, { generateMetadata as generateDetailMetadata } from "@/app/monitor/(panel)/monitors/[id]/page";
import { loadMessages } from "@/i18n/messages";

const { Monitor } = loadMessages("da");

const TEST_MONITOR_ID = "00000000-0000-0000-0000-000000000011";
const TEST_MONITOR = {
  id: TEST_MONITOR_ID,
  url: "https://example.com/",
  label: "My Site",
  status: "active" as const,
  interval_minutes: 1440,
  last_checked_at: null,
  consecutive_errors: 0,
  created_at: "2026-11-01T10:00:00Z",
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMonitor.mockResolvedValue({ userId: "u1", email: "mon@test.local", role: "monitor_user" });
  mockGetMonitor.mockResolvedValue(TEST_MONITOR);
  mockListMonitorEvents.mockResolvedValue([]);
});

async function renderDetail(id = TEST_MONITOR_ID) {
  render(await MonitorDetailPage({ params: Promise.resolve({ id }) }));
}

describe("MON-AC40: detail page renders monitor header", () => {
  it("MON-AC40a: shows monitor label as heading", async () => {
    await renderDetail();
    expect(screen.getByText("My Site")).toBeInTheDocument();
  });

  it("MON-AC40b: shows the URL", async () => {
    await renderDetail();
    expect(document.body.textContent).toContain("example.com");
  });

  it("MON-AC40c: shows 'Ikke tjekket endnu' when last_checked_at is null", async () => {
    await renderDetail();
    expect(document.body.textContent).toContain(Monitor.detail.notCheckedYet);
  });

  it("MON-AC40d: shows 'Overvågning oprettet' creation entry", async () => {
    await renderDetail();
    expect(document.body.textContent).toContain(Monitor.detail.createdEntry);
  });
});

describe("MON-AC41: empty state when no events", () => {
  it("MON-AC41a: shows 'Ingen ændringer endnu' when event list is empty", async () => {
    await renderDetail();
    expect(screen.getByText(Monitor.detail.noChanges)).toBeInTheDocument();
  });

  it("MON-AC41b: the empty state comes after (below) the 'Overvågning oprettet' entry", async () => {
    await renderDetail();
    const created = screen.getByText(Monitor.detail.createdEntry);
    const empty = screen.getByText(Monitor.detail.noChanges);
    expect(created.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("MON-AC41c: with events there is no empty state", async () => {
    mockListMonitorEvents.mockResolvedValue([
      { id: "e1", monitor_id: TEST_MONITOR_ID, detected_at: "2026-11-05T10:00:00Z", summary: "Changed" },
    ]);
    await renderDetail();
    expect(screen.queryByText(Monitor.detail.noChanges)).not.toBeInTheDocument();
  });
});

describe("MON-AC40: events shown newest-first", () => {
  it("MON-AC40e: renders events (delegated to service ordering)", async () => {
    mockListMonitorEvents.mockResolvedValue([
      { id: "e1", monitor_id: TEST_MONITOR_ID, detected_at: "2026-11-05T10:00:00Z", summary: "Changed" },
      { id: "e2", monitor_id: TEST_MONITOR_ID, detected_at: "2026-11-04T10:00:00Z", summary: "Earlier change" },
    ]);
    await renderDetail();
    expect(document.body.textContent).toContain("Changed");
    expect(document.body.textContent).toContain("Earlier change");
  });
});

describe("MON-AC39: another user's (or a missing) monitor → notFound", () => {
  // RLS hides another account's monitor, so getMonitor resolves null for it,
  // exactly as for an id that does not exist.
  const OTHER_MONITOR_ID = "00000000-0000-0000-0000-000000000077";

  it("MON-AC39d: a valid id getMonitor does not resolve → notFound(); nothing else is read", async () => {
    mockGetMonitor.mockResolvedValue(null);
    await expect(MonitorDetailPage({ params: Promise.resolve({ id: OTHER_MONITOR_ID }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mockGetMonitor).toHaveBeenCalledWith(OTHER_MONITOR_ID);
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(mockListMonitorEvents).not.toHaveBeenCalled();
  });

  it("MON-AC39f: a non-UUID id → notFound() without a query", async () => {
    await expect(MonitorDetailPage({ params: Promise.resolve({ id: "other-id" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockGetMonitor).not.toHaveBeenCalled();
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe("ENG-AC1: summary element has whitespace-pre-line for multi-line diffs", () => {
  it("ENG-AC1wp: event summary <p> carries the class whitespace-pre-line", async () => {
    mockListMonitorEvents.mockResolvedValue([
      {
        id: "e-wp",
        monitor_id: TEST_MONITOR_ID,
        detected_at: "2026-11-08T10:00:00Z",
        summary: "+ New paragraph\n\u2212 Old paragraph",
      },
    ]);
    await renderDetail();
    // Exactly one paragraph renders event.summary, with its line breaks kept for whitespace-pre-line.
    const summaries = [...document.querySelectorAll("p.whitespace-pre-line")].map((el) => el.textContent);
    expect(summaries).toEqual(["+ New paragraph\n\u2212 Old paragraph"]);
  });
});

// ── A11Y-06/07/08: generateMetadata — 404 cases return "Siden findes ikke" ────

describe("A11Y-06: detail generateMetadata — non-UUID id resolves 'Siden findes ikke' without querying DB", () => {
  it("A11Y-06a: title is 'Siden findes ikke'", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(metadata.title).toBe("Siden findes ikke");
  });

  it("A11Y-06b: robots is 'noindex, nofollow'", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("A11Y-06c: getMonitor is NOT called for a non-UUID id", async () => {
    await generateDetailMetadata({ params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(mockGetMonitor).not.toHaveBeenCalled();
  });

  it("A11Y-06d: does not throw for a non-UUID id", async () => {
    await expect(generateDetailMetadata({ params: Promise.resolve({ id: "not-a-uuid" }) })).resolves.toBeDefined();
  });
});

describe("A11Y-07: detail generateMetadata — valid UUID, getMonitor returns null, resolves 'Siden findes ikke'", () => {
  const MISSING_ID = "00000000-0000-0000-0000-000000000099";

  beforeEach(() => {
    mockGetMonitor.mockResolvedValue(null);
  });

  it("A11Y-07a: title is 'Siden findes ikke'", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: MISSING_ID }) });
    expect(metadata.title).toBe("Siden findes ikke");
  });

  it("A11Y-07b: robots is 'noindex, nofollow'", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: MISSING_ID }) });
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("A11Y-07c: does not throw when monitor is null", async () => {
    await expect(generateDetailMetadata({ params: Promise.resolve({ id: MISSING_ID }) })).resolves.toBeDefined();
  });
});

describe("A11Y-08: detail generateMetadata — found monitor keeps its label as title", () => {
  it("A11Y-08a: title equals monitor.label ('My Site')", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: TEST_MONITOR_ID }) });
    expect(metadata.title).toBe("My Site");
  });

  it("A11Y-08b: robots is 'noindex, nofollow'", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: TEST_MONITOR_ID }) });
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("A11Y-08c: title is a non-empty string", async () => {
    const metadata = await generateDetailMetadata({ params: Promise.resolve({ id: TEST_MONITOR_ID }) });
    expect(typeof metadata.title).toBe("string");
    expect((metadata.title as string).length).toBeGreaterThan(0);
  });
});

// ── PAY1-AC2i/j: ?limit=reached → limit-reached alert ───────────────────────
// Journey: payments-slice1-foundation  PAY1-AC2i, PAY1-AC2j
//
// Copy: factual — pause or delete frees a slot (pausing is cheaper than deleting).
// Pin the exact strings.

const DA_LIMIT_REACHED_ALERT =
  "Du har nået grænsen for aktive overvågninger. Sæt en anden overvågning på pause, eller slet en, for at genoptage denne.";
const EN_LIMIT_REACHED_ALERT =
  "You have reached the limit for active monitors. Pause or delete another monitor to resume this one.";

/** Render the detail page WITH the ?limit=reached search param. */
async function renderDetailWithLimitFlag(locale: "da" | "en" = "da"): Promise<void> {
  vi.mocked(getMonitorLocale).mockResolvedValueOnce(locale);
  render(await MonitorDetailPage({
    params: Promise.resolve({ id: TEST_MONITOR_ID }),
    searchParams: Promise.resolve({ limit: "reached" }),
  }));
}

/** Render the detail page WITHOUT any search params (normal visit). */
async function renderDetailNoFlag(): Promise<void> {
  render(await MonitorDetailPage({ params: Promise.resolve({ id: TEST_MONITOR_ID }) }));
}

describe("PAY1-AC2i: detail page with ?limit=reached shows limit alert with role=alert (DA)", () => {
  it("PAY1-AC2i: role=alert element is rendered", async () => {
    await renderDetailWithLimitFlag("da");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("PAY1-AC2i-copy: alert contains the pinned Danish copy", async () => {
    await renderDetailWithLimitFlag("da");
    expect(screen.getByRole("alert").textContent).toContain(DA_LIMIT_REACHED_ALERT);
  });

  it("PAY1-AC2i-absent: no alert without the query flag", async () => {
    await renderDetailNoFlag();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("PAY1-AC2i-absent-other: no alert when flag is a different value", async () => {
    render(await MonitorDetailPage({
      params: Promise.resolve({ id: TEST_MONITOR_ID }),
      searchParams: Promise.resolve({ limit: "other" }),
    }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PAY1-AC2j: detail page with ?limit=reached shows limit alert in EN", () => {
  it("PAY1-AC2j: role=alert element is rendered for EN visitor", async () => {
    await renderDetailWithLimitFlag("en");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("PAY1-AC2j-copy: alert contains the pinned English copy", async () => {
    await renderDetailWithLimitFlag("en");
    expect(screen.getByRole("alert").textContent).toContain(EN_LIMIT_REACHED_ALERT);
  });
});
