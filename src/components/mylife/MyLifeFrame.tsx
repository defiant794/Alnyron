import type { ReactNode } from "react";
import Logo from "@/components/brand/Logo";

/**
 * Centered single-card frame for every MyLife screen, drawn to the approved
 * MyLife login mock: a white card at most 400px wide (radius 16px, 36px
 * block padding from 640px) with the 80px Alnyron mark on top, on the
 * surface background. Each page brings its own heading. The card geometry is
 * MyLife's own, so this frame does not use the shared `Card` (radius 14px per
 * DESIGN.md, as on the admin) and sizes the mark from here.
 */
export default function MyLifeFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <main id="main" tabIndex={-1} className="w-full max-w-100 focus:outline-none">
        <div className="flex flex-col gap-8 rounded-2xl border border-border bg-bg p-6 shadow-card sm:px-8 sm:py-9">
          <Logo priority className="self-center [&_img]:w-20" />
          {children}
        </div>
      </main>
    </div>
  );
}
