"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import LoadingStatus from "@/components/ui/LoadingStatus";

const PendingContext = createContext(false);

/** Counts a mounted loading fallback in; the returned function counts it out again. */
type RegisterFallback = () => () => void;

const RegisterFallbackContext = createContext<RegisterFallback | null>(null);

export type NavigationPendingProviderProps = Readonly<{
  /** Classes of the frame element (the shell's layout). */
  className?: string;
  children: ReactNode;
}>;

/**
 * Frames the admin shell (sidebar and content) and notices a link click in
 * it that starts a client-side navigation, so the outgoing page makes way for
 * a loading status at once ({@link NavigationPendingContent}).
 *
 * The App Router keeps the old page on screen, and usable, until the server
 * has answered a navigation: a `loading.tsx` fallback can only appear once
 * that first response (or a finished prefetch) is in. On a slow network a
 * stale control, such as the old section's "+ Nyt element", could otherwise
 * still be clicked meanwhile.
 *
 * `next/link` cancels the default of a click it turns into a client-side
 * navigation and starts that navigation in a transition before the click
 * bubbles up here. The pending mark is an optimistic value set in a
 * transition of the same event, so React puts both in the same lane: the mark
 * shows at once and reverts in the commit that shows the new page (or the
 * old page again when the navigation fails). A click that keeps its default
 * (a new tab, an external link, a download) starts no navigation and marks
 * nothing.
 */
export function NavigationPendingProvider({ className, children }: NavigationPendingProviderProps) {
  const [pending, setPending] = useOptimistic(false);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (!event.defaultPrevented) return;
    if (!(event.target instanceof Element) || event.target.closest("a[href]") === null) return;
    startTransition(() => setPending(true));
  }

  return (
    <PendingContext value={pending}>
      <div className={className} onClick={handleClick}>
        {children}
      </div>
    </PendingContext>
  );
}

export type NavigationPendingContentProps = Readonly<{
  /** Text of the loading status ("Indlæser siden …"). */
  label: string;
  children: ReactNode;
}>;

/**
 * The page content inside {@link NavigationPendingProvider}, behind the one
 * status region that tells when the next page is on its way.
 *
 * While a navigation started in the shell is pending, a loading status takes
 * the content's place. The old page stays mounted but `hidden` (not shown,
 * focusable or clickable), so a navigation that fails brings it back as it
 * was. When focus was in it (a link activated with the keyboard), focus
 * moves to the `<main>` around the content (the shell's, `tabIndex={-1}`)
 * instead of dropping to `<body>`, and stays there when the next page shows,
 * so the next Tab enters that page. Focus outside the content, such as on
 * the sidebar link that was used, stays where it is.
 *
 * Once the next page's `loading.tsx` fallback ({@link NavigationPendingFallback})
 * is on screen, the fallback shows the spinner and text and the region keeps
 * the text visually hidden, so nothing shows twice. A navigation that commits
 * into that fallback (the server has answered, the page is still loading)
 * hands the text over in the element the region showed while pending: the
 * commit that ends the pending state still renders it (`wasPending` is only
 * cleared by this component's layout effect), and by then the fallback, whose
 * layout effect runs first, has counted itself in. Both updates render
 * together before paint, so the region's text is never taken out and put in
 * again (a new element might be announced twice). Without a fallback the
 * element is removed in that same pass.
 *
 * The status region is always in the DOM and only gets its text while a
 * navigation is pending or a fallback is mounted, so screen readers announce
 * the change (a live region that appears with its text already in it may
 * not be announced). `aria-live` and `aria-atomic` repeat the role's
 * defaults for assistive technology that misses the role of a
 * `display: contents` element. Both wrappers are `display: contents`: the
 * empty region adds no gap, and the page's own elements stay the items of the
 * surrounding layout.
 */
export default function NavigationPendingContent({ label, children }: NavigationPendingContentProps) {
  const pending = useContext(PendingContext);
  /** `pending` as of the last commit's layout effects: keeps the status element through the handoff. */
  const [wasPending, setWasPending] = useState(false);
  const [fallbacks, setFallbacks] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const registerFallback = useCallback<RegisterFallback>(() => {
    setFallbacks((count) => count + 1);
    return () => setFallbacks((count) => count - 1);
  }, []);

  // A layout effect runs in the commit that hides the content, before the
  // browser drops focus from a hidden element to `<body>`.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!pending || content === null || !content.contains(document.activeElement)) return;
    content.closest("main")?.focus({ preventScroll: true });
  }, [pending]);

  // Runs after the layout effect of a fallback mounted in the same commit (a
  // child's runs first); React renders both updates together before paint.
  useLayoutEffect(() => setWasPending(pending), [pending]);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="contents">
        {(pending || wasPending || fallbacks > 0) && (
          <LoadingStatus label={label} className={pending ? undefined : "sr-only"} />
        )}
      </div>
      <div ref={contentRef} hidden={pending} className="contents">
        <RegisterFallbackContext value={registerFallback}>{children}</RegisterFallbackContext>
      </div>
    </>
  );
}

/** `useSyncExternalStore` subscription of a value that never changes (stable, so it never resubscribes). */
const subscribeToNothing = () => () => {};

export type NavigationPendingFallbackProps = Readonly<{
  /** Text of the loading status ("Indlæser siden …"). */
  label: string;
}>;

/**
 * Loading fallback of a route (its `loading.tsx`) inside
 * {@link NavigationPendingContent}: the spinner and text, announced through
 * the content's status region. A fallback mounts with its text already in
 * it, which screen readers may not announce as a region of its own, so while
 * it is mounted it counts itself into that always present region (which then
 * gets the text) and hides its own copy from assistive technology. Rendered
 * on the server (the fallback a full page load streams), it keeps its text
 * readable, since the region is only filled on the client. Outside the admin
 * shell it is plain text.
 */
export function NavigationPendingFallback({ label }: NavigationPendingFallbackProps) {
  const registerFallback = useContext(RegisterFallbackContext);
  const clientRendered = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  useLayoutEffect(() => registerFallback?.(), [registerFallback]);
  return <LoadingStatus label={label} aria-hidden={clientRendered && registerFallback !== null} />;
}
