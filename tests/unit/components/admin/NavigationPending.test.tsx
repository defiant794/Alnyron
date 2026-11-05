// @vitest-environment jsdom
/**
 * Unit tests — NavigationPending (src/components/admin/NavigationPending.tsx)
 * Journey: catalog-section-fix
 * Acceptance ID: AC-CATSEC-15
 *
 * A link click in the admin shell that starts a client-side navigation hides
 * the outgoing page behind a loading text in an always-present
 * `role="status"` region until the next page commits. `FakeRouter` stands in
 * for the App Router the way next/link drives it: the click cancels the
 * default and sets the next page (a promise) in a transition; the page reads
 * it with `use()`, so that transition stays pending until the page "arrives".
 * The page sits in an error boundary, as a route's `error.tsx` does.
 * tests/e2e/catalog-section-fix.spec.ts (AC-CATSEC-15 race-1/race-2) covers
 * the real router with held RSC requests.
 *
 * Design review catalog-section-fix-design-1: focus that was in the hidden
 * page moves to `<main>` (F3); the region states `aria-live`/`aria-atomic`
 * (F4); a mounted `loading.tsx` fallback (`NavigationPendingFallback`) is
 * announced through that same region and is no region itself (F5).
 *
 * Code review catalog-section-fix-review-3: a navigation that commits into
 * the next page's still-loading fallback hands the text over in the same
 * element of the region (no new node that could be announced again).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, isInaccessible, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { Component, Suspense, startTransition, use, useState, type MouseEvent, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import NavigationPendingContent, {
  NavigationPendingFallback,
  NavigationPendingProvider,
} from "@/components/admin/NavigationPending";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LABEL = "Indlæser siden …";
const FAILED = "Siden kunne ikke vises";

/** The page of a navigation that never finishes. */
const NEVER = new Promise<string>(() => {});

type Route = string | Promise<string>;

/** The section page: its "+ Nyt element" names the section it was rendered for. */
function SectionPage({ route }: Readonly<{ route: Route }>) {
  const section = typeof route === "string" ? route : use(route);
  return <a href={`/admin/catalog/items/new?category=${section}`}>+ Nyt element</a>;
}

/** Shows a fallback when the page fails to render, as a route's `error.tsx` does. */
class PageErrorBoundary extends Component<Readonly<{ children: ReactNode }>, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p>{FAILED}</p> : this.props.children;
  }
}

// FakeRouter's and LoadingShell's plain anchors play next/link (whose real click handling needs the App Router).
/* eslint-disable @next/next/no-html-link-for-pages */
function FakeRouter({
  websites = NEVER,
  services = NEVER,
  loading,
}: Readonly<{
  websites?: Promise<string>;
  services?: Promise<string>;
  /** Content shown before the page, such as a loading fallback that is still mounted. */
  loading?: ReactNode;
}>) {
  const [route, setRoute] = useState<Route>("apps");
  const navigate = (next: Promise<string>) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    startTransition(() => setRoute(next));
  };
  return (
    <NavigationPendingProvider>
      <nav aria-label="Administration">
        <a href="/admin/catalog/websites" onClick={navigate(websites)}>
          <span>Hjemmesider</span>
        </a>
        <a href="/admin/catalog/services" onClick={navigate(services)}>
          Ydelser
        </a>
        <a href="#hjaelp">Hjælp</a>
        <a href="/admin/catalog/del" onClick={(event) => event.preventDefault()}>
          Del
        </a>
        <button type="button" onClick={(event) => event.preventDefault()}>
          Knap
        </button>
      </nav>
      <main tabIndex={-1}>
        <NavigationPendingContent label={LABEL}>
          {loading}
          <PageErrorBoundary>
            <SectionPage route={route} />
          </PageErrorBoundary>
          <a href="/admin/catalog/categories/websites" onClick={navigate(websites)}>
            Rediger Hjemmesider
          </a>
        </NavigationPendingContent>
      </main>
    </NavigationPendingProvider>
  );
}

/**
 * The admin shell around a page in a `loading.tsx` boundary. Its sidebar link
 * navigates the way the App Router does: the navigation stays pending until
 * the server has answered (`response`), then commits the next page in a
 * `loading.tsx` boundary of its own, where that page may still be loading
 * (`next`).
 */
function LoadingShell({
  page,
  response = NEVER,
  next = NEVER,
}: Readonly<{ page: Route; response?: Promise<string>; next?: Route }>) {
  const [navigated, setNavigated] = useState(false);
  return (
    <NavigationPendingProvider>
      <nav aria-label="Administration">
        <a
          href="/admin/catalog/websites"
          onClick={(event) => {
            event.preventDefault();
            startTransition(() => setNavigated(true));
          }}
        >
          Hjemmesider
        </a>
      </nav>
      <main tabIndex={-1}>
        <NavigationPendingContent label={LABEL}>
          {navigated ? (
            <NextPage response={response} page={next} />
          ) : (
            <Suspense fallback={<NavigationPendingFallback label={LABEL} />}>
              <SectionPage route={page} />
            </Suspense>
          )}
        </NavigationPendingContent>
      </main>
    </NavigationPendingProvider>
  );
}
/* eslint-enable @next/next/no-html-link-for-pages */

/**
 * The next page of a navigation. Until the server has answered it suspends
 * outside any boundary, so the router keeps the old page (the navigation is
 * pending); then it renders in its own `loading.tsx` boundary.
 */
function NextPage({ response, page }: Readonly<{ response: Promise<string>; page: Route }>) {
  use(response);
  return (
    <Suspense fallback={<NavigationPendingFallback label={LABEL} />}>
      <SectionPage route={page} />
    </Suspense>
  );
}

/**
 * Records the nodes added to and removed from the region from now on (until
 * the returned function is called). A class change is no such change: it
 * does not touch the text assistive technology announces.
 */
function recordRegionChanges(region: HTMLElement) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    return {
      added: records.flatMap((record) => [...record.addedNodes]),
      removed: records.flatMap((record) => [...record.removedNodes]),
      texts: records.filter((record) => record.type === "characterData"),
    };
  };
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** The page is shown again and the status region is empty. */
function expectSettled(section: string) {
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(accessibleLoadingTexts()).toHaveLength(0);
  const newItem = screen.getByRole("link", { name: "+ Nyt element" });
  expect(newItem).toBeVisible();
  expect(newItem).toHaveAttribute("href", `/admin/catalog/items/new?category=${section}`);
}

/** The loading text outside the status region: the fallback's own copy. */
function fallbackCopy(status: HTMLElement) {
  const copies = screen.getAllByText(LABEL).filter((element) => !status.contains(element));
  expect(copies).toHaveLength(1);
  return copies[0]!;
}

/** The loading texts assistive technology gets (not `hidden`, not `aria-hidden`). */
function accessibleLoadingTexts() {
  return screen.queryAllByText(LABEL).filter((element) => !isInaccessible(element));
}

describe("AC-CATSEC-15: a pending navigation hides the outgoing page behind a loading status", () => {
  it("AC-CATSEC-15u-a: before any click the page shows and the status region is empty", () => {
    render(<FakeRouter />);
    expectSettled("apps");
  });

  it("AC-CATSEC-15u-b: a link click that starts a navigation fills the status region and hides the stale controls until the next page commits", async () => {
    const websites = Promise.withResolvers<string>();
    render(<FakeRouter websites={websites.promise} />);
    const status = screen.getByRole("status");
    const stale = screen.getByRole("link", { name: "+ Nyt element" });

    // The click lands on an element inside the link, as a real click on its text does.
    await click(screen.getByText("Hjemmesider"));

    // The region that was there all along gets the text, so it is announced.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent(LABEL);
    expect(accessibleLoadingTexts()).toEqual([status.firstElementChild]);
    expect(stale).not.toBeVisible();
    expect(stale).toHaveAttribute("href", "/admin/catalog/items/new?category=apps");

    await act(async () => {
      websites.resolve("websites");
    });

    expect(screen.getByRole("status")).toBe(status);
    expectSettled("websites");
  });

  it("AC-CATSEC-15u-c: a link click that keeps its default (no client navigation) marks nothing", async () => {
    render(<FakeRouter />);
    await click(screen.getByRole("link", { name: "Hjælp" }));
    expectSettled("apps");
  });

  it("AC-CATSEC-15u-d: a cancelled click outside any link marks nothing", async () => {
    render(<FakeRouter />);
    await click(screen.getByRole("button", { name: "Knap" }));
    expectSettled("apps");
  });

  it("AC-CATSEC-15u-e: a link click that only cancels the default (no navigation starts) leaves the page shown", async () => {
    render(<FakeRouter />);
    await click(screen.getByRole("link", { name: "Del" }));
    expectSettled("apps");
  });

  it("AC-CATSEC-15u-f: a navigation that never finishes, superseded by one that does, leaves no loading status", async () => {
    const services = Promise.withResolvers<string>();
    render(<FakeRouter services={services.promise} />);

    await click(screen.getByText("Hjemmesider"));
    expect(screen.getByRole("status")).toHaveTextContent(LABEL);

    // The sidebar stays usable while a navigation is pending.
    await click(screen.getByRole("link", { name: "Ydelser" }));
    expect(screen.getByRole("status")).toHaveTextContent(LABEL);

    await act(async () => {
      services.resolve("services");
    });

    expectSettled("services");
  });

  it("AC-CATSEC-15u-g: a navigation whose page fails shows the error boundary, not a stuck loading status", async () => {
    // React reports the error the boundary caught on the console.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const websites = Promise.withResolvers<string>();
    render(<FakeRouter websites={websites.promise} />);

    await click(screen.getByText("Hjemmesider"));
    expect(screen.getByRole("status")).toHaveTextContent(LABEL);

    await act(async () => {
      websites.reject(new Error("RSC request failed"));
    });

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText(FAILED)).toBeVisible();
    expect(screen.queryByRole("link", { name: "+ Nyt element" })).not.toBeInTheDocument();
  });
});

describe("AC-CATSEC-15 (design F3): keyboard focus is not lost while the outgoing page is hidden", () => {
  it("AC-CATSEC-15u-h: a page link activated with Enter moves focus to <main>, where it stays, so the next Tab enters the new page", async () => {
    const user = userEvent.setup();
    const websites = Promise.withResolvers<string>();
    render(<FakeRouter websites={websites.promise} />);
    const edit = screen.getByRole("link", { name: "Rediger Hjemmesider" });
    const main = screen.getByRole("main");

    edit.focus();
    // The navigation suspends, so the key press runs in an awaited act scope.
    await act(async () => {
      await user.keyboard("{Enter}");
    });

    expect(screen.getByRole("status")).toHaveTextContent(LABEL);
    expect(edit).not.toBeVisible();
    expect(main).toHaveFocus();

    await act(async () => {
      websites.resolve("websites");
    });

    expectSettled("websites");
    expect(main).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "+ Nyt element" })).toHaveFocus();
  });

  it("AC-CATSEC-15u-i: focus on the sidebar link that started the navigation stays there", async () => {
    render(<FakeRouter />);
    const services = screen.getByRole("link", { name: "Ydelser" });

    services.focus();
    await click(services);

    expect(screen.getByRole("status")).toHaveTextContent(LABEL);
    expect(services).toHaveFocus();
  });

  it("AC-CATSEC-15u-j: focus left in the page when a sidebar link is clicked (without taking focus) moves to <main>", async () => {
    render(<FakeRouter />);
    const newItem = screen.getByRole("link", { name: "+ Nyt element" });

    newItem.focus();
    await click(screen.getByRole("link", { name: "Ydelser" }));

    expect(newItem).not.toBeVisible();
    expect(screen.getByRole("main")).toHaveFocus();
  });
});

describe("AC-CATSEC-15 (design F4): the status region states its live-region semantics", () => {
  it("AC-CATSEC-15u-k: the region carries aria-live=polite and aria-atomic=true, not only role=status", () => {
    render(<FakeRouter />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
  });
});

describe("AC-CATSEC-15 (design F5): a mounted loading fallback is announced through the shell's status region", () => {
  it("AC-CATSEC-15u-l: a fallback that mounts puts the text into the region that was there all along; the fallback is no region and hides its own copy", async () => {
    const websites = Promise.withResolvers<string>();
    const { rerender } = render(<LoadingShell page="apps" />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    // The next page's data is still on the way: its boundary shows the fallback.
    await act(async () => {
      rerender(<LoadingShell page={websites.promise} />);
    });

    expect(screen.getAllByRole("status")).toEqual([status]);
    expect(status).toHaveTextContent(LABEL);
    // The fallback shows the spinner and text; the region keeps the text visually hidden.
    expect(status.firstElementChild).toHaveClass("sr-only");
    const copy = fallbackCopy(status);
    expect(copy).toBeVisible();
    expect(copy).toHaveAttribute("aria-hidden", "true");
    expect(accessibleLoadingTexts()).toEqual([status.firstElementChild]);

    await act(async () => {
      websites.resolve("websites");
    });

    expectSettled("websites");
    expect(screen.getByRole("status")).toBe(status);
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it("AC-CATSEC-15u-m: a navigation started while a fallback shows gives the region the visible spinner and text, and the same element keeps the text afterwards", async () => {
    const websites = Promise.withResolvers<string>();
    render(<FakeRouter websites={websites.promise} loading={<NavigationPendingFallback label={LABEL} />} />);
    const status = screen.getByRole("status");
    const announced = status.firstElementChild;
    expect(status).toHaveTextContent(LABEL);
    expect(announced).toHaveClass("sr-only");

    await click(screen.getByText("Hjemmesider"));

    // Shown once: by the region, while the fallback is hidden with the page.
    expect(status.firstElementChild).toBe(announced);
    expect(announced).not.toHaveClass("sr-only");
    expect(fallbackCopy(status)).not.toBeVisible();
    expect(accessibleLoadingTexts()).toEqual([announced]);

    await act(async () => {
      websites.resolve("websites");
    });

    // The fallback is still mounted: the text stays in the same element (not
    // announced again), visually hidden behind the fallback's copy.
    expect(status.firstElementChild).toBe(announced);
    expect(announced).toHaveClass("sr-only");
    expect(fallbackCopy(status)).toBeVisible();
    expect(accessibleLoadingTexts()).toEqual([announced]);
  });

  it("AC-CATSEC-15u-n: server-rendered (a full page load streams the fallback), the fallback's text stays readable and the region is empty", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(
      <NavigationPendingProvider>
        <NavigationPendingContent label={LABEL}>
          <NavigationPendingFallback label={LABEL} />
        </NavigationPendingContent>
      </NavigationPendingProvider>,
    );

    expect(within(container).getByRole("status")).toBeEmptyDOMElement();
    expect(within(container).getByText(LABEL)).not.toHaveAttribute("aria-hidden");
  });

  it("AC-CATSEC-15u-o: outside the admin shell the fallback is plain, readable text", () => {
    render(<NavigationPendingFallback label={LABEL} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(LABEL)).not.toHaveAttribute("aria-hidden");
  });

  it("AC-CATSEC-15u-q: a navigation that commits into the next page's still-loading fallback hands the text over in the same element, now visually hidden", async () => {
    const response = Promise.withResolvers<string>();
    const websites = Promise.withResolvers<string>();
    render(<LoadingShell page="apps" response={response.promise} next={websites.promise} />);
    const status = screen.getByRole("status");

    await click(screen.getByRole("link", { name: "Hjemmesider" }));

    // Pending: the region shows the spinner and text.
    const announced = status.firstElementChild;
    expect(announced).toHaveTextContent(LABEL);
    expect(announced).not.toHaveClass("sr-only");

    // The server answers while the next page's data is still on its way: the
    // navigation commits into that page's loading fallback.
    const changes = recordRegionChanges(status);
    await act(async () => {
      response.resolve("websites");
    });

    expect(fallbackCopy(status)).toBeVisible();
    expect(status.firstElementChild).toBe(announced);
    expect(announced).toHaveClass("sr-only");
    // The text was never taken out of the region and put in again (which could be announced twice).
    expect(changes()).toEqual({ added: [], removed: [], texts: [] });
    expect(accessibleLoadingTexts()).toEqual([announced]);

    await act(async () => {
      websites.resolve("websites");
    });

    expectSettled("websites");
  });

  it("AC-CATSEC-15u-r: a navigation that commits its next page without a fallback empties the region, without putting the text in again", async () => {
    const response = Promise.withResolvers<string>();
    render(<LoadingShell page="apps" response={response.promise} next="websites" />);
    const status = screen.getByRole("status");

    await click(screen.getByRole("link", { name: "Hjemmesider" }));
    const announced = status.firstElementChild;
    expect(announced).toHaveTextContent(LABEL);

    const changes = recordRegionChanges(status);
    await act(async () => {
      response.resolve("websites");
    });

    expectSettled("websites");
    expect(changes()).toEqual({ added: [], removed: [announced], texts: [] });
  });
});
