"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Gives keyboard users a fresh page after every client-side navigation: the
 * next Tab reaches the {@link SkipLink} first, as after a full page load.
 *
 * A soft navigation keeps the document and swaps only the page segment. The
 * element that had focus (the submit button of a Server Action form that
 * redirects, or an activated link) goes with the old page, but the browser
 * keeps its sequential focus navigation starting point where that element
 * was: inside the new page's content, past the skip link. The App Router's
 * own `focus()` aims at the new segment's first element, which is not
 * focusable, so it changes nothing, and neither does `blur()`. After each
 * pathname change that left nothing focused, this focuses `<body>` (made
 * focusable for that moment, without scrolling) and blurs it straight away,
 * which moves the starting point to the top of the page before anything is
 * painted. The first render (a full page load) is left alone, and so is
 * focus the new page set on purpose (e.g. an alert it focuses on arrival).
 */
export default function NavigationFocusReset() {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (pathname === previousPathname.current) return;
    previousPathname.current = pathname;

    const { body } = document;
    if (document.activeElement !== null && document.activeElement !== body) return;

    body.tabIndex = -1;
    body.focus({ preventScroll: true });
    body.blur();
    body.removeAttribute("tabindex");
  }, [pathname]);

  return null;
}
