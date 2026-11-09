import {
  MONITOR_SUMMARY_MAX_CHARS,
  MONITOR_SUMMARY_MAX_LINE_CHARS,
  MONITOR_SUMMARY_MAX_LINES,
} from "@/config/monitor";

/** Prefix of an added line ("+ "). */
const ADDED_PREFIX = "+ ";

/** Prefix of a removed line: U+2212 MINUS SIGN and a space. */
const REMOVED_PREFIX = "\u2212 ";

/**
 * The lines of `lines` left over after taking out, once per occurrence, every
 * line `other` holds (a multiset difference), in `lines` order.
 */
function linesBeyond(lines: readonly string[], other: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const line of other) available.set(line, (available.get(line) ?? 0) + 1);
  return lines.filter((line) => {
    const count = available.get(line) ?? 0;
    if (count === 0) return true;
    available.set(line, count - 1);
    return false;
  });
}

/**
 * The short "what changed" text of a monitor event (`monitor_events.summary`):
 * added lines first (`+ line`, in the new text's order), then removed lines
 * (`− line`, in the old text's order), compared as multisets of lines (one
 * pass, no alignment). At most {@link MONITOR_SUMMARY_MAX_LINES} lines, each at
 * most {@link MONITOR_SUMMARY_MAX_LINE_CHARS} characters with its prefix
 * (longer ones end in `…`), {@link MONITOR_SUMMARY_MAX_CHARS} in all.
 *
 * @returns null without an old snapshot to compare with, or when no line
 * differs (the change lies past the stored part of the page).
 */
export function summarizeChange(oldSnapshot: string | null, newSnapshot: string): string | null {
  if (oldSnapshot === null) return null;
  const oldLines = oldSnapshot.split("\n").filter((line) => line !== "");
  const newLines = newSnapshot.split("\n").filter((line) => line !== "");
  const entries = [
    ...linesBeyond(newLines, oldLines).map((line) => ADDED_PREFIX + line),
    ...linesBeyond(oldLines, newLines).map((line) => REMOVED_PREFIX + line),
  ];

  const output: string[] = [];
  let length = 0;
  for (const entry of entries.slice(0, MONITOR_SUMMARY_MAX_LINES)) {
    let line = entry;
    if (line.length > MONITOR_SUMMARY_MAX_LINE_CHARS) {
      const cut = line.slice(0, MONITOR_SUMMARY_MAX_LINE_CHARS - 1);
      // Never leave half of a surrogate pair before the ellipsis.
      line = `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
    }
    const nextLength = length + (output.length > 0 ? 1 : 0) + line.length;
    if (nextLength > MONITOR_SUMMARY_MAX_CHARS) break;
    output.push(line);
    length = nextLength;
  }
  return output.length > 0 ? output.join("\n") : null;
}
