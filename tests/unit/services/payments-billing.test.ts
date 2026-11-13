/**
 * Unit tests: src/services/payments/billing.ts — billing service (mocked Supabase).
 * Journey: payments-slice1b-billing  PAY1B-AC43, PAY1B-AC44
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUBSCRIPTION_ENDED_STATUSES,
  SUBSCRIPTION_ENTITLING_STATUSES,
} from "@/config/payments";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(async () => ({ from: mockFrom })),
}));
// B1: getCurrentSubscription names the plan in the visitor's Monitor language (a cookie; no request here).
vi.mock("@/i18n/monitor-locale", () => ({ getMonitorLocale: vi.fn(async () => "da") }));
// The per-user reads also filter on the session's own user id: the RLS policies admit an admin
// (the owner may use Monitor) to every account's subscriptions and billing_customers rows.
const SESSION_USER_ID = "00000000-0000-0000-0000-0000000000aa";
vi.mock("@/services/auth/require-role", () => ({
  requireMonitor: vi.fn(async () => ({ userId: SESSION_USER_ID, email: "sub@test.local", role: "monitor_user" })),
}));

import { getMonitorLocale } from "@/i18n/monitor-locale";
import { requireMonitor } from "@/services/auth/require-role";
import {
  listMonitorPlans,
  getMonitorPlanByInterval,
  getCurrentSubscription,
  getBillingCustomerId,
} from "@/services/payments/billing";

beforeEach(() => {
  vi.clearAllMocks();
  // Drops any unconsumed stubQuery() builder, so a test that fails early cannot leak one.
  mockFrom.mockReset();
});

// ── Query builder fakes ───────────────────────────────────────────────────────

type QueryResult = { data: unknown; error: { code: string; message: string } | null };
type QueryCall = [method: string, ...args: unknown[]];

/**
 * Stubs the next `from()` with a PostgREST builder fake that records every call in order;
 * awaiting the builder, or `maybeSingle()`, resolves to `result`. Returns the recorded calls.
 */
function stubQuery(result: QueryResult): QueryCall[] {
  const calls: QueryCall[] = [];
  const builder: Record<string, unknown> = {
    then: (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
    maybeSingle: () => {
      calls.push(["maybeSingle"]);
      return Promise.resolve(result);
    },
  };
  for (const method of ["select", "eq", "not", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  mockFrom.mockReturnValueOnce(builder);
  return calls;
}

type Row = Record<string, string | number | boolean>;
type TableBuilder = {
  select: () => TableBuilder;
  eq: (column: string, value: unknown) => TableBuilder;
  order: (column: string, options: { ascending: boolean }) => TableBuilder;
  limit: (count: number) => TableBuilder;
  maybeSingle: () => Promise<QueryResult>;
};

/**
 * Stubs the next `from()` with a small PostgREST emulation over `rows`: `eq` filters, `order`
 * sorts and `limit` cuts (both applied when the rows are read, whatever the call order), and
 * `maybeSingle()` answers PGRST116 for more than one row, as PostgREST does.
 */
function stubTable(rows: Row[]): void {
  const filters: [string, unknown][] = [];
  const orders: [string, boolean][] = [];
  let limit = Infinity;
  const builder: TableBuilder = {
    select: () => builder,
    eq: (column, value) => {
      filters.push([column, value]);
      return builder;
    },
    order: (column, options) => {
      orders.push([column, options.ascending]);
      return builder;
    },
    limit: (count) => {
      limit = count;
      return builder;
    },
    maybeSingle: async () => {
      const found = rows
        .filter((row) => filters.every(([column, value]) => row[column] === value))
        .sort((a, b) => {
          for (const [column, ascending] of orders) {
            const [x, y] = [a[column], b[column]];
            const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
            if (order !== 0) return ascending ? order : -order;
          }
          return 0;
        })
        .slice(0, limit);
      return found.length > 1
        ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
        : { data: found[0] ?? null, error: null };
    },
  };
  mockFrom.mockReturnValueOnce(builder);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLAN_PRICE_SELECT = "id, stripe_price_id, billing_interval, monitor_limit, amount_ore";

/** A PostgREST error (here a permission denial), as the services receive it. */
const DENIED = { code: "42501", message: "denied" };

/** A `monitor_plans` row as listMonitorPlans selects it (with its translations). */
function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-yr-1",
    stripe_price_id: "price_yr_123",
    billing_interval: "year",
    monitor_limit: 20,
    amount_ore: 9500,
    monitor_plan_translations: [{ locale: "da", name: "Monitor Plus" }],
    ...overrides,
  };
}

// ── PAY1B-AC43: listMonitorPlans ──────────────────────────────────────────────

describe("PAY1B-AC43: listMonitorPlans — active filter, sort_order, locale fallback", () => {
  it("PAY1B-AC43a: reads monitor_plans: active only, ordered by sort_order (then id)", async () => {
    const calls = stubQuery({
      data: [
        planRow(),
        planRow({ id: "plan-mo-1", stripe_price_id: "price_mo_123", billing_interval: "month", amount_ore: 1000 }),
      ],
      error: null,
    });

    const plans = await listMonitorPlans("da");

    expect(mockFrom).toHaveBeenCalledExactlyOnceWith("monitor_plans");
    expect(calls).toEqual([
      ["select", `${PLAN_PRICE_SELECT}, monitor_plan_translations(locale, name)`],
      ["eq", "active", true],
      ["order", "sort_order", { ascending: true }],
      ["order", "id", { ascending: true }],
    ]);
    expect(plans.map((plan) => plan.interval)).toEqual(["year", "month"]);
  });

  it("PAY1B-AC43b: maps DB row to { id, stripePriceId, interval, monitorLimit, amountOre, name }", async () => {
    stubQuery({ data: [planRow()], error: null });

    expect(await listMonitorPlans("da")).toEqual([
      {
        id: "plan-yr-1",
        stripePriceId: "price_yr_123",
        interval: "year",
        monitorLimit: 20,
        amountOre: 9500,
        name: "Monitor Plus",
      },
    ]);
  });

  it("PAY1B-AC43c: uses locale translation name, falls back to da row when locale is en and no en row", async () => {
    stubQuery({ data: [planRow({ monitor_plan_translations: [{ locale: "da", name: "Monitor Plus DA" }] })], error: null });

    const plans = await listMonitorPlans("en");
    expect(plans[0]!.name).toBe("Monitor Plus DA");
  });

  it("PAY1B-AC43d: uses en translation when en row is present", async () => {
    stubQuery({
      data: [
        planRow({
          monitor_plan_translations: [
            { locale: "da", name: "Monitor Plus DA" },
            { locale: "en", name: "Monitor Plus EN" },
          ],
        }),
      ],
      error: null,
    });

    const plans = await listMonitorPlans("en");
    expect(plans[0]!.name).toBe("Monitor Plus EN");
  });

  it("PAY1B-AC43e: throws if amountOre is 0", async () => {
    stubQuery({ data: [planRow({ amount_ore: 0 })], error: null });
    await expect(listMonitorPlans("da")).rejects.toThrow("Payments plan has an invalid amount");
  });

  it("PAY1B-AC43f: throws if amountOre is negative", async () => {
    stubQuery({ data: [planRow({ amount_ore: -100 })], error: null });
    await expect(listMonitorPlans("da")).rejects.toThrow("Payments plan has an invalid amount");
  });

  it("PAY1B-AC43g: throws if amountOre is not a safe integer", async () => {
    stubQuery({ data: [planRow({ amount_ore: Number.MAX_SAFE_INTEGER + 1 })], error: null });
    await expect(listMonitorPlans("da")).rejects.toThrow("Payments plan has an invalid amount");
  });

  it("PAY1B-AC43l: a database error throws 'Payments plans failed: <code> <message>'", async () => {
    stubQuery({ data: null, error: DENIED });
    await expect(listMonitorPlans("da")).rejects.toThrow(new Error("Payments plans failed: 42501 denied"));
  });

  it("PAY1B-AC43m: a plan with an unknown billing interval throws", async () => {
    stubQuery({ data: [planRow({ billing_interval: "week" })], error: null });
    await expect(listMonitorPlans("da")).rejects.toThrow(new Error("Payments plan has an unknown billing interval"));
  });

  it("PAY1B-AC43n: a plan without a name in the locale or in Danish throws", async () => {
    stubQuery({ data: [planRow({ monitor_plan_translations: [] })], error: null });
    await expect(listMonitorPlans("en")).rejects.toThrow(new Error("Payments plan has no name"));
  });
});

// ── PAY1B-AC43: getMonitorPlanByInterval ──────────────────────────────────────

describe("PAY1B-AC43: getMonitorPlanByInterval — the first active plan of the interval, or null", () => {
  it("PAY1B-AC43h: reads the active plan of 'year' in listMonitorPlans' order, one row", async () => {
    const calls = stubQuery({
      data: { id: "plan-yr", stripe_price_id: "price_yr", billing_interval: "year", monitor_limit: 20, amount_ore: 9500 },
      error: null,
    });

    expect(await getMonitorPlanByInterval("year")).toEqual({
      id: "plan-yr",
      stripePriceId: "price_yr",
      interval: "year",
      monitorLimit: 20,
      amountOre: 9500,
    });
    expect(mockFrom).toHaveBeenCalledExactlyOnceWith("monitor_plans");
    expect(calls).toEqual([
      ["select", PLAN_PRICE_SELECT],
      ["eq", "active", true],
      ["eq", "billing_interval", "year"],
      ["order", "sort_order", { ascending: true }],
      ["order", "id", { ascending: true }],
      ["limit", 1],
      ["maybeSingle"],
    ]);
  });

  it("PAY1B-AC43i: returns null when no plan found", async () => {
    const calls = stubQuery({ data: null, error: null });

    expect(await getMonitorPlanByInterval("month")).toBeNull();
    expect(calls).toContainEqual(["eq", "billing_interval", "month"]);
  });

  /** A `monitor_plans` row for stubTable. */
  const plan = (id: string, interval: string, sortOrder: number, active = true): Row => ({
    id,
    stripe_price_id: `price_${id}`,
    billing_interval: interval,
    monitor_limit: 20,
    amount_ore: interval === "year" ? 9500 : 1000,
    active,
    sort_order: sortOrder,
  });

  it("PAY1B-AC43j: two active plans of one interval (a price being replaced) → the first by sort_order, no error", async () => {
    // The expected row is not first in the table: only ordering (not limit alone) picks it.
    stubTable([
      plan("year-new", "year", 3),
      plan("month", "month", 1),
      plan("year-old", "year", 2),
      plan("year-retired", "year", 0, false),
    ]);

    const chosen = await getMonitorPlanByInterval("year");
    expect(chosen?.id).toBe("year-old");
    expect(chosen?.stripePriceId).toBe("price_year-old");
  });

  it("PAY1B-AC43k: equal sort_order → the lower id (the order listMonitorPlans shows them in)", async () => {
    stubTable([plan("year-b", "year", 1), plan("year-a", "year", 1)]);

    expect((await getMonitorPlanByInterval("year"))?.id).toBe("year-a");
  });

  it("PAY1B-AC43o: a database error throws 'Payments plan failed: <code> <message>'", async () => {
    stubQuery({ data: null, error: DENIED });
    await expect(getMonitorPlanByInterval("year")).rejects.toThrow(new Error("Payments plan failed: 42501 denied"));
  });
});

// ── PAY1B-AC44: getCurrentSubscription ───────────────────────────────────────

const SUBSCRIPTION_SELECT =
  "status, current_period_end, cancel_at_period_end, monitor_plans(billing_interval, amount_ore, monitor_plan_translations(locale, name))";

/** A `subscriptions` row as getCurrentSubscription selects it: its plan embedded (null when RLS hides it). */
function subRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "active",
    current_period_end: "2027-06-01T00:00:00+00:00",
    cancel_at_period_end: false,
    monitor_plans: {
      billing_interval: "year",
      amount_ore: 9500,
      monitor_plan_translations: [
        { locale: "da", name: "Monitor Plus" },
        { locale: "en", name: "Monitor Plus EN" },
      ],
    },
    ...overrides,
  };
}

/** What subRow() maps to for a Danish visitor. */
const MAPPED_DA = {
  status: "active",
  interval: "year",
  amountOre: 9500,
  planName: "Monitor Plus",
  currentPeriodEnd: "2027-06-01T00:00:00+00:00",
  cancelAtPeriodEnd: false,
};

describe("PAY1B-AC44: getCurrentSubscription — excludes ended statuses, most recent first", () => {
  it("PAY1B-AC44a: returns null when query returns no rows", async () => {
    stubQuery({ data: null, error: null });
    expect(await getCurrentSubscription()).toBeNull();
  });

  it("PAY1B-AC44b: reads subscriptions: the session's own, not ended, newest first, one row", async () => {
    const calls = stubQuery({ data: null, error: null });

    await getCurrentSubscription();

    expect(mockFrom).toHaveBeenCalledExactlyOnceWith("subscriptions");
    expect(calls).toEqual([
      ["select", SUBSCRIPTION_SELECT],
      ["eq", "user_id", SESSION_USER_ID],
      ["not", "status", "in", "(canceled,incomplete_expired)"],
      ["order", "created_at", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ]);
  });

  it.each([...SUBSCRIPTION_ENTITLING_STATUSES])(
    "PAY1B-AC44c: returns the subscription with entitling status '%s'",
    async (status) => {
      stubQuery({ data: subRow({ status }), error: null });
      expect(await getCurrentSubscription()).toEqual({ ...MAPPED_DA, status });
    },
  );

  it.each(["incomplete", "unpaid", "paused"])(
    "PAY1B-AC44d: returns the subscription with non-ended status '%s' (user must manage it)",
    async (status) => {
      stubQuery({ data: subRow({ status }), error: null });
      expect(await getCurrentSubscription()).toEqual({ ...MAPPED_DA, status });
    },
  );

  it.each([...SUBSCRIPTION_ENDED_STATUSES])(
    "PAY1B-AC44e: ended status '%s' is in the status list the .not(…in…) filter excludes",
    async (status) => {
      const calls = stubQuery({ data: null, error: null });
      await getCurrentSubscription();
      const notCall = calls.find(([method]) => method === "not");
      expect(notCall?.slice(1, 3)).toEqual(["status", "in"]);
      expect(String(notCall?.[3]).slice(1, -1).split(",")).toContain(status);
    },
  );

  it("PAY1B-AC44n: filters on the session's own user id (RLS also admits an admin to every row)", async () => {
    vi.mocked(requireMonitor).mockResolvedValueOnce({
      userId: "00000000-0000-0000-0000-0000000000bb",
      email: "other@test.local",
      role: "owner",
    });
    const calls = stubQuery({ data: null, error: null });
    await getCurrentSubscription();
    expect(calls.filter(([method]) => method === "eq")).toEqual([
      ["eq", "user_id", "00000000-0000-0000-0000-0000000000bb"],
    ]);
  });

  it("PAY1B-AC44j: maps the row and its embedded plan to the exact CurrentSubscription", async () => {
    stubQuery({ data: subRow(), error: null });
    expect(await getCurrentSubscription()).toEqual(MAPPED_DA);
  });

  it("PAY1B-AC44k: names the plan in the visitor's Monitor language, Danish when it has no such name (B1)", async () => {
    vi.mocked(getMonitorLocale).mockResolvedValueOnce("en");
    stubQuery({ data: subRow(), error: null });
    expect((await getCurrentSubscription())?.planName).toBe("Monitor Plus EN");

    vi.mocked(getMonitorLocale).mockResolvedValueOnce("en");
    stubQuery({
      data: subRow({
        monitor_plans: {
          billing_interval: "month",
          amount_ore: 1000,
          monitor_plan_translations: [{ locale: "da", name: "Monitor Plus DA" }],
        },
      }),
      error: null,
    });
    expect(await getCurrentSubscription()).toEqual({
      ...MAPPED_DA,
      interval: "month",
      amountOre: 1000,
      planName: "Monitor Plus DA",
    });
  });

  it("PAY1B-AC44l: a plan hidden by RLS (no longer active) → interval, amountOre and planName null", async () => {
    stubQuery({ data: subRow({ monitor_plans: null }), error: null });
    expect(await getCurrentSubscription()).toEqual({
      ...MAPPED_DA,
      interval: null,
      amountOre: null,
      planName: null,
    });
  });

  it("PAY1B-AC44m: carries cancel_at_period_end and a null current_period_end as they are", async () => {
    stubQuery({ data: subRow({ cancel_at_period_end: true, current_period_end: null }), error: null });
    expect(await getCurrentSubscription()).toEqual({
      ...MAPPED_DA,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: true,
    });
  });

  it("PAY1B-AC44o: a database error throws 'Payments subscription failed: <code> <message>'", async () => {
    stubQuery({ data: null, error: DENIED });
    await expect(getCurrentSubscription()).rejects.toThrow(new Error("Payments subscription failed: 42501 denied"));
  });
});

// ── PAY1B-AC44: getBillingCustomerId ─────────────────────────────────────────

describe("PAY1B-AC44: getBillingCustomerId — returns stripe_customer_id or null", () => {
  it("PAY1B-AC44g: returns stripe_customer_id when the session's billing_customers row exists", async () => {
    const calls = stubQuery({ data: { stripe_customer_id: "cus_test_abc123" }, error: null });

    expect(await getBillingCustomerId()).toBe("cus_test_abc123");
    expect(mockFrom).toHaveBeenCalledExactlyOnceWith("billing_customers");
    expect(calls).toEqual([
      ["select", "stripe_customer_id"],
      ["eq", "user_id", SESSION_USER_ID],
      ["maybeSingle"],
    ]);
  });

  it("PAY1B-AC44h: returns null when no billing_customers row exists", async () => {
    stubQuery({ data: null, error: null });
    expect(await getBillingCustomerId()).toBeNull();
  });

  it("PAY1B-AC44i: the user id comes from the session (requireMonitor), never from a caller", async () => {
    vi.mocked(requireMonitor).mockResolvedValueOnce({
      userId: "00000000-0000-0000-0000-0000000000cc",
      email: "owner@test.local",
      role: "owner",
    });
    const calls = stubQuery({ data: null, error: null });

    await getBillingCustomerId();

    expect(calls).toContainEqual(["eq", "user_id", "00000000-0000-0000-0000-0000000000cc"]);
    expect(calls.filter(([method]) => method === "eq")).toHaveLength(1);
  });

  it("PAY1B-AC44p: a database error throws 'Payments customer failed: <code> <message>'", async () => {
    stubQuery({ data: null, error: DENIED });
    await expect(getBillingCustomerId()).rejects.toThrow(new Error("Payments customer failed: 42501 denied"));
  });
});
