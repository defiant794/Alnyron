"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import Button from "@/components/ui/Button";

type MyLifeErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Error boundary for every MyLife route (500: our fault, offer a retry),
 * rendered inside the MyLife frame. The retry re-requests the server
 * components, then re-renders the segment.
 */
export default function MyLifeError({ reset }: MyLifeErrorProps) {
  const t = useTranslations("Auth.error");
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <>
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-h2 font-semibold">{t("title")}</h1>
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
    </>
  );
}
