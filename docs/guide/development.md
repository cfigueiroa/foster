# Development and releasing

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run against **synthetic** store fixtures created in a temporary directory. They never read or
write a real Claude Desktop installation. `npm run check` (and CI's `privacy-guard` job, which runs
the same `scripts/privacy.mjs` rather than a second copy of its patterns) fails the build if
realistic account identifiers or personal filesystem paths appear anywhere `git add -A` would pick
up — tracked, staged, or merely untracked-but-not-`.gitignore`d (issue #134: a plain `git grep` sees
only tracked files, so a fixture written but not yet `git add`-ed used to pass locally and only fail
once CI saw it tracked, after the push).

CI (`.github/workflows/ci.yml`) runs the checks above on Node 22 and 24, on Ubuntu and Windows — not
20, which vitest 5 (picked up to clear three high-severity dependency advisories) refuses to start
under at all; `package.json`'s own `"engines": ">=20"` is unaffected, since that floor describes the
built CLI, which carries no vitest dependency, not the dev toolchain. The `check` job runs `npm run
coverage`, not a plain `npm test`, since the coverage floor below is only ever collected and enforced
under `--coverage`; `npm run check` (`package.json`) calls the same script, so a local run fails the
same way CI would. Three more CI jobs: a build + bundle smoke test (single self-contained file,
starts quietly, `--version` matches) that used to run only on a tag in `release.yml` and now runs on
every PR and push too, from the same `scripts/smoke-bundle.sh` both workflows call — on Node 20 as
well as 24, since this job never touches vitest and Node 20 is the floor the shipped bundle actually
promises; `npm audit --omit=dev --audit-level=high`, scoped to the two runtime dependencies
(`commander`, `picocolors`) since the dev toolchain's own advisories never reach anything foster
installs or executes; and the coverage floor itself.

`npm run coverage` measures `src/**/*.ts` including `src/cli/**` (excluding it made the number
optimistic — 88% became 66.6% once the CLI entrypoints were counted), and `vitest.config.ts` sets a
coverage floor with margin below the real level — measured coverage here is genuinely
environment-dependent, not just noisy: several code paths branch on what actually exists under the
home directory and on OS, and GitHub Actions' `ubuntu-latest` reads a few tenths of a point lower
across the board than a developer's own Windows machine or `windows-latest`. The floor sits under
the real low point of that range (`ubuntu-latest`), not under whichever environment was measured
most recently: a genuine drop still fails CI, an improvement is free to raise it, and the floor is
never lowered just to make a drop pass.

### Releasing

The version lives in four files — `package.json`, `package-lock.json` (which restates it twice, and
which `npm install` alone would leave reporting a version the release never had), `src/version.ts`
(stamped into every copy foster writes) and `install.ps1` (which pins the release it downloads).
`npm run version:set X.Y.Z` (`scripts/version.mjs`) bumps all four together, then tag:

```bash
npm run version:set 0.11.1
git commit -am "chore: release 0.11.1" && git tag -a v0.11.1 -m "foster v0.11.1"
git push && git push origin v0.11.1
```

Pushing the tag runs the release workflow, which refuses to publish unless the four versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with both assets. Run the
workflow manually from the Actions tab to exercise all of that without publishing anything.
