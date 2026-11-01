// @vitest-environment jsdom
/**
 * Unit tests: /mylife/(auth)/login/page.tsx renders per the approved mock.
 * Journey: mylife-login  ML-AC1 (and ML-AC21/ML-AC22/ML-AC25 for the `next` it passes on)
 *
 * Approved mock (mylife-login.html): MYLIFE wordmark heading, tagline,
 * "Kun for godkendte brugere" badge (12px), labelled email and password
 * fields with example placeholders, a "Log ind" button, "Glemt adgangskode?"
 * followed by a "Nulstil" link to /mylife/forgot-password, and the no-signup
 * footnote. `error=link_invalid` shows the invalid-link copy in a role=alert
 * that takes the focus on arrival, and the title says "Fejl: ..." (design
 * review 2026-11-01). The expected copy is read from the loaded Danish
 * messages.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl/server", async () => {
  // vi.mock factories are hoisted above static imports; dynamic import is required.
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/mylife/login",
}));
vi.mock("@/app/mylife/(auth)/actions", () => ({ signIn: vi.fn() }));

import LoginPage, { generateMetadata } from "@/app/mylife/(auth)/login/page";
import { loadMessages } from "@/i18n/messages";

const { Auth, MyLife } = loadMessages("da");

type SearchParams = { next?: string | string[]; error?: string | string[] };

async function renderLogin(searchParams: SearchParams = {}) {
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

const hiddenNext = () => document.querySelector<HTMLInputElement>('input[type="hidden"][name="next"]');

afterEach(cleanup);

describe("ML-AC1: /mylife/login renders per the approved mock", () => {
  it("ML-AC1a: the MyLife name is the page heading, with the tagline and the approved-users badge", async () => {
    await renderLogin();
    expect(screen.getByRole("heading", { level: 1, name: MyLife.name })).toBeInTheDocument();
    expect(screen.getByText(MyLife.login.tagline)).toBeInTheDocument();
    expect(screen.getByText(MyLife.login.badge)).toHaveClass("text-accent");
  });

  it("ML-AC1b: the email field is labelled 'E-mail' and has type=email", async () => {
    await renderLogin();
    expect(screen.getByLabelText(Auth.login.email)).toHaveAttribute("type", "email");
  });

  it("ML-AC1c: the password field is labelled 'Adgangskode' and has type=password", async () => {
    await renderLogin();
    expect(screen.getByLabelText(Auth.login.password)).toHaveAttribute("type", "password");
  });

  it("ML-AC1d: 'Log ind' is the form's submit button", async () => {
    await renderLogin();
    const button = screen.getByRole("button", { name: Auth.login.submit });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });

  it("ML-AC1e: 'Glemt adgangskode?' is plain text before the 'Nulstil' link to /mylife/forgot-password", async () => {
    await renderLogin();
    const prompt = screen.getByText(Auth.login.forgotPassword);
    expect(prompt.closest("a")).toBeNull();
    const link = screen.getByRole("link", { name: `${Auth.login.forgotPassword} ${MyLife.login.forgotLink}` });
    expect(link).toHaveTextContent(MyLife.login.forgotLink);
    expect(link).toHaveAttribute("href", "/mylife/forgot-password");
  });

  it("ML-AC1f: the no-signup footnote is shown", async () => {
    await renderLogin();
    expect(screen.getByText(MyLife.login.noSignup)).toBeInTheDocument();
  });

  it("ML-AC1g: without an error param there is no alert", async () => {
    await renderLogin();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ML-AC1h: error=link_invalid shows the invalid-link copy in a role=alert", async () => {
    await renderLogin({ error: "link_invalid" });
    expect(screen.getByRole("alert")).toHaveTextContent(Auth.login.linkInvalid);
  });

  it("ML-AC1i: an unknown error value shows no alert", async () => {
    await renderLogin({ error: "something_else" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ML-AC1t: error=link_invalid moves the focus to the alert on arrival, so it is read out", async () => {
    await renderLogin({ error: "link_invalid" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("ML-AC1u: the 'Nulstil' link is a 44x44px tap target", async () => {
    await renderLogin();
    const link = screen.getByRole("link", { name: `${Auth.login.forgotPassword} ${MyLife.login.forgotLink}` });
    expect(link).toHaveClass("min-h-11", "min-w-11");
  });

  it("ML-AC1v: the fields show the mock's example values from the messages", async () => {
    await renderLogin();
    expect(screen.getByLabelText(Auth.login.email)).toHaveAttribute("placeholder", MyLife.login.emailPlaceholder);
    expect(screen.getByLabelText(Auth.login.password)).toHaveAttribute(
      "placeholder",
      MyLife.login.passwordPlaceholder,
    );
  });

  it("ML-AC1w: the approved-users badge uses the mock's 12px type", async () => {
    await renderLogin();
    expect(screen.getByText(MyLife.login.badge)).toHaveClass("text-xs");
  });
});

describe("ML-AC1: the login page title reflects the error state", () => {
  const titleFor = async (searchParams: SearchParams) =>
    (await generateMetadata({ searchParams: Promise.resolve(searchParams) })).title;

  it("ML-AC1x: 'Log ind' without an error param", async () => {
    expect(await titleFor({})).toBe(Auth.login.title);
  });

  it("ML-AC1y: prefixed 'Fejl: ' while error=link_invalid is shown", async () => {
    const title = await titleFor({ error: "link_invalid" });
    expect(title).toBe(Auth.login.errorTitle.replace("{title}", Auth.login.title));
    expect(title).toMatch(/^Fejl: /);
  });

  it("ML-AC1z: an unknown error value (no alert shown) keeps 'Log ind'", async () => {
    expect(await titleFor({ error: "something_else" })).toBe(Auth.login.title);
  });
});

describe("ML-AC21/ML-AC22/ML-AC25: the login page passes on only an accepted MyLife next", () => {
  it("ML-AC21: a /mylife/ next reaches the form as a hidden field", async () => {
    await renderLogin({ next: "/mylife/set-password" });
    expect(hiddenNext()).toHaveValue("/mylife/set-password");
  });

  it("ML-AC22: an /admin/ next is dropped", async () => {
    await renderLogin({ next: "/admin/set-password" });
    expect(hiddenNext()).toBeNull();
  });

  it("ML-AC25: an external or dot-segment next is dropped", async () => {
    await renderLogin({ next: "https://evil.com/mylife/x" });
    expect(hiddenNext()).toBeNull();
    cleanup();
    await renderLogin({ next: "/mylife/../admin/x" });
    expect(hiddenNext()).toBeNull();
  });

  it("ML-AC25: a repeated next param (array) is dropped", async () => {
    await renderLogin({ next: ["/mylife/a", "/mylife/b"] });
    expect(hiddenNext()).toBeNull();
  });
});
