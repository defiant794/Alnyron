// @vitest-environment jsdom
// Tests for AC-DS-20
// These tests FAIL (Red) until web-developer creates src/components/ui/Field.tsx.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import Field from '@/components/ui/Field';

afterEach(cleanup);

// ── AC-DS-20: label association ────────────────────────────────────────────

describe('AC-DS-20: Field label is associated with the input', () => {
  it('getByLabelText finds the input by label text', () => {
    render(<Field label="Navn" />);
    expect(screen.getByLabelText('Navn')).toBeInTheDocument();
  });

  it('the associated element is an input', () => {
    render(<Field label="E-mail" />);
    expect(screen.getByLabelText('E-mail').tagName).toBe('INPUT');
  });
});

// ── AC-DS-20: error state ──────────────────────────────────────────────────

describe('AC-DS-20: Field error state', () => {
  it('sets aria-invalid="true" on the input when error is provided', () => {
    render(<Field label="E-mail" error="Ugyldig e-mailadresse" />);
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders the error message text', () => {
    render(<Field label="E-mail" error="Ugyldig e-mailadresse" />);
    expect(screen.getByText('Ugyldig e-mailadresse')).toBeInTheDocument();
  });

  it('aria-describedby on the input points to the error message element', () => {
    render(<Field label="E-mail" error="Ugyldig e-mailadresse" />);
    const input = screen.getByLabelText('E-mail');
    const describedById = input.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    const messageEl = document.getElementById(describedById!);
    expect(messageEl).not.toBeNull();
    expect(messageEl!.textContent).toContain('Ugyldig e-mailadresse');
  });

  it('error message is announced via role="alert" or a live region', () => {
    render(<Field label="E-mail" error="Ugyldig e-mailadresse" />);
    // The error message must be a live region so screen readers announce it.
    const alert = screen.queryByRole('alert');
    const liveRegion = document.querySelector('[aria-live]');
    expect(alert ?? liveRegion).not.toBeNull();
  });

  it('aria-invalid is not set when there is no error', () => {
    render(<Field label="Navn" />);
    expect(screen.getByLabelText('Navn')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

// ── AC-DS-20: hint text ────────────────────────────────────────────────────

describe('AC-DS-20: Field hint text is described', () => {
  it('renders hint text', () => {
    render(<Field label="Adgangskode" hint="Mindst 8 tegn" />);
    expect(screen.getByText('Mindst 8 tegn')).toBeInTheDocument();
  });

  it('aria-describedby references the hint element', () => {
    render(<Field label="Adgangskode" hint="Mindst 8 tegn" />);
    const input = screen.getByLabelText('Adgangskode');
    const describedById = input.getAttribute('aria-describedby');
    expect(describedById).not.toBeNull();
    const hintEl = document.getElementById(describedById!.split(' ')[0]!);
    expect(hintEl).not.toBeNull();
  });
});

// ── AC-DS-20: success state ────────────────────────────────────────────────

describe('AC-DS-20: Field success message', () => {
  it('renders the success message when provided', () => {
    render(<Field label="Brugernavn" success="Brugernavn er ledigt" />);
    expect(screen.getByText('Brugernavn er ledigt')).toBeInTheDocument();
  });
});

// ── AC-DS-20: disabled and required ────────────────────────────────────────

describe('AC-DS-20: Field disabled and required props forwarded to input', () => {
  it('disabled prop disables the input', () => {
    render(<Field label="Postnummer" disabled />);
    expect(screen.getByLabelText('Postnummer')).toBeDisabled();
  });

  it('required prop marks the input as required', () => {
    render(<Field label="Telefon" required />);
    expect(screen.getByLabelText('Telefon')).toBeRequired();
  });
});
