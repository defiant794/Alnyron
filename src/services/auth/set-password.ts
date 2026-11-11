import type { Locale } from "next-intl";
import { AUTH_LOCALE } from "@/config/auth-areas";
import { createServerClient } from "@/lib/supabase/server";
import { setPasswordSchema, type SetPasswordInput } from "@/lib/validation/auth";
import { authTranslator, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";

/** State of a set-password form (admin, MyLife and Monitor `updatePassword`). */
export type SetPasswordState = {
  /** Form-level message when Supabase rejects the password. */
  error?: string;
  fieldErrors?: FieldErrors<SetPasswordInput>;
};

/**
 * Set the signed-in user's password: the last step of the invite and
 * password-reset links, which reach the set-password page with a fresh
 * session from `/auth/confirm`, and Monitor's change-password form in its
 * settings. Shared by the admin, MyLife and Monitor `updatePassword` actions,
 * which gate the caller first (`requireAdmin()` / `requireMyLife()` /
 * `requireMonitor()`) and send them to their area's home once it is saved.
 *
 * Admin and MyLife have no change-password-later form: to change a password
 * deliberately, sign out and use the reset link. Supabase has
 * `secure_password_change` on, so it accepts a new password only from a
 * session signed in within the last 24 hours; the link's fresh session always
 * qualifies, and an older session is told to use a new link. Length and
 * repeat are checked before Supabase; Supabase's own rejections map to copy
 * in `locale` (Danish unless Monitor passes its visitor's language).
 *
 * @returns The state to show, or `null` once the password is saved.
 */
export async function setPassword(formData: FormData, locale: Locale = AUTH_LOCALE): Promise<SetPasswordState | null> {
  const parsed = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error, locale) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (!error) return null;

  const message =
    error.code === "same_password"
      ? "setPassword.samePassword"
      : error.code === "weak_password"
        ? "setPassword.weakPassword"
        : error.code === "reauthentication_needed"
          ? "setPassword.reauthenticationNeeded"
          : "setPassword.failed";
  return { error: authTranslator(locale)(message) };
}
