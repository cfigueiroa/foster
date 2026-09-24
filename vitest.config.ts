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
      // included), rounded down to one decimal so a platform-neutral rerun
      // cannot flake below it. Raise it when coverage genuinely improves;
      // never lower it to make a drop pass.
      thresholds: {
        statements: 66.6,
        branches: 60.4,
        functions: 71.5,
        lines: 67.8,
      },
    },
  },
});
