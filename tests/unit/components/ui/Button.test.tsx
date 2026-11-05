// @vitest-environment jsdom
// Tests for AC-DS-12 through AC-DS-16
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import Button from '@/components/ui/Button';

afterEach(cleanup);

// ── AC-DS-12: variant rendering ────────────────────────────────────────────

describe('AC-DS-12: Button renders with primary and secondary variants', () => {
  it('renders a button element with role="button"', () => {
    render(<Button variant="primary">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('primary variant renders without crashing', () => {
    render(<Button variant="primary">Gem</Button>);
    expect(screen.getByRole('button', { name: 'Gem' })).toBeInTheDocument();
  });

  it('secondary variant renders without crashing', () => {
    render(<Button variant="secondary">Annuller</Button>);
    expect(screen.getByRole('button', { name: 'Annuller' })).toBeInTheDocument();
  });
});

// ── AC-DS-13: default type="button" ───────────────────────────────────────

describe('AC-DS-13: Button defaults to type="button"', () => {
  it('has type="button" when no type prop is supplied', () => {
    render(<Button>Klik</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('respects an explicit type="submit" override', () => {
    render(<Button type="submit">Indsend</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });
});

// ── AC-DS-14: disabled state ───────────────────────────────────────────────

describe('AC-DS-14: Button disabled state', () => {
  it('has the disabled attribute when disabled prop is set', () => {
    render(<Button disabled>Deaktiveret</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does not fire onClick when disabled', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={handleClick}>
        Deaktiveret
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(handleClick).not.toHaveBeenCalled();
  });
});

// ── AC-DS-15: loading state ────────────────────────────────────────────────

describe('AC-DS-15: Button loading state', () => {
  it('sets aria-busy="true" when loading', () => {
    render(<Button loading>Gemmer...</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('is disabled while loading', () => {
    render(<Button loading>Gemmer...</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does not fire onClick while loading', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button loading onClick={handleClick}>
        Gemmer...
      </Button>,
    );
    await user.click(screen.getByRole('button'));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('preserves the accessible name while loading', () => {
    render(<Button loading>Gemmer...</Button>);
    // The spinner must be aria-hidden so the button name stays "Gemmer..."
    expect(screen.getByRole('button', { name: 'Gemmer...' })).toBeInTheDocument();
  });

  it('renders a spinner element with aria-hidden', () => {
    render(<Button loading>Gemmer...</Button>);
    // The spinner must not contribute to the accessibility tree.
    // It may be a <span aria-hidden="true"> or similar — query by attribute.
    const btn = screen.getByRole('button');
    const spinner = btn.querySelector('[aria-hidden="true"]');
    expect(spinner).not.toBeNull();
  });
});

// ── AC-DS-16: keyboard interaction ────────────────────────────────────────

describe('AC-DS-16: Button keyboard activation', () => {
  it('Tab moves focus to the button', async () => {
    const user = userEvent.setup();
    render(<Button>Fokus</Button>);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Fokus' })).toHaveFocus();
  });

  it('Enter activates the button', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={handleClick}>Aktiver</Button>);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('Space activates the button', async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={handleClick}>Aktiver</Button>);
    await user.tab();
    await user.keyboard(' ');
    expect(handleClick).toHaveBeenCalledOnce();
  });
});
