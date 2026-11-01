/**
 * Unit tests: src/config/mylife.ts, plus the Supabase config and email
 * templates the MyLife host depends on.
 * Journey: mylife-login  ML-AC5, ML-AC16, ML-AC17, ML-AC26, ML-AC30
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isMyLifeHost,
  myLifeOrigin,
  MYLIFE_HOME_PATH,
  MYLIFE_LOGIN_PATH,
  MYLIFE_FORGOT_PASSWORD_PATH,
  MYLIFE_SET_PASSWORD_PATH,
  MYLIFE_NO_ACCESS_PATH,
  MYLIFE_PUBLIC_PATHS,
} from "@/config/mylife";

// ── isMyLifeHost ──────────────────────────────────────────────────────────────

describe("isMyLifeHost — ML-AC17", () => {
  it("ML-AC17a: returns true for mylife.alnyron.dk", () => {
    expect(isMyLifeHost("mylife.alnyron.dk")).toBe(true);
  });

  it("ML-AC17b: returns true for mylife.alnyron.dk:443 (with port)", () => {
    expect(isMyLifeHost("mylife.alnyron.dk:443")).toBe(true);
  });

  it("ML-AC17c: returns true for mylife.localhost (local dev)", () => {
    expect(isMyLifeHost("mylife.localhost")).toBe(true);
  });

  it("ML-AC17d: returns true for mylife.localhost:3000 (local dev with port)", () => {
    expect(isMyLifeHost("mylife.localhost:3000")).toBe(true);
  });

  it("ML-AC17e: returns true for MYLIFE.ALNYRON.DK (case-insensitive)", () => {
    expect(isMyLifeHost("MYLIFE.ALNYRON.DK")).toBe(true);
  });

  it("ML-AC17f: returns false for alnyron.dk (apex host)", () => {
    expect(isMyLifeHost("alnyron.dk")).toBe(false);
  });

  it("ML-AC17g: returns false for localhost:3000 (local apex host)", () => {
    expect(isMyLifeHost("localhost:3000")).toBe(false);
  });

  it("ML-AC17h: returns false for www.alnyron.dk", () => {
    expect(isMyLifeHost("www.alnyron.dk")).toBe(false);
  });

  it("ML-AC17i: returns false for null", () => {
    expect(isMyLifeHost(null)).toBe(false);
  });

  it("ML-AC17j: returns false for evil-mylife.alnyron.dk (prefix attack)", () => {
    expect(isMyLifeHost("evil-mylife.alnyron.dk")).toBe(false);
  });

  it("ML-AC17k: returns false for empty string", () => {
    expect(isMyLifeHost("")).toBe(false);
  });

  it("ML-AC17l: returns false for notmylife.localhost", () => {
    expect(isMyLifeHost("notmylife.localhost")).toBe(false);
  });

  it("ML-AC17m: returns false for mylife.alnyron.dk.evil.com (suffix attack)", () => {
    expect(isMyLifeHost("mylife.alnyron.dk.evil.com")).toBe(false);
  });

  it("ML-AC17n: returns false for mylife.localhost.evil.com (suffix attack)", () => {
    expect(isMyLifeHost("mylife.localhost.evil.com")).toBe(false);
  });

  // A fully qualified name ends in one dot; DNS and browsers treat it as the
  // same host, so it must not escape the MyLife rewrite.
  it.each([
    "mylife.alnyron.dk.",
    "mylife.alnyron.dk.:443",
    "MYLIFE.ALNYRON.DK.",
    "mylife.localhost.",
    "mylife.localhost.:3000",
  ])("ML-AC17o: returns true for %s (one trailing FQDN dot, with or without a port)", (host) => {
    expect(isMyLifeHost(host)).toBe(true);
  });

  it.each([
    "mylife.alnyron.dk..",
    "mylife.localhost..:3000",
    "mylife.alnyron.dk.evil.com.",
    ".",
    ".:3000",
  ])("ML-AC17p: returns false for %s (more than one trailing dot, or not a MyLife name)", (host) => {
    expect(isMyLifeHost(host)).toBe(false);
  });
});

// ── myLifeOrigin (the password reset's redirectTo) ────────────────────────────

describe("myLifeOrigin: ML-AC16 origin from the allowlist, never echoed from the header", () => {
  it.each([
    ["mylife.alnyron.dk", "https://mylife.alnyron.dk"],
    ["mylife.alnyron.dk:443", "https://mylife.alnyron.dk"],
    ["MYLIFE.ALNYRON.DK", "https://mylife.alnyron.dk"],
    ["MyLife.Alnyron.dk:8443", "https://mylife.alnyron.dk:8443"],
    ["mylife.localhost", "http://mylife.localhost"],
    ["mylife.localhost:80", "http://mylife.localhost"],
    ["mylife.localhost:3000", "http://mylife.localhost:3000"],
    ["MYLIFE.LOCALHOST:3000", "http://mylife.localhost:3000"],
    ["mylife.alnyron.dk.", "https://mylife.alnyron.dk"],
    ["mylife.alnyron.dk.:443", "https://mylife.alnyron.dk"],
    ["mylife.localhost.:3000", "http://mylife.localhost:3000"],
    ["MyLife.Localhost.", "http://mylife.localhost"],
  ])("ML-AC16e: Host %s -> %s", (host, origin) => {
    expect(myLifeOrigin(host)).toBe(origin);
  });

  it.each([
    null,
    "",
    "alnyron.dk",
    "localhost:3000",
    "evil-mylife.alnyron.dk",
    "mylife.alnyron.dk.evil.com",
    "mylife.alnyron.dk..",
    "mylife.localhost..:3000",
    "mylife.alnyron.dk.:",
    "mylife.alnyron.dk:abc",
    "mylife.alnyron.dk/evil",
    "user@mylife.alnyron.dk",
    "constructor",
  ])("ML-AC16f: Host %s is not a MyLife host -> null", (host) => {
    expect(myLifeOrigin(host)).toBeNull();
  });
});

// ── Path constants ────────────────────────────────────────────────────────────

describe("MYLIFE_* path constants — ML-AC17", () => {
  it("MYLIFE_HOME_PATH is /mylife", () => {
    expect(MYLIFE_HOME_PATH).toBe("/mylife");
  });

  it("MYLIFE_LOGIN_PATH is /mylife/login", () => {
    expect(MYLIFE_LOGIN_PATH).toBe("/mylife/login");
  });

  it("MYLIFE_FORGOT_PASSWORD_PATH is /mylife/forgot-password", () => {
    expect(MYLIFE_FORGOT_PASSWORD_PATH).toBe("/mylife/forgot-password");
  });

  it("MYLIFE_SET_PASSWORD_PATH is /mylife/set-password", () => {
    expect(MYLIFE_SET_PASSWORD_PATH).toBe("/mylife/set-password");
  });

  it("MYLIFE_NO_ACCESS_PATH is /mylife/no-access", () => {
    expect(MYLIFE_NO_ACCESS_PATH).toBe("/mylife/no-access");
  });
});

// ── MYLIFE_PUBLIC_PATHS ───────────────────────────────────────────────────────

describe("MYLIFE_PUBLIC_PATHS — ML-AC5", () => {
  it("ML-AC5: /mylife/login is public (no session required)", () => {
    expect(MYLIFE_PUBLIC_PATHS.has("/mylife/login")).toBe(true);
  });

  it("ML-AC5: /mylife/forgot-password is public (no session required)", () => {
    expect(MYLIFE_PUBLIC_PATHS.has("/mylife/forgot-password")).toBe(true);
  });

  it("ML-AC5: /mylife (home) is NOT public — requires session", () => {
    expect(MYLIFE_PUBLIC_PATHS.has("/mylife")).toBe(false);
  });

  it("ML-AC5: /mylife/set-password is NOT public — requires session", () => {
    expect(MYLIFE_PUBLIC_PATHS.has("/mylife/set-password")).toBe(false);
  });

  it("ML-AC5: /mylife/no-access is NOT public — requires session", () => {
    expect(MYLIFE_PUBLIC_PATHS.has("/mylife/no-access")).toBe(false);
  });
});

// ── supabase/config.toml additional_redirect_urls: ML-AC26 ───────────────────

describe("supabase/config.toml: ML-AC26 mylife.localhost:3000 in additional_redirect_urls", () => {
  it("ML-AC26: additional_redirect_urls lists the entry as an array element, not just a comment", () => {
    const toml = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf-8");
    expect(toml).toMatch(/^additional_redirect_urls\s*=\s*\[[^\]]*"http:\/\/mylife\.localhost:3000"/m);
  });
});

// ── Email template RedirectTo branch: ML-AC30 ────────────────────────────────

describe("Email templates: ML-AC30 only the exact MyLife origins as RedirectTo link /mylife/set-password", () => {
  // GoTrue fills .RedirectTo with the Site URL when no redirect_to is sent and
  // passes any allowlisted URL through, so the MyLife branch is pinned to the
  // exact origins the MyLife reset sends as redirectTo; every other value
  // (Site URL, any other allowlist entry) gets the Site URL link.
  const PROD_ORIGIN = "https://mylife.alnyron.dk";
  const LOCAL_ORIGIN = "http://mylife.localhost:3000";

  it.each([
    ["mylife.alnyron.dk", PROD_ORIGIN],
    ["mylife.alnyron.dk:443", PROD_ORIGIN],
    ["mylife.alnyron.dk.", PROD_ORIGIN],
    ["mylife.localhost:3000", LOCAL_ORIGIN],
    ["mylife.localhost.:3000", LOCAL_ORIGIN],
  ])("ML-AC30: the reset on Host %s sends redirectTo %s, a pinned origin", (host, origin) => {
    expect(myLifeOrigin(host)).toBe(origin);
  });

  it.each(["recovery", "invite"])(
    "ML-AC30: %s.html builds the MyLife link from RedirectTo only when it is exactly a pinned origin",
    (type) => {
      const template = readFileSync(resolve(process.cwd(), `supabase/templates/${type}.html`), "utf-8");
      const parts = [
        `{{ if or (eq .RedirectTo "${PROD_ORIGIN}") (eq .RedirectTo "${LOCAL_ORIGIN}") }}`,
        `<a href="{{ .RedirectTo }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=${type}&amp;next=/mylife/set-password">`,
        "{{ else }}",
        `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=${type}&amp;next=/admin/set-password">`,
        "{{ end }}",
      ];
      const positions = parts.map((part) => template.indexOf(part));

      expect(positions).not.toContain(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(template.match(/\{\{ if /g)).toHaveLength(1);
      // RedirectTo is printed only in the pinned branch's link.
      expect(template.match(/\{\{ \.RedirectTo \}\}/g)).toHaveLength(1);
    },
  );
});
