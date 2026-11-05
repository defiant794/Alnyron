// @vitest-environment jsdom
// Tests for AC-DS-19
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Card from '@/components/ui/Card';

afterEach(cleanup);

// ── AC-DS-19: Card renders children and interactive variant ────────────────

describe('AC-DS-19: Card renders children', () => {
  it('renders passed children', () => {
    render(<Card>Kortindhold</Card>);
    expect(screen.getByText('Kortindhold')).toBeInTheDocument();
  });

  it('renders multiple children', () => {
    render(
      <Card>
        <h2>Overskrift</h2>
        <p>Beskrivelse</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Overskrift' })).toBeInTheDocument();
    expect(screen.getByText('Beskrivelse')).toBeInTheDocument();
  });
});

describe('AC-DS-19: Card interactive variant has a distinguishing marker', () => {
  it('non-interactive card renders without interactive attribute', () => {
    const { container } = render(<Card>Statisk kort</Card>);
    // An interactive card should carry data-interactive or similar;
    // the static card must not.
    expect(container.firstChild).not.toHaveAttribute('data-interactive');
  });

  it('interactive Card carries a data-interactive marker', () => {
    const { container } = render(<Card interactive>Klikbart kort</Card>);
    expect(container.firstChild).toHaveAttribute('data-interactive');
  });
});
