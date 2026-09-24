import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Tests build synthetic stores in temp dirs; they must never touch a real Claude install.
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // A floor, not a target: today's real coverage (2026-09-24, src/cli
      // included). Measured 66.6% statements / 60.5% branches / 71.5%
      // functions / 67.8% lines under a normal, populated $HOME, and a
      // *different* 66.59% / 60.46% / 71.51% / 67.84% under an empty one
      // (mktemp'd HOME + USERPROFILE) — several src/store and src/engine
      // code paths branch on what actually exists under the real home
      // directory, so the percentage itself is environment-dependent, not
      // just noisy at the last decimal the way a single flaky test would
      // be. Each number below sits under the lower of those two
      // measurements, with headroom for a third environment neither
      // matches (the GitHub Actions runner's own $HOME): raise a
      // threshold when coverage genuinely improves by more than this
      // margin; never lower one to let a real drop pass.
      thresholds: {
        statements: 66.3,
        branches: 60.2,
        functions: 71.3,
        lines: 67.6,
      },
    },
  },
});
