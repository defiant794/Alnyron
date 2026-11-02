/**
 * Unit tests — revalidatePublicContent (F1.2 pages editor)
 * Journey: pages-editor  AC-PAGES-17
 *
 * Expected module: src/lib/revalidate.ts
 *
 * revalidatePublicContent() must call revalidatePath('/', 'layout') to
 * bust the full-layout ISR cache.  The 'layout' type revalidates ALL routes
 * that share the root layout, so a single call covers every public page.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.hoisted ─────────────────────────────────────────────────────────────────

const { mockRevalidatePath } = vi.hoisted(() => ({
  mockRevalidatePath: vi.fn(),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { revalidatePublicContent } from "@/lib/revalidate";

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AC-PAGES-17: revalidatePublicContent — calls revalidatePath('/', 'layout')", () => {
  it("AC-PAGES-17: calls revalidatePath with path '/' and type 'layout'", async () => {
    await revalidatePublicContent();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("AC-PAGES-17b: calls revalidatePath exactly once per invocation", async () => {
    await revalidatePublicContent();
    expect(mockRevalidatePath).toHaveBeenCalledOnce();
  });
});
