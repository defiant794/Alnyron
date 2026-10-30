// @vitest-environment jsdom
// Tests for AC-DS-22 and AC-DS-23
// These tests FAIL (Red) until web-developer creates src/components/brand/Logo.tsx
// and copies the logo-mark asset to public/brand/logo-mark.png.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { existsSync } from 'fs';
import { join } from 'path';

vi.mock('next/image', () => ({
  default: ({
    src,
    alt,
    ...props
  }: {
    src: string;
    alt: string;
    [key: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} {...(props as React.ImgHTMLAttributes<HTMLImageElement>)} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  ),
}));

import { vi } from 'vitest';
import Logo from '@/components/brand/Logo';

afterEach(cleanup);

// ── AC-DS-22: Logo mark image ──────────────────────────────────────────────

describe('AC-DS-22: Logo renders the A-mark image', () => {
  it('renders an img element', () => {
    render(<Logo />);
    // There should be at least one img (the mark).
    expect(document.querySelector('img')).not.toBeNull();
  });

  it('img src references logo-mark', () => {
    render(<Logo />);
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toContain('logo-mark');
  });
});

// ── AC-DS-22: wordmark ─────────────────────────────────────────────────────

describe('AC-DS-22: Logo renders the ALNYRON wordmark', () => {
  it('shows the wordmark text "ALNYRON"', () => {
    render(<Logo wordmark />);
    expect(screen.getByText('ALNYRON')).toBeInTheDocument();
  });
});

// ── AC-DS-22: link variant ─────────────────────────────────────────────────

describe('AC-DS-22: Logo link variant has accessible name "Alnyron"', () => {
  it('renders a link with accessible name "Alnyron"', () => {
    render(<Logo asLink />);
    expect(screen.getByRole('link', { name: 'Alnyron' })).toBeInTheDocument();
  });

  it('link points to the home page "/"', () => {
    render(<Logo asLink />);
    expect(screen.getByRole('link', { name: 'Alnyron' })).toHaveAttribute('href', '/');
  });
});

// ── AC-DS-23: public asset exists ─────────────────────────────────────────

describe('AC-DS-23: public/brand/logo-mark.png exists on disk', () => {
  it('file is present in the public/ directory', () => {
    expect(existsSync(join(process.cwd(), 'public/brand/logo-mark.png'))).toBe(true);
  });
});
