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
    // No `module.enableCompileCache()` here: measured (built bundle, `foster
    // --version` timed over multiple 20-run trials, with a warmed persistent
    // NODE_COMPILE_CACHE dir to mirror real repeated-launch conditions) to make
    // no difference to ordinary invocations. `enableCompileCache()` only caches
    // compilation of modules loaded *after* the call — it cannot cache the very
    // script it runs inside, which V8 has already fully parsed and compiled by
    // the time any of that script's own top-level statements execute. Since
    // this bundle is a single self-contained file (see `noExternal` above), the
    // only thing calling it here could ever help is `src/agent/sdk.ts`'s own
    // `import()` of the Agent SDK and zod — the one place this codebase
    // dynamically imports anything at all, and not on the hot path of an
    // ordinary command (doctor/stores/clients/sweep/...).
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __nodeCreateRequire } from 'node:module';",
      'const require = __nodeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
