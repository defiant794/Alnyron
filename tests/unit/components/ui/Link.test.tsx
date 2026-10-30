// @vitest-environment jsdom
// Tests for AC-DS-17
// These tests FAIL (Red) until web-developer creates src/components/ui/Link.tsx.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// next/link renders as an <a> in test environments; mock for deterministic output.
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
import Link from '@/components/ui/Link';

afterEach(cleanup);

// ── AC-DS-17: Link rendering and rel safety ────────────────────────────────

describe('AC-DS-17: Link renders an anchor with correct href', () => {
  it('renders an anchor element', () => {
    render(<Link href="/om-os">Om os</Link>);
    expect(screen.getByRole('link', { name: 'Om os' })).toBeInTheDocument();
  });

  it('passes the href to the underlying anchor', () => {
    render(<Link href="/kontakt">Kontakt</Link>);
    expect(screen.getByRole('link', { name: 'Kontakt' })).toHaveAttribute('href', '/kontakt');
  });
});

describe('AC-DS-17: external target="_blank" link gets rel="noopener noreferrer"', () => {
  it('adds rel="noopener noreferrer" for https:// href with target="_blank"', () => {
    render(
      <Link href="https://example.com" target="_blank">
        Ekstern
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Ekstern' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('adds rel="noopener noreferrer" for http:// href with target="_blank"', () => {
    render(
      <Link href="http://example.com" target="_blank">
        Usikker ekstern
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Usikker ekstern' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does NOT add rel for internal href with target="_blank"', () => {
    render(
      <Link href="/intern" target="_blank">
        Intern
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Intern' });
    expect(link).not.toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does NOT add rel for external href without target="_blank"', () => {
    render(<Link href="https://example.com">Ingen blank</Link>);
    const link = screen.getByRole('link', { name: 'Ingen blank' });
    expect(link).not.toHaveAttribute('rel', 'noopener noreferrer');
  });
});
