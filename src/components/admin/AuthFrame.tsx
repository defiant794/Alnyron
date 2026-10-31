import type { ReactNode } from "react";
import Logo from "@/components/brand/Logo";
import Card from "@/components/ui/Card";

/**
 * Centered single-card frame for the admin screens outside the panel shell:
 * login, forgot password, no access and the error page (the approved login
 * mock's layout with the Alnyron lockup on top).
 */
export default function AuthFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <main id="main" tabIndex={-1} className="w-full max-w-md focus:outline-none">
        <Card className="flex flex-col gap-8 shadow-card sm:p-8">
          <Logo wordmark priority className="self-center" />
          {children}
        </Card>
      </main>
    </div>
  );
}
