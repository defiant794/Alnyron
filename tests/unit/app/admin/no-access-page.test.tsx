// @vitest-environment jsdom
// Design review F1.1 F-4: /admin/no-access (src/app/admin/(panel)/no-access/page.tsx).
// A signed-in user without an admin role sees the no-access copy naming the
// account in the plain card frame (no panel navigation), can sign out
// ("Log ud") and has a direct link to /admin/login to sign in with a
// different account. The page is rendered inside its (panel) layout, as Next
// does, so the frame choice is covered too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockGetAdminAccess } = vi.hoisted(() => ({ mockGetAdminAccess: vi.fn() }));

// vi.mock is hoisted above the imports, so the shared factory is loaded lazily.
vi.mock("next-intl/server", async () =>
  (await import("../../../helpers/next-intl-server")).nextIntlServerMock(),
);
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/admin/no-access",
}));
vi.mock("@/services/auth/require-admin", () => ({ getAdminAccess: mockGetAdminAccess }));
vi.mock("@/app/admin/(auth)/actions", () => ({ signOut: vi.fn() }));

import PanelLayout from "@/app/admin/(panel)/layout";
import NoAccessPage from "@/app/admin/(panel)/no-access/page";

const EMAIL = "bruger@example.com";

beforeEach(async () => {
  mockGetAdminAccess.mockResolvedValue({ status: "forbidden", email: EMAIL });
  render(await PanelLayout({ children: await NoAccessPage() }));
});

afterEach(cleanup);

describe("F-4: /admin/no-access lets a signed-in non-admin leave", () => {
  it("F-4: shows the no-access copy naming the account", () => {
    expect(screen.getByRole("heading", { level: 1, name: "Ingen adgang" })).toBeInTheDocument();
    expect(
      screen.getByText(`Kontoen ${EMAIL} har ikke adgang til administrationen.`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Kontakt ejeren, hvis du mener, det er en fejl, eller log ud og log ind med en anden konto.",
      ),
    ).toBeInTheDocument();
  });

  it('F-4: links "Log ind med en anden konto" to /admin/login', () => {
    expect(screen.getByRole("link", { name: "Log ind med en anden konto" })).toHaveAttribute(
      "href",
      "/admin/login",
    );
  });

  it('F-4: offers "Log ud" as the submit button of the sign-out form', () => {
    const signOut = screen.getByRole("button", { name: "Log ud" });
    expect(signOut).toHaveAttribute("type", "submit");
    expect(signOut.closest("form")).not.toBeNull();
  });

  it("F-4: renders in the card frame without the panel navigation or account block", () => {
    expect(screen.getByRole("main")).toHaveTextContent("Ingen adgang");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Konto" })).not.toBeInTheDocument();
  });
});
