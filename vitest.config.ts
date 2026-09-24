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
      // A floor, not a target — but coverage here is genuinely
      // environment-dependent (several src/store and src/engine paths branch
      // on what actually exists under the home directory and on OS), so this
      // isn't one number pinned to one run. Measured 2026-09-24, all real:
      //   - a normal, populated Windows $HOME:                66.60 / 60.52 / 71.51 / 67.82
      //   - an empty, mktemp'd Windows $HOME + %USERPROFILE%: 66.59 / 60.46 / 71.51 / 67.84
      //   - GitHub Actions windows-latest (node 22 and 24):   66.49 / 60.35 / 71.46 / 67.78
      //   - GitHub Actions ubuntu-latest (node 22 and 24):    66.31 / 60.16 / 71.23 / 67.61
      // (statements / branches / functions / lines, in each case). ubuntu-latest is the
      // real low point — a first pass at this floor pinned to the Windows numbers above
      // and failed both ubuntu-latest cells in CI on the first push. Each threshold below
      // sits with margin under the ubuntu-latest figure, not under whichever environment
      // happened to be measured last: raise a threshold when coverage genuinely improves
      // by more than that margin; never lower one to let a real drop pass.
      thresholds: {
        statements: 66.0,
        branches: 59.8,
        functions: 71.0,
        lines: 67.3,
      },
    },
  },
});
