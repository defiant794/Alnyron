/**
 * Unit tests: src/lib/monitor/page-text.ts
 * Journey: monitor-engine  ENG-AC2
 *
 * pageText: HTML stripping, entity decoding (æøå/nbsp/numeric), NFC,
 *   block→newlines, volatile-noise immunity, text/plain path.
 * hashPageText: v1: prefix + 64 lower-hex SHA-256.
 * isCurrentPageHash: false for null, unprefixed, legacy → engine re-baselines.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PAGE_HASH_VERSION,
  hashPageText,
  isCurrentPageHash,
  pageText,
} from "@/lib/monitor/page-text";

// ── pageText — HTML stripping ────────────────────────────────────────────────

describe("pageText — ENG-AC2: basic HTML body extraction", () => {
  it("ENG-AC2a: returns body text visible to users", () => {
    expect(pageText("<html><body><p>Hello world</p></body></html>", "text/html")).toBe(
      "Hello world",
    );
  });

  it("ENG-AC2b: extracts <title> as first line before body content", () => {
    const html =
      "<html><head><title>My Page</title></head><body><p>Content</p></body></html>";
    expect(pageText(html, "text/html")).toBe("My Page\nContent");
  });

  it("ENG-AC2c: drops head element content (meta, link, etc.)", () => {
    const html =
      "<html><head><meta charset='utf-8'><link rel='stylesheet' href='/style.css'></head><body>Body text</body></html>";
    const result = pageText(html, "text/html");
    expect(result).not.toContain("stylesheet");
    expect(result).not.toContain("utf-8");
    expect(result).toBe("Body text");
  });

  it("ENG-AC2d: drops script elements entirely including their contents", () => {
    const html =
      "<html><body><p>Visible</p><script>var secret='abc';</script><p>Also visible</p></body></html>";
    const result = pageText(html, "text/html");
    expect(result).not.toContain("secret");
    expect(result).toBe("Visible\nAlso visible");
  });

  it("ENG-AC2e: drops style elements entirely", () => {
    const html =
      "<html><body><p>Text</p><style>.x { color: red; }</style></body></html>";
    expect(pageText(html, "text/html")).not.toContain("color");
    expect(pageText(html, "text/html")).toBe("Text");
  });

  it("ENG-AC2f: drops noscript, template, svg, math, iframe, object, canvas entirely", () => {
    const html = `<html><body><p>Main</p>
      <noscript>Enable JS</noscript>
      <template><p>Tmpl</p></template>
      <svg><text>SVGtxt</text></svg>
      <math><mi>x</mi></math>
      <iframe src="x.html">Frame</iframe>
      <object data="x.pdf">Obj</object>
      <canvas>Canvas</canvas>
    </body></html>`;
    expect(pageText(html, "text/html")).toBe("Main");
  });

  it("ENG-AC2g: drops HTML comments", () => {
    const html =
      "<html><body><p>Text</p><!-- hidden comment --><p>More</p></body></html>";
    const result = pageText(html, "text/html");
    expect(result).not.toContain("hidden comment");
    expect(result).toBe("Text\nMore");
  });

  it("ENG-AC2h: drops CDATA sections", () => {
    const html =
      "<html><body><p>Text</p><![CDATA[secret cdata]]></body></html>";
    expect(pageText(html, "text/html")).toBe("Text");
  });

  it("ENG-AC2i: block tags (p, div, h1-h6, li, section, article, etc.) become newlines", () => {
    const html =
      "<html><body><h1>Title</h1><p>Para one</p><p>Para two</p><div>Div</div></body></html>";
    expect(pageText(html, "text/html")).toBe("Title\nPara one\nPara two\nDiv");
  });

  it("ENG-AC2j: <br> tags become newlines", () => {
    const html = "<html><body>Line one<br>Line two<br/>Line three</body></html>";
    expect(pageText(html, "text/html")).toBe("Line one\nLine two\nLine three");
  });

  it("ENG-AC2k: collapses runs of whitespace within a line to one space", () => {
    const html = "<html><body><p>  Hello   world  </p></body></html>";
    expect(pageText(html, "text/html")).toBe("Hello world");
  });

  it("ENG-AC2l: drops empty lines after normalization", () => {
    const html =
      "<html><body><p>Line 1</p><p>   </p><p>Line 2</p></body></html>";
    expect(pageText(html, "text/html")).toBe("Line 1\nLine 2");
  });
});

// ── pageText — entity decoding ───────────────────────────────────────────────

describe("pageText — ENG-AC2: entity decoding", () => {
  it("ENG-AC2m: decodes &amp; &lt; &gt; &quot; &apos;", () => {
    const html =
      "<html><body><p>5 &lt; 10 &amp; 3 &gt; 2 &quot;hi&quot; it&apos;s</p></body></html>";
    expect(pageText(html, "text/html")).toBe(`5 < 10 & 3 > 2 "hi" it's`);
  });

  it("ENG-AC2n: decodes &aelig; &oslash; &aring; (æøå)", () => {
    const html =
      "<html><body><p>s&aelig;rlig &oslash;ret &aring;r</p></body></html>";
    expect(pageText(html, "text/html")).toBe("særlig øret år");
  });

  it("ENG-AC2o: decodes &AElig; &Oslash; &Aring; (ÆØÅ)", () => {
    const html = "<html><body><p>&AElig;&Oslash;&Aring;</p></body></html>";
    expect(pageText(html, "text/html")).toBe("ÆØÅ");
  });

  it("ENG-AC2p: decodes &nbsp; to plain space (not U+00A0)", () => {
    const html = "<html><body><p>word&nbsp;another</p></body></html>";
    const result = pageText(html, "text/html");
    expect(result).toBe("word another");
    // Must be ASCII space (0x20), not non-breaking space (U+00A0)
    expect(result.codePointAt(4)).toBe(0x20);
  });

  it("ENG-AC2q: decodes decimal numeric entities &#229; (å)", () => {
    const html = "<html><body><p>&#229;r</p></body></html>";
    expect(pageText(html, "text/html")).toBe("år");
  });

  it("ENG-AC2r: decodes hex numeric entities &#xE5; (å)", () => {
    const html = "<html><body><p>&#xE5;r</p></body></html>";
    expect(pageText(html, "text/html")).toBe("år");
  });

  it("ENG-AC2s: decodes &copy; &reg; &hellip; &ndash; &mdash; &laquo; &raquo; &euro;", () => {
    const html =
      "<html><body><p>&copy; &reg; &hellip; &ndash; &mdash; &laquo; &raquo; &euro;</p></body></html>";
    expect(pageText(html, "text/html")).toBe("© ® … – — « » €");
  });

  it("ENG-AC2t: leaves unknown named entities verbatim", () => {
    const html = "<html><body><p>&unknown123xyz;</p></body></html>";
    expect(pageText(html, "text/html")).toBe("&unknown123xyz;");
  });
});

// ── pageText — volatile-noise immunity ──────────────────────────────────────

describe("pageText — ENG-AC2: volatile attribute noise never changes output", () => {
  it("ENG-AC2u: different nonce values on script tags produce identical output", () => {
    const html1 = `<html><body><p>Price: 100</p><script nonce="abc">x=1</script></body></html>`;
    const html2 = `<html><body><p>Price: 100</p><script nonce="xyz">x=1</script></body></html>`;
    expect(pageText(html1, "text/html")).toBe(pageText(html2, "text/html"));
    expect(pageText(html1, "text/html")).toBe("Price: 100");
  });

  it("ENG-AC2v: different CSRF token values produce identical output", () => {
    const html1 = `<html><body><form><input type="hidden" name="_csrf" value="tok-aaa"><p>Form</p></form></body></html>`;
    const html2 = `<html><body><form><input type="hidden" name="_csrf" value="tok-bbb"><p>Form</p></form></body></html>`;
    expect(pageText(html1, "text/html")).toBe(pageText(html2, "text/html"));
    expect(pageText(html1, "text/html")).toBe("Form");
  });

  it("ENG-AC2w: different asset-hash fingerprints in script src produce identical output", () => {
    const html1 = `<html><body><p>Text</p><script src="/app.aaa111.js"></script></body></html>`;
    const html2 = `<html><body><p>Text</p><script src="/app.bbb222.js"></script></body></html>`;
    expect(pageText(html1, "text/html")).toBe(pageText(html2, "text/html"));
    expect(pageText(html1, "text/html")).toBe("Text");
  });

  it("ENG-AC2x: different inline script contents produce identical output (scripts dropped)", () => {
    const html1 = `<html><body><p>Main text</p><script>window.__NONCE__='a1b2';</script></body></html>`;
    const html2 = `<html><body><p>Main text</p><script>window.__NONCE__='c3d4';</script></body></html>`;
    expect(pageText(html1, "text/html")).toBe(pageText(html2, "text/html"));
    expect(pageText(html1, "text/html")).toBe("Main text");
  });

  it("ENG-AC2y: visible text change IS detected even when volatile scripts also differ", () => {
    const html1 = `<html><body><p>Old price: 100</p><script nonce="a">x=1</script></body></html>`;
    const html2 = `<html><body><p>New price: 200</p><script nonce="b">x=2</script></body></html>`;
    expect(pageText(html1, "text/html")).toBe("Old price: 100");
    expect(pageText(html2, "text/html")).toBe("New price: 200");
  });
});

// ── pageText — text/plain path ───────────────────────────────────────────────

describe("pageText — ENG-AC2: text/plain path", () => {
  it("ENG-AC2z: NFC-normalises and collapses whitespace, drops empty lines", () => {
    const plain = "  Hello   world  \n\nFoo  Bar  ";
    expect(pageText(plain, "text/plain")).toBe("Hello world\nFoo Bar");
  });

  it("ENG-AC2z1: text/plain does not HTML-strip — < and & are preserved as-is", () => {
    const plain = "Price < 100 & > 50";
    expect(pageText(plain, "text/plain")).toBe("Price < 100 & > 50");
  });
});

// ── pageText — NFC normalization ─────────────────────────────────────────────

describe("pageText — ENG-AC2: NFC normalization", () => {
  it("ENG-AC2z2: NFD-encoded å (a + U+030A combining ring) is normalized to NFC U+00E5", () => {
    // NFD: a (U+0061) + combining ring above (U+030A) = visually 'å'
    const nfdA = "\u0061\u030A";
    const nfcA = "\u00E5"; // NFC å
    const html = `<html><body><p>${nfdA}r</p></body></html>`;
    const result = pageText(html, "text/html");
    expect(result).toBe(`${nfcA}r`);
    expect(result.codePointAt(0)).toBe(0x00e5);
  });
});

// ── hashPageText ─────────────────────────────────────────────────────────────

describe("hashPageText — ENG-AC2: v1: prefix + 64 lower-hex SHA-256", () => {
  it("ENG-AC2h1: PAGE_HASH_VERSION is 'v1'", () => {
    expect(PAGE_HASH_VERSION).toBe("v1");
  });

  it("ENG-AC2h2: returns 'v1:' + the SHA-256 of the text's UTF-8 bytes (known vector)", async () => {
    expect(await hashPageText("hello world")).toBe(
      "v1:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("ENG-AC2h3: hashes the UTF-8 encoding of non-ASCII text (æøå, checked against node:crypto)", async () => {
    expect(await hashPageText("æøå")).toBe(`v1:${createHash("sha256").update("æøå", "utf8").digest("hex")}`);
  });

  it("ENG-AC2h4: is deterministic — same input always produces the same hash", async () => {
    const a = await hashPageText("test content æøå");
    const b = await hashPageText("test content æøå");
    expect(a).toBe(b);
  });

  it("ENG-AC2h5: different inputs produce different hashes", async () => {
    const a = await hashPageText("content one");
    const b = await hashPageText("content two");
    expect(a).not.toBe(b);
  });

  it("ENG-AC2h6: empty string produces the SHA-256 of no bytes", async () => {
    expect(await hashPageText("")).toBe(
      "v1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// ── isCurrentPageHash ────────────────────────────────────────────────────────

describe("isCurrentPageHash — ENG-AC2: false for legacy/null → engine re-baselines", () => {
  it("ENG-AC2i1: returns true for a valid v1: prefixed hash", () => {
    expect(isCurrentPageHash("v1:" + "a".repeat(64))).toBe(true);
  });

  it("ENG-AC2i2: returns false for null (no stored hash — first run)", () => {
    expect(isCurrentPageHash(null)).toBe(false);
  });

  it("ENG-AC2i3: returns false for a hex string without v1: prefix (legacy format)", () => {
    expect(isCurrentPageHash("a".repeat(64))).toBe(false);
  });

  it("ENG-AC2i4: returns false for an arbitrary non-v1: prefix string", () => {
    expect(isCurrentPageHash("sha256:abc")).toBe(false);
    expect(isCurrentPageHash("v2:abc")).toBe(false);
  });

  it("ENG-AC2i5: returns true for the actual output of hashPageText (round-trip)", async () => {
    const hash = await hashPageText("some page content");
    expect(isCurrentPageHash(hash)).toBe(true);
  });
});
