/**
 * Switch look for a native checkbox (approved admin mocks: "Vis i menuen",
 * "Synlig", "Udvalgt"). It stays an `<input type="checkbox">`, so assistive
 * technology and forms treat it as one; only the paint changes.
 */
export const SWITCH_CLASS =
  "relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-pill border border-border-input bg-border transition-[background-color,border-color] before:absolute before:top-0.5 before:left-0.5 before:size-4.5 before:rounded-pill before:bg-bg before:shadow-card before:transition-transform hover:border-muted checked:border-accent checked:bg-accent checked:before:translate-x-5 checked:hover:border-accent-hover checked:hover:bg-accent-hover motion-reduce:before:transition-none";
