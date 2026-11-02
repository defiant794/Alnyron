// @vitest-environment jsdom
/**
 * Unit tests — sanitizeMarkdown (F1.2 pages editor — privacy page)
 * Journey: pages-editor  AC-PAGES-21, 22, 23
 *
 * Expected module: src/lib/sanitize-markdown.ts
 *   sanitizeMarkdown(md: string): string
 *
 * Assertions use DOMParser (available in jsdom) instead of substring checks
 * so that correct implementations that ESCAPE rather than strip unsafe content
 * (e.g. turning <script> into &lt;script&gt;) still pass: the DOM never
 * contains a `<script>` element regardless of the escaping strategy.
 */

import { describe, it, expect } from "vitest";
import { sanitizeMarkdown } from "@/lib/sanitize-markdown";

// ── Helper ────────────────────────────────────────────────────────────────────

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}</body>`, "text/html");
}

/** True if any element in `doc.body` has an attribute whose name starts with 'on'. */
function hasEventHandler(doc: Document): boolean {
  for (const el of doc.body.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      if (attr.name.toLowerCase().startsWith("on")) return true;
    }
  }
  return false;
}

/** True if any <a> in `doc.body` has a href that starts with 'javascript:' (case-insensitive). */
function hasJavascriptHref(doc: Document): boolean {
  for (const a of doc.body.querySelectorAll("a[href]")) {
    if (/^javascript:/i.test(a.getAttribute("href") ?? "")) return true;
  }
  return false;
}

// ── AC-PAGES-21: <script> tags stripped ──────────────────────────────────────

describe("AC-PAGES-21: sanitizeMarkdown — <script> tags absent from parsed DOM", () => {
  it("AC-PAGES-21a: <script>alert('xss')</script> leaves no <script> element in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<script>alert("xss")</script>'));
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("AC-PAGES-21b: <script src='...'></script> leaves no <script> element in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<script src="https://evil.example/x.js"></script>'));
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("AC-PAGES-21c: <script> in markdown code fence leaves no <script> element in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("```\n<script>evil()</script>\n```"));
    // Code blocks may render a <pre><code> but must not produce a live <script>
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });
});

// ── AC-PAGES-22: unsafe attributes stripped ───────────────────────────────────

describe("AC-PAGES-22: sanitizeMarkdown — on* handlers and javascript: hrefs absent from parsed DOM", () => {
  it("AC-PAGES-22a: onclick attribute on a <span> is absent from the parsed DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<span onclick="evil()">click me</span>'));
    expect(hasEventHandler(doc)).toBe(false);
  });

  it("AC-PAGES-22b: onmouseover attribute is absent from the parsed DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<img src="x" onmouseover="evil()" alt="">'));
    expect(hasEventHandler(doc)).toBe(false);
  });

  it("AC-PAGES-22c: onerror on <img> is absent from the parsed DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<img src="x" onerror="evil()">'));
    expect(hasEventHandler(doc)).toBe(false);
  });

  it("AC-PAGES-22d: javascript: href on a markdown link is absent from the parsed DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("[click me](javascript:alert(1))"));
    expect(hasJavascriptHref(doc)).toBe(false);
  });

  it("AC-PAGES-22e: javascript: href in raw HTML anchor is absent from the parsed DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<a href="javascript:void(0)">link</a>'));
    expect(hasJavascriptHref(doc)).toBe(false);
  });
});

// ── Additional dangerous elements ─────────────────────────────────────────────

describe("sanitizeMarkdown — dangerous elements absent from parsed DOM", () => {
  it("no <iframe> element in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown('<iframe src="https://evil.example"></iframe>'));
    expect(doc.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("no <style> element in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("<style>body { display:none }</style>"));
    expect(doc.querySelectorAll("style")).toHaveLength(0);
  });
});

// ── AC-PAGES-23: safe markdown rendered to HTML ───────────────────────────────

describe("AC-PAGES-23: sanitizeMarkdown — safe markdown renders to HTML elements in DOM", () => {
  it("AC-PAGES-23a: ATX heading '# Heading' → <h1> with that text in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("# Privatlivspolitik"));
    expect(doc.querySelector("h1")?.textContent).toContain("Privatlivspolitik");
  });

  it("AC-PAGES-23b: ## heading → <h2> in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("## Afsnit"));
    expect(doc.querySelector("h2")?.textContent).toContain("Afsnit");
  });

  it("AC-PAGES-23c: **bold** → <strong> in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("**vigtigt**"));
    expect(doc.querySelector("strong")?.textContent).toContain("vigtigt");
  });

  it("AC-PAGES-23d: paragraph text → wrapped in <p> in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("Dette er et afsnit."));
    expect(doc.querySelector("p")?.textContent).toContain("Dette er et afsnit.");
  });

  it("AC-PAGES-23e: plain https:// link → <a> with intact href in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("[alnyron](https://alnyron.dk)"));
    const a = doc.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://alnyron.dk");
    expect(a?.textContent).toContain("alnyron");
  });

  it("AC-PAGES-23f: markdown list items → <li> elements in DOM", () => {
    const doc = parseHtml(sanitizeMarkdown("- Indsigt\n- Berigtigelse\n- Sletning"));
    expect(doc.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
  });
});
