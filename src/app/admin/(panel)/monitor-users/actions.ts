"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ADMIN_MONITOR_USERS_PATH } from "@/config/admin";
import { deleteMonitorUser, type DeleteMonitorUserResult } from "@/services/admin/monitor-users";
import { requireAdmin } from "@/services/auth/require-admin";

/** A user id (any UUID-shaped string; PostgREST errors on others). */
const userIdSchema = z.guid();

/**
 * Delete a Monitor signup from Admin › Monitor-brugere (see
 * `deleteMonitorUser`). Admins only. `userId` is validated, never trusted: an
 * id that is not UUID-shaped names no account, so it is `not-found` without a
 * database call. The list is refreshed when the account is gone, deleted now
 * or already before (`not-found`); after any other failure it is unchanged.
 */
export async function deleteMonitorSignup(userId: unknown): Promise<DeleteMonitorUserResult> {
  await requireAdmin();
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) return { ok: false, error: "not-found" };

  const result = await deleteMonitorUser(parsed.data);
  if (result.ok || result.error === "not-found") revalidatePath(ADMIN_MONITOR_USERS_PATH);
  return result;
}
