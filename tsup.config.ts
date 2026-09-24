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
    //
    // module.enableCompileCache persists V8's compiled bytecode for this file to
    // disk (a default OS temp/cache location) and reuses it on the next launch —
    // real gain for a CLI invoked over and over in a single short-lived process
    // each time, which is exactly foster's shape. A namespace import rather than
    // `import { enableCompileCache }`: the named form is a static binding, and on
    // a Node below the version that added the function it would fail the whole
    // module at load with "does not provide an export named", not just no-op.
    // The namespace object always exists; the optional call on it is what
    // actually guards Node 20's minimum-supported minor versions, several of
    // which predate this API.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __nodeCreateRequire } from 'node:module';",
      'const require = __nodeCreateRequire(import.meta.url);',
      "import * as __nodeModule from 'node:module';",
      '__nodeModule.enableCompileCache?.();',
    ].join('\n'),
  },
});
