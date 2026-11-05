/**
 * Unit tests: package.json script shapes (AC-CACHE-19).
 *
 * F2.0 cache-infra: `cf:build` and `deploy` scripts must match the required
 * shape so the Worker build runs the secret guard and deploys to prod only
 * (no deploy:preview script — straight to prod).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

type PackageJson = { scripts?: Record<string, string> };

let scripts!: Record<string, string>;

beforeAll(() => {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageJson;
  scripts = pkg.scripts ?? {};
});

describe('package.json scripts (AC-CACHE-19)', () => {
  it('AC-CACHE-19: cf:build starts with SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1', () => {
    expect(scripts['cf:build']).toBeDefined();
    expect(scripts['cf:build']).toMatch(/^SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1/);
  });

  it('AC-CACHE-19: cf:build runs opennextjs-cloudflare build', () => {
    expect(scripts['cf:build']).toContain('opennextjs-cloudflare build');
  });

  it('AC-CACHE-19: cf:build runs node scripts/guard-no-bundled-secrets.mjs', () => {
    expect(scripts['cf:build']).toContain('node scripts/guard-no-bundled-secrets.mjs');
  });

  it('AC-CACHE-19: deploy script runs opennextjs-cloudflare deploy', () => {
    expect(scripts['deploy']).toBeDefined();
    expect(scripts['deploy']).toContain('opennextjs-cloudflare deploy');
  });

  it('AC-CACHE-19: no deploy:preview script exists (straight to prod, no preview Worker)', () => {
    expect(scripts['deploy:preview']).toBeUndefined();
  });
});
