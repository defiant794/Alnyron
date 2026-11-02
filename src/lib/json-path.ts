/**
 * The string at a dotted `path` (`"ctaBand.title"`) inside parsed JSON, or
 * `undefined` when the path is missing or ends at something else.
 */
export function stringAt(value: unknown, path: string): string | undefined {
  let node = value;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : undefined;
}
