import { describe, it, expect, afterEach, vi } from 'vitest';
import { parsePublicEnv, parseServerEnv, getServerEnv } from '@/config/env';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PUBLIC: Record<string, string | undefined> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_abc123',
  NEXT_PUBLIC_SITE_URL: 'https://alnyron.dk',
};

const VALID_SERVER: Record<string, string | undefined> = {
  RESEND_API_KEY: 're_test_abc',
  MAIL_FROM: 'Alnyron <noreply@send.alnyron.dk>',
};

// ---------------------------------------------------------------------------
// parsePublicEnv
// ---------------------------------------------------------------------------

describe('AC-6, AC-8, AC-10, AC-11, AC-13: parsePublicEnv', () => {
  it('AC-6: accepts a valid public env record and returns exactly the three PublicEnv keys with correct values', () => {
    const result = parsePublicEnv(VALID_PUBLIC);
    expect(result).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_abc123',
      NEXT_PUBLIC_SITE_URL: 'https://alnyron.dk',
    });
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL'],
    ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    ['NEXT_PUBLIC_SITE_URL'],
  ])(
    'AC-8: names %s in the error when that public var is the only one missing',
    (varName) => {
      const env: Record<string, string | undefined> = { ...VALID_PUBLIC, [varName]: undefined };
      expect(() => parsePublicEnv(env)).toThrow(varName);
    },
  );

  it('AC-10: names all three public vars when all are absent', () => {
    let err: Error | null = null;
    try {
      parsePublicEnv({});
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(err!.message).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    expect(err!.message).toContain('NEXT_PUBLIC_SITE_URL');
  });

  it('AC-11: names NEXT_PUBLIC_SITE_URL when its value is not a valid URL', () => {
    const env: Record<string, string | undefined> = { ...VALID_PUBLIC, NEXT_PUBLIC_SITE_URL: 'not-a-url' };
    expect(() => parsePublicEnv(env)).toThrow('NEXT_PUBLIC_SITE_URL');
  });

  it('AC-11: names NEXT_PUBLIC_SUPABASE_URL when its value is not a valid URL', () => {
    const env: Record<string, string | undefined> = { ...VALID_PUBLIC, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' };
    expect(() => parsePublicEnv(env)).toThrow('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('AC-13: strips unknown extra keys from the returned PublicEnv', () => {
    const env: Record<string, string | undefined> = { ...VALID_PUBLIC, UNKNOWN_KEY: 'foo' };
    const result = parsePublicEnv(env);
    expect(result).not.toHaveProperty('UNKNOWN_KEY');
  });
});

// ---------------------------------------------------------------------------
// parseServerEnv
// ---------------------------------------------------------------------------

describe('AC-7, AC-9, AC-10, AC-12, AC-13: parseServerEnv', () => {
  it('AC-7: accepts a valid server env record and returns exactly the two ServerEnv keys with correct values', () => {
    const result = parseServerEnv(VALID_SERVER);
    expect(result).toEqual({
      RESEND_API_KEY: 're_test_abc',
      MAIL_FROM: 'Alnyron <noreply@send.alnyron.dk>',
    });
  });

  it.each([
    ['RESEND_API_KEY'],
    ['MAIL_FROM'],
  ])(
    'AC-9: names %s in the error when that server var is the only one missing',
    (varName) => {
      const env: Record<string, string | undefined> = { ...VALID_SERVER, [varName]: undefined };
      expect(() => parseServerEnv(env)).toThrow(varName);
    },
  );

  it('AC-10: names both server vars in the error when both are absent', () => {
    let err: Error | null = null;
    try {
      parseServerEnv({});
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('RESEND_API_KEY');
    expect(err!.message).toContain('MAIL_FROM');
  });

  it('AC-12: does not include the RESEND_API_KEY value in the error when MAIL_FROM is missing', () => {
    let err: Error | null = null;
    try {
      parseServerEnv({ RESEND_API_KEY: 're_secret_123', MAIL_FROM: undefined });
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toContain('MAIL_FROM');
    expect(err!.message).not.toContain('re_secret_123');
  });

  it('AC-13: strips unknown extra keys from the returned ServerEnv', () => {
    const env: Record<string, string | undefined> = { ...VALID_SERVER, EXTRA_KEY: 'bar' };
    const result = parseServerEnv(env);
    expect(result).not.toHaveProperty('EXTRA_KEY');
  });
});

// ---------------------------------------------------------------------------
// Module-level safety (AC-14)
// ---------------------------------------------------------------------------

describe('AC-14: env module import safety', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('AC-14: dynamic import of @/config/env with all required vars absent does not throw', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', undefined);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', undefined);
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('MAIL_FROM', undefined);

    // Module-level code must not call parse/validate — if it does, this will throw.
    await expect(import('@/config/env')).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getServerEnv lazy reading (AC-15)
// ---------------------------------------------------------------------------

describe('AC-15: getServerEnv lazy reading', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AC-15: reads process.env at call time, picking up values stubbed after the module was imported', () => {
    // The module was already imported statically at the top of this file.
    // We stub env vars NOW (post-import) to prove getServerEnv reads lazily.
    vi.stubEnv('RESEND_API_KEY', 're_post_import_key');
    vi.stubEnv('MAIL_FROM', 'Alnyron <post-import@send.alnyron.dk>');

    const result = getServerEnv();

    expect(result.RESEND_API_KEY).toBe('re_post_import_key');
    expect(result.MAIL_FROM).toBe('Alnyron <post-import@send.alnyron.dk>');
  });
});
