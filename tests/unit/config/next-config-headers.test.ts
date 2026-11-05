/**
 * Unit tests: next.config.mjs X-Robots-Tag for the MyLife host.
 * Journey: mylife-login  ML-AC19
 *
 * Header rules match the requested path, before the middleware rewrites it
 * into /mylife, so the MyLife host is matched by a catch-all rule with a
 * `has` host condition. The rules are run through Next's own `matchHas` (the
 * matcher the server uses: `^value$` against the lowercased Host header
 * without its port), so these tests cover the real matching, not the regex
 * text.
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";
import { isMyLifeHost } from "@/config/mylife";

vi.mock("next-intl/plugin", () => ({ default: () => (config: NextConfig) => config }));
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));

import nextConfig from "../../../next.config.mjs";

function requestOnHost(host: string): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.headers.host = host;
  return request;
}

/** The X-Robots-Tag value the catch-all host rules give a request on `host`, or null. */
async function robotsTagForHost(host: string): Promise<string | null> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const request = requestOnHost(host);
  const matching = rules.filter(
    (rule) => rule.source === "/:path*" && rule.has && matchHas(request, {}, rule.has, rule.missing) !== false,
  );
  const header = matching.flatMap((rule) => rule.headers).find((entry) => entry.key === "X-Robots-Tag");
  return header?.value ?? null;
}

describe("next.config headers: ML-AC19 every MyLife host variant is noindex", () => {
  it.each([
    "mylife.alnyron.dk",
    "mylife.alnyron.dk:443",
    "MYLIFE.ALNYRON.DK",
    "mylife.alnyron.dk.",
    "mylife.alnyron.dk.:443",
    "mylife.localhost:3000",
    "mylife.localhost.",
    "mylife.localhost.:3000",
  ])("ML-AC19: a request on %s gets X-Robots-Tag noindex, nofollow", async (host) => {
    expect(isMyLifeHost(host)).toBe(true);
    await expect(robotsTagForHost(host)).resolves.toBe("noindex, nofollow");
  });

  it.each([
    "alnyron.dk",
    "www.alnyron.dk",
    "localhost:3000",
    "evil-mylife.alnyron.dk",
    "mylife.alnyron.dk.evil.com",
    "mylife.alnyron.dk..",
  ])("ML-AC19: a request on %s (not a MyLife host) gets no host-based X-Robots-Tag", async (host) => {
    expect(isMyLifeHost(host)).toBe(false);
    await expect(robotsTagForHost(host)).resolves.toBeNull();
  });
});
