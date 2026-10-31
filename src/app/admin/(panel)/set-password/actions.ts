"use server";

import { redirect } from "next/navigation";
import { ADMIN_HOME_PATH } from "@/config/admin";
import { createServerClient } from "@/lib/supabase/server";
import { setPasswordSchema, type SetPasswordInput } from "@/lib/validation/auth";
import { authT, toFieldErrors, type FieldErrors } from "@/services/auth/form-feedback";
import { requireAdmin } from "@/services/auth/require-admin";

export type SetPasswordState = {
  /** Form-level message when Supabase rejects the password. */
  error?: string;
  fieldErrors?: FieldErrors<SetPasswordInput>;
};

/**
 * Set the signed-in admin's password: the last step of the invite and
 * password-reset links, which reach this route with a fresh session from
 * `/auth/confirm`. It is not a change-password-later feature: to change a
 * password deliberately, sign out and use the reset link. Supabase has
 * `secure_password_change` on, so it accepts a new password only from a
 * session signed in within the last 24 hours; the link's fresh session always
 * qualifies, and an older session is told to use a new link. Length and
 * repeat are checked before Supabase; Supabase's own rejections map to Danish
 * copy. Success: the panel home.
 */
export async function updatePassword(
  _previous: SetPasswordState | null,
  formData: FormData,
): Promise<SetPasswordState> {
  await requireAdmin();

  const parsed = setPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) return { fieldErrors: toFieldErrors(parsed.error) };

  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
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

  redirect(ADMIN_HOME_PATH);
}
