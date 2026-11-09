/**
 * Unit tests: src/lib/monitor/change-summary.ts — summarizeChange
 * Journey: monitor-engine  ENG-AC1, ENG-AC2
 *
 * Covers: null-when-old-null, null-when-no-diff (also when the change lies past
 * the snapshot cap), added-first order, U+2212 prefix, duplicate counting
 * (multiset), the line limit (exactly 5 vs 6 lines) and the line cut (exactly
 * 160 vs 161 chars, no split surrogate pair). Every case asserts the whole summary.
 */
import { describe, expect, it } from "vitest";
import {
  MONITOR_SUMMARY_MAX_CHARS,
  MONITOR_SUMMARY_MAX_LINE_CHARS,
  MONITOR_SUMMARY_MAX_LINES,
} from "@/config/monitor";
import { summarizeChange } from "@/lib/monitor/change-summary";
import { pageSnapshot } from "@/lib/monitor/page-text";

// Confirm the literals this file depends on so the test pins them exactly.
describe("config literals pinned — ENG-AC1", () => {
  it("MONITOR_SUMMARY_MAX_LINES is 5", () => {
    expect(MONITOR_SUMMARY_MAX_LINES).toBe(5);
  });
  it("MONITOR_SUMMARY_MAX_LINE_CHARS is 160", () => {
    expect(MONITOR_SUMMARY_MAX_LINE_CHARS).toBe(160);
  });
  it("MONITOR_SUMMARY_MAX_CHARS is 1000", () => {
    expect(MONITOR_SUMMARY_MAX_CHARS).toBe(1000);
  });
});

// ── null cases ───────────────────────────────────────────────────────────────

describe("summarizeChange — ENG-AC2: null cases", () => {
  it("ENG-AC2sum1: returns null when oldSnapshot is null", () => {
    expect(summarizeChange(null, "anything")).toBeNull();
  });

  it("ENG-AC2sum2: returns null when old and new are identical (no differing line)", () => {
    expect(summarizeChange("line a\nline b", "line a\nline b")).toBeNull();
  });

  it("ENG-AC2sum3: returns null when every differing line lies past the snapshot cap", () => {
    // 1000 lines of 49 characters plus a line break fill the 50 000-character snapshot exactly;
    // only the text after them differs, so both stored snapshots are the same.
    const head = `${"x".repeat(49)}\n`.repeat(1000);
    const oldSnapshot = pageSnapshot(`${head}old tail`);
    const newSnapshot = pageSnapshot(`${head}new tail`);
    expect(newSnapshot).toBe(head.slice(0, -1));
    expect(summarizeChange(oldSnapshot, newSnapshot)).toBeNull();
  });
});

// ── U+2212 MINUS SIGN prefix ─────────────────────────────────────────────────

describe("summarizeChange — ENG-AC1: U+2212 MINUS SIGN prefix for removed lines", () => {
  it("ENG-AC1sum1: added lines are prefixed with '+ ' (ASCII plus-space)", () => {
    expect(summarizeChange("kept", "kept\nnew line")).toBe("+ new line");
  });

  it("ENG-AC1sum2: removed lines are prefixed with U+2212 + space (not ASCII hyphen)", () => {
    const result = summarizeChange("old line\nkept", "kept");
    expect(result).toBe("\u2212 old line");
    // Must NOT be ASCII hyphen-minus (U+002D)
    expect(result!.charCodeAt(0)).toBe(0x2212);
  });
});

// ── Added-first ordering ─────────────────────────────────────────────────────

describe("summarizeChange — ENG-AC1: added lines appear before removed lines", () => {
  it("ENG-AC1sum3: added lines first (new text's order), then removed lines (old text's order)", () => {
    expect(summarizeChange("alpha\nbeta\ndelta", "gamma\nalpha\nepsilon")).toBe(
      "+ gamma\n+ epsilon\n\u2212 beta\n\u2212 delta",
    );
  });
});

// ── Duplicate counting (multiset) ─────────────────────────────────────────────

describe("summarizeChange — ENG-AC1: duplicates counted (multiset diff)", () => {
  it("ENG-AC1sum4: a line appearing twice in new but once in old contributes one added entry", () => {
    // new has 2, old has 1 → net +1
    expect(summarizeChange("line a", "line a\nline a")).toBe("+ line a");
  });

  it("ENG-AC1sum5: a line appearing twice in old but once in new contributes one removed entry", () => {
    // old has 2, new has 1 → net -1
    expect(summarizeChange("line a\nline a", "line a")).toBe("\u2212 line a");
  });
});

// ── MONITOR_SUMMARY_MAX_LINES limit ─────────────────────────────────────────

describe("summarizeChange — ENG-AC1: at most MONITOR_SUMMARY_MAX_LINES (5) output lines", () => {
  it("ENG-AC1sum6: a 10-added / 10-removed diff keeps the first 5 entries (all added)", () => {
    const old = Array.from({ length: 10 }, (_, i) => `removed-${i}`).join("\n");
    const next = Array.from({ length: 10 }, (_, i) => `added-${i}`).join("\n");
    expect(summarizeChange(old, next)).toBe(
      ["+ added-0", "+ added-1", "+ added-2", "+ added-3", "+ added-4"].join("\n"),
    );
  });

  it("ENG-AC1sum11: exactly 5 differing lines (3 added, 2 removed) are all kept", () => {
    expect(summarizeChange("a\nb\nkept", "kept\nc\nd\ne")).toBe("+ c\n+ d\n+ e\n\u2212 a\n\u2212 b");
  });

  it("ENG-AC1sum12: a 6th differing line (3 added, 3 removed) is dropped: the last removed one", () => {
    expect(summarizeChange("a\nb\nf\nkept", "kept\nc\nd\ne")).toBe("+ c\n+ d\n+ e\n\u2212 a\n\u2212 b");
  });
});

// ── MONITOR_SUMMARY_MAX_LINE_CHARS (160) truncation ─────────────────────────

describe("summarizeChange — ENG-AC1: each output line ≤ 160 chars (incl. prefix)", () => {
  it("ENG-AC1sum7: a 200-char added line is cut to exactly 160 chars: prefix, 157 chars and …", () => {
    expect(summarizeChange("other", "x".repeat(200))).toBe(`+ ${"x".repeat(157)}…\n\u2212 other`);
  });

  it("ENG-AC1sum8: a 200-char removed line is cut to exactly 160 chars: prefix, 157 chars and …", () => {
    expect(summarizeChange("y".repeat(200), "other")).toBe(`+ other\n\u2212 ${"y".repeat(157)}…`);
  });

  it("ENG-AC1sum10: a cut that would end in half a surrogate pair drops it (159 chars)", () => {
    // "+ " + 156 × x puts the emoji's high surrogate at index 158, the last one the cut keeps.
    const result = summarizeChange("other", `${"x".repeat(156)}😀${"z".repeat(10)}`);
    expect(result).toBe(`+ ${"x".repeat(156)}…\n\u2212 other`);
    expect(result!.isWellFormed()).toBe(true);
  });

  it("ENG-AC1sum13: lines of exactly 160 chars with their prefix are kept whole", () => {
    expect(summarizeChange("y".repeat(158), "x".repeat(158))).toBe(`+ ${"x".repeat(158)}\n\u2212 ${"y".repeat(158)}`);
  });

  it("ENG-AC1sum14: lines of 161 chars with their prefix are cut to 160: prefix, 157 chars and …", () => {
    expect(summarizeChange("y".repeat(159), "x".repeat(159))).toBe(
      `+ ${"x".repeat(157)}…\n\u2212 ${"y".repeat(157)}…`,
    );
  });
});

// ── MONITOR_SUMMARY_MAX_CHARS (1000) note ────────────────────────────────────
// With MAX_LINES=5 and MAX_LINE_CHARS=160 the longest summary is 5×160 + 4
// line breaks = 804 chars, so the 1000-char total never binds with the real
// limits. change-summary-total-cap.test.ts raises the line limit to reach the
// total's exact edge; the test below verifies the max-lines limit.

describe("summarizeChange — ENG-AC1: max-lines limit is enforced before the total-chars limit", () => {
  it("ENG-AC1sum9: large diff (20 added + 20 removed) keeps exactly the first MONITOR_SUMMARY_MAX_LINES (5) entries", () => {
    const old  = Array.from({ length: 20 }, (_, i) => `removed-line-${i}`).join("\n");
    const next = Array.from({ length: 20 }, (_, i) => `added-line-${i}`).join("\n");
    expect(summarizeChange(old, next)).toBe(
      Array.from({ length: MONITOR_SUMMARY_MAX_LINES }, (_, i) => `+ added-line-${i}`).join("\n"),
    );
  });
});
