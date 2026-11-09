/**
 * Unit tests: package.json script shapes (AC-CACHE-19, MON-AC68, ENG-AC7).
 *
 * F2.0 cache-infra: `cf:build` and `deploy` scripts must match the required
 * shape so the Worker build runs the secret guard and deploys to prod only
 * (no deploy:preview script — straight to prod).
 * monitor-web-area: the e2e-project integration script (MON-AC68).
 * monitor-engine: the cron Worker's dry-run build and deploy scripts, `deploy`
 * deploying the cron Worker after the web Worker, the use-intl dependency (ENG-AC7).
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
  it('AC-CACHE-19: cf:build starts with SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1 (via cross-env)', () => {
    expect(scripts['cf:build']).toBeDefined();
    // `cross-env` sets the variable on Windows too (commit 5f9742e); the bare
    // POSIX `VAR=1 cmd` form stays accepted.
    expect(scripts['cf:build']).toMatch(/^(?:cross-env )?SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1 /);
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

describe('package.json scripts (MON-AC68)', () => {
  it('MON-AC68: test:integration:e2e-project script exists and runs the e2e-project script', () => {
    expect(scripts['test:integration:e2e-project']).toBeDefined();
    expect(scripts['test:integration:e2e-project']).toContain('scripts/vitest-e2e-project.mjs');
  });
});

describe('package.json scripts (ENG-AC7)', () => {
  it('ENG-AC7pkg1: build:monitor-cron is a wrangler dry-run build of the cron config', () => {
    expect(scripts['build:monitor-cron']).toBe(
      'wrangler deploy --dry-run --config workers/monitor-cron/wrangler.jsonc --outdir .wrangler/monitor-cron',
    );
  });

  it('ENG-AC7pkg2: deploy:monitor-cron deploys the cron config', () => {
    expect(scripts['deploy:monitor-cron']).toBe('wrangler deploy --config workers/monitor-cron/wrangler.jsonc');
  });

  it('ENG-AC7pkg3: deploy builds, deploys the web Worker, then deploy:monitor-cron', () => {
    expect(scripts['deploy']).toBe('npm run cf:build && opennextjs-cloudflare deploy && npm run deploy:monitor-cron');
  });

  it('ENG-AC7pkg4: package.json has use-intl dependency', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['use-intl']).toBeDefined();
  });
});
