import { useTranscriptRoots } from '../src/engine/lineage.js';

// Unit tests never walk the real Claude install. Tests that ask about branches
// pass their own tree to lineageAt / projectsDirs.
useTranscriptRoots([]);
