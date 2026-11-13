/**
 * Unit tests: src/lib/payments/webhook-mapping.ts — pure Stripe-object mappers.
 * Journey: payments-slice1c-webhook
 * Criteria: WH-AC15a..WH-AC15k2, WH-AC16a..WH-AC16j, WH-AC17a..WH-AC17b,
 *           WH-AC_A7-normalizeSubscription, WH-AC_A7-normalizeInvoice (out-of-range unix → null),
 *           WH-AC_A12-regex-import/-sub/-inv/-pi/-cus/-evt (exported id regex constants — A12).
 *
 * normalizeSubscription, normalizeInvoice, eventForRpc, unixToIso, toSubscriptionPayload.
 * All mappers receive `unknown` input and never throw.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeSubscription,
  normalizeInvoice,
  eventForRpc,
  unixToIso,
  toSubscriptionPayload,
  SUB_ID_REGEX,
  INV_ID_REGEX,
  PI_ID_REGEX,
  CUS_ID_REGEX,
  EVT_ID_REGEX,
} from "@/lib/payments/webhook-mapping";

// ── WH-AC17b: unixToIso ───────────────────────────────────────────────────────

describe("WH-AC17b: unixToIso(s) = new Date(s*1000).toISOString() — always Z, ms precision", () => {
  it("WH-AC17b1: unix 0 → '1970-01-01T00:00:00.000Z'", () => {
    expect(unixToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("WH-AC17b2: unix 1_700_000_000 matches new Date(1_700_000_000_000).toISOString()", () => {
    const t = 1_700_000_000;
    expect(unixToIso(t)).toBe(new Date(t * 1000).toISOString());
  });

  it("WH-AC17b3: result always ends with Z", () => {
    expect(unixToIso(1_700_000_001)).toMatch(/Z$/);
  });
});

// ── WH-AC17a: eventForRpc ─────────────────────────────────────────────────────

describe("WH-AC17a: eventForRpc maps event to { id, type, created: ISO, livemode }", () => {
  const event = { id: "evt_abc123", type: "customer.subscription.updated", created: 1_700_000_000, livemode: false };

  it("WH-AC17a1: id passes through", () => {
    expect(eventForRpc(event).id).toBe("evt_abc123");
  });

  it("WH-AC17a2: type passes through", () => {
    expect(eventForRpc(event).type).toBe("customer.subscription.updated");
  });

  it("WH-AC17a3: created is unixToIso(event.created)", () => {
    expect(eventForRpc(event).created).toBe(unixToIso(1_700_000_000));
  });

  it("WH-AC17a4: livemode passes through", () => {
    expect(eventForRpc(event).livemode).toBe(false);
  });
});
/** Typed key-omit helper — no cast; rest destructuring lets TypeScript infer Omit<T,K>. */
function omitKey<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _omit, ...rest } = o;
  void _omit;
  return rest;
}


// ── WH-AC15: normalizeSubscription ───────────────────────────────────────────

/** Build a minimal valid raw Stripe subscription. */
function validSub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_test001",
    customer: "cus_test001",
    status: "active",
    cancel_at_period_end: false,
    created: 1_700_000_000,
    metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" },
    items: {
      data: [
        {
          price: { id: "price_test001" },
          current_period_end: 1_732_000_000,
        },
      ],
    },
    latest_invoice: "in_test001",
    ...overrides,
  };
}

describe("WH-AC15a: normalizeSubscription accepts all 8 Stripe subscription statuses", () => {
  const STRIPE_STATUSES = [
    "trialing",
    "active",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ] as const;

  it.each(STRIPE_STATUSES)("WH-AC15a: status '%s' → non-null result", (status) => {
    const result = normalizeSubscription(validSub({ status }));
    expect(result).not.toBeNull();
    expect(result?.status).toBe(status);
  });
});

describe("WH-AC15b: id not matching ^sub_ → null", () => {
  it("WH-AC15b: id='cus_bad' → null", () => {
    expect(normalizeSubscription(validSub({ id: "cus_bad" }))).toBeNull();
  });
});

describe("WH-AC15c: expanded customer object → its .id used", () => {
  it("WH-AC15c: customer = { id: 'cus_expanded' } → customer field = 'cus_expanded'", () => {
    const result = normalizeSubscription(validSub({ customer: { id: "cus_expanded" } }));
    expect(result?.customer).toBe("cus_expanded");
  });
});

describe("WH-AC15d: customer not matching ^cus_ → null", () => {
  it("WH-AC15d1: customer string 'acct_bad' → null", () => {
    expect(normalizeSubscription(validSub({ customer: "acct_bad" }))).toBeNull();
  });

  it("WH-AC15d2: customer is expanded object with id not matching ^cus_ → null", () => {
    expect(normalizeSubscription(validSub({ customer: { id: "acct_expanded" } }))).toBeNull();
  });
});

describe("WH-AC15e: items.data must have EXACTLY one item → null otherwise", () => {
  it("WH-AC15e1: zero items → null", () => {
    expect(normalizeSubscription(validSub({ items: { data: [] } }))).toBeNull();
  });

  it("WH-AC15e2: two items → null", () => {
    const item = { price: { id: "price_x" }, current_period_end: 1_700_000_000 };
    expect(normalizeSubscription(validSub({ items: { data: [item, item] } }))).toBeNull();
  });
});

describe("WH-AC15f: item has no string price.id → null", () => {
  it("WH-AC15f1: price.id is number → null", () => {
    expect(normalizeSubscription(validSub({ items: { data: [{ price: { id: 123 }, current_period_end: 1_700_000_000 }] } }))).toBeNull();
  });

  it("WH-AC15f2: price is null → null", () => {
    expect(normalizeSubscription(validSub({ items: { data: [{ price: null, current_period_end: 1_700_000_000 }] } }))).toBeNull();
  });
});

describe("WH-AC15g: user_id from metadata when kind=monitor_subscription and valid UUID", () => {
  it("WH-AC15g1: valid metadata → user_id is set", () => {
    const result = normalizeSubscription(validSub());
    expect(result?.user_id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("WH-AC15g2: metadata.kind !== 'monitor_subscription' → user_id = null", () => {
    const result = normalizeSubscription(validSub({ metadata: { kind: "other", user_id: "00000000-0000-0000-0000-000000000001" } }));
    expect(result?.user_id).toBeNull();
  });

  it("WH-AC15g3: metadata.user_id is not a UUID → user_id = null", () => {
    const result = normalizeSubscription(validSub({ metadata: { kind: "monitor_subscription", user_id: "not-a-uuid" } }));
    expect(result?.user_id).toBeNull();
  });

  it("WH-AC15g4: metadata.user_id uppercase UUID → user_id = null (must be canonical lowercase)", () => {
    // The UUID needs hex letters, or toUpperCase() changes nothing.
    const result = normalizeSubscription(validSub({ metadata: { kind: "monitor_subscription", user_id: "abcdef00-0000-0000-0000-00000000000a".toUpperCase() } }));
    expect(result?.user_id).toBeNull();
  });

  it("WH-AC15g5: no metadata → user_id = null", () => {
    const result = normalizeSubscription(validSub({ metadata: null }));
    expect(result?.user_id).toBeNull();
  });
});

describe("WH-AC15h: item current_period_end integer → ISO; absent/non-integer → null", () => {
  it("WH-AC15h1: current_period_end integer → unixToIso result", () => {
    const t = 1_732_000_000;
    const result = normalizeSubscription(validSub({ items: { data: [{ price: { id: "price_x" }, current_period_end: t }] } }));
    expect(result?.current_period_end).toBe(unixToIso(t));
  });

  it("WH-AC15h2: current_period_end absent → null", () => {
    const result = normalizeSubscription(validSub({ items: { data: [{ price: { id: "price_x" } }] } }));
    expect(result?.current_period_end).toBeNull();
  });

  it("WH-AC15h3: current_period_end is string → null", () => {
    const result = normalizeSubscription(validSub({ items: { data: [{ price: { id: "price_x" }, current_period_end: "not-a-number" }] } }));
    expect(result?.current_period_end).toBeNull();
  });
});

describe("WH-AC15i: cancel_at_period_end must be boolean", () => {
  it("WH-AC15i1: true → passed through", () => {
    const result = normalizeSubscription(validSub({ cancel_at_period_end: true }));
    expect(result?.cancel_at_period_end).toBe(true);
  });

  it("WH-AC15i2: false → passed through", () => {
    const result = normalizeSubscription(validSub({ cancel_at_period_end: false }));
    expect(result?.cancel_at_period_end).toBe(false);
  });

  it("WH-AC15i3: non-boolean (1) → null result", () => {
    expect(normalizeSubscription(validSub({ cancel_at_period_end: 1 }))).toBeNull();
  });
});

describe("WH-AC15j: toSubscriptionPayload omits created from the RPC payload", () => {
  it("WH-AC15j: toSubscriptionPayload has no 'created' key", () => {
    const result = normalizeSubscription(validSub());
    expect(result).not.toBeNull();
    const payload = toSubscriptionPayload(result!);
    expect(Object.keys(payload)).not.toContain("created");
    // But the normalize result itself carries created
    expect(result!.created).toBe(1_700_000_000);
  });

  it("WH-AC15j2: toSubscriptionPayload has exactly id, customer, user_id, price_id, status, current_period_end, cancel_at_period_end", () => {
    const result = normalizeSubscription(validSub());
    const payload = toSubscriptionPayload(result!);
    expect(Object.keys(payload).sort()).toEqual(
      ["cancel_at_period_end", "current_period_end", "customer", "id", "price_id", "status", "user_id"].sort()
    );
  });
});

describe("WH-AC15k: invalid status value → null", () => {
  it("WH-AC15k: status='unknown_status' → null", () => {
    expect(normalizeSubscription(validSub({ status: "unknown_status" }))).toBeNull();
  });

  it("WH-AC15k2: status missing → null", () => {
    expect(normalizeSubscription(omitKey(validSub(), "status"))).toBeNull();
  });
});

// ── WH-AC16: normalizeInvoice ─────────────────────────────────────────────────

/** Build a minimal valid raw Stripe invoice (2026-10-28.endive shape). */
function validInvoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_test001",
    customer_email: "user@example.com",
    amount_paid: 9500,
    total_taxes: [{ amount: 1900 }],
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: "sub_test001" },
    },
    lines: {
      data: [
        { period: { start: 1_700_000_000, end: 1_732_000_000 } },
      ],
    },
    status_transitions: { paid_at: 1_700_000_001 },
    ...overrides,
  };
}

describe("WH-AC16a: normalizeInvoice maps all fields correctly", () => {
  it("WH-AC16a: full valid invoice → all fields present and correct", () => {
    const result = normalizeInvoice(validInvoice());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("in_test001");
    expect(result!.subscription_id).toBe("sub_test001");
    expect(result!.email).toBe("user@example.com");
    expect(result!.amount_total_ore).toBe(9500);
    expect(result!.amount_tax_ore).toBe(1900);
    expect(result!.period_start).toBe(unixToIso(1_700_000_000));
    expect(result!.period_end).toBe(unixToIso(1_732_000_000));
    expect(result!.paid_at).toBe(unixToIso(1_700_000_001));
  });
});

describe("WH-AC16b: id not matching ^in_ → null", () => {
  it("WH-AC16b: id='ev_bad' → null", () => {
    expect(normalizeInvoice(validInvoice({ id: "ev_bad" }))).toBeNull();
  });
});

describe("WH-AC16c: parent.type !== subscription_details → subscription_id null → null result", () => {
  it("WH-AC16c1: parent.type = 'one_off' → null", () => {
    expect(normalizeInvoice(validInvoice({ parent: { type: "one_off" } }))).toBeNull();
  });

  it("WH-AC16c2: no parent → null", () => {
    expect(normalizeInvoice(validInvoice({ parent: null }))).toBeNull();
  });
});

describe("WH-AC16d: customer_email not a string → email = ''", () => {
  it("WH-AC16d1: customer_email = null → email = ''", () => {
    const result = normalizeInvoice(validInvoice({ customer_email: null }));
    expect(result?.email).toBe("");
  });

  it("WH-AC16d2: customer_email absent → email = ''", () => {
    expect(normalizeInvoice(omitKey(validInvoice(), "customer_email"))?.email).toBe("");
  });
});

describe("WH-AC16e: amount_paid negative or non-integer → null", () => {
  it("WH-AC16e1: amount_paid = -1 → null", () => {
    expect(normalizeInvoice(validInvoice({ amount_paid: -1 }))).toBeNull();
  });

  it("WH-AC16e2: amount_paid = 9.5 (float) → null", () => {
    expect(normalizeInvoice(validInvoice({ amount_paid: 9.5 }))).toBeNull();
  });

  it("WH-AC16e3: amount_paid = 0 → non-null (zero is valid)", () => {
    expect(normalizeInvoice(validInvoice({ amount_paid: 0 }))).not.toBeNull();
  });
});

describe("WH-AC16f: total_taxes entry with negative or non-integer amount → null", () => {
  it("WH-AC16f1: a tax entry with amount = -100 → null", () => {
    expect(normalizeInvoice(validInvoice({ total_taxes: [{ amount: -100 }] }))).toBeNull();
  });

  it("WH-AC16f2: a tax entry with amount = 1.5 (float) → null", () => {
    expect(normalizeInvoice(validInvoice({ total_taxes: [{ amount: 1.5 }] }))).toBeNull();
  });
});

describe("WH-AC16g: missing or empty total_taxes → amount_tax_ore = 0", () => {
  it("WH-AC16g1: total_taxes = [] → 0", () => {
    const result = normalizeInvoice(validInvoice({ total_taxes: [] }));
    expect(result?.amount_tax_ore).toBe(0);
  });

  it("WH-AC16g2: total_taxes absent → 0", () => {
    expect(normalizeInvoice(omitKey(validInvoice(), "total_taxes"))?.amount_tax_ore).toBe(0);
  });

  it("WH-AC16g3: multiple tax entries → sum (integer)", () => {
    const result = normalizeInvoice(validInvoice({ total_taxes: [{ amount: 100 }, { amount: 50 }] }));
    expect(result?.amount_tax_ore).toBe(150);
  });
});

describe("WH-AC16h: lines.data with no period → period_start and period_end are null", () => {
  it("WH-AC16h1: lines.data = [] → both null", () => {
    const result = normalizeInvoice(validInvoice({ lines: { data: [] } }));
    expect(result?.period_start).toBeNull();
    expect(result?.period_end).toBeNull();
  });

  it("WH-AC16h2: line has no period field → both null", () => {
    const result = normalizeInvoice(validInvoice({ lines: { data: [{ description: "item" }] } }));
    expect(result?.period_start).toBeNull();
    expect(result?.period_end).toBeNull();
  });

  it("WH-AC16h3: multiple lines → min(start) and max(end)", () => {
    const result = normalizeInvoice(validInvoice({
      lines: {
        data: [
          { period: { start: 1_700_000_100, end: 1_732_000_000 } },
          { period: { start: 1_700_000_000, end: 1_732_000_100 } },
        ],
      },
    }));
    expect(result?.period_start).toBe(unixToIso(1_700_000_000));
    expect(result?.period_end).toBe(unixToIso(1_732_000_100));
  });
});

describe("WH-AC16i: status_transitions.paid_at missing → null result", () => {
  it("WH-AC16i1: paid_at absent → null", () => {
    expect(normalizeInvoice(validInvoice({ status_transitions: {} }))).toBeNull();
  });

  it("WH-AC16i2: status_transitions absent → null", () => {
    expect(normalizeInvoice(omitKey(validInvoice(), "status_transitions"))).toBeNull();
  });
});

describe("WH-AC16j: money stays integer øre — no floats, no division", () => {
  it("WH-AC16j: amount fields are plain integers", () => {
    const result = normalizeInvoice(validInvoice({ amount_paid: 9500, total_taxes: [{ amount: 1900 }] }));
    expect(Number.isInteger(result!.amount_total_ore)).toBe(true);
    expect(Number.isInteger(result!.amount_tax_ore)).toBe(true);
    expect(result!.amount_total_ore).toBe(9500);
    expect(result!.amount_tax_ore).toBe(1900);
  });
});

// ── normalizeSubscription: never throws on garbage input ──────────────────────

describe("WH-AC15-nothrow: normalizeSubscription never throws on garbage input", () => {
  it.each([null, undefined, 42, "string", [], {}])("WH-AC15-nothrow: input %o → null, never throws", (input) => {
    expect(() => normalizeSubscription(input)).not.toThrow();
    expect(normalizeSubscription(input)).toBeNull();
  });
});

describe("WH-AC16-nothrow: normalizeInvoice never throws on garbage input", () => {
  it.each([null, undefined, 42, "string", [], {}])("WH-AC16-nothrow: input %o → null, never throws", (input) => {
    expect(() => normalizeInvoice(input)).not.toThrow();
    expect(normalizeInvoice(input)).toBeNull();
  });
});

// ── WH-AC_A7-mapper: out-of-range unix seconds → null ────────────────────────

describe("WH-AC_A7-mapper: mappers return null when unix seconds are out of Date range", () => {
  const OUT_OF_RANGE = 9e12; // > 8.64e12 s — exceeds Date's max representable unix seconds

  it("WH-AC_A7-normalizeSubscription: out-of-range created → null", () => {
    // A7: mappers must call isUnixSeconds which rejects |s| > 8.64e12.
    const sub = {
      id: "sub_outofrange",
      customer: "cus_outofrange",
      status: "active",
      cancel_at_period_end: false,
      created: OUT_OF_RANGE, // out-of-range → isUnixSeconds returns false → normalizeSubscription returns null
      metadata: { kind: "monitor_subscription", user_id: "00000000-0000-0000-0000-000000000001" },
      items: { data: [{ price: { id: "price_test" }, current_period_end: 1_732_000_000 }] },
    };
    expect(normalizeSubscription(sub)).toBeNull();
  });

  it("WH-AC_A7-normalizeInvoice: out-of-range paid_at → null", () => {
    // A7: status_transitions.paid_at must pass isUnixSeconds.
    const inv = {
      id: "in_outofrange",
      customer_email: "user@test.local",
      amount_paid: 1000,
      total_taxes: [],
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_test" } },
      lines: { data: [] },
      status_transitions: { paid_at: OUT_OF_RANGE }, // out-of-range → null
    };
    expect(normalizeInvoice(inv)).toBeNull();
  });
});

// ── WH-AC_A12-regex: exported id regex constants ──────────────────────────────

describe("WH-AC_A12-regex: webhook-mapping exports id regex constants for id validation", () => {
  it("WH-AC_A12-regex-import: SUB_ID_REGEX, INV_ID_REGEX, PI_ID_REGEX, CUS_ID_REGEX, EVT_ID_REGEX exported as RegExp", () => {
    expect(SUB_ID_REGEX).toBeInstanceOf(RegExp);
    expect(INV_ID_REGEX).toBeInstanceOf(RegExp);
    expect(PI_ID_REGEX).toBeInstanceOf(RegExp);
    expect(CUS_ID_REGEX).toBeInstanceOf(RegExp);
    expect(EVT_ID_REGEX).toBeInstanceOf(RegExp);
  });

  it("WH-AC_A12-regex-sub: SUB_ID_REGEX.source === '^sub_[A-Za-z0-9]+$'", () => {
    expect(SUB_ID_REGEX.source).toBe("^sub_[A-Za-z0-9]+$");
    expect(SUB_ID_REGEX.test("sub_abc123")).toBe(true);
    expect(SUB_ID_REGEX.test("sub_")).toBe(false);
    expect(SUB_ID_REGEX.test("sub_a b")).toBe(false);
    expect(SUB_ID_REGEX.test("cus_abc123")).toBe(false);
  });

  it("WH-AC_A12-regex-inv: INV_ID_REGEX.source === '^in_[A-Za-z0-9]+$'", () => {
    expect(INV_ID_REGEX.source).toBe("^in_[A-Za-z0-9]+$");
    expect(INV_ID_REGEX.test("in_abc123")).toBe(true);
    expect(INV_ID_REGEX.test("in_")).toBe(false);
    expect(INV_ID_REGEX.test("sub_abc123")).toBe(false);
  });

  it("WH-AC_A12-regex-pi: PI_ID_REGEX.source === '^pi_[A-Za-z0-9]+$'", () => {
    expect(PI_ID_REGEX.source).toBe("^pi_[A-Za-z0-9]+$");
    expect(PI_ID_REGEX.test("pi_abc123")).toBe(true);
    expect(PI_ID_REGEX.test("pi_")).toBe(false);
    expect(PI_ID_REGEX.test("in_abc123")).toBe(false);
  });

  it("WH-AC_A12-regex-cus: CUS_ID_REGEX.source === '^cus_[A-Za-z0-9]+$'", () => {
    expect(CUS_ID_REGEX.source).toBe("^cus_[A-Za-z0-9]+$");
    expect(CUS_ID_REGEX.test("cus_abc123")).toBe(true);
    expect(CUS_ID_REGEX.test("cus_")).toBe(false);
    expect(CUS_ID_REGEX.test("sub_abc123")).toBe(false);
  });

  it("WH-AC_A12-regex-evt: EVT_ID_REGEX.source === '^evt_[A-Za-z0-9]+$'", () => {
    expect(EVT_ID_REGEX.source).toBe("^evt_[A-Za-z0-9]+$");
    expect(EVT_ID_REGEX.test("evt_abc123")).toBe(true);
    expect(EVT_ID_REGEX.test("evt_")).toBe(false);
    expect(EVT_ID_REGEX.test("sub_abc123")).toBe(false);
  });
});

// ── WH-AC15l: normalizeSubscription includes duplicate_marked (A19) ──────────

describe("WH-AC15l: normalizeSubscription returns duplicate_marked boolean (A19)", () => {
  it("WH-AC15l1: metadata.duplicate_subscription absent → duplicate_marked: false", () => {
    expect(normalizeSubscription(validSub())).toMatchObject({ duplicate_marked: false });
  });

  it("WH-AC15l2: metadata.duplicate_subscription === 'true' → duplicate_marked: true", () => {
    const sub = validSub({
      metadata: {
        kind: "monitor_subscription",
        user_id: "00000000-0000-0000-0000-000000000001",
        duplicate_subscription: "true",
      },
    });
    expect(normalizeSubscription(sub)).toMatchObject({ duplicate_marked: true });
  });

  it("WH-AC15l3: toSubscriptionPayload does not include duplicate_marked (not in RPC payload per A19)", () => {
    const sub = validSub({
      metadata: {
        kind: "monitor_subscription",
        user_id: "00000000-0000-0000-0000-000000000001",
        duplicate_subscription: "true",
      },
    });
    const result = normalizeSubscription(sub);
    expect(result).not.toBeNull();
    const payload = toSubscriptionPayload(result!);
    expect(Object.keys(payload)).not.toContain("duplicate_marked");
  });
});
