import { describe, expect, it } from 'vitest';
import config from '../tsup.config.js';

/**
 * The banner sets up what Node's ESM output needs from the bundle's very
 * first line: a working `require` for bundled CommonJS dependencies (they
 * still call the CommonJS builtin, which does not exist in an ESM output).
 *
 * Deliberately no `module.enableCompileCache()` here — see tsup.config.ts:
 * measured to make no difference to an ordinary invocation, since it can
 * only cache modules loaded *after* the call, not the single bundled script
 * it would be running inside.
 */
describe('tsup banner', () => {
  const options = Array.isArray(config) || typeof config === 'function' ? undefined : config;
  const banner = options?.banner;
  const js = typeof banner === 'object' ? (banner?.js ?? '') : '';

  it('sets up createRequire for bundled CommonJS dependencies', () => {
    expect(js).toMatch(/createRequire/);
  });

  it("does not call enableCompileCache, which cannot cache the bundle's own compilation", () => {
    expect(js).not.toMatch(/enableCompileCache/);
  });
});
