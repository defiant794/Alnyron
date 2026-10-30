// @vitest-environment jsdom
// Tests for AC-DS-07 through AC-DS-11
// Uses renderToStaticMarkup + DOMParser so <html>/<body> attributes are
// reachable in a string snapshot rather than relying on RTL container,
// which in React 19 receives only the children of <html>/<body>.
// These tests FAIL (Red) until web-developer updates src/app/layout.tsx.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Mock next/font/google ──────────────────────────────────────────────────
// vi.mock is hoisted before imports, so the layout module gets the mock.
vi.mock('next/font/google', () => ({
  Inter: vi.fn(() => ({ variable: '--font-inter', className: 'font-inter' })),
}));

import { Inter } from 'next/font/google';
import RootLayout from '@/app/layout';

// Vitest 5 sets clearMocks:true by default, which wipes mock.calls between
// tests.  Inter() runs once at module evaluation time (top-level call in
// layout.tsx) before any test lifecycle hook fires.  Capture the args here,
// at module scope, so clearMocks cannot erase them.
const interCallOptions: Record<string, unknown> =
  (vi.mocked(Inter).mock.calls[0]?.[0] as Record<string, unknown>) ?? {};

// Parse the full rendered document once; all structural assertions share it.
// Inter() runs at module evaluation (top-level in layout.tsx), so
// vi.mocked(Inter).mock.calls is already populated before beforeAll runs.
let doc: Document;

beforeAll(() => {
  const markup = renderToStaticMarkup(
    <RootLayout>
      <main id="main">
        <p>content</p>
      </main>
    </RootLayout>,
  );
  doc = new DOMParser().parseFromString(markup, 'text/html');
});

// ── AC-DS-11: no Geist in source ───────────────────────────────────────────

describe('AC-DS-11: layout source has no Geist reference', () => {
  it('src/app/layout.tsx does not import or reference Geist', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/layout.tsx'), 'utf-8');
    expect(src).not.toMatch(/Geist/);
  });
});

// ── AC-DS-07: Inter font configuration ────────────────────────────────────

describe('AC-DS-07: Inter font configured with correct options', () => {
  it('Inter is called with variable "--font-inter"', () => {
    expect(interCallOptions).toMatchObject({ variable: '--font-inter' });
  });

  it('Inter is called with display "swap"', () => {
    expect(interCallOptions).toMatchObject({ display: 'swap' });
  });

  it('Inter is called with latin subset', () => {
    expect(interCallOptions['subsets']).toEqual(
      expect.arrayContaining(['latin']),
    );
  });
});

// ── AC-DS-08 & AC-DS-09: html element attributes ──────────────────────────

describe('AC-DS-09: <html> has lang="da"', () => {
  it('documentElement lang is "da"', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('da');
  });
});

describe('AC-DS-08: Inter variable class applied to <html> or <body>', () => {
  it('<html> or <body> classList contains "--font-inter"', () => {
    const onHtml = doc.documentElement.classList.contains('--font-inter');
    const onBody = doc.body.classList.contains('--font-inter');
    expect(onHtml || onBody).toBe(true);
  });
});

// ── AC-DS-10: SkipLink rendered before #main ───────────────────────────────

describe('AC-DS-10: SkipLink is present and correctly configured', () => {
  it('a[href="#main"] element exists in the rendered document', () => {
    expect(doc.querySelector('a[href="#main"]')).not.toBeNull();
  });

  it('SkipLink text is "Spring til indhold"', () => {
    const link = doc.querySelector('a[href="#main"]');
    expect(link?.textContent?.trim()).toBe('Spring til indhold');
  });

  it('SkipLink text contains no em-dash (writing-style.md hard rule)', () => {
    const link = doc.querySelector('a[href="#main"]');
    expect(link?.textContent).not.toContain('\u2014');
  });

  it('SkipLink appears before #main in DOM order', () => {
    const skipLink = doc.querySelector('a[href="#main"]');
    const main = doc.getElementById('main');
    expect(skipLink).not.toBeNull();
    expect(main).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING (4): main comes after skipLink
    const position = skipLink!.compareDocumentPosition(main!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
