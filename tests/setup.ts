import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTranscriptRoots } from '../src/engine/lineage.js';
import { useProcessTable } from '../src/util/processes.js';

// Everything under src/store/configDirs.ts (configDirCandidates, inUseConfigDir,
// and the rest of what `clients`/`sweep` walk) defaults its `home` parameter to
// `os.homedir()`, which — unset — is this machine's real profile: measured on
// this store, 13 GB under ~/.claude* that a unit test has no business scanning.
// Pointed at a fresh, empty directory before any of that code has a chance to
// read the real one, every default-`home` call lands somewhere both isolated
// and fast instead. `os.homedir()` on win32 reads USERPROFILE (and HOME
// elsewhere), and every caller resolves it lazily — a default parameter
// evaluated per call, not cached at import time — so setting both here, before
// any test file's own imports run, is enough to redirect all of them. Measured
// 24/09/2026: the suite went from 30 s to 7 s for the same 1,631 green tests,
// and tests/interactive.test.ts alone from 22 s to 0.8 s. A test that needs a
// specific `home` still passes its own, same as before.
const FAKE_HOME = mkdtempSync(path.join(tmpdir(), 'foster-test-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// Unit tests never walk the real Claude install. Tests that ask about branches
// pass their own tree to lineageAt / projectsDirs.
useTranscriptRoots([]);

// Nor do they read the real process table: the session registry checks a pid
// against what is running, and letting that reach the machine would spawn
// PowerShell per test file and make the answers depend on whoever is logged in.
// An empty table means "could not be read", which every caller treats as no
// evidence either way. Tests about identity pass their own rows.
useProcessTable([]);
