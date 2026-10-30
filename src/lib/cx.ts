/** Joins the truthy class names with single spaces (falsy entries are skipped). */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
