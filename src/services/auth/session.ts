import { cookies } from "next/headers";
import { createServerClient } from "@/lib/supabase/server";
import {
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  type SignInInput,
  type SignUpInput,
} from "@/lib/validation/auth";
import { authT, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";

/** State of a sign-in form (admin and MyLife `signIn`). */
export type SignInState = {
  /** Form-level message (credentials, rate limit, outage). */
  error?: string;
  fieldErrors?: FieldErrors<SignInInput>;
  /** Echoed so the email field keeps its value after a failed attempt. */
  email?: string;
};

/** State of a forgot-password form (admin and MyLife `requestPasswordReset`). */
export type ResetPasswordState = {
  /** True once the request was handed to Supabase, whether or not the address has an account. */
  sent?: boolean;
  fieldErrors?: FieldErrors<{ email: string }>;
  /**
   * Echoed so the email field keeps its value after a field error and after
   * sending (React resets the form once the action finishes). It is the
   * address the user typed, so it reveals nothing about the account.
   */
  email?: string;
};

/**
 * Result of a Monitor signup attempt. Every state echoes the typed address
 * (React resets the form once the action finishes); it is what the user
 * typed, so it reveals nothing about any account.
 */
export type SignUpResult =
  /**
   * Handed to Supabase: the same answer for a new address, an address that
   * already has an account and an address the signup hook refuses (one on the
   * admin/MyLife allowlist), so the form never tells them apart.
   */
  | { type: "confirmation"; email: string }
  /** Invalid input, or a password Supabase finds too weak. `field` is the first invalid one. */
  | { type: "field_error"; field: keyof SignUpInput; fieldErrors: FieldErrors<SignUpInput>; email: string }
  /** Supabase's rate limit (HTTP 429). */
  | { type: "rate_limited"; email: string }
  /** Supabase unreachable or failing (status 0 or 5xx), or signup switched off. */
  | { type: "unavailable"; email: string };

function signUpFieldError(email: string, fieldErrors: FieldErrors<SignUpInput>): SignUpResult {
  const field = fieldErrors.email !== undefined ? "email" : "password";
  return { type: "field_error", field, fieldErrors, email };
}

/**
 * Email + password sign-in (architecture §6), shared by the admin, MyLife and
 * Monitor `signIn` actions, which send the user on to their area once it succeeds.
 * Every credential failure (wrong password, unknown or unconfirmed account)
 * gets the same message, so the form never reveals whether an account
 * exists. Only rate limiting and an unreachable auth service, which say
 * nothing about the account, get their own message.
 *
 * @returns The state to show, or `null` once signed in.
 */
export async function signInWithPassword(formData: FormData): Promise<SignInState | null> {
  const emailField = formData.get("email");
  const email = typeof emailField === "string" ? emailField : "";
  const parsed = signInSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (!error) return null;

  const { status } = error;
  const message =
    status === 429
      ? "login.rateLimited"
      : status !== undefined && (status === 0 || status >= 500)
        ? "login.unavailable"
        : "login.invalidCredentials";
  return { email: parsed.data.email, error: authT(message) };
}

/**
 * Email + password signup for the Monitor area (public, email-verified).
 * Only the address and the password reach Supabase: no metadata and no
 * redirect URL, so nothing the form sends can influence the account's role
 * (the database assigns `monitor_user`, or refuses an allowlisted address in
 * the before-user-created hook). With email confirmation on, Supabase
 * returns no session; the confirmation link (the Site URL's
 * `/auth/confirm?type=signup`, forwarded to the Monitor host) signs the user
 * in there.
 *
 * Success, an address that already has an account and a refused address all
 * get the same "check your email" answer (no account enumeration). Only
 * input problems (checked before Supabase, plus Supabase's own
 * `weak_password` and `email_address_invalid`, which describe the input),
 * rate limiting and an unavailable or closed signup get their own state.
 * Supabase's error text is never passed on; refusals are logged by code.
 */
export async function signUpWithPassword(formData: FormData): Promise<SignUpResult> {
  const emailField = formData.get("email");
  const email = typeof emailField === "string" ? emailField : "";
  const parsed = signUpSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return signUpFieldError(email, toFieldErrors(parsed.error));

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  const typed = parsed.data.email;
  if (!error) return { type: "confirmation", email: typed };

  const { status, code } = error;
  if (status === 429) return { type: "rate_limited", email: typed };
  // Signup switched off for the whole project says nothing about the address.
  const closed = code === "signup_disabled" || code === "email_provider_disabled";
  if (closed || status === 0 || (status !== undefined && status >= 500)) {
    console.error(`signUp unavailable: ${code ?? status ?? "unknown"}`);
    return { type: "unavailable", email: typed };
  }
  if (code === "weak_password") {
    return signUpFieldError(typed, { password: authT("setPassword.weakPassword") });
  }
  if (code === "email_address_invalid") {
    return signUpFieldError(typed, { email: authT("validation.emailInvalid") });
  }
  console.error(`signUp refused: ${code ?? status ?? "unknown"}`);
  return { type: "confirmation", email: typed };
}

/**
 * Send a password-reset link (architecture §6), shared by the admin, MyLife
 * and Monitor `requestPasswordReset` actions. The answer is the same whether or not
 * the address has an account (no account enumeration); it echoes the
 * submitted address so the form keeps it. Supabase failures go to the server
 * log only.
 *
 * Without `redirectTo` the DA templates build the link from the project's
 * Site URL, `{{ .SiteURL }}/auth/confirm?token_hash=...&next=/admin/set-password`,
 * which also serves invites sent from the dashboard (they carry none). With
 * it (the MyLife or Monitor host's own origin, never user input) they link
 * `{{ .RedirectTo }}/auth/confirm?...&next=/mylife/set-password` or
 * `...&next=/monitor/reset`, but only when it is exactly
 * `https://mylife.alnyron.dk` / `http://mylife.localhost:3000` or
 * `https://monitor.alnyron.dk` / `http://monitor.localhost:3000`; any other
 * value gets the Site URL link.
 */
export async function sendPasswordResetLink(
  formData: FormData,
  redirectTo: string | null = null,
): Promise<ResetPasswordState> {
  const emailField = formData.get("email");
  const email = typeof emailField === "string" ? emailField : "";
  const parsed = resetPasswordSchema.safeParse({ email });
  if (!parsed.success) return { email, fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = redirectTo
    ? await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo })
    : await supabase.auth.resetPasswordForEmail(parsed.data.email);
  if (error) console.error(`requestPasswordReset failed: ${error.code ?? error.status ?? "unknown"}`);
  return { sent: true, email: parsed.data.email };
}

/**
 * End this browser's session (other devices stay signed in), shared by the
 * admin, MyLife and Monitor `signOut` actions, which then show their login page. If
 * Supabase cannot revoke the session, the auth cookies are still removed so
 * the browser is signed out either way.
 */
export async function endSession(): Promise<void> {
  const supabase = await createServerClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (!error) return;

  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name.startsWith("sb-")) cookieStore.delete(name);
  }
}
