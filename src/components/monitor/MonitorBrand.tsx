import NextLink from "next/link";
import Logo from "@/components/brand/Logo";
import { cx } from "@/lib/cx";

export type MonitorBrandProps = {
  /** The product name beside the lockup ("Monitor"). */
  name: string;
  /** Makes the brand a link (the panel's way back to the dashboard). */
  href?: string;
  className?: string;
};

/**
 * The approved Monitor mocks' brand: the Alnyron lockup with a small mark and
 * the product name after a hairline. Read out as "Alnyron Monitor".
 */
export default function MonitorBrand({ name, href, className }: MonitorBrandProps) {
  const brand = (
    <>
      <Logo wordmark className="[&_img]:w-8" />
      <span className="border-l border-border pl-3 text-small text-muted">{name}</span>
    </>
  );
  const classes = cx("inline-flex min-h-11 items-center gap-3", className);

  return href ? (
    <NextLink href={href} className={cx(classes, "rounded-btn")}>
      {brand}
    </NextLink>
  ) : (
    <span className={classes}>{brand}</span>
  );
}
