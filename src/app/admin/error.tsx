"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import AuthFrame from "@/components/admin/AuthFrame";
import Button from "@/components/ui/Button";

type AdminErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Error boundary for every admin route (500: our fault, offer a retry). The
 * retry re-requests the server components, then re-renders the segment.
 */
export default function AdminError({ reset }: AdminErrorProps) {
  const t = useTranslations("Admin.error");
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <AuthFrame>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h1 font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("body")}</p>
      </header>
      <Button
        className="w-full"
        loading={retrying}
        onClick={() =>
          startRetry(() => {
            router.refresh();
            reset();
          })
        }
      >
        {t("retry")}
      </Button>
    </AuthFrame>
  );
}
