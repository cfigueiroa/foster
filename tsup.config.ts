import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { foster: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Single self-contained file so install.ps1 can fetch and SHA256-verify one artifact.
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
});
