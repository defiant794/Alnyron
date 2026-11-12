// @vitest-environment jsdom
/**
 * Unit test — `/admin/monitor-users` page (admin-monitor-users-cleanup + admin-monitor-users-sites)
 * Journey: admin-monitor-users       AC-AMU-01, AC-AMU-02, AC-AMU-02c, AC-AMU-04, AC-AMU-11, AC-AMU-13, AC-AMU-20, AC-AMU-21
 * Journey: admin-monitor-users-cleanup  AMC-16, AMC-21, AMC-27, AMC-28
 * Journey: admin-monitor-users-sites    AMSS-13, Overvåger da.json copy pins (Overvåger header: AMC-16)
 * Journey: payments-slice1-foundation   PAY1-AC6d
 *
 * Pattern follows tests/unit/app/monitor/dashboard-page.test.tsx:
 *  - next-intl/server mocked with the real createTranslator, so the ICU
 *    plurals (summary, lead) are asserted as the text a user reads; a missing
 *    key throws
 *  - the dialog body is formatted in the browser by the page's real
 *    NextIntlClientProvider (AMC-21c)
 *  - requireAdmin mocked; redirect propagation tested for non-admin + anon
 *  - listMonitorSignups mocked; monitorSignupStatus uses the real module under
 *    vi.useFakeTimers() (AMC-27, AMC-28); da.json string pins are literal values
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import type { MonitorSignup } from "@/services/admin/monitor-users";
import da from "../../../../messages/da.json";

// ── Pinned DA strings (from messages/da.json Admin.monitorUsers — contract shape) ──

const DA_TITLE        = "Monitor-brugere";
const DA_CAPTION      = "Tilmeldinger";
const DA_EMAIL        = "E-mail";
/** Contract: table.signedUp value is "Oprettet" (signup time column heading). */
const DA_OPRETTET     = "Oprettet";
const DA_STATUS       = "Status";
const DA_MONITORS     = "Overvågninger";
const DA_ACTIONS      = "Handlinger";
const DA_REGISTERED   = "Tilmeldt";
const DA_PENDING      = "Afventer bekræftelse";
const DA_EXPIRED      = "Udløbet";
const DA_EMPTY        = "Ingen tilmeldinger endnu.";
const DA_NAV_LABEL    = "Monitor-brugere";
/** The PageHeader description as a user reads it: the window from the config (10) through the ICU plural. */
const DA_LEAD =
  "Alle der har tilmeldt sig Monitor, nyeste først. En tilmelding, der ikke er bekræftet inden for 10 minutter, er udløbet.";
const DA_DELETE_BODY_MESSAGE =
  "<strong>{email}</strong> og alle kontoens overvågninger slettes permanent. Det kan ikke fortrydes.";

// ── Fixed "now" for the AMC-27/AMC-28 fake-timer tests ────────────────────────

const FIXED_NOW = new Date("2026-11-10T12:00:00.000Z");

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockListMonitorSignups, mockRequireAdmin, mockRedirect } = vi.hoisted(() => ({
  mockListMonitorSignups: vi.fn<() => Promise<MonitorSignup[]>>(),
  mockRequireAdmin: vi.fn(async () => ({
    userId: "u-1",
    email: "ejer@example.com",
    role: "owner" as const,
  })),
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Real next-intl formatting (the shared helper returns plural syntax as is), so
// the summary and the lead are asserted as the full text a user reads. A missing
// key throws. The factory is hoisted above the static imports, so it loads its
// modules itself.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { loadMessages } = await import("@/i18n/messages");
  return {
    getTranslations: vi.fn(async ({ locale, namespace }: { locale: "da"; namespace: "Admin.monitorUsers" }) =>
      createTranslator({
        locale,
        messages: loadMessages(locale),
        namespace,
        onError: (error) => {
          throw error;
        },
      }),
    ),
  };
});
vi.mock("@/services/auth/require-admin", () => ({
  requireAdmin: mockRequireAdmin,
}));
vi.mock("@/services/admin/monitor-users", () => ({
  listMonitorSignups: mockListMonitorSignups,
}));
// The table (client component) imports the server action directly; mock it so
// the server-action module is not loaded in the unit test environment.
vi.mock("@/app/admin/(panel)/monitor-users/actions", () => ({
  deleteMonitorSignup: vi.fn(),
}));
// The table's catch around the delete action passes navigation errors (a redirect)
// on with unstable_rethrow, so the mocked module provides it next to redirect.
vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  unstable_rethrow: vi.fn(),
}));

import AdminMonitorUsersPage, { generateMetadata } from "@/app/admin/(panel)/monitor-users/page";
import { ADMIN_MONITOR_USERS_PATH } from "@/config/admin";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ROWS: MonitorSignup[] = [
  {
    userId: "u-newer",
    email: "a@example.com",
    signedUpAt: "2026-10-15T09:00:00.000Z",
    confirmed: true,
    monitorCount: 2,
    monitors: [],
  },
  {
    userId: "u-older",
    email: "b@example.com",
    signedUpAt: "2026-09-01T14:30:00.000Z",
    confirmed: false,
    monitorCount: 0,
    monitors: [],
  },
];

/**
 * Rows with timestamps relative to FIXED_NOW for AMC-28 (fake-timer tests).
 * The real monitorSignupStatus runs against these under vi.setSystemTime.
 *
 * FIXED_NOW = 2026-11-10T12:00:00.000Z; window = 10 minutes.
 *   confirmed@: confirmed=true, 30 min old → "registered"
 *   pending@:   confirmed=false, 5 min old → "pending"
 *   expired@:   confirmed=false, 11 min old → "expired"
 */
const ROWS_STATUS: MonitorSignup[] = [
  {
    userId: "u-confirmed",
    email: "confirmed@example.com",
    // 30 min before FIXED_NOW; confirmed → "registered"
    signedUpAt: "2026-11-10T11:30:00.000Z",
    confirmed: true,
    monitorCount: 1,
    monitors: [],
  },
  {
    userId: "u-pending",
    email: "pending@example.com",
    // 5 min before FIXED_NOW; unconfirmed, age < 10 min → "pending"
    signedUpAt: "2026-11-10T11:55:00.000Z",
    confirmed: false,
    monitorCount: 0,
    monitors: [],
  },
  {
    userId: "u-expired",
    email: "expired@example.com",
    // 11 min before FIXED_NOW; unconfirmed, age ≥ 10 min → "expired"
    signedUpAt: "2026-11-10T11:49:00.000Z",
    confirmed: false,
    monitorCount: 0,
    monitors: [],
  },
];

/**
 * Rows for the plural summary under FIXED_NOW (AMC-27): two confirmed signups
 * and three unconfirmed ones signed up 11 min, 1 h and 1 day before it, so
 * 2 registered, 0 pending and 3 expired.
 */
const ROWS_PLURAL: MonitorSignup[] = [
  { userId: "u-p1", email: "p1@example.com", signedUpAt: "2026-11-10T11:30:00.000Z", confirmed: true,  monitorCount: 1, monitors: [] },
  { userId: "u-p2", email: "p2@example.com", signedUpAt: "2026-11-09T12:00:00.000Z", confirmed: true,  monitorCount: 0, monitors: [] },
  { userId: "u-p3", email: "p3@example.com", signedUpAt: "2026-11-10T11:49:00.000Z", confirmed: false, monitorCount: 0, monitors: [] },
  { userId: "u-p4", email: "p4@example.com", signedUpAt: "2026-11-10T11:00:00.000Z", confirmed: false, monitorCount: 0, monitors: [] },
  { userId: "u-p5", email: "p5@example.com", signedUpAt: "2026-11-09T12:00:00.000Z", confirmed: false, monitorCount: 0, monitors: [] },
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

    expect(callOrder).toEqual(["requireAdmin", "listMonitorSignups"]);
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

// ── AC-AMU-02: PageHeader title ───────────────────────────────────────────────

describe("AC-AMU-02: AdminMonitorUsersPage — PageHeader title from da.json", () => {
  it("AC-AMU-02a: renders a heading with title 'Monitor-brugere'", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByRole("heading", { name: DA_TITLE })).toBeInTheDocument();
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

// ── AMC-16: six column headers in order ───────────────────────────────────────

describe("AMC-16: AdminMonitorUsersPage — six column headers from da.json in order", () => {
  it("AMC-16: renders column headers E-mail, Oprettet, Status, Overvåger, Overvågninger, Handlinger in order", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).toHaveTextContent(DA_EMAIL);
    expect(headers[1]).toHaveTextContent(DA_OPRETTET);
    expect(headers[2]).toHaveTextContent(DA_STATUS);
    // headers[3] = Overvåger (new)
    expect(headers[3]).toHaveTextContent("Overvåger");
    expect(headers[4]).toHaveTextContent(DA_MONITORS);
    expect(headers[5]).toHaveTextContent(DA_ACTIONS);
  });
});

// ── AC-AMU-04: rows rendered ──────────────────────────────────────────────────

describe("AC-AMU-04: AdminMonitorUsersPage — rows rendered from listMonitorSignups", () => {
  it("AC-AMU-04: fixture email row headers appear in the table in order", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    const table = screen.getByRole("table");
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders[0]).toHaveTextContent("a@example.com");
    expect(rowHeaders[1]).toHaveTextContent("b@example.com");
  });
});

// ── AMC-28: page computes statuses via real monitorSignupStatus + fake timers ──

describe("AMC-28: AdminMonitorUsersPage — computes status per row via monitorSignupStatus (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AMC-28a: confirmed row renders 'Tilmeldt' status badge", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS_STATUS);

    render(await AdminMonitorUsersPage());

    const confirmedRow = screen
      .getByRole("rowheader", { name: "confirmed@example.com" })
      .closest("tr") as HTMLElement;
    expect(within(confirmedRow).getAllByRole("cell")[1]).toHaveTextContent(DA_REGISTERED);
  });

  it("AMC-28b: unconfirmed-recent row renders 'Afventer bekræftelse' status badge", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS_STATUS);

    render(await AdminMonitorUsersPage());

    const pendingRow = screen
      .getByRole("rowheader", { name: "pending@example.com" })
      .closest("tr") as HTMLElement;
    expect(within(pendingRow).getAllByRole("cell")[1]).toHaveTextContent(DA_PENDING);
  });

  it("AMC-28c: unconfirmed-old row renders 'Udløbet' status badge", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS_STATUS);

    render(await AdminMonitorUsersPage());

    const expiredRow = screen
      .getByRole("rowheader", { name: "expired@example.com" })
      .closest("tr") as HTMLElement;
    expect(within(expiredRow).getAllByRole("cell")[1]).toHaveTextContent(DA_EXPIRED);
  });
});

// ── AMC-27 / AC-AMU-02c: summary and lead formatted by the real ICU plurals ───

describe("AMC-27 / AC-AMU-02c: AdminMonitorUsersPage — summary of the computed statuses and the lead through the ICU plurals (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AMC-27c: one signup of each status describes the table as '1 tilmeldt · 1 afventer · 1 udløbet'", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS_STATUS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByRole("table", { description: "1 tilmeldt · 1 afventer · 1 udløbet" })).toBeInTheDocument();
  });

  it("AMC-27d: the plural forms — two registered, none pending, three expired → '2 tilmeldte · 0 afventer · 3 udløbne'", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS_PLURAL);

    render(await AdminMonitorUsersPage());

    expect(screen.getByRole("table", { description: "2 tilmeldte · 0 afventer · 3 udløbne" })).toBeInTheDocument();
  });

  it("AC-AMU-02c: the PageHeader description gives the confirm window from the config through the ICU plural ('inden for 10 minutter')", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);

    render(await AdminMonitorUsersPage());

    expect(screen.getByText(DA_LEAD)).toBeInTheDocument();
  });
});

// ── AMC-21: dialog body formatted by next-intl in the client ─────────────────

describe("AMC-21: AdminMonitorUsersPage — the delete dialog's body is formatted by the page's client provider", () => {
  beforeEach(() => {
    // jsdom: HTMLDialogElement lacks showModal; the polyfill opens the dialog.
    HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
  });

  it("AMC-21c: Slet opens a dialog described by delete.body with the row's address filled in, in bold", async () => {
    mockListMonitorSignups.mockResolvedValue(ROWS);
    const user = userEvent.setup();

    render(await AdminMonitorUsersPage());
    await user.click(screen.getByRole("button", { name: /^\s*Slet[\s\S]*a@example\.com/ }));

    const dialog = screen.getByRole("dialog", {
      name: "Slet tilmelding?",
      description: "a@example.com og alle kontoens overvågninger slettes permanent. Det kan ikke fortrydes.",
    });
    expect(within(dialog).getByText("a@example.com", { selector: "strong" })).toBeInTheDocument();
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

// ── da.json key pins ──────────────────────────────────────────────────────────

describe("da.json Admin.monitorUsers — all contract keys pinned", () => {
  function monitorUsers(): Record<string, unknown> {
    const admin = da.Admin as Record<string, unknown>;
    return (admin["monitorUsers"] ?? {}) as Record<string, unknown>;
  }

  function table(): Record<string, unknown> {
    return (monitorUsers()["table"] ?? {}) as Record<string, unknown>;
  }

  function status(): Record<string, unknown> {
    return (monitorUsers()["status"] ?? {}) as Record<string, unknown>;
  }

  function deleteKeys(): Record<string, unknown> {
    return (monitorUsers()["delete"] ?? {}) as Record<string, unknown>;
  }

  function deleteErrors(): Record<string, unknown> {
    return (deleteKeys()["errors"] ?? {}) as Record<string, unknown>;
  }

  it("AC-AMU-02-da: Admin.monitorUsers.title === 'Monitor-brugere'", () => {
    expect(monitorUsers()["title"]).toBe(DA_TITLE);
  });

  it("AC-AMU-13-da: Admin.monitorUsers.table.caption === 'Tilmeldinger'", () => {
    expect(table()["caption"]).toBe(DA_CAPTION);
  });

  it("AMC-16-da-email: Admin.monitorUsers.table.email === 'E-mail'", () => {
    expect(table()["email"]).toBe(DA_EMAIL);
  });

  it("AMC-16-da-signedUp: Admin.monitorUsers.table.signedUp === 'Oprettet'", () => {
    expect(table()["signedUp"]).toBe(DA_OPRETTET);
  });

  it("AMC-16-da-status: Admin.monitorUsers.table.status === 'Status'", () => {
    expect(table()["status"]).toBe(DA_STATUS);
  });

  it("AMC-16-da-monitors: Admin.monitorUsers.table.monitors === 'Overvågninger'", () => {
    expect(table()["monitors"]).toBe(DA_MONITORS);
  });

  it("AMC-16-da-actions: Admin.monitorUsers.table.actions === 'Handlinger'", () => {
    expect(table()["actions"]).toBe(DA_ACTIONS);
  });

  it("AMC-17-da: Admin.monitorUsers.table does NOT have key 'confirmed'", () => {
    expect(Object.keys(table())).not.toContain("confirmed");
  });

  it("AMC-17-da: Admin.monitorUsers does NOT have key 'confirmed' (no badge namespace)", () => {
    expect(Object.keys(monitorUsers())).not.toContain("confirmed");
  });

  it("AMC-18-da: Admin.monitorUsers.status.registered === 'Tilmeldt'", () => {
    expect(status()["registered"]).toBe(DA_REGISTERED);
  });

  it("AMC-19-da: Admin.monitorUsers.status.pending === 'Afventer bekræftelse'", () => {
    expect(status()["pending"]).toBe(DA_PENDING);
  });

  it("AMC-20-da: Admin.monitorUsers.status.expired === 'Udløbet'", () => {
    expect(status()["expired"]).toBe(DA_EXPIRED);
  });

  it("AMC-21-da: Admin.monitorUsers.delete.open === 'Slet'", () => {
    expect(deleteKeys()["open"]).toBe("Slet");
  });

  it("AMC-21-da: Admin.monitorUsers.delete.title === 'Slet tilmelding?'", () => {
    expect(deleteKeys()["title"]).toBe("Slet tilmelding?");
  });

  it("AMC-21-da-body: Admin.monitorUsers.delete.body names the address in <strong> and the permanent loss", () => {
    expect(deleteKeys()["body"]).toBe(DA_DELETE_BODY_MESSAGE);
  });

  it("AMC-23-da: Admin.monitorUsers.delete.confirm === 'Slet tilmelding'", () => {
    expect(deleteKeys()["confirm"]).toBe("Slet tilmelding");
  });

  it("AMC-24-da: Admin.monitorUsers.delete.pending === 'Sletter\u2026'", () => {
    expect(deleteKeys()["pending"]).toBe("Sletter\u2026");
  });

  it("AMC-22-da: Admin.monitorUsers.delete.cancel === 'Annuller'", () => {
    expect(deleteKeys()["cancel"]).toBe("Annuller");
  });

  it("AMC-25-da-failed: Admin.monitorUsers.delete.errors.failed", () => {
    expect(deleteErrors()["failed"]).toBe("Tilmeldingen kunne ikke slettes. Prøv igen.");
  });

  it("AMC-25-da-notFound: Admin.monitorUsers.delete.errors.notFound", () => {
    expect(deleteErrors()["notFound"]).toBe("Tilmeldingen findes ikke længere.");
  });

  it("AMC-25-da-notMonitorUser: Admin.monitorUsers.delete.errors.notMonitorUser", () => {
    expect(deleteErrors()["notMonitorUser"]).toBe("Kun Monitor-brugere kan slettes her.");
  });

  it("AC-AMU-11-da: Admin.monitorUsers.empty === 'Ingen tilmeldinger endnu.'", () => {
    expect(monitorUsers()["empty"]).toBe(DA_EMPTY);
  });

  it("AC-AMU-02c-da: Admin.monitorUsers.lead pluralises {minutes}", () => {
    expect(monitorUsers()["lead"]).toBe(
      "Alle der har tilmeldt sig Monitor, nyeste først. En tilmelding, der ikke er bekræftet inden for {minutes, plural, one {# minut} other {# minutter}}, er udløbet.",
    );
  });

  it("AMC-27-da: Admin.monitorUsers.summary pluralises the registered and expired counts", () => {
    expect(monitorUsers()["summary"]).toBe(
      "{registered, plural, one {# tilmeldt} other {# tilmeldte}} · {pending} afventer · {expired, plural, one {# udløbet} other {# udløbne}}",
    );
  });

  it("AC-AMU-01-da: Admin.nav.monitorUsers === 'Monitor-brugere'", () => {
    const nav = da.Admin.nav as Record<string, unknown>;
    expect(nav["monitorUsers"]).toBe(DA_NAV_LABEL);
  });
});

// ── AMSS da.json key pins — new copy for Overvåger column ────────────────────
// Journey: admin-monitor-users-sites   AC: da.json has sites/none/paused/newTab keys

describe("da.json Admin.monitorUsers — Overvåger column copy (AMSS)", () => {
  function monitorUsers(): Record<string, unknown> {
    const admin = da.Admin as Record<string, unknown>;
    return (admin["monitorUsers"] ?? {}) as Record<string, unknown>;
  }

  function table(): Record<string, unknown> {
    return (monitorUsers()["table"] ?? {}) as Record<string, unknown>;
  }

  function sites(): Record<string, unknown> {
    return (monitorUsers()["sites"] ?? {}) as Record<string, unknown>;
  }

  it("AMSS-da-table-sites: Admin.monitorUsers.table.sites === 'Overvåger'", () => {
    expect(table()["sites"]).toBe("Overvåger");
  });

  it("AMSS-da-sites-none: Admin.monitorUsers.sites.none === 'Ingen'", () => {
    expect(sites()["none"]).toBe("Ingen");
  });

  it("AMSS-da-sites-paused: Admin.monitorUsers.sites.paused === 'sat på pause'", () => {
    expect(sites()["paused"]).toBe("sat på pause");
  });

  it("AMSS-da-sites-newTab: Admin.monitorUsers.sites.newTab === 'åbner i ny fane'", () => {
    expect(sites()["newTab"]).toBe("åbner i ny fane");
  });
});

// ── AMSS-13: page passes monitors through to the table rows ──────────────────
// Journey: admin-monitor-users-sites   AC: page passes monitors array to table

describe("AMSS-13: AdminMonitorUsersPage — monitors array flows through to MonitorSignupsTable rows", () => {
  it("AMSS-13: a row with 1 monitor renders a link in the Overvåger column", async () => {
    const rowWithSite: MonitorSignup = {
      userId: "u-with-site",
      email: "site@example.com",
      signedUpAt: "2026-10-20T10:00:00.000Z",
      confirmed: true,
      monitorCount: 1,
      monitors: [{ url: "https://my-site.example.com", label: "My Site", status: "active" }],
    };
    mockListMonitorSignups.mockResolvedValue([rowWithSite]);

    render(await AdminMonitorUsersPage());

    // The link is named by displayUrl(url); the label is a muted note beside it
    const link = screen.getByRole("link", { name: /^my-site\.example\.com/ });
    expect(link).toHaveAttribute("href", "https://my-site.example.com");
    expect(screen.getByText("My Site")).toHaveClass("text-muted");
  });
});

// ── PAY1-AC6d: admin delete dialog shows has-active-subscription copy ─────────
// Journey: payments-slice1-foundation  PAY1-AC6d
//
// Pin the exact Danish copy for the has-active-subscription guard.

const DA_HAS_ACTIVE_SUBSCRIPTION =
  "Kontoen har et abonnement, der ikke er ophørt, og kan først slettes, når det er ophørt.";

describe("PAY1-AC6d: da.json Admin.monitorUsers.delete.errors.hasActiveSubscription — key exists and is pinned", () => {
  function deleteErrors(): Record<string, unknown> {
    const admin = da.Admin as Record<string, unknown>;
    const mu = (admin["monitorUsers"] ?? {}) as Record<string, unknown>;
    const del = (mu["delete"] ?? {}) as Record<string, unknown>;
    return (del["errors"] ?? {}) as Record<string, unknown>;
  }

  it("PAY1-AC6d-da: Admin.monitorUsers.delete.errors.hasActiveSubscription exists and matches pinned text", () => {
    expect(deleteErrors()["hasActiveSubscription"]).toBe(DA_HAS_ACTIVE_SUBSCRIPTION);
  });
});

