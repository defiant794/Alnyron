/**
 * Unit tests: AUTH_AREAS + AREA_CONFIG.monitor entry.
 * Journey: monitor-web-area  MON-AC58, MON-AC59, MON-AC60
 */
import { describe, expect, it } from "vitest";
import { AUTH_AREAS, AREA_CONFIG } from "@/config/auth-areas";
import { areaOfPath } from "@/lib/safe-next";

describe("AUTH_AREAS — MON-AC58", () => {
  it("MON-AC58m: AUTH_AREAS includes 'monitor'", () => {
    expect(AUTH_AREAS).toContain("monitor");
  });

  it("MON-AC58n: 'monitor' comes after 'mylife' in AUTH_AREAS", () => {
    const mylifeIdx = AUTH_AREAS.indexOf("mylife");
    const monitorIdx = AUTH_AREAS.indexOf("monitor");
    expect(mylifeIdx).toBeGreaterThanOrEqual(0);
    expect(monitorIdx).toBeGreaterThan(mylifeIdx);
  });
});

describe("AREA_CONFIG.monitor — MON-AC59", () => {
  const mon = AREA_CONFIG.monitor;

  it("MON-AC59a: label is 'Monitor'", () => {
    expect(mon.label).toBe("Monitor");
  });

  it("MON-AC59b: home is /monitor", () => {
    expect(mon.home).toBe("/monitor");
  });

  it("MON-AC59c: login is /monitor/login", () => {
    expect(mon.login).toBe("/monitor/login");
  });

  it("MON-AC59d: noAccess is /monitor/no-access", () => {
    expect(mon.noAccess).toBe("/monitor/no-access");
  });

  it("MON-AC59e: setPassword is /monitor/reset", () => {
    expect(mon.setPassword).toBe("/monitor/reset");
  });

  it("MON-AC59f: roles includes 'owner'", () => {
    expect(mon.roles).toContain("owner");
  });

  it("MON-AC59g: roles includes 'monitor_user'", () => {
    expect(mon.roles).toContain("monitor_user");
  });

  it("MON-AC59h: roles does NOT include 'admin' or 'mylife_user'", () => {
    expect(mon.roles).not.toContain("admin");
    expect(mon.roles).not.toContain("mylife_user");
  });

  it("MON-AC59i: landing is /monitor/dashboard (sign-in lands on dashboard, not public home)", () => {
    expect(mon.landing).toBe("/monitor/dashboard");
  });

  it("MON-AC59j: publicPaths has /monitor (the home/landing)", () => {
    expect(mon.publicPaths.has("/monitor")).toBe(true);
  });

  it("MON-AC59k: publicPaths has /monitor/signup", () => {
    expect(mon.publicPaths.has("/monitor/signup")).toBe(true);
  });

  it("MON-AC59l: publicPaths has /monitor/login", () => {
    expect(mon.publicPaths.has("/monitor/login")).toBe(true);
  });

  it("MON-AC59m: publicPaths has /monitor/forgot-password", () => {
    expect(mon.publicPaths.has("/monitor/forgot-password")).toBe(true);
  });

  it("MON-AC59n: publicPaths does NOT have /monitor/dashboard", () => {
    expect(mon.publicPaths.has("/monitor/dashboard")).toBe(false);
  });
});

describe("AREA_CONFIG landing fields — MON-AC59/contract", () => {
  it("MON-AC59o: AREA_CONFIG.monitor.landing is /monitor/dashboard", () => {
    expect(AREA_CONFIG.monitor.landing).toBe("/monitor/dashboard");
  });

  it("MON-AC59p: AREA_CONFIG.admin.landing is /admin (unchanged)", () => {
    expect(AREA_CONFIG.admin.landing).toBe("/admin");
  });

  it("MON-AC59q: AREA_CONFIG.mylife.landing is /mylife (unchanged)", () => {
    expect(AREA_CONFIG.mylife.landing).toBe("/mylife");
  });
});

describe("areaOfPath — MON-AC60", () => {
  it("MON-AC60a: areaOfPath('/monitor') returns 'monitor'", () => {
    expect(areaOfPath("/monitor")).toBe("monitor");
  });

  it("MON-AC60b: areaOfPath('/monitor/dashboard') returns 'monitor'", () => {
    expect(areaOfPath("/monitor/dashboard")).toBe("monitor");
  });

  it("MON-AC60c: areaOfPath('/admin') returns 'admin'", () => {
    expect(areaOfPath("/admin")).toBe("admin");
  });

  it("MON-AC60d: areaOfPath('/') returns null for non-area paths", () => {
    expect(areaOfPath("/")).toBeNull();
  });
});
