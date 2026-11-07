import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Link types the DA email templates send (`supabase/templates/*.html`):
 * invites and password resets (every area) and the Monitor signup
 * confirmation. Kept outside `route.ts`, which may export only route
 * handlers and route segment options.
 */
export const CONFIRM_TYPES: ReadonlySet<ConfirmType> = new Set(["invite", "recovery", "signup"] as const);

export type ConfirmType = Extract<EmailOtpType, "invite" | "recovery" | "signup">;

/** Whether a `type` query value is one of the {@link CONFIRM_TYPES}. */
export function isConfirmType(value: string | null): value is ConfirmType {
  return value !== null && (CONFIRM_TYPES as ReadonlySet<string>).has(value);
}
