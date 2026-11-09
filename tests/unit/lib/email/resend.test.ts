/**
 * Unit tests: src/lib/email/resend.ts — sendEmail
 * Journey: monitor-engine  ENG-AC1; monitor-signup-notice  SNE-AC1e, SNE-AC1f
 *
 * Covers: POST URL/headers/body shape, any 2xx → ok (id or ""), 429+quota_name → quota,
 *   429 other → rate_limited, 401/403 → config, 409 invalid_idempotent_request (key reused
 *   with a different payload) → rejected, 409 concurrent_idempotent_requests or without a
 *   known name → transient, 5xx → transient, thrown → transient(status:null), 422 → rejected,
 *   the status-range edges (299/300, 399/400, 499/500, 599), idempotency-key header, the
 *   request's abort signal = AbortSignal.timeout(MONITOR_EMAIL_SEND_TIMEOUT_MS = 10 000 ms),
 *   API key and recipient never in return value or errors.
 */
import { describe, expect, it, vi } from "vitest";
import { MONITOR_EMAIL_SEND_TIMEOUT_MS } from "@/config/monitor";
import { sendEmail, type EmailMessage, type SendResult } from "@/lib/email/resend";

// ── Helpers ───────────────────────────────────────────────────────────────────

type FakeRequest = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Builds a fake fetchImpl that captures the request and returns a canned response. */
function makeFetch(
  captured: { req?: FakeRequest },
  responseFactory: () => Response,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const bodyText = init?.body ? String(init.body) : undefined;
    const bodyParsed = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else {
        Object.assign(headers, init.headers as Record<string, string>);
      }
    }
    captured.req = { url, method: init?.method ?? "GET", headers, body: bodyParsed };
    return responseFactory();
  };
}

const TEST_API_KEY = "re_test_key_abcdef123456";
const TEST_RECIPIENT = "user@monitor-test.local";

const TEST_MSG: EmailMessage = {
  from: "Alnyron <noreply@send.alnyron.dk>",
  to: TEST_RECIPIENT,
  subject: "Test subject",
  html: "<p>Hello</p>",
  text: "Hello",
};

const TEST_KEY = "monitor-event/evt-123";

// ── Request shape ─────────────────────────────────────────────────────────────

describe("sendEmail — ENG-AC1: POST to api.resend.com/emails with correct headers", () => {
  it("ENG-AC1rs1: POSTs to https://api.resend.com/emails", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_1" }), { status: 200 }),
    );
    await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(captured.req?.url).toBe("https://api.resend.com/emails");
    expect(captured.req?.method).toBe("POST");
  });

  it("ENG-AC1rs2: sends exactly authorization: Bearer <apiKey>, content-type JSON and the idempotency key", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_2" }), { status: 200 }),
    );
    await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(captured.req?.headers).toEqual({
      authorization: `Bearer ${TEST_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": TEST_KEY,
    });
  });

  it("ENG-AC1rs3: sets idempotency-key header to the provided key", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_3" }), { status: 200 }),
    );
    await sendEmail(TEST_API_KEY, TEST_MSG, "monitor-event/evt-abc", fetchImpl);
    expect(captured.req?.headers["idempotency-key"]).toBe("monitor-event/evt-abc");
  });

  it("ENG-AC1rs4: body wraps 'to' as an array [to]", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_4" }), { status: 200 }),
    );
    await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    const body = captured.req?.body as Record<string, unknown> | undefined;
    expect(Array.isArray(body?.["to"])).toBe(true);
    expect(body?.["to"]).toEqual([TEST_RECIPIENT]);
  });

  it("ENG-AC1rs5: body is exactly {from, to:[to], subject, html, text} from the message", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_5" }), { status: 200 }),
    );
    await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(captured.req?.body).toEqual({
      from: TEST_MSG.from,
      to: [TEST_RECIPIENT],
      subject: TEST_MSG.subject,
      html: TEST_MSG.html,
      text: TEST_MSG.text,
    });
  });

  it("ENG-AC1rs25: the request's signal is AbortSignal.timeout(MONITOR_EMAIL_SEND_TIMEOUT_MS), 10 000 ms, the run's email time budget", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      let signal: AbortSignal | null | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ id: "res_timeout" }), { status: 200 });
      };
      expect(await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl)).toEqual({ ok: true, id: "res_timeout" });
      expect(MONITOR_EMAIL_SEND_TIMEOUT_MS).toBe(10_000);
      expect(timeout.mock.calls).toEqual([[10_000]]);
      expect(signal).toBe(timeout.mock.results[0]?.value);
    } finally {
      timeout.mockRestore();
    }
  });
});

// ── Status mapping ────────────────────────────────────────────────────────────

describe("sendEmail — ENG-AC1: status code mapping", () => {
  it("ENG-AC1rs6: 200 + {id} → {ok:true, id}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_ok_200" }), { status: 200 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: true, id: "res_ok_200" });
  });

  it("ENG-AC1rs7: 201 + {id} → {ok:true, id}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ id: "res_ok_201" }), { status: 201 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: true, id: "res_ok_201" });
  });

  it("ENG-AC1rs23: 200 with body {} (no id) → {ok:true, id:''}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () => new Response("{}", { status: 200 }));
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: true, id: "" });
  });

  it.each<[string, string]>([
    ["an empty body", ""],
    ["a non-JSON body", "Accepted"],
  ])("ENG-AC1rs24: 202 with %s → {ok:true, id:''}", async (_kind, body) => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () => new Response(body, { status: 202 }));
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: true, id: "" });
  });

  it("ENG-AC1rs8: 429 with body.name='daily_quota_exceeded' → {ok:false, kind:'quota'}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ name: "daily_quota_exceeded" }), { status: 429 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "quota", status: 429 });
  });

  it("ENG-AC1rs9: 429 with body.name='monthly_quota_exceeded' → {ok:false, kind:'quota'}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ name: "monthly_quota_exceeded" }), { status: 429 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "quota", status: 429 });
  });

  it("ENG-AC1rs10: 429 with other body.name → {ok:false, kind:'rate_limited'}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ name: "too_many_requests" }), { status: 429 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "rate_limited", status: 429 });
  });

  it("ENG-AC1rs11: 429 with no recognisable quota name → {ok:false, kind:'rate_limited'}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response("{}", { status: 429 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "rate_limited", status: 429 });
  });

  it("ENG-AC1rs12: 401 → {ok:false, kind:'config', status:401}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "config", status: 401 });
  });

  it("ENG-AC1rs13: 403 → {ok:false, kind:'config', status:403}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "config", status: 403 });
  });

  it("ENG-AC1rs14: 409 without a recognised error name → {ok:false, kind:'transient', status:409}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response("{}", { status: 409 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: 409 });
  });

  it("SNE-AC1f-rs1: 409 invalid_idempotent_request (key already used with a different payload) → {ok:false, kind:'rejected', status:409}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "rejected", status: 409 });
  });

  it("SNE-AC1e-rs2: 409 concurrent_idempotent_requests (the key's first request still in progress) → {ok:false, kind:'transient', status:409}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: 409 });
  });

  it("ENG-AC1rs15: 500 → {ok:false, kind:'transient', status:500}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response("Server Error", { status: 500 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: 500 });
  });

  it("ENG-AC1rs16: thrown fetch error → {ok:false, kind:'transient', status:null}", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("Network failure");
    };
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: null });
  });

  it("ENG-AC1rs17: 422 → {ok:false, kind:'rejected', status:422}", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response(JSON.stringify({ message: "Invalid" }), { status: 422 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "rejected", status: 422 });
  });

  it("ENG-AC1rs18: 400 → {ok:false, kind:'rejected', status:400} (other 4xx)", async () => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () =>
      new Response("{}", { status: 400 }),
    );
    const result = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "rejected", status: 400 });
  });

  it.each<[number, SendResult]>([
    [299, { ok: true, id: "res_edge" }],
    [300, { ok: false, kind: "transient", status: 300 }],
    [399, { ok: false, kind: "transient", status: 399 }],
    [499, { ok: false, kind: "rejected", status: 499 }],
    [599, { ok: false, kind: "transient", status: 599 }],
  ])("ENG-AC1rs22: status-range edge %i → %o", async (status, expected) => {
    const captured: { req?: FakeRequest } = {};
    const fetchImpl = makeFetch(captured, () => new Response(JSON.stringify({ id: "res_edge" }), { status }));
    expect(await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl)).toEqual(expected);
  });
});

// ── API key and recipient never leak ─────────────────────────────────────────

describe("sendEmail — ENG-AC1: API key and recipient never appear in return value", () => {
  // The 5xx body echoes the apiKey and recipient.  A buggy implementation that
  // passes the response body into the return value would be caught by these assertions.
  it("ENG-AC1rs19: 5xx body echoing the API key → result does not contain it", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: `Bad key: ${TEST_API_KEY}`, to: TEST_RECIPIENT }),
        { status: 500 },
      );
    const result: SendResult = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: 500 });
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });

  it("ENG-AC1rs20: 5xx body echoing the recipient → result does not contain it", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: `Undeliverable: ${TEST_RECIPIENT}`, key: TEST_API_KEY }),
        { status: 500 },
      );
    const result: SendResult = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: 500 });
    expect(JSON.stringify(result)).not.toContain(TEST_RECIPIENT);
  });

  it("ENG-AC1rs21: thrown error whose message contains the API key → result does not", async () => {
    // A buggy catch block might propagate the error message into the return value.
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`Auth failed for ${TEST_API_KEY}`);
    };
    const result: SendResult = await sendEmail(TEST_API_KEY, TEST_MSG, TEST_KEY, fetchImpl);
    expect(result).toEqual({ ok: false, kind: "transient", status: null });
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });
});
