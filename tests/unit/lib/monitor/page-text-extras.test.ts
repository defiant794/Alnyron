/**
 * Unit tests: src/lib/monitor/page-text.ts beyond the contract's examples
 * Journey: monitor-engine  ENG-AC2
 *
 * pageText: quoted `>` in attributes, nested and self-closing dropped elements,
 *   a head without `</head>`, NUL removal, literal `<`, unterminated script, a
 *   multi-line title as one line.
 * pageSnapshot: whole lines within MONITOR_SNAPSHOT_MAX_CHARS (exactly 50 000
 *   vs 50 001 chars, a line break right at the limit), no split surrogate pair.
 */
import { describe, expect, it } from "vitest";
import { MONITOR_SNAPSHOT_MAX_CHARS } from "@/config/monitor";
import { pageSnapshot, pageText } from "@/lib/monitor/page-text";

describe("pageText — ENG-AC2: tokenizer edge cases", () => {
  it("ENG-AC2pt1: a > inside a quoted attribute value does not end the tag", () => {
    expect(pageText('<p title="a > b" data-x=\'c > d\'>Text</p>', "text/html")).toBe("Text");
  });

  it("ENG-AC2pt2: a nested svg is dropped whole (same-name nesting counted)", () => {
    expect(pageText("<p>Before</p><svg><svg><text>Inner</text></svg><text>Outer</text></svg><p>After</p>", "text/html")).toBe(
      "Before\nAfter",
    );
  });

  it("ENG-AC2pt3: a self-closing svg drops nothing after it", () => {
    expect(pageText('<p>Icon<svg viewBox="0 0 1 1"/> label</p>', "text/html")).toBe("Icon label");
  });

  it("ENG-AC2pt4: a head without </head> ends at the first body tag, as in a browser", () => {
    expect(pageText("<html><head><title>T</title><meta charset=utf-8><p>Body text</p>", "text/html")).toBe(
      "T\nBody text",
    );
  });

  it("ENG-AC2pt5: NUL characters are removed (Postgres text cannot hold them)", () => {
    expect(pageText("A\u0000B", "text/plain")).toBe("AB");
    expect(pageText("<p>&#0;x</p>", "text/html")).toBe("\ufffdx");
  });

  it("ENG-AC2pt6: a < that starts no tag stays text", () => {
    expect(pageText("<p>5 < 10 and 3 <= 4</p>", "text/html")).toBe("5 < 10 and 3 <= 4");
  });

  it("ENG-AC2pt7: an unterminated script drops the rest of the document", () => {
    expect(pageText("<p>Shown</p><script>var leaked = '<p>Hidden</p>';", "text/html")).toBe("Shown");
  });

  it("ENG-AC2pt8: the title is one line even when its source spans several", () => {
    expect(pageText("<title>\n  My\n  Page\n</title><body><p>Body</p></body>", "text/html")).toBe("My Page\nBody");
  });
});

describe("pageSnapshot — ENG-AC2: what monitors.last_snapshot stores", () => {
  it("ENG-AC2snapshot1: text within the limit is stored whole", () => {
    const text = "line one\nline two";
    expect(pageSnapshot(text)).toBe(text);
  });

  it("ENG-AC2snapshot2: longer text keeps only whole lines within the limit", () => {
    const line = "x".repeat(999);
    const text = Array.from({ length: 60 }, () => line).join("\n");
    // Each line plus its break is 1000 characters: 50 whole lines end before the 50 000th.
    expect(pageSnapshot(text)).toBe(Array.from({ length: 50 }, () => line).join("\n"));
  });

  it("ENG-AC2snapshot3: a single over-long line is cut without splitting a surrogate pair", () => {
    const text = `${"a".repeat(MONITOR_SNAPSHOT_MAX_CHARS - 1)}😀tail`;
    const snapshot = pageSnapshot(text);
    expect(snapshot).toBe("a".repeat(MONITOR_SNAPSHOT_MAX_CHARS - 1));
    expect(snapshot.isWellFormed()).toBe(true);
  });

  it("ENG-AC2snapshot4: text of exactly 50 000 chars is stored whole; 50 001 chars cuts back to the last whole line", () => {
    const first = "a".repeat(100);
    const exact = `${first}\n${"b".repeat(MONITOR_SNAPSHOT_MAX_CHARS - 101)}`;
    expect(exact).toHaveLength(MONITOR_SNAPSHOT_MAX_CHARS);
    expect(pageSnapshot(exact)).toBe(exact);
    expect(pageSnapshot(`${exact}b`)).toBe(first);
  });

  it("ENG-AC2snapshot5: a line break right after the 50 000th char keeps all 50 000; one char later only the earlier lines", () => {
    const first = "a".repeat(100);
    const lines = `${first}\n${"b".repeat(MONITOR_SNAPSHOT_MAX_CHARS - 101)}`;
    expect(pageSnapshot(`${lines}\ntail`)).toBe(lines);
    expect(pageSnapshot(`${lines}b\ntail`)).toBe(first);
  });

  it("ENG-AC2snapshot6: a single line of exactly 50 000 chars is stored whole; one of 50 001 is cut to 50 000", () => {
    expect(pageSnapshot("a".repeat(MONITOR_SNAPSHOT_MAX_CHARS))).toBe("a".repeat(MONITOR_SNAPSHOT_MAX_CHARS));
    expect(pageSnapshot("a".repeat(MONITOR_SNAPSHOT_MAX_CHARS + 1))).toBe("a".repeat(MONITOR_SNAPSHOT_MAX_CHARS));
  });
});
