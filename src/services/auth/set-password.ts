import { createServerClient } from "@/lib/supabase/server";
import { setPasswordSchema, type SetPasswordInput } from "@/lib/validation/auth";
import { authT, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";

/** State of a set-password form (admin and MyLife `updatePassword`). */
export type SetPasswordState = {
  /** Form-level message when Supabase rejects the password. */
  error?: string;
  fieldErrors?: FieldErrors<SetPasswordInput>;
};

/**
 * Set the signed-in user's password: the last step of the invite and
 * password-reset links, which reach the set-password page with a fresh
 * session from `/auth/confirm`. Shared by the admin and MyLife
 * `updatePassword` actions, which gate the caller first (`requireAdmin()` /
 * `requireMyLife()`) and send them to their area's home once it is saved.
 *
 * It is not a change-password-later feature: to change a password
 * deliberately, sign out and use the reset link. Supabase has
 * `secure_password_change` on, so it accepts a new password only from a
 * session signed in within the last 24 hours; the link's fresh session always
 * qualifies, and an older session is told to use a new link. Length and
 * repeat are checked before Supabase; Supabase's own rejections map to Danish
 * copy.
 *
 * @returns The state to show, or `null` once the password is saved.
 */
export async function setPassword(formData: FormData): Promise<SetPasswordState | null> {
  const parsed = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

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
  return { error: authT(message) };
}
