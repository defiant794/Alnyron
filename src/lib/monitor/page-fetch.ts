import {
  MONITOR_FETCH_TIMEOUT_MS,
  MONITOR_FETCH_USER_AGENT,
  MONITOR_MAX_BODY_BYTES,
  MONITOR_MAX_REDIRECTS,
} from "@/config/monitor";
import { checkMonitorUrl, isBlockedAddress } from "@/lib/monitor/url-guard";

/** Why a page check failed. */
export type PageFetchFailure =
  | "blocked"
  | "dns"
  | "timeout"
  | "network"
  | "http_status"
  | "content_type"
  | "too_many_redirects";

export type PageFetchResult =
  | { ok: true; body: string; contentType: string; finalUrl: string; truncated: boolean; subrequests: number }
  | { ok: false; reason: PageFetchFailure; subrequests: number };

export type PageFetchDeps = { fetchImpl?: typeof fetch; timeoutMs?: number };

/** Cloudflare's DNS-over-HTTPS JSON endpoint: resolves a hostname before the checker fetches it. */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** DNS record types whose answers are addresses: A (1) and AAAA (28). CNAME (5) and others are ignored. */
const ADDRESS_RECORD_TYPES = new Set([1, 28]);

/** Media types the checker reads; everything else (images, PDFs, JSON, ...) is a failed check. */
const PAGE_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Addresses in one DoH answer (A or AAAA), or null when the lookup failed (non-2xx, unparsable, `Status` other than NOERROR). */
async function lookUp(host: string, type: "A" | "AAAA", fetchImpl: typeof fetch, signal: AbortSignal) {
  const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
    signal,
    headers: { accept: "application/dns-json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  if (typeof answer !== "object" || answer === null || !("Status" in answer) || answer.Status !== 0) return null;
  const records = "Answer" in answer && Array.isArray(answer.Answer) ? (answer.Answer as unknown[]) : [];
  return records.flatMap((record) =>
    typeof record === "object" &&
    record !== null &&
    "type" in record &&
    ADDRESS_RECORD_TYPES.has(Number(record.type)) &&
    "data" in record &&
    typeof record.data === "string"
      ? [record.data]
      : [],
  );
}

/**
 * Re-checks a hostname right before it is fetched (the SSRF guard's second
 * line, see `checkMonitorUrl`): resolves its A and AAAA records over DoH and
 * refuses the hop when any address is private, loopback, link-local or
 * otherwise not public. A failed lookup or a name without addresses is a DNS
 * failure. Accepted risk: the answer can change between this lookup and the
 * fetch (DNS rebinding window).
 */
async function checkResolvedHost(
  host: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<PageFetchFailure | null> {
  const lookups = await Promise.all([
    lookUp(host, "A", fetchImpl, signal),
    lookUp(host, "AAAA", fetchImpl, signal),
  ]);
  const addresses = lookups.flatMap((addressList) => addressList ?? []);
  if (addresses.some(isBlockedAddress)) return "blocked";
  if (lookups.includes(null) || addresses.length === 0) return "dns";
  return null;
}

/**
 * Reads at most {@link MONITOR_MAX_BODY_BYTES} of a body and decodes it with
 * the charset the content type names (UTF-8 when it names none or one the
 * runtime does not know). A longer body is cut at exactly that many bytes and
 * its stream cancelled.
 */
async function readBody(response: Response, contentType: string): Promise<{ body: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MONITOR_MAX_BODY_BYTES) {
      chunks.push(value.subarray(0, MONITOR_MAX_BODY_BYTES - size));
      size = MONITOR_MAX_BODY_BYTES;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return { body: decoder.decode(bytes), truncated };
}

/**
 * Fetches a monitored page the safe way. Every hop (the URL itself and each of
 * at most {@link MONITOR_MAX_REDIRECTS} redirects, followed by hand) must pass
 * `checkMonitorUrl` and, for a hostname, a DoH lookup whose every address is
 * public; only then is it requested. A 2xx response must be HTML, XHTML or
 * plain text; its body is read up to {@link MONITOR_MAX_BODY_BYTES}. One
 * timeout ({@link MONITOR_FETCH_TIMEOUT_MS} unless `timeoutMs`) covers the
 * whole check, lookups included.
 *
 * @returns the body (decoded) and the URL it came from, or why the check
 * failed; `subrequests` counts every request made either way (lookups too), for
 * the Worker's subrequest budget.
 */
export async function fetchMonitorPage(url: string, deps: PageFetchDeps = {}): Promise<PageFetchResult> {
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const signal = AbortSignal.timeout(deps.timeoutMs ?? MONITOR_FETCH_TIMEOUT_MS);
  let subrequests = 0;
  const countedFetch: typeof fetch = (input, init) => {
    subrequests += 1;
    return fetchImpl(input, init);
  };

  try {
    let hopUrl = url;
    for (let redirects = 0; ; redirects += 1) {
      const check = checkMonitorUrl(hopUrl);
      if (!check.ok) return { ok: false, reason: "blocked", subrequests };
      hopUrl = check.url;

      // An IP literal was judged by checkMonitorUrl; a hostname is resolved and judged here.
      const { hostname } = new URL(hopUrl);
      if (!hostname.startsWith("[") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        const failure = await checkResolvedHost(hostname, countedFetch, signal);
        if (failure !== null) return { ok: false, reason: failure, subrequests };
      }

      const response = await countedFetch(hopUrl, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": MONITOR_FETCH_USER_AGENT,
          "accept-language": "da",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
      });

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        await response.body?.cancel();
        if (redirects >= MONITOR_MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects", subrequests };
        // An unparsable Location goes to checkMonitorUrl as is, which refuses it.
        hopUrl = URL.canParse(location, hopUrl) ? new URL(location, hopUrl).href : location;
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        return { ok: false, reason: "http_status", subrequests };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!PAGE_MEDIA_TYPES.has((contentType.split(";")[0] ?? "").trim().toLowerCase())) {
        await response.body?.cancel();
        return { ok: false, reason: "content_type", subrequests };
      }
      const { body, truncated } = await readBody(response, contentType);
      return { ok: true, body, contentType, finalUrl: hopUrl, truncated, subrequests };
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "network", subrequests };
  }
}
