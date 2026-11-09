// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(panel)/monitors/[id]/page.tsx — monitor detail + history,
 * multi-line change summaries kept on their lines.
 * Journey: monitor-web-area  MON-AC39, MON-AC40, MON-AC41; monitor-engine  ENG-AC1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { notFound } from "next/navigation";

const { mockRequireMonitor, mockGetMonitor, mockListMonitorEvents } = vi.hoisted(() => ({
  mockRequireMonitor: vi.fn(),
  mockGetMonitor: vi.fn(),
  mockListMonitorEvents: vi.fn(),
}));

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
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

import MonitorDetailPage from "@/app/monitor/(panel)/monitors/[id]/page";
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
