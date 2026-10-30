/**
 * Locale fallback merge: Danish (`base`) is the source of truth and every
 * other locale overrides it leaf by leaf.
 *
 * Rules (applied recursively through plain objects and arrays):
 * - The result has exactly the shape of `base`: base keys are never dropped,
 *   override-only keys are never added.
 * - An override leaf wins only when it is a non-blank string. Blank or
 *   whitespace-only strings, missing keys and non-string values fall back to
 *   the base value.
 *
 * Used for UI messages (`src/i18n/messages.ts`) and DB content
 * (`resolveContent`). A shallow spread would lose nested base keys.
 */

/** Override shape accepted for a base value: same keys, every key optional. */
export type LocalizedOverride<T> = T extends string
  ? string
  : T extends readonly (infer Item)[]
    ? readonly (LocalizedOverride<Item> | undefined)[]
    : T extends object
      ? { [K in keyof T]?: LocalizedOverride<T[K]> | null }
      : T;

/** Result of a merge plus the dotted paths of string leaves taken from base. */
export type MergeResult<T> = {
  value: T;
  fallbackPaths: string[];
};

/**
 * Recursively merges `override` onto `base`; see the module doc for the rules.
 */
export function mergeLocalized<T extends object>(
  base: T,
  override: LocalizedOverride<T> | null | undefined,
): T {
  return mergeLocalizedWithFallbacks(base, override).value;
}

/**
 * Same merge as {@link mergeLocalized}, also reporting which string leaves
 * fell back to `base` as dotted paths (`"lead"`, `"hero.title"`, `"items.0"`).
 * Callers use the paths to mark base-language text, e.g. `lang="da"` on an
 * English page (WCAG 3.1.2).
 */
export function mergeLocalizedWithFallbacks<T extends object>(
  base: T,
  override: LocalizedOverride<T> | null | undefined,
): MergeResult<T> {
  const fallbackPaths: string[] = [];
  const value = mergeNode(base, override, "", fallbackPaths) as T;
  return { value, fallbackPaths };
}

function mergeNode(base: unknown, override: unknown, path: string, fallbackPaths: string[]): unknown {
  if (Array.isArray(base)) {
    const overrideItems: readonly unknown[] = Array.isArray(override) ? override : [];
    return base.map((item, index) =>
      mergeNode(item, overrideItems[index], joinPath(path, String(index)), fallbackPaths),
    );
  }

  if (isPlainObject(base)) {
    const overrideRecord = isPlainObject(override) ? override : undefined;
    const merged: Record<string, unknown> = {};
    for (const [key, baseValue] of Object.entries(base)) {
      merged[key] = mergeNode(baseValue, overrideRecord?.[key], joinPath(path, key), fallbackPaths);
    }
    return merged;
  }

  if (isNonBlankString(override)) return override;
  if (typeof base === "string") fallbackPaths.push(path);
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}
