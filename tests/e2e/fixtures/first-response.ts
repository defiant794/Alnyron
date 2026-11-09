import type { Page, Response } from "@playwright/test";

/**
 * The first response the browser gets when it opens `url`: a redirect is followed by the
 * browser and read back here, so `status()` and `headerValue("location")` are the redirect's
 * own. For the `*.localhost` app hosts (`monitor.localhost`, `mylife.localhost`): Chromium
 * resolves them to the loopback, Node's resolver behind Playwright's API request context does
 * not on every OS (`getaddrinfo ENOTFOUND` on Windows). The page's cookies go along, as on
 * any navigation.
 */
export async function firstResponse(page: Page, url: string): Promise<Response> {
  const last = await page.goto(url);
  if (!last) throw new Error(`No response for ${url}`);
  let request = last.request();
  for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
    request = previous;
  }
  const first = await request.response();
  if (!first) throw new Error(`No response for the first request of ${url}`);
  return first;
}
