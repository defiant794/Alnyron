/**
 * Unit tests: workers/monitor-cron/react-shim.ts — the `react` stand-in of the cron Worker bundle
 * Journey: monitor-engine  ENG-AC1, ENG-AC3
 *
 * workers/monitor-cron/wrangler.jsonc aliases `react` to the shim for the Worker build only;
 * vitest (like Next.js) keeps the real React. This suite loads change-email, and use-intl/core
 * under it, a second time with `react` mocked by the shim, proves the shim was the module
 * use-intl received, and checks both emails come out identical to the real-React build.
 * (vitest.config.ts inlines use-intl in the unit project, so vi.doMock("react") reaches it.)
 */
import { describe, expect, it, vi } from "vitest";
import { cloneElement, isValidElement } from "../../../../workers/monitor-cron/react-shim";

const CHANGE_INPUT = {
  eventId: "evt-shim",
  monitorId: "00000000-0000-0000-0000-0000000000a1",
  url: "https://example.com/side?a=1&b=<2>",
  label: "Æblegrød & \"kager\"",
  detectedAt: "2026-11-08T10:15:00Z",
  summary: "+ Ny linje <b>fed</b>\n+ Endnu en\n\u2212 Gammel linje",
  siteUrl: "https://alnyron.dk",
};

const ERROR_INPUT = {
  monitorId: "00000000-0000-0000-0000-0000000000a2",
  url: "https://example.com/væk",
  label: null,
  failures: 3,
  siteUrl: "https://alnyron.dk",
};

/**
 * Builds one email of each kind from a fresh module graph. Dynamic import on purpose: the test
 * loads change-email twice, once per `react` (real, then the shim), after vi.resetModules().
 */
async function buildEmails() {
  const { buildChangeEmail, buildErrorEmail } = await import("@/lib/monitor/change-email");
  return { change: buildChangeEmail(CHANGE_INPUT), error: buildErrorEmail(ERROR_INPUT) };
}

describe("react-shim — ENG-AC1/ENG-AC3: emails built with the Worker's react stand-in", () => {
  it("ENG-AC1shim1: change and error emails are identical to the real-React build", async () => {
    vi.resetModules();
    const real = await buildEmails();

    vi.resetModules();
    let shimLoads = 0;
    vi.doMock("react", async () => {
      shimLoads += 1;
      // The mocked `react` module is the shim itself, resolved when use-intl first imports it.
      return import("../../../../workers/monitor-cron/react-shim");
    });
    try {
      const shimmed = await buildEmails();
      // use-intl/core really imported the stand-in (else this comparison would prove nothing).
      expect(shimLoads).toBe(1);
      expect(shimmed).toEqual(real);
    } finally {
      vi.doUnmock("react");
      vi.resetModules();
    }
  });

  it("ENG-AC3shim2: isValidElement is always false and cloneElement refuses", () => {
    expect(isValidElement()).toBe(false);
    expect(() => cloneElement()).toThrow("React elements are not supported in the monitor cron Worker");
  });
});
