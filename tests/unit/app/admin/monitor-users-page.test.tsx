// @vitest-environment jsdom
/**
 * Unit test — `/admin/monitor-users` page (admin-monitor-users)
 * Journey: admin-monitor-users  AC-AMU-01, AC-AMU-02, AC-AMU-03, AC-AMU-04,
 *          AC-AMU-11, AC-AMU-13, AC-AMU-20, AC-AMU-21
 *
 * Pattern follows tests/unit/app/admin/pages-page.test.tsx:
 *  - real next-intl server mock (throws on missing keys)
 *  - requireAdmin mocked; redirect propagation tested for non-admin + anon
 *  - listMonitorSignups mocked
 *  - real da.json strings pinned literally below
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { MonitorSignup } from "@/services/admin/monitor-users";
import da from "../../../../messages/da.json";

// ── Pinned DA strings (from messages/da.json Admin.monitorUsers) ──────────────
const DA_TITLE        = "Monitor-brugere";
const DA_LEAD         = "Alle der har tilmeldt sig Monitor, nyeste først.";
const DA_CAPTION      = "Tilmeldinger";
const DA_EMAIL        = "E-mail";
const DA_SIGNED_UP    = "Tilmeldt";
const DA_CONFIRMED    = "Bekræftet";
const DA_MONITORS     = "Overvågninger";
const DA_YES          = "Ja";
const DA_NO           = "Nej";
const DA_EMPTY        = "Ingen tilmeldinger endnu.";
const DA_NAV_LABEL    = "Monitor-brugere";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockListMonitorSignups, mockRequireAdmin, mockRedirect } = vi.hoisted(() => ({
  mockListMonitorSignups: vi.fn<() => Promise<MonitorSignup[]>>(),
  mockRequireAdmin: vi.fn(async () => ({ userId: "u-1", email: "ejer@example.com", role: "owner" as const })),
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// vi.mock factories are hoisted above static imports by Vite, so the helper
// must be imported dynamically inside the factory (static import would not
// yet exist at hoist time).
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));
vi.mock("@/services/admin/monitor-users", () => ({
  listMonitorSignups: mockListMonitorSignups,
}));
vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

import AdminMonitorUsersPage, { generateMetadata } from "@/app/admin/(panel)/monitor-users/page";
import { ADMIN_MONITOR_USERS_PATH } from "@/config/admin";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ROWS: MonitorSignup[] = [
  { email: "a@example.com", signedUpAt: "2026-10-15T09:00:00.000Z", confirmed: true,  monitorCount: 2 },
  { email: "b@example.com", signedUpAt: "2026-09-01T14:30:00.000Z", confirmed: false, monitorCount: 0 },
];

const OWNER_USER = { userId: "u-1", email: "ejer@example.com", role: "owner" as const };

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(OWNER_USER);
});

// ── AC-AMU-02: metadata title ─────────────────────────────────────────────────

describe("AC-AMU-02: generateMetadata — title is 'Monitor-brugere'", () => {
  it("AC-AMU-02: generateMetadata returns { title: 'Monitor-brugere' }", async () => {
    const meta = await generateMetadata();
    expect(meta.title).toBe(DA_TITLE);
  });
});

// ── AC-AMU-20: requireAdmin redirect — non-admin → /admin/no-access ───────────

describe("AC-AMU-20: requireAdmin redirect — non-admin → /admin/no-access", () => {
  it("AC-AMU-20a: requireAdmin is called before listMonitorSignups", async () => {
    const callOrder: string[] = [];
    mockRequireAdmin.mockImplementation(async () => {
      callOrder.push("requireAdmin");
      return OWNER_USER;
    });
    mockListMonitorSignups.mockImplementation(async () => {
      callOrder.push("listMonitorSignups");
      return [];
    });

    render(await AdminMonitorUsersPage());

    expect(callOrder.indexOf("requireAdmin")).toBeLessThan(callOrder.indexOf("listMonitorSignups"));
  });

  it("AC-AMU-20b: when requireAdmin redirects to /admin/no-access, listMonitorSignups is not called", async () => {
    mockRequireAdmin.mockImplementation(async () => mockRedirect("/admin/no-access"));

    await expect(AdminMonitorUsersPage()).rejects.toThrow("NEXT_REDIRECT:/admin/no-access");
    expect(mockListMonitorSignups).not.toHaveBeenCalled();
  });
});

// ── AC-AMU-21: requireAdmin redirect — anon → /admin/login ───────────────────

describe("AC-AMU-21: requireAdmin redirect — anonymous → /admin/login", () => {
  it("AC-AMU-21: when requireAdmin redirects to /admin/login, listMonitorSignups is not called", async () => {
    mockRequireAdmin.mockImplementation(async () => mockRedirect("/admin/login"));

    await expect(AdminMonitorUsersPage()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    expect(mockListMonitorSignups).not.toHaveBeenCalled();
  });
});

// ── AC-AMU-02: PageHeader title + lead ───────────────────────────────────────

describe("AC-AMU-02: AdminMonitorUsersPage — PageHeader title and lead from da.json", () => {
  it("AC-AMU-02a: renders a heading with title 'Monitor-brugere'", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
  });

  it("AC-AMU-02c: renders the lead text 'Alle der har tilmeldt sig Monitor, nyeste først.'", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByText(DA_LEAD)).toBeInTheDocument();
  });
});

// ── AC-AMU-13: caption heading ────────────────────────────────────────────────

describe("AC-AMU-13: AdminMonitorUsersPage — table labelled by the h2 'Tilmeldinger'", () => {
  it("AC-AMU-13: renders an h2 'Tilmeldinger' that names the table", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByRole("heading", { level: 2, name: DA_CAPTION })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: DA_CAPTION })).toBeInTheDocument();
  });
});

// ── AC-AMU-03: column headers in order ───────────────────────────────────────

describe("AC-AMU-03: AdminMonitorUsersPage — four column headers from da.json in order", () => {
  it("AC-AMU-03: renders column headers E-mail, Tilmeldt, Bekræftet, Overvågninger in order", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).toHaveTextContent(DA_EMAIL);
    expect(headers[1]).toHaveTextContent(DA_SIGNED_UP);
    expect(headers[2]).toHaveTextContent(DA_CONFIRMED);
    expect(headers[3]).toHaveTextContent(DA_MONITORS);
  });
});

// ── AC-AMU-04: rows rendered ──────────────────────────────────────────────────

describe("AC-AMU-04: AdminMonitorUsersPage — rows rendered from listMonitorSignups", () => {
  it("AC-AMU-04: both fixture email row headers appear in the table in order", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    const table = screen.getByRole("table");
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("a@example.com");
    expect(rowHeaders[1]).toHaveTextContent("b@example.com");
  });
});

// ── AC-AMU-11: empty state ────────────────────────────────────────────────────

describe("AC-AMU-11: AdminMonitorUsersPage — empty state renders paragraph, no table", () => {
  it("AC-AMU-11a: empty list renders 'Ingen tilmeldinger endnu.'", async () => {
    mockListMonitorSignups.mockResolvedValue([]);

    render(await AdminMonitorUsersPage());

    expect(screen.getByText(DA_EMPTY)).toBeInTheDocument();
  });

  it("AC-AMU-11b: empty list does not render a table", async () => {
    mockListMonitorSignups.mockResolvedValue([]);

    render(await AdminMonitorUsersPage());

    expect(screen.queryByRole("table")).toBeNull();
  });
});

// ── AC-AMU-01: ADMIN_MONITOR_USERS_PATH pin ──────────────────────────────────

describe("AC-AMU-01: ADMIN_MONITOR_USERS_PATH is '/admin/monitor-users'", () => {
  it("AC-AMU-01: the exported config constant equals '/admin/monitor-users'", () => {
    expect(ADMIN_MONITOR_USERS_PATH).toBe("/admin/monitor-users");
  });
});

// ── da.json key existence pins ────────────────────────────────────────────────

describe("da.json Admin.monitorUsers — all contract keys pinned", () => {
  function monitorUsers(): Record<string, unknown> {
    const admin = da.Admin as Record<string, unknown>;
    return (admin["monitorUsers"] ?? {}) as Record<string, unknown>;
  }

  function table(): Record<string, unknown> {
    return (monitorUsers()["table"] ?? {}) as Record<string, unknown>;
  }

  function confirmed(): Record<string, unknown> {
    return (monitorUsers()["confirmed"] ?? {}) as Record<string, unknown>;
  }

  it("AC-AMU-02-da: Admin.monitorUsers.title === 'Monitor-brugere'", () => {
    expect(monitorUsers()["title"]).toBe(DA_TITLE);
  });

  it("AC-AMU-02-da: Admin.monitorUsers.lead === 'Alle der har tilmeldt sig Monitor, nyeste først.'", () => {
    expect(monitorUsers()["lead"]).toBe(DA_LEAD);
  });

  it("AC-AMU-13-da: Admin.monitorUsers.table.caption === 'Tilmeldinger'", () => {
    expect(table()["caption"]).toBe(DA_CAPTION);
  });

  it("AC-AMU-03-da: Admin.monitorUsers.table.email === 'E-mail'", () => {
    expect(table()["email"]).toBe(DA_EMAIL);
  });

  it("AC-AMU-03-da: Admin.monitorUsers.table.signedUp === 'Tilmeldt'", () => {
    expect(table()["signedUp"]).toBe(DA_SIGNED_UP);
  });

  it("AC-AMU-03-da: Admin.monitorUsers.table.confirmed === 'Bekræftet'", () => {
    expect(table()["confirmed"]).toBe(DA_CONFIRMED);
  });

  it("AC-AMU-03-da: Admin.monitorUsers.table.monitors === 'Overvågninger'", () => {
    expect(table()["monitors"]).toBe(DA_MONITORS);
  });

  it("AC-AMU-06-da: Admin.monitorUsers.confirmed.yes === 'Ja'", () => {
    expect(confirmed()["yes"]).toBe(DA_YES);
  });

  it("AC-AMU-07-da: Admin.monitorUsers.confirmed.no === 'Nej'", () => {
    expect(confirmed()["no"]).toBe(DA_NO);
  });

  it("AC-AMU-11-da: Admin.monitorUsers.empty === 'Ingen tilmeldinger endnu.'", () => {
    expect(monitorUsers()["empty"]).toBe(DA_EMPTY);
  });

  it("AC-AMU-01-da: Admin.nav.monitorUsers === 'Monitor-brugere'", () => {
    const nav = da.Admin.nav as Record<string, unknown>;
    expect(nav["monitorUsers"]).toBe(DA_NAV_LABEL);
  });
});
