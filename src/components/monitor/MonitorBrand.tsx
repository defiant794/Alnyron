import Logo from "@/components/brand/Logo";
import { cx } from "@/lib/cx";

export type MonitorBrandProps = {
  /** Where the lockup leads: the main site's frontpage (absolute URL) outside the panel, the dashboard inside it. */
  href: string;
  className?: string;
};

/**
 * The Monitor area's brand: the site's ALNYRON lockup (`Logo wordmark`, as
 * `SiteHeader` renders it), always a link, announced as "Alnyron". It stays
 * a 44px tap target like every standalone link (DESIGN.md), also below 640px
 * where the mark is compact.
 */
export default function MonitorBrand({ href, className }: MonitorBrandProps) {
  return <Logo wordmark asLink href={href} priority className={cx("min-h-11", className)} />;
}
