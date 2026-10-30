export type SkipLinkProps = {
  /** Link text. Defaults to the Danish label. */
  label?: string;
};

/**
 * First focusable element on every page: jumps keyboard users past the
 * header to `<main id="main">`. Visually hidden until it receives focus.
 */
export default function SkipLink({ label = "Spring til indhold" }: SkipLinkProps) {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-btn focus:border focus:border-border focus:bg-bg focus:px-4 focus:text-body focus:font-semibold focus:text-accent focus:shadow-card"
    >
      {label}
    </a>
  );
}
