// @vitest-environment jsdom
/**
 * Unit tests: /admin/(auth)/login/page.tsx with the shared LoginForm.
 * Journey: mylife-login  ML-AC27 (admin flows keep working through the
 * shared auth form)
 *
 * The design review 2026-11-01 a11y fixes reach the admin login through the
 * shared form and metadata helper: `error=link_invalid` shows the invalid-link
 * copy in a role=alert that takes the focus on arrival and prefixes the title
 * with "Fejl: "; a failed sign-in links to the admin forgot-password page.
 * The MyLife-only mock details (placeholders) stay off the admin form.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { mockSignIn } = vi.hoisted(() => ({ mockSignIn: vi.fn() }));

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("@/app/admin/(auth)/actions", () => ({ signIn: mockSignIn }));

import LoginPage, { generateMetadata } from "@/app/admin/(auth)/login/page";
import { loadMessages } from "@/i18n/messages";

const { Auth } = loadMessages("da");

type SearchParams = { next?: string | string[]; error?: string | string[] };

async function renderLogin(searchParams: SearchParams = {}) {
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

const titleFor = async (searchParams: SearchParams) =>
  (await generateMetadata({ searchParams: Promise.resolve(searchParams) })).title;

afterEach(cleanup);

describe("ML-AC27: /admin/login through the shared login form", () => {
  it("ML-AC27a: the title is 'Log ind', prefixed 'Fejl: ' only while error=link_invalid is shown", async () => {
    expect(await titleFor({})).toBe(Auth.login.title);
    expect(await titleFor({ error: "something_else" })).toBe(Auth.login.title);
    expect(await titleFor({ error: "link_invalid" })).toBe(
      Auth.login.errorTitle.replace("{title}", Auth.login.title),
    );
  });

  it("ML-AC27b: error=link_invalid shows the invalid-link copy in a role=alert that takes the focus on arrival", async () => {
    await renderLogin({ error: "link_invalid" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(Auth.login.linkInvalid);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("ML-AC27c: without an error param nothing is announced and focus stays put", async () => {
    await renderLogin();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("ML-AC27d: a failed sign-in links to the admin forgot-password page", async () => {
    mockSignIn.mockResolvedValue({ email: "nobody@example.com", error: Auth.login.invalidCredentials });
    await renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(Auth.login.email), "nobody@example.com");
    await user.type(screen.getByLabelText(Auth.login.password), "wrong-password");
    await user.click(screen.getByRole("button", { name: Auth.login.submit }));

    await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: Auth.login.resetPassword })).toHaveAttribute(
      "href",
      "/admin/forgot-password",
    );
  });

  it("ML-AC27e: the admin fields keep no placeholders (MyLife mock only)", async () => {
    await renderLogin();
    expect(screen.getByLabelText(Auth.login.email)).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText(Auth.login.password)).not.toHaveAttribute("placeholder");
  });
});
