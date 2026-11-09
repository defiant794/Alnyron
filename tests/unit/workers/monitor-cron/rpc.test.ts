/**
 * Unit tests: workers/monitor-cron/rpc.ts — every database call is aborted after 5 s
 * Journey: monitor-engine  ENG-AC7; monitor-signup-notice  SNE-AC4f
 *
 * `rpcFetch` (the engine client's supabase-js `global.fetch`) gives each request
 * the signal AbortSignal.timeout(MONITOR_RPC_TIMEOUT_MS = 5 000 ms), combined
 * with a signal the caller passed (either one aborts the request), and passes
 * the rest of the request on unchanged. Through createSupabaseEngineRpc, each
 * of the eight engine calls (claim, snapshot, record, pendingEmails, markEmailed,
 * pendingSignups, markSignupNotified, purgeUnconfirmed) whose request is never
 * answered until that timeout aborts it rejects with EngineRpcError("unknown"),
 * naming neither the URL, the key nor the abort reason; an answer in time comes
 * back as usual. The three signup-notice calls send their SQL argument names and
 * pass the RPC result through unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MONITOR_RPC_TIMEOUT_MS } from "@/config/monitor";
import { createSupabaseEngineRpc, EngineRpcError, rpcFetch, type EngineRpc } from "../../../../workers/monitor-cron/rpc";

const SUPABASE_URL = "https://engine-unit-test.supabase.co";
const SECRET_KEY = "sb_secret_engine-unit-test-key";

/**
 * Stands in for AbortSignal.timeout: every call records the requested ms and gets the signal of
 * one controller, which the test aborts by hand in place of the timer firing.
 */
function fakeTimeout() {
  const timer = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
  return { timer, timeout };
}

/** What AbortSignal.timeout's signal is aborted with when it fires. */
function timeoutReason(message = "The operation was aborted due to timeout"): DOMException {
  return new DOMException(message, "TimeoutError");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rpcFetch — ENG-AC7: every engine request is aborted after MONITOR_RPC_TIMEOUT_MS", () => {
  it("ENG-AC7rpc1: without a caller signal, fetch gets AbortSignal.timeout(5 000) itself and the rest of the request unchanged", async () => {
    const { timer, timeout } = fakeTimeout();
    const response = new Response("[]");
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return response;
    });
    const headers = { apikey: SECRET_KEY, "content-type": "application/json" };

    expect(await rpcFetch(`${SUPABASE_URL}/rest/v1/rpc/f`, { method: "POST", headers, body: "{}" })).toBe(response);

    expect(MONITOR_RPC_TIMEOUT_MS).toBe(5_000);
    expect(timeout.mock.calls).toEqual([[5_000]]);
    expect(calls.map(({ input }) => input)).toEqual([`${SUPABASE_URL}/rest/v1/rpc/f`]);
    const { signal, ...rest } = calls[0]?.init ?? {};
    expect(signal).toBe(timer.signal);
    expect(rest).toEqual({ method: "POST", headers, body: "{}" });
  });

  it.for([
    { id: "ENG-AC7rpc2", label: "the caller's signal", by: "caller" as const },
    { id: "ENG-AC7rpc3", label: "the timeout", by: "timeout" as const },
  ])("$id: with a caller signal, the request's signal aborts on $label, with its reason", async (row) => {
    const { timer, timeout } = fakeTimeout();
    const caller = new AbortController();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Response("[]");
    });

    await rpcFetch(`${SUPABASE_URL}/rest/v1/rpc/f`, { method: "POST", signal: caller.signal });

    expect(timeout.mock.calls).toEqual([[5_000]]);
    // A signal of its own that follows both, not either one alone.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(caller.signal);
    expect(signal).not.toBe(timer.signal);
    expect(signal?.aborted).toBe(false);
    const reason = row.by === "caller" ? new Error("caller gave up") : timeoutReason();
    (row.by === "caller" ? caller : timer).abort(reason);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(reason);
  });
});

describe("createSupabaseEngineRpc — ENG-AC7: an aborted call is an EngineRpcError like any other", () => {
  const CALLS: { name: keyof EngineRpc; fn: string; call: (rpc: EngineRpc) => Promise<unknown> }[] = [
    { name: "claim", fn: "monitor_engine_claim", call: (rpc) => rpc.claim(2, 5, 3) },
    { name: "snapshot", fn: "monitor_engine_snapshot", call: (rpc) => rpc.snapshot("00000000-0000-0000-0000-0000000000a1") },
    {
      name: "record",
      fn: "monitor_engine_record",
      call: (rpc) =>
        rpc.record({
          monitorId: "00000000-0000-0000-0000-0000000000a1",
          claimedUrl: "https://example.com/private-page",
          outcome: "error",
          expectedHash: null,
          newHash: null,
          snapshot: null,
          summary: null,
          errorThreshold: 3,
          dailyCap: 10,
          repay: false,
        }),
    },
    { name: "pendingEmails", fn: "monitor_engine_pending_emails", call: (rpc) => rpc.pendingEmails(2, 10) },
    { name: "markEmailed", fn: "monitor_engine_mark_emailed", call: (rpc) => rpc.markEmailed("00000000-0000-0000-0000-0000000000e1") },
    { name: "pendingSignups", fn: "monitor_engine_pending_signups", call: (rpc) => rpc.pendingSignups(1, 10) },
    { name: "markSignupNotified", fn: "monitor_engine_mark_signup_notified", call: (rpc) => rpc.markSignupNotified("00000000-0000-0000-0000-000000005e01") },
    { name: "purgeUnconfirmed", fn: "monitor_engine_purge_unconfirmed", call: (rpc) => rpc.purgeUnconfirmed(5) },
  ];

  it.for(CALLS)(
    "ENG-AC7rpc4: $name — its request, unanswered until the 5 000 ms timeout aborts it, rejects with EngineRpcError(\"unknown\"), nothing leaked",
    async (row) => {
      const { timer, timeout } = fakeTimeout();
      const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), signal: init?.signal });
        // Never answers: only an abort settles it, rejecting with the signal's reason as fetch does.
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        return promise;
      });
      const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);

      let settled = false;
      const outcome = row.call(rpc).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(settled).toBe(false);
      expect(requests[0]?.url).toBe(`${SUPABASE_URL}/rest/v1/rpc/${row.fn}`);
      expect(requests[0]?.signal).toBe(timer.signal);
      expect(timeout.mock.calls).toEqual([[5_000]]);

      // The timer fires; its reason names the URL and the key, which must not reach the error.
      timer.abort(timeoutReason(`aborted ${SUPABASE_URL} ${SECRET_KEY}`));
      const error = await outcome;

      expect(error).toBeInstanceOf(EngineRpcError);
      const { name, code, message } = error as EngineRpcError;
      expect({ name, code, message }).toEqual({
        name: "EngineRpcError",
        code: "unknown",
        message: "monitor engine rpc failed (unknown)",
      });
      for (const secret of [SUPABASE_URL, SECRET_KEY, "aborted", "example.com"]) {
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    },
  );

  it("ENG-AC7rpc5: an answer before the timeout comes back as usual, the request carrying the timeout signal", async () => {
    const { timer, timeout } = fakeTimeout();
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
    });

    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);

    expect(await rpc.markEmailed("00000000-0000-0000-0000-0000000000e1")).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(timer.signal);
    expect(timeout.mock.calls).toEqual([[5_000]]);
  });
});

describe("createSupabaseEngineRpc — signup-notice RPCs use the correct SQL arg names and pass the RPC result through unchanged", () => {
  it("SNE-AC4f-rpc1: pendingSignups(1, 10) sends exactly { p_limit: 1, p_daily_cap: 10 } and returns the rows unchanged", async () => {
    const mockRows = [
      { user_id: "00000000-0000-0000-0000-000000005e01", email: "test@test.local", confirmed_at: "2026-11-08T10:00:00.000Z", waiting: 0, owner_emails: ["owner@test.local"] },
    ];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(mockRows), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    const result = await rpc.pendingSignups(1, 10);
    expect(bodies[0]).toEqual({ p_limit: 1, p_daily_cap: 10 });
    expect(result).toEqual(mockRows);
  });

  it("SNE-AC4f-rpc2: purgeUnconfirmed(5) sends exactly { p_limit: 5 } and returns the count", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(5), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    const result = await rpc.purgeUnconfirmed(5);
    expect(bodies[0]).toEqual({ p_limit: 5 });
    expect(result).toBe(5);
  });

  it("SNE-AC4f-rpc3: markSignupNotified sends exactly { p_user_id } on each call", async () => {
    const userId = "00000000-0000-0000-0000-000000005e01";
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    await rpc.markSignupNotified(userId);
    await rpc.markSignupNotified(userId);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ p_user_id: userId });
    expect(bodies[1]).toEqual({ p_user_id: userId });
  });

  it("SNE-AC4f-rpc4: markSignupNotified passes the boolean RPC result through unchanged (true first call, false second call from stub)", async () => {
    const userId = "00000000-0000-0000-0000-000000005e01";
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify(call++ === 0 ? true : false), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rpc = createSupabaseEngineRpc(SUPABASE_URL, SECRET_KEY);
    expect(await rpc.markSignupNotified(userId)).toBe(true);
    expect(await rpc.markSignupNotified(userId)).toBe(false);
  });
});
