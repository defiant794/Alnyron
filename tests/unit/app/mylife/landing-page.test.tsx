// @vitest-environment jsdom
/**
 * Unit tests: /mylife/(panel)/page.tsx, the signed-in placeholder landing.
 * Journey: mylife-login  ML-AC2 (landing after sign-in), ML-AC3 (sign-out),
 * ML-AC6 (the page is gated)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockRequireMyLife } = vi.hoisted(() => ({ mockRequireMyLife: vi.fn() }));

vi.mock("next-intl/server", async () => {
  // vi.mock factories are hoisted above static imports; dynamic import is required.
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/mylife",
}));
vi.mock("@/services/auth/require-role", () => ({ requireMyLife: mockRequireMyLife }));
vi.mock("@/app/mylife/(auth)/actions", () => ({ signOut: vi.fn() }));

import MyLifeLandingPage, { generateMetadata } from "@/app/mylife/(panel)/page";
import { loadMessages } from "@/i18n/messages";

const { Auth, MyLife } = loadMessages("da");

afterEach(cleanup);

describe("ML-AC2/ML-AC3: MyLife landing (signed-in placeholder)", () => {
  beforeEach(async () => {
    mockRequireMyLife.mockResolvedValue({ userId: "u1", email: "ml@alnyron.dk", role: "mylife_user" });
    render(await MyLifeLandingPage());
  });

  it("ML-AC2d: is gated by requireMyLife", () => {
    expect(mockRequireMyLife).toHaveBeenCalledTimes(1);
  });

  it("ML-AC2e: shows the 'MyLife kommer snart' heading and the lead", () => {
    expect(screen.getByRole("heading", { level: 1, name: MyLife.home.title })).toBeInTheDocument();
    expect(screen.getByText(MyLife.home.lead)).toBeInTheDocument();
  });

  it("ML-AC2c: names the signed-in account", () => {
    expect(screen.getByText(MyLife.home.signedInAs.replace("{email}", "ml@alnyron.dk"))).toBeInTheDocument();
  });

  it("ML-AC3: offers 'Log ud' as the submit button of the sign-out form", () => {
    const button = screen.getByRole("button", { name: Auth.signOut });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });

  it("ML-AC2f: the page title names the page (the layout template adds '| MyLife')", async () => {
    expect((await generateMetadata()).title).toBe(MyLife.home.metaTitle);
  });
});

describe("ML-AC6: the landing page is gated", () => {
  it("ML-AC6: requireMyLife's redirect for a forbidden role propagates (the page never renders)", async () => {
    mockRequireMyLife.mockRejectedValue(new Error("NEXT_REDIRECT:/mylife/no-access"));
    await expect(MyLifeLandingPage()).rejects.toThrow("NEXT_REDIRECT:/mylife/no-access");
  });
});
