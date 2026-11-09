/**
 * Unit tests: src/lib/monitor/page-fetch.ts — fetchMonitorPage
 * Journey: monitor-engine  ENG-AC5
 *
 * All tests inject a fake fetchImpl — no real network calls are made.
 * Covers: blocked initial URL (0 fetches), DoH private → blocked (any private
 * A/AAAA answer, also beside a public one or a failed lookup), redirect to
 * private IP, redirect to private DoH answer, exactly 3 vs 4 redirects, relative
 * Location, non-2xx, wrong content-type, dns (Status≠0, non-2xx, unparsable, a
 * failed AAAA lookup, CNAME only), one public AAAA answer suffices, a public IP
 * literal skips DoH, network (thrown), timeout, the 1 MiB body cap (exactly
 * 1 MiB vs 1 MiB + 1, endless body + reader cancel), subrequests, request
 * headers, the ok result shape, the content-type charset (unknown → UTF-8).
 *
 * DoH routing: type=AAAA is checked BEFORE type=A in every handler because
 * `url.includes("type=A")` also matches `type=AAAA`.  Every handler uses
 * `url.endsWith("type=A")` for the A branch.
 */
import { describe, expect, it } from "vitest";
import {
  MONITOR_FETCH_USER_AGENT,
  MONITOR_MAX_BODY_BYTES,
  MONITOR_MAX_REDIRECTS,
} from "@/config/monitor";
import {
  fetchMonitorPage,
  type PageFetchResult,
} from "@/lib/monitor/page-fetch";

// ── Fake-fetch helpers ────────────────────────────────────────────────────────

type FakeCall = { url: string; init?: RequestInit };

function makeFetch(
  calls: FakeCall[],
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (init?.signal?.aborted) {
      throw Object.assign(new Error("AbortError"), { name: "AbortError" });
    }
    calls.push({ url, init });
    return handler(url, init);
  };
}

/** Public IP A record — passes isBlockedAddress. */
function dohPublic(host: string, ip = "93.184.215.14"): Response {
  return new Response(
    JSON.stringify({ Status: 0, Answer: [{ name: host, type: 1, TTL: 300, data: ip }] }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

/** Private IP A record — triggers isBlockedAddress. */
function dohPrivate(host: string): Response {
  return new Response(
    JSON.stringify({ Status: 0, Answer: [{ name: host, type: 1, TTL: 300, data: "10.0.0.1" }] }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

/** AAAA with no answers — only A record drives the SSRF decision. */
function dohNoAAAA(host: string): Response {
  return new Response(
    JSON.stringify({ Status: 0, Question: [{ name: host, type: 28 }] }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

/** DoH SERVFAIL — triggers the dns error path. */
function dohServfail(): Response {
  return new Response(
    JSON.stringify({ Status: 2 }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

/** Returns a DoH response for the given URL (AAAA checked before A to avoid substring match). */
function routeDoh(
  url: string,
  host: string,
  dohA: () => Response = () => dohPublic(host),
  dohAAAAFn: () => Response = () => dohNoAAAA(host),
): Response | null {
  if (!url.includes("cloudflare-dns.com")) return null;
  if (url.includes("type=AAAA")) return dohAAAAFn();   // ← AAAA first
  if (url.endsWith("type=A"))    return dohA();         // ← A only after AAAA ruled out
  return null;
}

function htmlOk(body = "<html><body><p>Content</p></body></html>"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function assertFetchFailed(
  result: PageFetchResult,
): asserts result is Extract<PageFetchResult, { ok: false }> {
  if (result.ok) throw new Error("Expected fetchMonitorPage to fail but it succeeded");
}

// ── Blocked initial URL — 0 fetch calls ─────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: blocked initial URL makes zero fetchImpl calls", () => {
  it("ENG-AC5a: http://127.0.0.1/ is blocked before any fetch (loopback)", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, () => htmlOk());
    const result = await fetchMonitorPage("http://127.0.0.1/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(calls).toHaveLength(0);
    expect(result.subrequests).toBe(0);
  });

  it("ENG-AC5b: http://10.0.0.1/ is blocked before any fetch (private 10/8)", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, () => htmlOk());
    const result = await fetchMonitorPage("http://10.0.0.1/", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(calls).toHaveLength(0);
  });
});

// ── DoH private answer → blocked, no page request ───────────────────────────

describe("fetchMonitorPage — ENG-AC5: DoH private A answer → blocked, no page request", () => {
  it("ENG-AC5c: DoH A answer 10.0.0.1 → blocked; no page request made", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "evil.example.com",
        () => dohPrivate("evil.example.com"),
        () => dohNoAAAA("evil.example.com"),
      );
      if (doh) return doh;
      return htmlOk(); // must not be reached
    });
    const result = await fetchMonitorPage("https://evil.example.com/", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(calls.filter((c) => !c.url.includes("cloudflare-dns.com"))).toHaveLength(0);
    expect(result.subrequests).toBe(calls.length); // all recorded calls are DoH; no page request
  });
});

// ── DoH Status ≠ 0 → dns ─────────────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: DoH Status≠0 → dns error", () => {
  it("ENG-AC5v: DoH A responds with Status=2 (SERVFAIL) → {ok:false, reason:'dns'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com",
        () => dohServfail(),
        () => dohNoAAAA("example.com"),
      );
      if (doh) return doh;
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("dns");
    // No page fetch was made
    expect(calls.filter((c) => !c.url.includes("cloudflare-dns.com"))).toHaveLength(0);
  });
});

// ── Thrown fetch error → network ──────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: thrown fetch error (non-abort) → network", () => {
  it("ENG-AC5w: page fetch throws ECONNREFUSED → {ok:false, reason:'network'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("network");
  });
});

// ── Redirect to private IP literal → blocked ────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: redirect to private IP literal → blocked", () => {
  it("ENG-AC5d: hop-0 redirects to http://10.0.0.1/page → blocked", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      if (url === "https://example.com/start")
        return new Response(null, { status: 301, headers: { location: "http://10.0.0.1/page" } });
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/start", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    // 10.0.0.1 is blocked by checkMonitorUrl before any fetchImpl call for it
    expect(calls.filter((c) => c.url.includes("10.0.0.1"))).toHaveLength(0);
  });
});

// ── Redirect to host with private DoH answer → blocked ───────────────────────

describe("fetchMonitorPage — ENG-AC5: redirect to host whose DoH resolves to private IP", () => {
  it("ENG-AC5e: hop-0 → https://internal.corp/ DoH A is 192.168.1.1 → blocked", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      if (url.includes("cloudflare-dns.com") && url.includes("example.com")) {
        return routeDoh(url, "example.com")!;
      }
      if (url.includes("cloudflare-dns.com") && url.includes("internal.corp")) {
        if (url.includes("type=AAAA")) return dohNoAAAA("internal.corp");
        if (url.endsWith("type=A"))
          return new Response(
            JSON.stringify({ Status: 0, Answer: [{ name: "internal.corp", type: 1, TTL: 60, data: "192.168.1.1" }] }),
            { status: 200, headers: { "content-type": "application/dns-json" } },
          );
      }
      if (url === "https://example.com/page")
        return new Response(null, { status: 302, headers: { location: "https://internal.corp/secret" } });
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(calls.filter(
      (c) => c.url.includes("internal.corp") && !c.url.includes("cloudflare-dns"),
    )).toHaveLength(0);
  });
});

// ── > MONITOR_MAX_REDIRECTS → too_many_redirects ─────────────────────────────

describe("fetchMonitorPage — ENG-AC5: >MONITOR_MAX_REDIRECTS → too_many_redirects", () => {
  /** Answers page request `/r<n>` with a 302 to `/r<n+1>` while n < `redirects`, then with a 200 page. */
  function redirectChain(calls: FakeCall[], redirects: number): typeof fetch {
    return makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      const hop = Number(/\/r(\d+)$/.exec(url)?.[1]);
      return hop < redirects
        ? new Response(null, { status: 302, headers: { location: `https://example.com/r${hop + 1}` } })
        : htmlOk(`<p>r${hop}</p>`);
    });
  }

  const FOUR_HOPS = ["https://example.com/r0", "https://example.com/r1", "https://example.com/r2", "https://example.com/r3"];

  it(
    `ENG-AC5f: ${MONITOR_MAX_REDIRECTS + 1} redirects → too_many_redirects after requesting /r0–/r3 only`,
    async () => {
      const calls: FakeCall[] = [];
      const result = await fetchMonitorPage("https://example.com/r0", {
        fetchImpl: redirectChain(calls, MONITOR_MAX_REDIRECTS + 1),
      });
      expect(result).toEqual({
        ok: false,
        reason: "too_many_redirects",
        subrequests: (MONITOR_MAX_REDIRECTS + 1) * 3,
      });
      expect(pageCalls(calls).map((c) => c.url)).toEqual(FOUR_HOPS);
    },
  );

  it(`ENG-AC5af: exactly ${MONITOR_MAX_REDIRECTS} redirects → the 200 page at /r3 is returned`, async () => {
    const calls: FakeCall[] = [];
    const result = await fetchMonitorPage("https://example.com/r0", {
      fetchImpl: redirectChain(calls, MONITOR_MAX_REDIRECTS),
    });
    expect(result).toEqual({
      ok: true,
      body: "<p>r3</p>",
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/r3",
      truncated: false,
      subrequests: 12, // 4 hops × (DoH A + DoH AAAA + page)
    });
    expect(pageCalls(calls).map((c) => c.url)).toEqual(FOUR_HOPS);
  });
});

// ── Relative Location resolved ───────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: relative Location resolved against hopUrl", () => {
  it("ENG-AC5g: Location '/final' on https://example.com/start → the page at https://example.com/final is returned", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      if (url === "https://example.com/start") return new Response(null, { status: 302, headers: { location: "/final" } });
      return htmlOk("<html><body><p>Final</p></body></html>");
    });
    const result = await fetchMonitorPage("https://example.com/start", { fetchImpl });
    expect(result).toEqual({
      ok: true,
      body: "<html><body><p>Final</p></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/final",
      truncated: false,
      subrequests: 6, // 2 hops × (DoH A + DoH AAAA + page)
    });
    expect(pageCalls(calls).map((c) => c.url)).toEqual(["https://example.com/start", "https://example.com/final"]);
  });
});

// ── Non-2xx (non-redirect) → http_status ─────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: non-2xx non-redirect → http_status", () => {
  it("ENG-AC5h: 404 response → {ok:false, reason:'http_status'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response("Not Found", { status: 404 });
    });
    const result = await fetchMonitorPage("https://example.com/missing", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("http_status");
  });

  it("ENG-AC5i: 500 response → {ok:false, reason:'http_status'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response("Error", { status: 500 });
    });
    const result = await fetchMonitorPage("https://example.com/broken", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("http_status");
  });
});

// ── Wrong content-type → content_type ────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: wrong content-type → content_type", () => {
  it("ENG-AC5j: image/png → {ok:false, reason:'content_type'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const result = await fetchMonitorPage("https://example.com/logo.png", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("content_type");
  });

  it("ENG-AC5k: application/json → {ok:false, reason:'content_type'}", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await fetchMonitorPage("https://example.com/api", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("content_type");
  });

  it("ENG-AC5l: text/plain is accepted", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response("Plain text page", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    });
    const result = await fetchMonitorPage("https://example.com/robots.txt", { fetchImpl });
    expect(result).toEqual({
      ok: true,
      body: "Plain text page",
      contentType: "text/plain; charset=utf-8",
      finalUrl: "https://example.com/robots.txt",
      truncated: false,
      subrequests: 3,
    });
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: timeout via small timeoutMs", () => {
  it(
    "ENG-AC5m: fetchImpl that only resolves on abort + timeoutMs:80 → {ok:false, reason:'timeout'}",
    async () => {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
          return promise;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
        });
        return promise;
      };
      const result = await fetchMonitorPage("https://example.com/slow", { fetchImpl, timeoutMs: 80 });
      assertFetchFailed(result);
      expect(result.reason).toBe("timeout");
    },
    3000,
  );
});

// ── MONITOR_MAX_BODY_BYTES: exact edge, truncation, reader cancelled ─────────

describe(`fetchMonitorPage — ENG-AC5: the ${MONITOR_MAX_BODY_BYTES}-byte body cap`, () => {
  /** A fake whose page body is `stream`, served as UTF-8 HTML. */
  function pageStream(stream: ReadableStream<Uint8Array>): typeof fetch {
    return makeFetch([], (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }

  /**
   * Exactly `MONITOR_MAX_BODY_BYTES` of 'a' in 64 KiB chunks, then `extra` bytes of 'b', then
   * the end. Chunks are produced only on demand (highWaterMark 0), so a cancel after the last
   * chunk reaches the source instead of a stream that already closed.
   */
  function fixedBody(extra: number, onCancel: () => void): ReadableStream<Uint8Array> {
    const chunks = Array.from({ length: MONITOR_MAX_BODY_BYTES / 65_536 }, () => new Uint8Array(65_536).fill(97));
    if (extra > 0) chunks.push(new Uint8Array(extra).fill(98));
    let next = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[next++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel: onCancel,
      },
      { highWaterMark: 0 },
    );
  }

  it(
    "ENG-AC5n: a body that never ends → the first 1 MiB is kept, truncated:true, reader.cancel() called",
    async () => {
      // Pull-based: never closes on its own — keeps generating 64 KiB chunks of 'a'.
      // The implementation reads until 1 MiB then calls reader.cancel(), which triggers
      // the cancel() hook.  A start()-only stream that calls close() never fires cancel().
      let readerCancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(65_536).fill(97)); // 64 KiB of 'a' (0x61)
        },
        cancel() {
          readerCancelled = true;
        },
      });

      const result = await fetchMonitorPage("https://example.com/huge", { fetchImpl: pageStream(stream) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.length).toBe(MONITOR_MAX_BODY_BYTES); // exactly 1 MiB
      expect(result.truncated).toBe(true);
      expect(readerCancelled).toBe(true);
    },
    10_000,
  );

  it("ENG-AC5ag: a body of exactly 1 MiB is read whole: truncated:false, nothing cancelled", async () => {
    let readerCancelled = false;
    const stream = fixedBody(0, () => {
      readerCancelled = true;
    });
    const result = await fetchMonitorPage("https://example.com/full", { fetchImpl: pageStream(stream) });
    expect(result).toEqual({
      ok: true,
      body: "a".repeat(MONITOR_MAX_BODY_BYTES),
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/full",
      truncated: false,
      subrequests: 3,
    });
    expect(readerCancelled).toBe(false);
  });

  it("ENG-AC5ah: a body of 1 MiB + 1 byte keeps exactly the first 1 MiB: truncated:true, reader.cancel() called", async () => {
    let readerCancelled = false;
    const stream = fixedBody(1, () => {
      readerCancelled = true;
    });
    const result = await fetchMonitorPage("https://example.com/over", { fetchImpl: pageStream(stream) });
    expect(result).toEqual({
      ok: true,
      body: "a".repeat(MONITOR_MAX_BODY_BYTES),
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/over",
      truncated: true,
      subrequests: 3,
    });
    expect(readerCancelled).toBe(true);
  });
});

// ── subrequests counting ──────────────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: subrequests counts every fetchImpl call", () => {
  it(
    "ENG-AC5o: public hostname → 3 subrequests (DoH A + DoH AAAA + page)",
    async () => {
      const calls: FakeCall[] = [];
      const fetchImpl = makeFetch(calls, (url) => {
        const doh = routeDoh(url, "example.com");
        if (doh) return doh;
        return htmlOk();
      });
      const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.subrequests).toBe(3);
    },
  );

  it("ENG-AC5p: blocked initial URL → subrequests === 0", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, () => htmlOk());
    const result = await fetchMonitorPage("http://127.0.0.1/x", { fetchImpl });
    expect(result.subrequests).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ── Request headers ───────────────────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: page request headers", () => {
  function capturePageCall(calls: FakeCall[]): FakeCall | undefined {
    return calls.find((c) => !c.url.includes("cloudflare-dns.com"));
  }
  function getHeader(call: FakeCall, name: string): string | null | undefined {
    const h = call.init?.headers;
    if (!h) return undefined;
    if (h instanceof Headers) return h.get(name);
    return (h as Record<string, string>)[name];
  }

  it("ENG-AC5q: page request uses redirect:'manual'", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return htmlOk();
    });
    await fetchMonitorPage("https://example.com/", { fetchImpl });
    const page = capturePageCall(calls);
    expect(page).toBeDefined();
    expect(page!.init?.redirect).toBe("manual");
  });

  it("ENG-AC5r: page request includes User-Agent: MONITOR_FETCH_USER_AGENT", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return htmlOk();
    });
    await fetchMonitorPage("https://example.com/", { fetchImpl });
    const page = capturePageCall(calls);
    expect(getHeader(page!, "user-agent")).toBe(MONITOR_FETCH_USER_AGENT);
    expect(MONITOR_FETCH_USER_AGENT).toBe("AlnyronMonitor/1.0 (+https://monitor.alnyron.dk)");
  });

  it("ENG-AC5s: page request includes accept-language: da", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return htmlOk();
    });
    await fetchMonitorPage("https://example.com/", { fetchImpl });
    const page = capturePageCall(calls);
    expect(getHeader(page!, "accept-language")).toBe("da");
  });

  it("ENG-AC5t: DoH requests include accept: application/dns-json", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return htmlOk();
    });
    await fetchMonitorPage("https://example.com/", { fetchImpl });
    const dohCall = calls.find(
      (c) => c.url.includes("cloudflare-dns.com") && c.url.endsWith("type=A"),
    );
    expect(dohCall).toBeDefined();
    expect(getHeader(dohCall!, "accept")).toBe("application/dns-json");
  });
});

// ── Successful fetch result shape ─────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: successful fetch result shape", () => {
  it("ENG-AC5u: ok result fields: body, contentType, finalUrl, truncated:false, subrequests", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return htmlOk("<html><body><p>Hello</p></body></html>");
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    expect(result).toEqual({
      ok: true,
      body: "<html><body><p>Hello</p></body></html>",
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/page",
      truncated: false,
      subrequests: 3, // DoH A + DoH AAAA + page = 3
    });
  });
});

// ── DoH answer shapes: AAAA, CNAME-only, mixed ───────────────────────────────

/** A NOERROR DoH answer holding exactly the given records. */
function dohAnswers(host: string, records: Array<{ type: number; data: string }>): Response {
  return new Response(
    JSON.stringify({ Status: 0, Answer: records.map((record) => ({ name: host, TTL: 300, ...record })) }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

function pageCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter((c) => !c.url.includes("cloudflare-dns.com"));
}

describe("fetchMonitorPage — ENG-AC5: every DoH address is judged; no address is a dns failure", () => {
  it("ENG-AC5aa: public A but private AAAA (fd00::1) → blocked; no page request", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com",
        () => dohPublic("example.com"),
        () => dohAnswers("example.com", [{ type: 28, data: "fd00::1" }]),
      );
      if (doh) return doh;
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(pageCalls(calls)).toHaveLength(0);
    expect(result.subrequests).toBe(2);
  });

  it("ENG-AC5ab: NOERROR with only a CNAME and no A/AAAA records → dns; no page request", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com",
        () => dohAnswers("example.com", [{ type: 5, data: "alias.example.net." }]),
        () => dohNoAAAA("example.com"),
      );
      if (doh) return doh;
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("dns");
    expect(pageCalls(calls)).toHaveLength(0);
  });

  it("ENG-AC5ac: one public and one private A record → blocked; no page request", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com",
        () => dohAnswers("example.com", [
          { type: 1, data: "93.184.215.14" },
          { type: 1, data: "10.0.0.1" },
        ]),
        () => dohNoAAAA("example.com"),
      );
      if (doh) return doh;
      return htmlOk();
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    assertFetchFailed(result);
    expect(result.reason).toBe("blocked");
    expect(pageCalls(calls)).toHaveLength(0);
  });

  it("ENG-AC5ai: one public AAAA record and no A record → the page is fetched (one address suffices)", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => {
      const doh = routeDoh(url, "example.com",
        () => dohAnswers("example.com", []),
        () => dohAnswers("example.com", [{ type: 28, data: "2606:4700::1111" }]),
      );
      if (doh) return doh;
      return htmlOk("<p>v6</p>");
    });
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    expect(result).toEqual({
      ok: true,
      body: "<p>v6</p>",
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/page",
      truncated: false,
      subrequests: 3,
    });
  });

  it.each<[string, () => Response, () => Response]>([
    ["the A lookup answers HTTP 503", () => new Response("unavailable", { status: 503 }), () => dohNoAAAA("example.com")],
    ["the A lookup's body is not JSON", () => new Response("not json", { status: 200 }), () => dohNoAAAA("example.com")],
    ["the AAAA lookup fails (SERVFAIL) beside a public A record", () => dohPublic("example.com"), () => dohServfail()],
  ])("ENG-AC5aj: %s → dns; no page request", async (_case, dohA, dohAAAA) => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) => routeDoh(url, "example.com", dohA, dohAAAA) ?? htmlOk());
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "dns", subrequests: 2 });
    expect(pageCalls(calls)).toHaveLength(0);
  });

  it("ENG-AC5ak: a private A record beside a failed AAAA lookup → blocked (a blocked address outranks a failed lookup)", async () => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, (url) =>
      routeDoh(url, "example.com", () => dohPrivate("example.com"), () => dohServfail()) ?? htmlOk(),
    );
    const result = await fetchMonitorPage("https://example.com/page", { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "blocked", subrequests: 2 });
    expect(pageCalls(calls)).toHaveLength(0);
  });
});

// ── IP-literal hosts: no DoH lookup ──────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: a public IP-literal host is fetched without a DoH lookup", () => {
  it.each([
    ["IPv4", "http://93.184.215.14/page"],
    ["IPv6", "http://[2606:4700::1111]/page"],
  ])("ENG-AC5ad: %s literal → one request (the page), no cloudflare-dns.com call", async (_kind, url) => {
    const calls: FakeCall[] = [];
    const fetchImpl = makeFetch(calls, () => htmlOk());
    const result = await fetchMonitorPage(url, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([url]);
    expect(result.subrequests).toBe(1);
  });
});

// ── Charset ──────────────────────────────────────────────────────────────────

describe("fetchMonitorPage — ENG-AC5: body decoded with the content-type charset, UTF-8 for an unknown one", () => {
  function pageWith(bytes: Uint8Array<ArrayBuffer>, contentType: string): typeof fetch {
    return makeFetch([], (url) => {
      const doh = routeDoh(url, "example.com");
      if (doh) return doh;
      return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
    });
  }

  it("ENG-AC5ae: charset=windows-1252 is honoured; an unknown charset label falls back to UTF-8", async () => {
    // "Æblegrød" in windows-1252: Æ = 0xC6, ø = 0xF8.
    const latin = Uint8Array.from([0x3c, 0x70, 0x3e, 0xc6, 0x62, 0x6c, 0x65, 0x67, 0x72, 0xf8, 0x64]);
    const known = await fetchMonitorPage("https://example.com/page", {
      fetchImpl: pageWith(latin, "text/html; charset=windows-1252"),
    });
    expect(known.ok && known.body).toBe("<p>Æblegrød");

    const utf8 = new TextEncoder().encode("<p>Æblegrød på bænken</p>");
    const unknown = await fetchMonitorPage("https://example.com/page", {
      fetchImpl: pageWith(utf8, "text/html; charset=x-no-such-charset"),
    });
    expect(unknown.ok && unknown.body).toBe("<p>Æblegrød på bænken</p>");
  });
});
