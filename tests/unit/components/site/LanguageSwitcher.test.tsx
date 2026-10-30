// @vitest-environment jsdom
// Tests for AC-I18N-05 (/kontakt -> /en/contact) and AC-I18N-06
// (/en/contact -> /kontakt) at the component level, plus the switcher's a11y
// contract. tests/e2e/i18n-routing.spec.ts covers the hrefs in a real browser;
// these pin the markup:
// - WCAG 2.5.3 Label in Name: the other locale's link has an accessible name
//   that STARTS with its visible code ("EN English"). This regressed once.
// - The current locale is marked (aria-current), not linked.
// - The landmark is labelled from messages ("Sprog" / "Language").
// - lang/hreflang identify each locale's language.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { NextIntlClientProvider, type Locale } from 'next-intl';

// ── Mock the Next router hooks ───────────────────────────────────────────────
// There is no Next router outside Next. Each hook returns what it returns on
// the live route: `usePathname` the browser path ("/kontakt") and `useParams`
// the route params. Everything above them is real: next-intl's `usePathname`
// maps the browser path to the internal template ("/contact") and
// `getPathname` builds the href from the routing table in src/i18n/routing.ts.
const route = vi.hoisted(() => ({
  pathname: '/',
  params: {} as Record<string, string>,
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => route.pathname,
  useParams: () => route.params,
}));

import LanguageSwitcher from '@/components/site/LanguageSwitcher';
import { loadMessages } from '@/i18n/messages';

afterEach(cleanup);

/**
 * Renders the switcher on `pathname` the way the locale layout does: copy
 * from the real messages (with the DA fallback) and the route locale in the
 * intl context. Returns the switcher's navigation landmark.
 */
function renderSwitcher(locale: Locale, pathname: string) {
  route.pathname = pathname;
  route.params = { locale };
  const { label, da, en } = loadMessages(locale).LanguageSwitcher;
  render(
    <NextIntlClientProvider locale={locale}>
      <LanguageSwitcher label={label} localeNames={{ da, en }} />
    </NextIntlClientProvider>,
  );
  return screen.getByRole('navigation');
}

/**
 * Accessible-name matcher for WCAG 2.5.3 Label in Name: the name starts with
 * the visible `code`, so an aria-label or an aria-hidden code fails it.
 *
 * dom-accessibility-api trims inline children, so jsdom computes "ENEnglish"
 * where Chromium computes "EN English" and a `/^EN\b/` name query can never
 * match here. The space after the code is asserted on the link text instead,
 * which is what browsers build the name from.
 */
const nameStartsWith = (code: string) => (name: string) => name.startsWith(code);

// ── AC-I18N-05: DA contact page (/kontakt) ───────────────────────────────────

describe('AC-I18N-05: LanguageSwitcher on /kontakt (DA)', () => {
  it('nav landmark is labelled "Sprog"', () => {
    renderSwitcher('da', '/kontakt');
    expect(screen.getByRole('navigation', { name: 'Sprog' })).toBeInTheDocument();
  });

  it('EN link name starts with the visible code "EN" (WCAG 2.5.3) and points to /en/contact', () => {
    const nav = renderSwitcher('da', '/kontakt');
    const link = within(nav).getByRole('link', { name: nameStartsWith('EN') });
    expect(link).toHaveTextContent(/^EN English$/);
    expect(link).toHaveAttribute('href', '/en/contact');
  });

  it('EN link carries hreflang="en" and lang="en"', () => {
    const nav = renderSwitcher('da', '/kontakt');
    const link = within(nav).getByRole('link', { name: nameStartsWith('EN') });
    expect(link).toHaveAttribute('hreflang', 'en');
    expect(link).toHaveAttribute('lang', 'en');
  });

  it('current locale DA is a non-link span with aria-current and lang="da"', () => {
    const nav = renderSwitcher('da', '/kontakt');
    expect(within(nav).getAllByRole('link')).toHaveLength(1);
    expect(within(nav).queryByRole('link', { name: nameStartsWith('DA') })).toBeNull();

    const current = nav.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0]!.tagName).toBe('SPAN');
    expect(current[0]!.closest('a')).toBeNull();
    expect(current[0]).toHaveAttribute('aria-current', 'true');
    expect(current[0]).toHaveAttribute('lang', 'da');
    expect(current[0]).toHaveTextContent(/^DA Dansk$/);
  });
});

// ── AC-I18N-06: EN contact page (/en/contact) ────────────────────────────────

describe('AC-I18N-06: LanguageSwitcher on /en/contact (EN)', () => {
  it('nav landmark is labelled "Language"', () => {
    renderSwitcher('en', '/en/contact');
    expect(screen.getByRole('navigation', { name: 'Language' })).toBeInTheDocument();
  });

  it('DA link name starts with the visible code "DA" (WCAG 2.5.3) and points to /kontakt', () => {
    const nav = renderSwitcher('en', '/en/contact');
    const link = within(nav).getByRole('link', { name: nameStartsWith('DA') });
    expect(link).toHaveTextContent(/^DA Dansk$/);
    expect(link).toHaveAttribute('href', '/kontakt');
  });

  it('DA link carries hreflang="da" and lang="da"', () => {
    const nav = renderSwitcher('en', '/en/contact');
    const link = within(nav).getByRole('link', { name: nameStartsWith('DA') });
    expect(link).toHaveAttribute('hreflang', 'da');
    expect(link).toHaveAttribute('lang', 'da');
  });

  it('current locale EN is a non-link span with aria-current and lang="en"', () => {
    const nav = renderSwitcher('en', '/en/contact');
    expect(within(nav).getAllByRole('link')).toHaveLength(1);
    expect(within(nav).queryByRole('link', { name: nameStartsWith('EN') })).toBeNull();

    const current = nav.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0]!.tagName).toBe('SPAN');
    expect(current[0]!.closest('a')).toBeNull();
    expect(current[0]).toHaveAttribute('aria-current', 'true');
    expect(current[0]).toHaveAttribute('lang', 'en');
    expect(current[0]).toHaveTextContent(/^EN English$/);
  });
});
