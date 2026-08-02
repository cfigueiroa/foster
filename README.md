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

## Undoing a deletion

Deleting a session in the app removes the pointer and **keeps the conversation**. The transcript
stays under `~/.claude/projects`, and the app records the deletion by writing a `deleted_<id>` marker
next to the sessions — one per identifier the session carried, each holding only the time.

Those markers exist to stop the app's own recovery scan from offering back something you threw away
on purpose. They do not stop a session file that points at that conversation from being written and
loaded. So for an accidental deletion, writing a fresh pointer is the only route left, and it is the
one `foster restore` takes:

```bash
foster restore          # what could come back, writing nothing
foster restore --yes    # bring them back
```

Title, working directory and dates are read out of the transcript itself, so the restored session
arrives named and dated rather than blank. What cannot come back is what was never in the
conversation: the model it ran, its permission mode, and any MCP or worktree configuration. The
marker is left exactly where it is — it is the app's record, not `foster`'s to erase — and the
restored session is an ordinary copy, so `foster return` undoes it like any other.

A conversation that some session still points at is not offered: it is not lost, and restoring it
would only produce a duplicate.

## Why a restart is needed

Claude Desktop reads its session directory **once**, while it initialises, and keeps what it found in
memory. Nothing watches the directory afterwards, so a file that appears later is invisible until the
app initialises again. Reloading the window (F5) does not help: the list it redraws comes from the
app, not from disk.

`foster` will do the restart for you — from the menu, or with `--restart`. It will not close an app
it is running inside, because that would kill the session that asked.

Closing it is less polite than it should be, and `foster` says so rather than pretending otherwise.
Claude Desktop's window-close handler quits the app **only when its tray icon is turned off**; with
the tray on — the default — it cancels the close and hides the window. So asking politely would make
your window vanish and leave the process running. `foster` does not send that request at all: it
tells you the situation and asks for an explicit yes to end the process. Session files survive
either way (they are written through a temporary and renamed), but ending the process skips the
app's own shutdown, so a title or timestamp changed in the last few seconds may not be saved and
Cowork sandboxes are not stopped cleanly. Quitting from the tray icon yourself avoids all of that.

If your account has **more than one organization**, switching organization and switching back also
makes the app re-read the directory, with no restart. It ends any session that is running, so it is
not free either.

### The app's own import, and why `foster` does not use it

Claude Desktop registers a deep link, `claude://resume?session=<cliSessionId>`, which imports a CLI
transcript into the current account **live** — no restart, appears immediately. It looks like the
perfect answer and it is not, for two reasons:

- **It rewrites the transcript it imports.** The import strips thinking blocks from the `.jsonl` in
  place — the same file the original session points at. `foster` promises not to modify anything
  that already exists, and calling this would break that promise on the one file that actually holds
  your conversation.
- **It only carries the working directory.** Title, model, timestamps and the rest are not read from
  the old session; the imported session gets today's dates and a default configuration.

It is a good way to pull _one_ session back by hand, and it is worth knowing about. It is not a way
to move three hundred.

Relatedly: the app has a built-in recovery scan that offers importable transcripts, and it will
never offer these ones. Before scanning it collects every `cliSessionId` referenced by every account
and organization on disk and treats those as already known — so a session that still exists under
your old account is excluded by the very fact that it still exists.

## What about switching accounts?

`foster` cannot switch accounts, and nothing else on your disk can either. This is worth stating
precisely, because it is the first thing people try.

Inside one installation the account is not stored anywhere. The app keeps it in memory only —
deliberately non-persistent, and cleared whenever its web view navigates — and just three things ever
set it: an IPC call the app's own signed-in page makes, the app noticing that page navigate to
`/logout`, and a backfill that asks the server who you are using the cookies you already have. The
`lastKnownAccountUuid` in the config is a leftover of that answer, not the source of it; nothing reads
it to decide anything. So there is no file to edit and no flag to pass. Deep links, command-line
arguments, environment variables, config files and group policy were each checked, and none of them
selects an account.

**The one real mechanism is a second profile.** `CLAUDE_USER_DATA_DIR` is read at the app's entry
point, before anything else, and becomes its `userData` outright — separate cookie jar, separate
account, separate instance lock. That is how you hold two accounts at once, and each one needs its
own sign-in. `foster` looks there first when that variable is set, so it operates on the profile the
app would be using rather than the default one. Two caveats worth knowing before relying on it: the
`claude://` protocol is registered to the installed package, so magic links, SSO callbacks and
`claude://resume` always land on the default instance whatever profile you meant them for; and
`foster` cannot start a profile for you, because only whatever launched it knows how.

If you are simply moving between accounts on one profile, staging still works and is the shortest
path: send copies to the other account first (`--to`, or "Send them somewhere else" in the menu),
then sign into it. They are waiting when you arrive.

## Install

```powershell
irm https://github.com/cfigueiroa/foster/releases/latest/download/install.ps1 | iex
```

That URL always serves the installer from the newest release. The installer itself pins the tag it
was published from and verifies the downloaded bundle's SHA256 against that release's checksum before
running anything, so the integrity check is unaffected by the URL being version-independent. To pin a
specific version instead, fetch it by tag:
`https://raw.githubusercontent.com/cfigueiroa/foster/v0.6.1/install.ps1`.

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
foster restore   # bring back sessions deleted in the app
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
you are already signed into. Sessions that could never appear in the sidebar are always excluded —
scheduled tasks, sessions that were never opened, and sessions whose file is over the 10 MB the app
refuses to load. `list --all` shows them anyway.

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
- **It never ends the app behind your back.** Where a polite close would work (tray off) it uses one;
  where it would not, it says so and waits for an explicit yes rather than quietly escalating, and it
  names what that costs. `foster` refuses outright to close an app it is running inside — detected
  both from the process tree and from the environment the app stamps on the sessions it spawns,
  because an exited intermediate can break the first signal and the failure mode is killing the
  caller mid-write.
- **It never reads credentials.** `foster` does not open, parse, copy or log credential files, cookie
  stores or OAuth token caches. It only touches session metadata. This is also why it cannot switch
  accounts.
- **A copy shares one thing with its original: the conversation.** That is the point — it is what
  makes the copy open the real thing rather than an empty session — but it means the file is not
  private to either of them. `foster` only ever reads it. The app does write to it: renaming a
  session syncs the new title into the transcript, and its own import rewrites the file in place. So
  renaming a copy is not confined to the copy. Nothing is lost by it; it is simply not the isolation
  the word "copy" suggests, and you should know which part is shared.
- **Scheduled-task sessions are treated separately.** Sessions carrying a `scheduledTaskId` are not
  listed in the sidebar's recents and are excluded from ordinary fostering.
- **One request, and only about versions.** Because the install URL pins a tag, an install would
  never learn about later releases on its own. So `foster` asks GitHub for the latest release tag,
  at most once a day, and tells you when you are behind. It sends nothing beyond the request itself,
  gives up after 2.5s, and stays silent if it fails — being offline never slows anything down.
  Set `FOSTER_NO_UPDATE_CHECK=1` to turn it off.

### What is not supported

**Cowork sessions are not supported — but not for the reason this file used to give.** Earlier
versions said the Cowork list came from the server and so could never be restored locally. That was
wrong: `local-agent-mode-sessions/<accountUuid>/<organizationUuid>/local_<id>.json` is the
authoritative store, and the app builds the list by reading those folders, exactly as it does for
Code sessions.

So the mechanism probably transfers. It is not supported because it has not been established that it
_works_, and there are specific reasons to check rather than assume: a Cowork session owns a sandbox
whose state a copy does not carry, and the app picks between full and shortened directory names for
that tree, so writing into the wrong one would produce a copy it never reads. Until someone verifies
it end to end, this remains a Code-session tool — which is a different statement from the one that
was here before, and an honest one.

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
npm run version:set 0.6.1
git commit -am "chore: release 0.6.1" && git tag -a v0.6.1 -m "foster v0.6.1"
git push && git push origin v0.6.1
```

Pushing the tag runs the release workflow, which refuses to publish unless the three versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with both assets. Run the
workflow manually from the Actions tab to exercise all of that without publishing anything.

## License

MIT — see [LICENSE](LICENSE).
