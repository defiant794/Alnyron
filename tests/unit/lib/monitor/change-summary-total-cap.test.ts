/**
 * Unit tests: src/lib/monitor/change-summary.ts — the MONITOR_SUMMARY_MAX_CHARS stop
 * Journey: monitor-engine  ENG-AC1
 *
 * With the real limits the longest summary is 5 lines × 160 chars + 4 line
 * breaks = 804 chars, so the 1000-char total never binds. This file raises the
 * line limit to 7 (the config module is mocked; every other constant stays
 * real) to reach the total's exact edge: 1000 chars kept, 1001 stopped.
 */
import { describe, expect, it, vi } from "vitest";
import type * as MonitorConfig from "@/config/monitor";
import { MONITOR_SUMMARY_MAX_CHARS, MONITOR_SUMMARY_MAX_LINES } from "@/config/monitor";
import { summarizeChange } from "@/lib/monitor/change-summary";

vi.mock("@/config/monitor", async (importOriginal) => ({
  ...(await importOriginal<typeof MonitorConfig>()),
  MONITOR_SUMMARY_MAX_LINES: 7,
}));

/** Six added lines of 158 chars: with "+ " each output line is 160, together 6 × 160 + 5 breaks = 965. */
const ADDED = ["a", "b", "c", "d", "e", "f"].map((first) => `${first}${"x".repeat(157)}`);
const ADDED_SUMMARY = ADDED.map((line) => `+ ${line}`).join("\n");

describe("summarizeChange — ENG-AC1: the MONITOR_SUMMARY_MAX_CHARS (1000) total", () => {
  it("ENG-AC1sum15/16 setup: only the line limit is raised (to 7); the total stays 1000", () => {
    expect(MONITOR_SUMMARY_MAX_LINES).toBe(7);
    expect(MONITOR_SUMMARY_MAX_CHARS).toBe(1000);
    expect(ADDED_SUMMARY).toHaveLength(965);
  });

  it("ENG-AC1sum15: a 7th line that brings the summary to exactly 1000 chars is kept", () => {
    // 965 + 1 break + "− " + 32 chars = 1000.
    const summary = summarizeChange("r".repeat(32), ADDED.join("\n"));
    expect(summary).toBe(`${ADDED_SUMMARY}\n\u2212 ${"r".repeat(32)}`);
    expect(summary).toHaveLength(MONITOR_SUMMARY_MAX_CHARS);
  });

  it("ENG-AC1sum16: a 7th line that would bring it to 1001 chars is left out", () => {
    // 965 + 1 break + "− " + 33 chars = 1001.
    expect(summarizeChange("r".repeat(33), ADDED.join("\n"))).toBe(ADDED_SUMMARY);
  });
});
