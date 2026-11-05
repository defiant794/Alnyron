// @vitest-environment jsdom
// Tests for AC-I18N-05 (/contact -> /en/contact) and AC-I18N-06
// (/en/contact -> /contact) at the component level, plus the switcher's a11y
// contract. tests/e2e/i18n-routing.spec.ts covers the hrefs in a real browser;
// these pin the markup:
// - The href is right in the prerendered HTML too, not only after
//   hydration (the prerendered contact page once linked to /en/[slug]).
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
// the live route for a client component in the `[locale]` layout:
// `useSelectedLayoutSegments` the internal segments below that layout
// (["contact"] on /contact and /en/contact) and `useParams` the route params.
// `usePathname` is the URL in the browser ("/contact") but the rewrite target
// while the page is prerendered ("/da/contact"), so the DA cases run with
// both. Everything above the hooks is real: `getPathname` builds the href
// from the routing table in src/i18n/routing.ts.
const route = vi.hoisted(() => ({
  segments: [] as string[],
  params: {} as Record<string, string>,
  pathname: '/',
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSelectedLayoutSegments: () => route.segments,
  useParams: () => route.params,
  usePathname: () => route.pathname,
}));

import LanguageSwitcher from '@/components/site/LanguageSwitcher';
import { loadMessages } from '@/i18n/messages';

afterEach(cleanup);

/**
 * Renders the switcher on the page with the internal `segments` (below the
 * `[locale]` layout) the way the locale layout does: copy from the real
 * messages (with the DA fallback) and the route locale in the intl context.
 * `pathname` is what `usePathname` reports, `params` the route params besides
 * the locale. Returns the switcher's landmark.
 */
function renderSwitcher(
  locale: Locale,
  segments: string[],
  pathname: string,
  params: Record<string, string> = {},
) {
  route.segments = segments;
  route.params = { locale, ...params };
  route.pathname = pathname;
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

// ── AC-I18N-05/AC-ENSLUG-05d: DA contact page (/contact) ─────────────────────

describe.each([
  ['prerendered', '/da/contact'],
  ['in the browser', '/contact'],
])('AC-I18N-05/AC-ENSLUG-05d: LanguageSwitcher on /contact (DA, %s)', (_phase, pathname) => {
  const renderContact = () => renderSwitcher('da', ['contact'], pathname);

  it('nav landmark is labelled "Sprog"', () => {
    renderContact();
    expect(screen.getByRole('navigation', { name: 'Sprog' })).toBeInTheDocument();
  });

  it('EN link name starts with the visible code "EN" (WCAG 2.5.3) and points to /en/contact', () => {
    const nav = renderContact();
    const link = within(nav).getByRole('link', { name: nameStartsWith('EN') });
    expect(link).toHaveTextContent(/^EN English$/);
    expect(link).toHaveAttribute('href', '/en/contact');
  });

  it('EN link carries hreflang="en" and lang="en"', () => {
    const nav = renderContact();
    const link = within(nav).getByRole('link', { name: nameStartsWith('EN') });
    expect(link).toHaveAttribute('hreflang', 'en');
    expect(link).toHaveAttribute('lang', 'en');
  });

  it('current locale DA is a non-link span with aria-current and lang="da"', () => {
    const nav = renderContact();
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
  const renderContact = () => renderSwitcher('en', ['contact'], '/en/contact');

  it('nav landmark is labelled "Language"', () => {
    renderContact();
    expect(screen.getByRole('navigation', { name: 'Language' })).toBeInTheDocument();
  });

  it('DA link points to /contact (the same English path, unprefixed)', () => {
    const nav = renderContact();
    const link = within(nav).getByRole('link', { name: nameStartsWith('DA') });
    expect(link).toHaveTextContent(/^DA Dansk$/);
    expect(link).toHaveAttribute('href', '/contact');
  });

  it('DA link carries hreflang="da" and lang="da"', () => {
    const nav = renderContact();
    const link = within(nav).getByRole('link', { name: nameStartsWith('DA') });
    expect(link).toHaveAttribute('hreflang', 'da');
    expect(link).toHaveAttribute('lang', 'da');
  });

  it('current locale EN is a non-link span with aria-current and lang="en"', () => {
    const nav = renderContact();
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

// ── Other routes: home, DB-slug catalog pages ─────────────────────────────────

describe('LanguageSwitcher links the same route in the other locale', () => {
  it.each([
    ['da', '/da', '/en'],
    ['da', '/', '/en'],
    ['en', '/en', '/'],
  ] as const)('%s home (usePathname %s): other locale -> %s', (locale, pathname, href) => {
    const nav = renderSwitcher(locale, [], pathname);
    expect(within(nav).getByRole('link')).toHaveAttribute('href', href);
  });

  it('the privacy route links /privacy -> /en/privacy', () => {
    const nav = renderSwitcher('da', ['privacy'], '/privacy');
    expect(within(nav).getByRole('link')).toHaveAttribute('href', '/en/privacy');
  });

  it('AC-ENSLUG-05: a DB-slug catalog page keeps its English slug (/services -> /en/services)', () => {
    const nav = renderSwitcher('da', ['services'], '/services', { slug: 'services' });
    expect(within(nav).getByRole('link')).toHaveAttribute('href', '/en/services');
  });

  it('a DB-slug page keeps its slug (/apps -> /en/apps)', () => {
    const nav = renderSwitcher('da', ['apps'], '/apps', { slug: 'apps' });
    expect(within(nav).getByRole('link')).toHaveAttribute('href', '/en/apps');
  });

  it('a DB-slug page whose slug is a fixed route name stays on the slug route (/en/contact -> /contact)', () => {
    const nav = renderSwitcher('en', ['contact'], '/en/contact', { slug: 'contact' });
    expect(within(nav).getByRole('link')).toHaveAttribute('href', '/contact');
  });
});
