import { useTranscriptRoots } from '../src/engine/lineage.js';
import { useProcessTable } from '../src/util/processes.js';

// Unit tests never walk the real Claude install. Tests that ask about branches
// pass their own tree to lineageAt / projectsDirs.
useTranscriptRoots([]);

// Nor do they read the real process table: the session registry checks a pid
// against what is running, and letting that reach the machine would spawn
// PowerShell per test file and make the answers depend on whoever is logged in.
// An empty table means "could not be read", which every caller treats as no
// evidence either way. Tests about identity pass their own rows.
useProcessTable([]);
