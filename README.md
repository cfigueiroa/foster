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
is _the folder it sits in_, and which folder that is comes from the account you are signed into.
(The `lastKnownAccountUuid` in the app's config is a cached copy of that answer, not the source of
it — which is why no local edit can switch accounts.)

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

## Why a restart is needed

Claude Desktop reads its session directory **once**, while it initialises, and keeps what it found in
memory. Nothing watches the directory afterwards, so a file that appears later is invisible until the
app initialises again. Reloading the window (F5) does not help: the list it redraws comes from the
app, not from disk.

`foster` will do the restart for you — from the menu, or with `--restart`. It asks the app to close
the way clicking its close button does, so the app runs its own shutdown; it never terminates it
unless you say so. And it will not close an app it is running inside, because that would kill the
session that asked.

There is exactly one way to avoid the restart, and it only applies if your account has **more than
one organization**: switching organization makes the app re-read the directory, and switching back
reads it again. That also ends any session that is running, so it is not free.

## What about switching accounts?

`foster` cannot switch accounts, and does not try. Which account the app uses comes from the session
you are signed into — the account id in its config is only a cached copy of that answer, so writing
to it changes nothing. Doing it properly would mean handling credentials, which `foster` never
touches.

What does work is staging: send copies to the other account first (`--to`, or "Send them somewhere
else" in the menu), then sign into it. They are waiting when you arrive.

## Install

```powershell
irm https://github.com/cfigueiroa/foster/releases/latest/download/install.ps1 | iex
```

That URL always serves the installer from the newest release. The installer itself pins the tag it
was published from and verifies the downloaded bundle's SHA256 against that release's checksum before
running anything, so the integrity check is unaffected by the URL being version-independent. To pin a
specific version instead, fetch it by tag:
`https://raw.githubusercontent.com/cfigueiroa/foster/v0.5.0/install.ps1`.

When it finishes it opens the menu straight away; pass `-NoLaunch` to skip that. For development,
clone the repo and use `npm run dev -- <command>`.

## Usage

Run it with no arguments for a guided menu that stays open — pick an account,
choose sessions, review, confirm, and carry on without relaunching:

```bash
foster
```

You do not have to close Claude Desktop first. When the copies are written it
offers to restart the app so they show up.

Copies go to the account you are signed into by default. The confirmation names
the destination and the title prefix, and either can be changed from there — any
organization of any account is a valid target, though copies written outside the
account in use only appear once you switch to it.

The same operations are available as one-shot commands, for scripting:

```bash
foster doctor    # environment check: store location, app state, whether it is running
foster scan      # read-only inventory of accounts, organizations and sessions
foster list      # sessions from other accounts that are available to foster
foster label     # give an opaque account UUID a human name
foster labels    # list the names given so far
foster foster    # create the copies
foster return    # remove fostered copies, restoring the previous state
foster status    # what is currently fostered
foster app       # status | quit | start | restart — drive Claude Desktop itself
```

`foster` and `return` are dry runs unless you pass `--yes`: they print exactly what
would be written or removed and touch nothing. (`label` only records a name in
foster's own ledger, so it writes immediately.) Add `--restart` to either to
restart Claude Desktop when it finishes.

Narrow what gets fostered with `--title`, `--cwd`, `--since 30d`, `--session <id...>`,
`--from <accountUuid>` or `--from-org <organizationUuid>`, and choose where the copies land with
`--to <accountUuid>` / `--to-org <organizationUuid>`. Identifiers may be abbreviated to any unique
prefix; an ambiguous one is reported rather than guessed at.

An account can hold several organizations and the sidebar only reads one of them, so any
organization other than that one is a valid source — including another organization of the account
you are already signed into. Sessions that could never appear in the sidebar — scheduled tasks, and
sessions that were never opened — are always excluded; `list --all` shows them anyway.

`scan`, `list`, `status`, `doctor` and `app status` take `--json`.

## Safety model

- **Reads and writes are separated.** The scanner never writes. All mutation goes through a single
  engine module, and every completed operation is appended to a ledger (`~/.foster/ledger.jsonl`) so
  it can be replayed in reverse. The write comes first and only a finished write is recorded: a
  ledger entry for a write that failed would mark the session as fostered for ever, with no file to
  show for it.
- **The originals are never modified.** Fostering only ever _adds_ a file to the current account's
  folder. There is no move, and no rewrite of anything under the old account.
- **Adding is safe while the app runs; removing is the case that is not.** Every copy carries a
  session id the app has never seen, so a running app neither reads that file (it is past its one
  read) nor writes it (it only writes sessions it holds) — it is simply invisible until the app
  starts again. A copy the app _did_ load is different: it may be written back at any time, which
  would recreate a file `foster` had just deleted. So `return` refuses for copies that already
  existed when the app started, and offers to close it for you.
- **It never terminates the app behind your back.** Quitting asks the app to close, the way its own
  close button does, so it can flush pending writes and warn you about work in progress. Forcing is
  a separate, explicit answer. And `foster` refuses outright to close an app it is running inside.
- **It never reads credentials.** `foster` does not open, parse, copy or log credential files, cookie
  stores or OAuth token caches. It only touches session metadata. This is also why it cannot switch
  accounts.
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
npm run version:set 0.5.0
git commit -am "chore: release 0.5.0" && git tag -a v0.5.0 -m "foster v0.5.0"
git push && git push origin v0.5.0
```

Pushing the tag runs the release workflow, which refuses to publish unless the three versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with both assets. Run the
workflow manually from the Actions tab to exercise all of that without publishing anything.

## License

MIT — see [LICENSE](LICENSE).
