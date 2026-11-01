"use server";

import { redirect } from "next/navigation";
import { ADMIN_HOME_PATH } from "@/config/admin";
import { requireAdmin } from "@/services/auth/require-admin";
import { setPassword, type SetPasswordState } from "@/services/auth/set-password";

/**
 * Set the signed-in admin's password (`/admin/set-password`, the end of the
 * invite and reset links; see `setPassword`). Admins only. Success: the panel
 * home.
 */
export async function updatePassword(
  _previous: SetPasswordState | null,
  formData: FormData,
): Promise<SetPasswordState> {
  await requireAdmin();

  const failure = await setPassword(formData);
  if (failure) return failure;

  redirect(ADMIN_HOME_PATH);
}
