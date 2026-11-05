import type { Page } from "@playwright/test";

/**
 * Signs in on /admin/login and waits until the browser is on `path`. A path
 * below /admin/ goes along as `?next=`, so signIn redirects straight there
 * (safeNext only accepts paths that start with /admin/); the bare /admin home
 * is sent without `next` and relies on the action's default. A non-admin is
 * redirected to /admin/no-access by the server, so pass that as `path`.
 */
export async function loginAs(page: Page, email: string, password: string, path = "/admin"): Promise<void> {
  const loginUrl = path === "/admin" ? "/admin/login" : `/admin/login?next=${encodeURIComponent(path)}`;
  await page.goto(loginUrl);
  await page.getByLabel(/E-mail/i).fill(email);
  await page.getByLabel(/Adgangskode/i).fill(password);
  await page.getByRole("button", { name: /Log ind/i }).click();
  await page.waitForURL(path, { timeout: 10_000 });
}
