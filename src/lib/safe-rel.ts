import type { LinkProps } from "next/link";

type Href = LinkProps["href"];

/** Absolute http(s) URL or protocol-relative URL ("//host/..."). */
const EXTERNAL_URL = /^(?:https?:)?\/\//i;

/** True when the href leaves the site over http(s). */
export function isExternalHref(href: Href): boolean {
  if (typeof href === "string") return EXTERNAL_URL.test(href);
  if (href.protocol) return /^https?:?$/i.test(href.protocol);
  return typeof href.href === "string" && EXTERNAL_URL.test(href.href);
}

/**
 * Returns the `rel` for a link. External links opened with `target="_blank"`
 * always get `noopener noreferrer` (no `window.opener` access, no referrer
 * leak), merged with any tokens the caller passed. Other links keep the
 * caller's `rel` unchanged.
 */
export function safeRel(
  href: Href,
  target: string | undefined,
  rel: string | undefined,
): string | undefined {
  if (target !== "_blank" || !isExternalHref(href)) return rel;
  const tokens = new Set(rel?.split(/\s+/).filter(Boolean));
  tokens.add("noopener");
  tokens.add("noreferrer");
  return [...tokens].join(" ");
}
