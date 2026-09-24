import { describe, expect, it } from 'vitest';
import config from '../tsup.config.js';

/**
 * The banner sets up two things Node's ESM output needs from the bundle's
 * very first line: a working `require` for bundled CommonJS dependencies, and
 * (see tsup.config.ts) `module.enableCompileCache`, which persists this
 * file's compiled bytecode across runs — a real saving for a CLI that is a
 * short-lived process invoked over and over. Guarded with a namespace import
 * and optional chaining rather than a named import, because a named import of
 * a function a Node minor version does not yet export fails the whole module
 * at load — not just a no-op — which would turn a startup optimisation into
 * an outage on an older Node 20.
 */
describe('tsup banner', () => {
  const options = Array.isArray(config) || typeof config === 'function' ? undefined : config;
  const banner = options?.banner;
  const js = typeof banner === 'object' ? (banner?.js ?? '') : '';

  it('enables the compile cache, guarded so a Node without it does not crash', () => {
    expect(js).toMatch(/__nodeModule\.enableCompileCache\?\.\(\)/);
  });

  it('never imports enableCompileCache by name, which would fail to load on an older Node', () => {
    expect(js).not.toMatch(/import\s*\{[^}]*enableCompileCache/);
  });

  it('still sets up createRequire for bundled CommonJS dependencies', () => {
    expect(js).toMatch(/createRequire/);
  });
});
