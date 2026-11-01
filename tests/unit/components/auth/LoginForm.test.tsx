// @vitest-environment jsdom
/**
 * Unit tests: the shared LoginForm (admin and MyLife), design review
 * 2026-11-01 (mylife-login) fixes.
 * Journey: mylife-login  ML-AC1 (error state announced), ML-AC4 (failed sign-in)
 *
 * - A failed sign-in offers the area's forgot-password page right after the
 *   message (Nielsen #9): the next Tab stop from the focused alert, outside
 *   the alert so the alert stays the message itself.
 * - A message the page arrives with (`?error=link_invalid`) is server HTML,
 *   so its role=alert is never announced as a change: it takes the focus on
 *   arrival instead, unless the user already focused something.
 * - Placeholders reach the fields only when the page passes them.
 * useActionState and the form action dispatch are the real React 19 ones;
 * the Server Action is a mock.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import LoginForm, { type LoginFormProps } from "@/components/auth/LoginForm";

afterEach(cleanup);

const signIn = vi.fn();

const LABELS = { email: "E-mail", password: "Adgangskode", submit: "Log ind", resetPassword: "Nulstil adgangskode" };
const INVALID_CREDENTIALS = "Forkert e-mail eller adgangskode";
const LINK_INVALID = "Linket er ugyldigt eller udløbet.";

function renderLoginForm(props: Partial<LoginFormProps> = {}) {
  render(
    <LoginForm action={signIn} next={null} forgotPasswordHref="/admin/forgot-password" labels={LABELS} {...props} />,
  );
}

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("E-mail"), "nobody@example.com");
  await user.type(screen.getByLabelText("Adgangskode"), "wrong-password");
  await user.click(screen.getByRole("button", { name: "Log ind" }));
  return user;
}

describe("ML-AC4: a failed sign-in links to the area's forgot-password page", () => {
  it("ML-AC4h: the reset link follows the alert, outside it, as the next Tab stop", async () => {
    signIn.mockResolvedValue({ email: "nobody@example.com", error: INVALID_CREDENTIALS });
    renderLoginForm();
    const user = await submitLogin();

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert).toHaveTextContent(new RegExp(`^${INVALID_CREDENTIALS}$`));

    const link = screen.getByRole("link", { name: "Nulstil adgangskode" });
    expect(link).toHaveAttribute("href", "/admin/forgot-password");
    expect(alert).not.toContainElement(link);
    expect(link).toHaveClass("min-h-11");

    await user.tab();
    expect(link).toHaveFocus();
  });

  it("ML-AC4i: field errors alone show no reset link", async () => {
    signIn.mockResolvedValue({ email: "nobody@example.com", fieldErrors: { password: "Skriv din adgangskode." } });
    renderLoginForm();
    await submitLogin();

    await waitFor(() => expect(screen.getByLabelText("Adgangskode")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.queryByRole("link", { name: "Nulstil adgangskode" })).not.toBeInTheDocument();
  });

  it("ML-AC4j: before any attempt there is no reset link and no alert", () => {
    renderLoginForm();
    expect(screen.queryByRole("link", { name: "Nulstil adgangskode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ML-AC1: a message the page arrives with is announced", () => {
  it("ML-AC1o: it renders as a role=alert outside the form and takes the focus on arrival", async () => {
    renderLoginForm({ initialError: LINK_INVALID });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(LINK_INVALID);
    expect(alert).toHaveAttribute("tabindex", "-1");
    expect(alert.closest("form")).toBeNull();
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("ML-AC1p: it leaves the focus where the user already put it", () => {
    render(<button type="button">Elsewhere</button>);
    screen.getByRole("button", { name: "Elsewhere" }).focus();

    renderLoginForm({ initialError: LINK_INVALID });

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    expect(screen.getByRole("alert")).not.toHaveFocus();
  });

  it("ML-AC1q: a failed sign-in after arriving with a message still focuses the new alert", async () => {
    signIn.mockResolvedValue({ email: "nobody@example.com", error: INVALID_CREDENTIALS });
    renderLoginForm({ initialError: LINK_INVALID });
    await submitLogin();

    const result = await screen.findByText(INVALID_CREDENTIALS);
    await waitFor(() => expect(result).toHaveFocus());
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});

describe("ML-AC1: placeholders", () => {
  it("ML-AC1r: the fields show the placeholders the page passes", () => {
    renderLoginForm({ placeholders: { email: "dig@eksempel.dk", password: "••••••••" } });
    expect(screen.getByLabelText("E-mail")).toHaveAttribute("placeholder", "dig@eksempel.dk");
    expect(screen.getByLabelText("Adgangskode")).toHaveAttribute("placeholder", "••••••••");
  });

  it("ML-AC1s: without placeholders the fields have none", () => {
    renderLoginForm();
    expect(screen.getByLabelText("E-mail")).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText("Adgangskode")).not.toHaveAttribute("placeholder");
  });
});
