// @vitest-environment jsdom
// Design review F1.1 F-8: after an auth form (admin or MyLife) is submitted,
// focus moves to the result instead of dropping to <body> (the submit button
// is disabled while the Server Action runs, which takes the focus away from
// it).
// - a form-level message (error alert, reset confirmation) takes the focus;
// - with field errors only, the first invalid field takes it;
// - the first render (nothing submitted) leaves focus alone.
// The pages pass each area's Server Action as the `action` prop; here it is a
// mock. useActionState, useFormStatus and the form action dispatch are the
// real React 19 ones.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import LoginForm from "@/components/auth/LoginForm";
import SetPasswordForm from "@/components/auth/SetPasswordForm";

afterEach(cleanup);

const signIn = vi.fn();
const requestPasswordReset = vi.fn();
const updatePassword = vi.fn();

const LOGIN_LABELS = {
  email: "E-mail",
  password: "Adgangskode",
  submit: "Log ind",
  resetPassword: "Nulstil adgangskode",
};
const FORGOT_PASSWORD_PATH = "/mylife/forgot-password";

function renderLoginForm(next: string | null = null) {
  render(
    <LoginForm action={signIn} next={next} forgotPasswordHref={FORGOT_PASSWORD_PATH} labels={LOGIN_LABELS} />,
  );
}

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("E-mail"), "nobody@example.com");
  await user.type(screen.getByLabelText("Adgangskode"), "wrong-password");
  await user.click(screen.getByRole("button", { name: "Log ind" }));
  return user;
}

describe("F-8: LoginForm moves focus to the result of a sign-in attempt", () => {
  it("leaves focus alone on the first render", () => {
    renderLoginForm();
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses the error alert after a failed sign-in", async () => {
    signIn.mockResolvedValue({
      email: "nobody@example.com",
      error: "Forkert e-mail eller adgangskode",
    });
    renderLoginForm();
    await submitLogin();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Forkert e-mail eller adgangskode");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert).toHaveAttribute("tabindex", "-1");
  });

  it("focuses the alert again after a second identical failure", async () => {
    signIn.mockImplementation(async () => ({
      email: "nobody@example.com",
      error: "Forkert e-mail eller adgangskode",
    }));
    renderLoginForm();
    const user = await submitLogin();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());

    await user.type(screen.getByLabelText("Adgangskode"), "another-wrong-one");
    expect(alert).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Log ind" }));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  });

  it("focuses the first invalid field when there are only field errors", async () => {
    signIn.mockResolvedValue({
      email: "nobody@example.com",
      fieldErrors: { password: "Skriv din adgangskode." },
    });
    renderLoginForm();
    await submitLogin();

    await waitFor(() => expect(screen.getByLabelText("Adgangskode")).toHaveFocus());
    expect(screen.getByLabelText("Adgangskode")).toHaveAttribute("aria-invalid", "true");
  });

  it("posts the accepted next target to the area's action", async () => {
    signIn.mockResolvedValue({ email: "nobody@example.com", error: "Forkert e-mail eller adgangskode" });
    renderLoginForm("/mylife/set-password");
    await submitLogin();

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    const formData = signIn.mock.calls[0]?.[1] as FormData;
    expect(formData.get("next")).toBe("/mylife/set-password");
  });
});

describe("F-8: ForgotPasswordForm moves focus to the confirmation", () => {
  it("focuses the confirmation inside the status region after sending", async () => {
    requestPasswordReset.mockResolvedValue({ sent: true, email: "nobody@nowhere.test" });
    render(
      <ForgotPasswordForm
        action={requestPasswordReset}
        labels={{ email: "E-mail", submit: "Send nulstillingslink", sent: "Tjek din e-mail." }}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("E-mail"), "nobody@nowhere.test");
    await user.click(screen.getByRole("button", { name: "Send nulstillingslink" }));

    const message = await screen.findByText("Tjek din e-mail.");
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.getByRole("status")).toContainElement(message);
    // AC-RESET-02: React resets the form after the action; the echoed address refills the field.
    expect(screen.getByLabelText("E-mail")).toHaveValue("nobody@nowhere.test");
  });
});

describe("F-8: SetPasswordForm moves focus to the error", () => {
  it("focuses the error alert when the password cannot be saved", async () => {
    updatePassword.mockResolvedValue({
      error: "Den nye adgangskode skal være forskellig fra den nuværende.",
    });
    render(
      <SetPasswordForm
        action={updatePassword}
        email="admin@example.com"
        minLength={12}
        labels={{
          password: "Ny adgangskode",
          passwordHint: "Mindst 12 tegn.",
          confirm: "Gentag adgangskode",
          submit: "Gem adgangskode",
        }}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Ny adgangskode"), "a-long-password-1!");
    await user.type(screen.getByLabelText("Gentag adgangskode"), "a-long-password-1!");
    await user.click(screen.getByRole("button", { name: "Gem adgangskode" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
