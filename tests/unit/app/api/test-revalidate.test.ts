// Tests for the test-only POST /api/test/revalidate
// (src/app/api/test/revalidate/route.ts): the e2e DB fixtures call it to
// refresh the ISR cache on a production build. It must be inert unless the
// server has E2E_REVALIDATE_SECRET (never set in the deployed Worker):
// - no secret configured: 404, whatever the request sends;
// - missing or wrong x-revalidate-secret header: 404;
// - matching header: revalidates every page from the root layout down, 200.
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockRevalidatePath } = vi.hoisted(() => ({ mockRevalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import { POST } from "@/app/api/test/revalidate/route";

const SECRET = "e2e-test-secret";

/** POST /api/test/revalidate with the given headers. */
function revalidateRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/test/revalidate", { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockRevalidatePath.mockClear();
});

describe("POST /api/test/revalidate without E2E_REVALIDATE_SECRET (production)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("404s and revalidates nothing when the secret is %s, even with a header", async (_case, value) => {
    vi.stubEnv("E2E_REVALIDATE_SECRET", value);
    const response = await POST(revalidateRequest({ "x-revalidate-secret": value ?? "" }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("POST /api/test/revalidate with E2E_REVALIDATE_SECRET set", () => {
  it.each([
    ["no header", {}],
    ["an empty header", { "x-revalidate-secret": "" }],
    ["a wrong secret", { "x-revalidate-secret": "wrong" }],
    ["a prefix of the secret", { "x-revalidate-secret": SECRET.slice(0, -1) }],
    ["the secret plus extra characters", { "x-revalidate-secret": `${SECRET}x` }],
  ])("404s and revalidates nothing with %s", async (_case, headers) => {
    vi.stubEnv("E2E_REVALIDATE_SECRET", SECRET);
    const response = await POST(revalidateRequest(headers));
    expect(response.status).toBe(404);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates every page from the root layout and answers 200 { revalidated: true } with the matching header", async () => {
    vi.stubEnv("E2E_REVALIDATE_SECRET", SECRET);
    const response = await POST(revalidateRequest({ "x-revalidate-secret": SECRET }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revalidated: true });
    expect(mockRevalidatePath).toHaveBeenCalledExactlyOnceWith("/", "layout");
  });
});
