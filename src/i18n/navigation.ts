import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/** Locale-aware navigation APIs bound to {@link routing}. */
export const { Link, redirect, permanentRedirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
