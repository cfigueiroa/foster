# foster

Bring your **Claude Code sessions from a previous local account** back into the sidebar of the
account you are signed into now — **without moving or modifying the originals**.

If you switched Claude Desktop accounts and your old sessions vanished from the sidebar, they are
almost certainly still on your disk. `foster` finds them and exposes them under your current account,
reversibly.

> **Status:** early. Windows-only for now (that is where Claude Desktop ships as an MSIX package).
> Read [Safety model](#safety-model) before running anything that writes.

## Why the sessions disappear

Claude Desktop stores each Code session as a small JSON file, in a directory tree keyed by account
and organization:

```
<userData>/claude-code-sessions/<accountUuid>/<organizationUuid>/local_<sessionId>.json
```

There is **no account field inside the session file**. The only thing binding a session to an account
is _the folder it sits in_. The app decides which folder to read from a single value in its config
(`lastKnownAccountUuid`).

So when you sign in with a different account, the app reads a different folder — and everything you
did under the old account becomes invisible, while remaining perfectly intact on disk.

The conversation transcript is not in that JSON at all. It lives outside the account tree, under
`~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl`, and is **account-agnostic**. That is why a
session can be re-attributed locally: only a pointer has to move, not the content.

## What `foster` does

For each session you select, it writes a **copy** of the session JSON into your current account's
folder, with:

- a **fresh `sessionId`**, so the copy is a distinct object the server has never seen (deleting it
  can never reach the original);
- the **same `cliSessionId`**, so it opens the real transcript;
- `error` / `errorAt` **stripped**, so a stale failure from the old account does not show up as a
  warning badge on the restored session;
- a configurable **title prefix** (default `↪ `) marking it as fostered;
- a `_foster` key recording where it came from, so the copy is self-describing.

The original file is never touched. `foster return` deletes the copy and the session is simply gone
from the current account again.

Changes appear **after you restart Claude Desktop** — the sidebar is populated at load time and does
not watch the directory.

## Install

```powershell
irm https://github.com/cfigueiroa/foster/releases/latest/download/install.ps1 | iex
```

That URL always serves the installer from the newest release. The installer itself pins the tag it
was published from and verifies the downloaded bundle's SHA256 against that release's checksum before
running anything, so the integrity check is unaffected by the URL being version-independent. To pin a
specific version instead, fetch it by tag:
`https://raw.githubusercontent.com/cfigueiroa/foster/v0.4.2/install.ps1`.

When it finishes it opens the menu straight away; pass `-NoLaunch` to skip that. For development,
clone the repo and use `npm run dev -- <command>`.

## Usage

Run it with no arguments for a guided menu that stays open — pick an account,
narrow the batch, review, confirm, and carry on without relaunching:

```bash
foster
```

If Claude Desktop is open when you confirm, it waits for you to quit it instead
of failing, and picks up where you left off.

Copies go to the account you are signed into by default. The confirmation names
the destination, and offers to send them anywhere else — any organization of any
account is a valid target, though copies written outside the account in use only
appear once you switch to it.

The same operations are available as one-shot commands, for scripting:

```bash
foster doctor    # environment check: store location, app state, whether it is running
foster scan      # read-only discovery of accounts, organizations and sessions
foster list      # sessions from other accounts that are available to foster
foster label     # give the opaque account UUIDs human names
foster foster    # create the copies
foster return    # remove fostered copies, restoring the previous state
foster status    # what is currently fostered
```

`foster` and `return` are dry runs unless you pass `--yes`: they print exactly what
would be written or removed and touch nothing. (`label` only records a name in
foster's own ledger, so it writes immediately.)

Narrow what gets fostered with `--title`, `--cwd`, `--since 30d`, `--from <accountUuid>` or
`--from-org <organizationUuid>`. An account can hold several organizations and the sidebar only
reads one of them, so any organization other than that one is a valid source — including another
organization of the account you are already signed into.
Sessions that could never appear in the sidebar — scheduled tasks, and sessions that
were never opened — are always excluded; `list --all` shows them anyway.

## Safety model

- **Reads and writes are separated.** The scanner never writes. All mutation goes through a single
  engine module, and every operation is appended to a ledger (`~/.foster/ledger.jsonl`) before it
  happens, so it can be replayed in reverse.
- **The originals are never modified.** Fostering only ever _adds_ a file to the current account's
  folder. There is no move, and no rewrite of anything under the old account.
- **It refuses to run while Claude Desktop is open.** The app rewrites session files at runtime, so
  writing underneath it risks a lost update. `foster` detects a running app and stops.
- **It never reads credentials.** `foster` does not open, parse, copy or log credential files, cookie
  stores or OAuth token caches. It only touches session metadata.
- **Scheduled-task sessions are treated separately.** Sessions carrying a `scheduledTaskId` are not
  listed in the sidebar's recents and are excluded from ordinary fostering.
- **One request, and only about versions.** Because the install URL pins a tag, an install would
  never learn about later releases on its own. So `foster` asks GitHub for the latest release tag,
  at most once a day, and tells you when you are behind. It sends nothing beyond the request itself,
  gives up after 2.5s, and stays silent if it fails — being offline never slows anything down.
  Set `FOSTER_NO_UPDATE_CHECK=1` to turn it off.

### What is not supported

**Cowork sessions cannot be fostered.** Their sandboxes live on disk under
`local-agent-mode-sessions/`, but the list you see in the app is not built from those folders — it
comes from the server. Linking or copying a sandbox does not make an old Cowork session reappear.
`foster` deliberately does not pretend otherwise. This is a Code-session tool.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run against **synthetic** store fixtures created in a temporary directory. They never read or
write a real Claude Desktop installation. CI additionally runs a privacy guard that fails the build
if realistic account identifiers or personal filesystem paths appear in tracked files.

### Releasing

The version lives in three files — `package.json`, `src/version.ts` (stamped into every copy foster
writes) and `install.ps1` (which pins the release it downloads). Bump them together, then tag:

```bash
npm run version:set 0.4.2
git commit -am "chore: release 0.4.2" && git tag -a v0.4.2 -m "foster v0.4.2"
git push && git push origin v0.4.2
```

Pushing the tag runs the release workflow, which refuses to publish unless the three versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with both assets. Run the
workflow manually from the Actions tab to exercise all of that without publishing anything.

## License

MIT — see [LICENSE](LICENSE).
