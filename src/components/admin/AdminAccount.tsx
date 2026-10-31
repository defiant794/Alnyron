import { signOut } from "@/app/admin/(auth)/actions";
import SubmitButton from "@/components/ui/SubmitButton";
import type { AdminUser } from "@/services/auth/require-admin";

export type AdminAccountProps = {
  user: AdminUser;
  /**
   * `bar`: compact, beside the logo in the top bar below 768px: only "Log ud"
   * is shown, the email and role are read out to screen readers. It moves
   * under the logo, still right-aligned, when the row is too narrow (320px).
   * `sidebar`: at the foot of the sidebar from 768px (initials, email, role
   * and a full-width "Log ud").
   * The shell renders both; each is `display: none` outside its breakpoint,
   * so only one is ever on screen or in the accessibility tree.
   */
  variant: "bar" | "sidebar";
  labels: { region: string; role: string; signOut: string };
};

/**
 * The signed-in account and "Log ud" in the admin shell. Its place depends on
 * the layout so it never sits between the navigation and the page content:
 * on small screens it shares the top row with the logo, on wide screens it
 * closes the sidebar.
 */
export default function AdminAccount({ user, variant, labels }: AdminAccountProps) {
  if (variant === "bar") {
    return (
      <section aria-label={labels.region} className="ml-auto md:hidden">
        <span className="sr-only">{`${user.email}, ${labels.role}`}</span>
        <form action={signOut}>
          <SubmitButton variant="secondary">{labels.signOut}</SubmitButton>
        </form>
      </section>
    );
  }

  return (
    <section
      aria-label={labels.region}
      className="mt-auto hidden flex-col gap-3 border-t border-border pt-4 md:flex"
    >
      <div className="flex items-center gap-3 px-2">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-border text-small font-semibold"
        >
          {user.email.slice(0, 2).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-small font-semibold" title={user.email}>
            {user.email}
          </span>
          <span className="text-small text-muted">{labels.role}</span>
        </div>
      </div>
      <form action={signOut}>
        <SubmitButton variant="secondary" className="w-full">
          {labels.signOut}
        </SubmitButton>
      </form>
    </section>
  );
}
