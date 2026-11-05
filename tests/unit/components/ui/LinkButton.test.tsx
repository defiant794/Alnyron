// @vitest-environment jsdom
// Tests for AC-DS-18
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

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
import LinkButton from '@/components/ui/LinkButton';

afterEach(cleanup);

// ── AC-DS-18: LinkButton is accessible as a link ───────────────────────────

describe('AC-DS-18: LinkButton renders as an accessible link', () => {
  it('has role="link"', () => {
    render(<LinkButton href="/get-started">Kom i gang</LinkButton>);
    expect(screen.getByRole('link', { name: 'Kom i gang' })).toBeInTheDocument();
  });

  it('carries the href', () => {
    render(<LinkButton href="/contact">Kontakt os</LinkButton>);
    expect(screen.getByRole('link', { name: 'Kontakt os' })).toHaveAttribute(
      'href',
      '/contact',
    );
  });

  it('primary variant renders without crashing', () => {
    render(
      <LinkButton href="/offers" variant="primary">
        Se tilbud
      </LinkButton>,
    );
    expect(screen.getByRole('link', { name: 'Se tilbud' })).toBeInTheDocument();
  });

  it('secondary variant renders without crashing', () => {
    render(
      <LinkButton href="/about" variant="secondary">
        Om os
      </LinkButton>,
    );
    expect(screen.getByRole('link', { name: 'Om os' })).toBeInTheDocument();
  });
});
