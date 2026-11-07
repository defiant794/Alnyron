"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import MonitorAuthFrame from "@/components/monitor/MonitorAuthFrame";
import Button from "@/components/ui/Button";

type MonitorErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Error boundary for every Monitor route (500: our fault, offer a retry),
 * in the Monitor card frame. The retry re-requests the server components,
 * then re-renders the segment.
 */
export default function MonitorError({ reset }: MonitorErrorProps) {
  const t = useTranslations("Auth.error");
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <MonitorAuthFrame>
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
    </MonitorAuthFrame>
  );
}
