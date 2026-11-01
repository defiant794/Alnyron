// @vitest-environment jsdom
/**
 * Unit tests: /mylife/(panel)/no-access/page.tsx
 * Journey: mylife-login  ML-AC6 (blocked role), ML-AC5 / ML-AC2 (everyone else is sent on)
 *
 * A signed-in user without MyLife access sees "Ingen adgang" naming their
 * account, can sign out, and has a link to /mylife/login. A visitor without a
 * session goes to the login page, a user with access to the MyLife home. The
 * expected copy is read from the loaded Danish messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockGetMyLifeAccess } = vi.hoisted(() => ({ mockGetMyLifeAccess: vi.fn() }));

vi.mock("next-intl/server", async () => {
  // vi.mock factories are hoisted above static imports; dynamic import is required.
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/mylife/no-access",
}));
vi.mock("@/services/auth/require-role", () => ({ getMyLifeAccess: mockGetMyLifeAccess }));
vi.mock("@/app/mylife/(auth)/actions", () => ({ signOut: vi.fn() }));

import NoAccessPage from "@/app/mylife/(panel)/no-access/page";
import { loadMessages } from "@/i18n/messages";

const { Auth, MyLife } = loadMessages("da");
const EMAIL = "wrong-role@example.com";

afterEach(cleanup);

describe("ML-AC6: /mylife/no-access lets a blocked user leave gracefully", () => {
  beforeEach(async () => {
    mockGetMyLifeAccess.mockResolvedValue({ status: "forbidden", email: EMAIL });
    render(await NoAccessPage());
  });

  it("ML-AC6a: 'Ingen adgang' is the page heading", () => {
    expect(screen.getByRole("heading", { level: 1, name: Auth.noAccess.title })).toBeInTheDocument();
  });

  it("ML-AC6b: names the blocked account and explains what to do", () => {
    expect(screen.getByText(MyLife.noAccess.body.replace("{email}", EMAIL))).toBeInTheDocument();
    expect(screen.getByText(Auth.noAccess.help)).toBeInTheDocument();
  });

  it("ML-AC6c: links to /mylife/login to sign in with another account", () => {
    expect(screen.getByRole("link", { name: Auth.noAccess.switchAccount })).toHaveAttribute(
      "href",
      "/mylife/login",
    );
  });

  it("ML-AC6d: offers 'Log ud' as the submit button of the sign-out form", () => {
    const button = screen.getByRole("button", { name: Auth.signOut });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });
});

describe("/mylife/no-access sends everyone else where they belong", () => {
  it("ML-AC5: a visitor without a session is redirected to /mylife/login", async () => {
    mockGetMyLifeAccess.mockResolvedValue({ status: "anonymous" });
    await expect(NoAccessPage()).rejects.toThrow("NEXT_REDIRECT:/mylife/login");
  });

  it("ML-AC2: a user with MyLife access is redirected to the MyLife home", async () => {
    mockGetMyLifeAccess.mockResolvedValue({
      status: "allowed",
      user: { userId: "u1", email: "ml@alnyron.dk", role: "mylife_user" },
    });
    await expect(NoAccessPage()).rejects.toThrow(/^NEXT_REDIRECT:\/mylife$/);
  });
});
