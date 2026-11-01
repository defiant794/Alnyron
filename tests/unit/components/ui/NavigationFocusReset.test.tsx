// @vitest-environment jsdom
/**
 * Unit tests: NavigationFocusReset, mounted by the MyLife layout.
 * Journey: mylife-login  ML-AC2 (landing after sign-in); design review
 * 2026-11-01 round 2 (WCAG 2.4.1 / 2.4.3: skip link first after sign-in).
 *
 * After a client-side navigation removed the focused control, the browser
 * resumes Tab where that control was, past the skip link. The reset moves the
 * sequential focus starting point to the top of the page by focusing
 * `<body>` and blurring it straight away. jsdom has no Tab navigation, so
 * these tests observe that focus/blur pair on `<body>`; the Tab order itself
 * is checked in the browser by the ML-AC1ad/ML-AC2n/ML-AC6f e2e tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const route = vi.hoisted(() => ({ pathname: "/mylife/login" }));

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

import NavigationFocusReset from "@/components/ui/NavigationFocusReset";

let bodyFocusEvents: string[];
let stopWatching: AbortController;

beforeEach(() => {
  route.pathname = "/mylife/login";
  bodyFocusEvents = [];
  stopWatching = new AbortController();
  const record = (event: FocusEvent) => bodyFocusEvents.push(event.type);
  document.body.addEventListener("focus", record, { signal: stopWatching.signal });
  document.body.addEventListener("blur", record, { signal: stopWatching.signal });
});

afterEach(() => {
  stopWatching.abort();
  cleanup();
});

/** A fresh element per render: RTL's rerender bails out on an identical one. */
const tree = (pageControl?: string) => (
  <>
    <NavigationFocusReset />
    {pageControl && <button type="button">{pageControl}</button>}
  </>
);

describe("ML-AC2: after a client-side navigation the next Tab starts at the top of the page", () => {
  it("ML-AC2j: a navigation that dropped the focus parks it on <body> and releases it, leaving no tabindex", () => {
    const { rerender } = render(tree());

    route.pathname = "/mylife";
    rerender(tree("Log ud"));

    expect(bodyFocusEvents).toEqual(["focus", "blur"]);
    expect(document.activeElement).toBe(document.body);
    expect(document.body).not.toHaveAttribute("tabindex");
  });

  it("ML-AC2k: the first render (a full page load) leaves the focus alone", () => {
    render(tree("Log ind"));

    expect(bodyFocusEvents).toEqual([]);
  });

  it("ML-AC2l: focus that a control holds when the navigation commits stays there", () => {
    const { rerender } = render(tree("Beholder fokus"));
    const control = screen.getByRole("button", { name: "Beholder fokus" });
    control.focus();

    route.pathname = "/mylife/no-access";
    rerender(tree("Beholder fokus"));

    expect(bodyFocusEvents).toEqual([]);
    expect(control).toHaveFocus();
  });

  it("ML-AC2m: a re-render on the same pathname (e.g. a new search param) does nothing", () => {
    const { rerender } = render(tree());

    rerender(tree("Log ind"));

    expect(bodyFocusEvents).toEqual([]);
  });
});
