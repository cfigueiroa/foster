#!/usr/bin/env bash
# Smoke-tests dist/foster.js after `npm run build`: single self-contained file,
# --version matches package.json, --help works, and nothing reaches stderr on
# startup.
#
# Used to live only in release.yml, exercised on a tag push. That left a
# packaging mistake — a stray shebang, an unshimmed require — invisible until
# a release was already being cut. Shared by ci.yml (every PR and push) and
# release.yml (every tag) now, so the same script cannot drift between the two
# call sites the way two copies of the same bash block did.
#
#   scripts/smoke-bundle.sh
set -euo pipefail

# The release ships and checksums exactly one file, so the build must produce
# exactly one. A dynamic import is enough to make the bundler split out a
# chunk, which would be left behind at publish time and only fail once a user
# reached the code path that loads it.
count="$(find dist -name '*.js' | wc -l)"
if [ "$count" -ne 1 ]; then
  echo "::error::build produced $count JS files, expected a single self-contained bundle:"
  find dist -name '*.js'
  exit 1
fi

expected="$(node -p "require('./package.json').version")"
actual="$(node dist/foster.js --version)"
[ "$actual" = "$expected" ] || { echo "::error::bundle reports $actual, expected $expected"; exit 1; }
node dist/foster.js --help > /dev/null

# Run it from a directory holding nothing but the bundle and the package.json
# install.ps1 writes beside it, which is what an install looks like: an
# unresolvable relative import fails here. The directory sits under a
# package.json that declares no type — the ordinary state of a Windows home
# directory, and what Node finds instead when the install does not declare its
# own.
root="$(mktemp -d)"
echo '{ "name": "not-foster" }' > "$root/package.json"
isolated="$root/install"
mkdir "$isolated"
cp dist/foster.js "$isolated/"
echo '{ "type": "module" }' > "$isolated/package.json"

# Nothing may reach stderr ahead of the output that was asked for. A startup
# warning is not cosmetic here: it prefixes every command, including the ones
# whose output gets piped somewhere.
noise="$(cd "$isolated" && FOSTER_NO_UPDATE_CHECK=1 node foster.js --version 2>&1 >/dev/null)"
if [ -n "$noise" ]; then
  echo "::error::the bundle wrote to stderr on startup:"
  echo "$noise"
  exit 1
fi
echo "bundle is self-contained, starts quietly, and reports $actual"
