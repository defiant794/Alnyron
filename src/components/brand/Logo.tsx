import Image from "next/image";
import NextLink from "next/link";
import { cx } from "@/lib/cx";

/** The real A-mark artwork (DESIGN.md "Logo mark"); intrinsic size of the PNG. */
const MARK = { src: "/brand/logo-mark.png", width: 235, height: 175 } as const;

export type LogoProps = {
  /** Show the ALNYRON wordmark to the right of the mark. */
  wordmark?: boolean;
  /** Wrap the logo in a link to the home page. */
  asLink?: boolean;
  /** Preload the mark, for the above-the-fold header instance. */
  priority?: boolean;
  className?: string;
};

/**
 * Alnyron logo: the A-mark, optionally with the wordmark, optionally linked to "/".
 * Either way it is announced once as "Alnyron": the mark alone carries the alt
 * text; with the wordmark the lockup is one labelled image and the mark itself
 * is decorative.
 */
export default function Logo({
  wordmark = false,
  asLink = false,
  priority,
  className,
}: LogoProps) {
  const mark = (
    <Image
      src={MARK.src}
      width={MARK.width}
      height={MARK.height}
      alt={wordmark ? "" : "Alnyron"}
      priority={priority}
      className="h-auto w-15 shrink-0"
    />
  );

  const logo = wordmark ? (
    <span role="img" aria-label="Alnyron" className="inline-flex items-center gap-3">
      {mark}
      <span className="text-h3 font-semibold tracking-wordmark text-brand-navy">ALNYRON</span>
    </span>
  ) : (
    mark
  );

  if (asLink) {
    return (
      <NextLink href="/" className={cx("inline-flex items-center rounded-btn", className)}>
        {logo}
      </NextLink>
    );
  }

  return <span className={cx("inline-flex items-center", className)}>{logo}</span>;
}
