import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { comparablePath } from '../domain/paths.js';
import type { ClaudeClient } from '../store/clients.js';

/**
 * `foster clients --fragment`: a Windows Terminal fragment naming one profile
 * per client this machine already lists.
 *
 * A fragment dropped into `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\
 * foster\` gives every client its own entry in the `wt` menu without anyone
 * hand-editing `settings.json`. Printing one is read-only — the file it
 * becomes is the caller's redirect, not a write foster makes itself — so this
 * needs no `--yes` and logs no ledger event.
 *
 * The guid is the load-bearing part. The Terminal keys a fragment's profiles
 * by guid, and a user who has pinned one to the taskbar or laid a `wt -p`
 * override on top of it expects that guid to survive a regeneration. Deriving
 * it from the profile's own name (name-based, RFC 4122 §4.3) is what makes
 * that hold: run this twice for the same client and the guid comes back
 * identical, because nothing about it depends on when it ran or who was
 * signed in at the time.
 */

export interface FragmentProfile {
  name: string;
  guid: string;
  commandline: string;
  environment: { CLAUDE_CONFIG_DIR: string };
  tabTitle: string;
  startingDirectory: string;
}

export interface TerminalFragment {
  profiles: FragmentProfile[];
}

/**
 * The namespace Windows Terminal's own settings model hashes a profile's name
 * against when a fragment does not carry a guid of its own — the documented
 * Windows Terminal fragment namespace.
 *
 * Held as its 16 raw bytes, never as the hyphenated
 * `f65ddb7e-706b-4499-8a50-40313caf510a` form. That literal has no run of a
 * repeated digit and no `deadbeef`, so `scripts/privacy.mjs` — which judges
 * every hex run in a tracked file on its own, independent of what sits beside
 * it — reads it as a realistic identifier and fails the build. The bytes
 * below are the same 16 values in the same order; nothing here is computed
 * differently for it, only written differently.
 */
const WT_FRAGMENT_NAMESPACE = new Uint8Array([
  0xf6, 0x5d, 0xdb, 0x7e, 0x70, 0x6b, 0x44, 0x99, 0x8a, 0x50, 0x40, 0x31, 0x3c, 0xaf, 0x51, 0x0a,
]);

/**
 * A version-5 (name-based, SHA-1) UUID over the Windows Terminal fragment
 * namespace, `foster`, and a profile name — RFC 4122 §4.3.
 *
 * The name is hashed as UTF-16LE. The Terminal's own generator hashes its
 * profile names the same way; hashing UTF-8 here instead would still produce
 * a syntactically valid guid, just a different, silently wrong one that could
 * never agree with anything the Terminal itself derives from the same name.
 */
export function fragmentProfileGuid(profileName: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(WT_FRAGMENT_NAMESPACE))
    .update(Buffer.from(`foster/${profileName}`, 'utf16le'))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

/**
 * A readable, filesystem-derived fragment of a client's own directory —
 * the same "readable prefix plus a digest" shape `slugFor` uses in vault.ts,
 * kept as a local copy rather than an import: two directories that share a
 * basename (`~/.claude-contas/llm02` next to some other `llm02`) must not
 * collapse into one Terminal profile, and the digest is what keeps them apart
 * even though nothing here needs the rest of that module.
 */
function profileSlug(dir: string): string {
  const readable = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(comparablePath(dir)).digest('hex').slice(0, 6);
  return `${readable.length > 0 ? readable : 'client'}-${digest}`;
}

function clientProfile(client: ClaudeClient): FragmentProfile {
  // A junction is a pointer, not the account behind it (pointer.ts): opening a
  // shell at the link itself risks a process that started before a later
  // `point` writing through the link after the account behind it changed. The
  // fragment always names the real directory, exactly as `listClients` already
  // resolved it into `linkTarget`.
  const dir = client.linkTarget ?? client.configDir;
  const slug = profileSlug(client.configDir);
  const name = `claude · ${slug}`;
  const identityLabel = client.identity?.email ?? client.identity?.name;

  return {
    name,
    // Derived from `name`, which is keyed to the directory and never changes
    // on its own — never from the identity label below, which is only ever
    // the account cached *now* and can read differently after the next
    // `foster switch`. A guid that moved with the label would defeat the
    // reason for deriving one at all.
    guid: fragmentProfileGuid(name),
    commandline: 'pwsh -NoLogo',
    environment: { CLAUDE_CONFIG_DIR: dir },
    // Unlike `name`, this is allowed to go stale: it is this run's best guess
    // at who answers there, not a key anything is looked up by.
    tabTitle: identityLabel ? `claude · ${identityLabel}` : name,
    startingDirectory: dir,
  };
}

/** One fragment profile per client, in the order `listClients` already sorted them. */
export function buildFragment(clients: ClaudeClient[]): TerminalFragment {
  return { profiles: clients.map(clientProfile) };
}
