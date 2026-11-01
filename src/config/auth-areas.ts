import type { Locale } from "next-intl";
import {
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_NO_ACCESS_PATH,
  ADMIN_PUBLIC_PATHS,
  ADMIN_SET_PASSWORD_PATH,
} from "@/config/admin";
import {
  MYLIFE_HOME_PATH,
  MYLIFE_LOGIN_PATH,
  MYLIFE_NO_ACCESS_PATH,
  MYLIFE_PUBLIC_PATHS,
  MYLIFE_SET_PASSWORD_PATH,
} from "@/config/mylife";
import type { Database } from "@/types/database";

type AppRole = Database["public"]["Enums"]["app_role"];

/**
 * The signed-in areas (outside `[locale]`, architecture §2), in the order
 * `/auth/confirm` picks a user's own area.
 */
export const AUTH_AREAS = ["admin", "mylife"] as const;

export type AuthArea = (typeof AUTH_AREAS)[number];

/** Both areas, and the auth copy they share (`Auth` in `messages/da.json`), are Danish only. */
export const AUTH_LOCALE: Locale = "da";

/** Value of the `error` query param a login page explains: a dead invite or reset link (set by `/auth/confirm`). */
export const LOGIN_ERROR_LINK_INVALID = "link_invalid";

type AreaConfig = {
  /** Names the area in server logs. */
  label: string;
  /** Root path; the area's pages live under `<home>/`. */
  home: string;
  login: string;
  /** Where a signed-in user whose role the area does not admit is sent. */
  noAccess: string;
  /** Where the area's invite and reset links land. */
  setPassword: string;
  /** The only routes the middleware serves without a session. */
  publicPaths: ReadonlySet<string>;
  /**
   * Roles allowed in. The owner may enter both areas; every other role belongs
   * to one, so a `mylife_user` never reaches the admin panel and an `admin`
   * never reaches MyLife.
   */
  roles: readonly AppRole[];
};

/** Per area: its paths, its public routes and the roles it admits. */
export const AREA_CONFIG = {
  admin: {
    label: "Admin",
    home: ADMIN_HOME_PATH,
    login: ADMIN_LOGIN_PATH,
    noAccess: ADMIN_NO_ACCESS_PATH,
    setPassword: ADMIN_SET_PASSWORD_PATH,
    publicPaths: ADMIN_PUBLIC_PATHS,
    roles: ["owner", "admin"],
  },
  mylife: {
    label: "MyLife",
    home: MYLIFE_HOME_PATH,
    login: MYLIFE_LOGIN_PATH,
    noAccess: MYLIFE_NO_ACCESS_PATH,
    setPassword: MYLIFE_SET_PASSWORD_PATH,
    publicPaths: MYLIFE_PUBLIC_PATHS,
    roles: ["owner", "mylife_user"],
  },
} as const satisfies Record<AuthArea, AreaConfig>;

/** A role allowed into `A`. */
export type AreaRole<A extends AuthArea> = (typeof AREA_CONFIG)[A]["roles"][number];

/** Whether `role` may enter `area`. */
export function canEnterArea<A extends AuthArea>(area: A, role: AppRole | null): role is AreaRole<A> {
  return role !== null && (AREA_CONFIG[area].roles as readonly AppRole[]).includes(role);
}
