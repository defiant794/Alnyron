// @vitest-environment jsdom
/**
 * Unit tests: /monitor/(auth)/signup/page.tsx
 * Journey: monitor-web-area  MON-AC4, MON-AC5, MON-AC9
 *
 * Verifies: email field, password field, submit button, privacy note link,
 * and the generic confirmation naming the typed address.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { mockSignUp } = vi.hoisted(() => ({ mockSignUp: vi.fn() }));

vi.mock("next-intl/server", async () => {
  const { nextIntlServerMock } = await import("../../../helpers/next-intl-server");
  return nextIntlServerMock();
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  usePathname: () => "/monitor/signup",
}));
vi.mock("@/app/monitor/(auth)/actions", () => ({ signUp: mockSignUp }));

import MonitorSignupPage, { generateMetadata } from "@/app/monitor/(auth)/signup/page";
import { loadMessages } from "@/i18n/messages";

const { Monitor } = loadMessages("da");

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MON-AC4/MON-AC9: /monitor/signup renders per design", () => {
  it("MON-AC4c: renders without throwing", async () => {
    await expect(async () =>
      render(await MonitorSignupPage({ searchParams: Promise.resolve({}) })),
    ).not.toThrow();
  });

  it("MON-AC5d: has a labeled email field", async () => {
    render(await MonitorSignupPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument();
  });

  it("MON-AC5e: has a labeled password field of type=password", async () => {
    render(await MonitorSignupPage({ searchParams: Promise.resolve({}) }));
    const pwd = screen.getByLabelText(/adgangskode/i);
    expect(pwd).toHaveAttribute("type", "password");
  });

  it("MON-AC4d: has a submit button", async () => {
    render(await MonitorSignupPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("button", { name: Monitor.signup.submit })).toBeInTheDocument();
  });

  it("MON-AC9a: privacy note is present with a link to the privacy page", async () => {
    render(await MonitorSignupPage({ searchParams: Promise.resolve({}) }));
    const privacyLink = screen.getByRole("link", { name: Monitor.signup.privacyLinkText });
    expect(privacyLink).toBeInTheDocument();
    // The link must not point to the monitor area itself
    expect(privacyLink).not.toHaveAttribute("href", expect.stringContaining("/monitor/"));
  });

  it("MON-AC3a: metadata has noindex robots directive", async () => {
    const meta = await generateMetadata();
    expect(JSON.stringify(meta.robots ?? "")).toMatch(/noindex/);
  });
});

describe("MON-AC4: generic confirmation after submitting", () => {
  it("MON-AC4e: shows 'Tjek din e-mail' with the typed address filled into the message", async () => {
    // An apostrophe is valid in an address and is ICU's quote character: it must come out as typed.
    const email = "o'brien@eksempel.dk";
    mockSignUp.mockResolvedValue({ type: "confirmation", email });
    render(await MonitorSignupPage({ searchParams: Promise.resolve({}) }));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/e-mail/i), email);
    await user.type(screen.getByLabelText(/adgangskode/i), "a-long-password-1!");
    await user.click(screen.getByRole("button", { name: Monitor.signup.submit }));

    expect(await screen.findByRole("heading", { name: Monitor.signup.confirmationTitle })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Hvis o'brien@eksempel.dk kan bruges til en ny konto, har vi sendt et link, der bekræfter adressen. Følg linket for at logge ind. Har du allerede en konto, kan du logge ind eller nulstille din adgangskode.",
      ),
    ).toBeInTheDocument();
    expect(mockSignUp).toHaveBeenCalledTimes(1);
  });
});
