"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { CatalogKind } from "@/config/catalog";

type SetActiveKind = Dispatch<SetStateAction<CatalogKind | null>>;

const ActiveKindContext = createContext<CatalogKind | null>(null);
const SetActiveKindContext = createContext<SetActiveKind | null>(null);

/**
 * Holds the kind of the catalog section the current admin page edits, so the
 * sidebar can mark that kind's link. The panel layout renders the sidebar
 * without the page's params (a section editor's path carries only the
 * section id), so the page declares the kind with `ActiveCatalogKind`.
 */
export function ActiveCatalogKindProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [kind, setKind] = useState<CatalogKind | null>(null);
  return (
    <SetActiveKindContext value={setKind}>
      <ActiveKindContext value={kind}>{children}</ActiveKindContext>
    </SetActiveKindContext>
  );
}

/** The kind declared by the current page, `null` on pages that edit no section. */
export function useActiveCatalogKind(): CatalogKind | null {
  return useContext(ActiveKindContext);
}

/**
 * Declares, while mounted, that the current page edits a section of `kind`;
 * renders nothing. Set in a layout effect, so after a client navigation the
 * sidebar is painted with the right link marked; on a full page load the link
 * is marked at hydration. Outside the admin shell there is no sidebar to mark.
 */
export default function ActiveCatalogKind({ kind }: Readonly<{ kind: CatalogKind }>) {
  const setKind = useContext(SetActiveKindContext);
  useLayoutEffect(() => {
    if (!setKind) return;
    setKind(kind);
    return () => setKind((current) => (current === kind ? null : current));
  }, [setKind, kind]);
  return null;
}
