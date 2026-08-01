import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { foster: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  platform: 'node',
  // Single self-contained file so install.ps1 can fetch and SHA256-verify one artifact.
  noExternal: [/.*/],
  banner: {
    // Bundled CommonJS dependencies still call require() for Node builtins, which
    // does not exist in an ESM output — createRequire gives them a working one.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __nodeCreateRequire } from 'node:module';",
      'const require = __nodeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
