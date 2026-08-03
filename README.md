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
on purpose. They stop the _scan_ only: a `claude://resume` link imports a tombstoned conversation
without complaint, and nothing stops a session file that points at one from being written and
loaded. So for an accidental deletion, writing a fresh pointer is the route left, and it is the one
`foster restore` takes:

```bash
foster restore          # what could come back, writing nothing
foster restore --yes    # bring them back
```

Title, working directory and dates are read out of the transcript itself, so the restored session
arrives named and dated rather than blank — and it sorts into its real place in Recents instead of
jumping to the top with today's date. Recovering the working directory does more than label it: the
session opens with its repository and branch bound again, reading the diff and offering to open a
pull request. It comes back resumable, not merely readable.

What cannot come back is what was never in the conversation: the model it ran, its permission mode,
and any MCP configuration. The marker is left exactly where it is — it is the app's record, not
`foster`'s to erase — and the restored session is an ordinary copy, so `foster return` undoes it
like any other.

A conversation that some session still points at is not offered: it is not lost, and restoring it
would only produce a duplicate.

Conversations are looked for in every Claude config directory that has them, not just the one this
process happens to be running under. Running a second Claude Code account means pointing the CLI at
its own `CLAUDE_CONFIG_DIR`, and each of those keeps a separate `projects/` tree — searching only one
would produce a shorter list that looks complete. Siblings of `~/.claude` are picked up when they
actually contain transcripts, and `--config-dir <path...>` adds any that live elsewhere.

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
perfect answer. Running it once on a real conversation is what settles it:

- **It deletes part of the conversation.** The import rewrites the `.jsonl` in place to strip
  reasoning. Measured on a 58,678-byte transcript: 22 records became 19, three assistant records
  containing only reasoning were removed, and 9,677 bytes went with them. Nothing else changed — no
  message or answer was touched — but the file is the one the original session also points at, and
  those records are not coming back. This is the reason `foster` will not call it.
- **The title does not survive.** It carries the working directory and nothing else, so the session
  arrives with no title at all — which the app displays as "General coding session", the same label
  every other untitled session gets. The transcript holds the real title the whole time; the import
  simply does not read it.
- **The dates are reset** to the moment of the import, and the model and permission mode are gone.
- **It takes over your window.** The app navigates to the imported session and focuses the composer,
  so whatever you were reading is replaced.

`foster restore` reads the same transcript and writes a pointer at it instead: the real title with
your prefix, the real dates, a fresh identity, and the transcript's modification time left exactly
where it was.

The deep link is still worth knowing about — it is the only thing that puts a session on screen
without a restart. It is not a way to move three hundred, and it is not free.

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
`lastKnownAccountUuid` in the config is a leftover of that answer, not the source of it: nothing reads
it to decide who you are signed in as. (It is not entirely dead — it feeds a check against reusing a
token across identities — but it selects nothing, and `foster` reads it only as a hint about which
directory the sidebar is on.) So there is no file to edit and no flag to pass. Deep links,
command-line arguments, environment variables, config files and group policy were each checked, and
none of them selects an account.

**A second profile does give you a second account, with one manual step.** Both
`CLAUDE_USER_DATA_DIR` and the `--user-data-dir` switch relocate `userData` outright: the profile
starts, populates its own store, takes its own instance lock, and runs beside the default
installation without disturbing it.

Signing in is where it gets awkward, and it is worth understanding why rather than giving up at the
symptom. The `claude://` protocol belongs to the installed package, so when the browser hands back
the OAuth callback, Windows routes it to the package and starts an instance on the **default**
`userData`. The profile never receives its own callback and sits on the sign-in screen forever.

But look at what that registration actually is:

```
HKCU\Software\Classes\claude\shell\open\command
  "…\WindowsApps\Claude_…\app\Claude.exe" "%1"
```

A plain executable with the URL as an argument — no package activation, no broker. And a second
invocation carrying the same `--user-data-dir` loses that profile's single-instance lock and
forwards its argv to the instance holding it. So the callback can simply be delivered by hand:

```powershell
& "…\app\Claude.exe" --user-data-dir="<profile>" "claude://<the callback URL>"
```

The profile started the login, so it is the instance holding the pending state; the URL only ever
needed to reach it. Capture the URL from the browser's network tab (or a fallback link on the page),
cancel the browser's "Open Claude?" prompt so the default instance never sees it, and run that. The
authorization code is single-use and short-lived, so do it promptly.

`foster` does that part for you, without needing the executable's path:

```bash
foster --store "D:\Claude-Work" app link "claude://<the callback URL>"
```

It refuses anything that is not a `claude://` link, and never prints or records the URL.

Demonstrated once, end to end: two accounts signed in simultaneously in the same Windows session,
each in its own instance, with the default installation untouched. An account whose organization
requires SSO will still refuse — that is the account's policy, not this mechanism.

`foster` works in either profile. It looks at `CLAUDE_USER_DATA_DIR` first when that is set;
for a profile started with the `--user-data-dir` switch instead, `foster doctor` lists the
directories of every running instance so you know what to pass to `--store`.

It can also start one. `foster --store <profile> app start` runs the installed executable — the one
Windows records when it registers the `claude://` handler — with the switch that points it at that
profile, so `app restart` works there too:

```bash
foster --store "D:\Claude-Work" app restart --terminate
```

Everything that inspects or closes an app is scoped to the store you name. The installed app is the
one whose main process carries no switch; a profile is matched by its own path. And `foster` refuses
to close the app it is running inside — which, with two instances up, means the one holding the Code
session that started it, not both of them.

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
`https://raw.githubusercontent.com/cfigueiroa/foster/v0.11.1/install.ps1`.

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

Sessions can also come from **another installation or profile**. A second profile
is a separate store that nothing in this one points at, so the source picker
offers it as its own entry: the profiles running right now are listed, and one
that is not running can be given by path. Copies made that way record which store
they came from, because two installations can hold the same account identifier.

"Work on another installation" goes further and points the whole menu at a
different profile — everything after it reads and writes there — so a second
account is not a reason to quit and relaunch.

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
foster agent     # hand a task to a Claude agent that drives the operations above
```

`return` only touches copies in the installation it is pointed at; copies written into another
profile are counted and left alone unless you pass `--all-stores`. The ledger spans every
installation, and quietly deleting from one while working in another is not something a tool should
do on its own.

`foster` and `return` are dry runs unless you pass `--yes`: they print exactly what
would be written or removed and touch nothing. (`label` only records a name in
foster's own ledger, so it writes immediately.) Add `--restart` to either to
restart Claude Desktop when it finishes.

Narrow what gets fostered with `--title`, `--cwd`, `--since 30d`, `--session <id...>`,
`--from <accountUuid>` or `--from-org <organizationUuid>`, and choose where the copies land with
`--to <accountUuid>` / `--to-org <organizationUuid>`. Identifiers may be abbreviated to any unique
prefix; an ambiguous one is reported rather than guessed at.

`--from-store <path>` reads the sessions from a different installation or profile while still
writing into the store `--store` names, which is how sessions move between two profiles:

```bash
foster --store "$env:LOCALAPPDATA\Claude-Work" foster --from-store "<the default store>" --yes
```

An account can hold several organizations and the sidebar only reads one of them, so any
organization other than that one is a valid source — including another organization of the account
you are already signed into. Sessions that could never appear in the sidebar are always excluded —
scheduled tasks, sessions that were never opened, and sessions whose file is over the 10 MB the app
refuses to load. `list --all` shows them anyway.

`--store` and `--from-store` take a distinctive piece of a path as well as the whole thing, matched
against the installations below — `--store work` finds `D:\Claude-Work`. A piece that matches two of
them is reported rather than guessed at, and one that matches nothing and is not a directory is an
error rather than an empty store.

`foster stores` lists the installations it can name without being told — the installed app, whatever
is running, and the profiles the ledger has been used in — with the account each one holds, which is
the question a second profile exists to answer. The menu offers the same list, so a profile you have
worked in once never has to be typed again.

```
* C:\…\Claude_…\LocalCache\Roaming\Claude  (installed app, running) 9866b1e8
  D:\Claude-Work                           (profile, running) not signed in
```

`scan`, `list`, `status`, `stores`, `doctor` and `app status` take `--json`.

## Agent

`foster agent` hands a task, in plain language, to a Claude agent whose only tools are foster's own
operations:

```bash
foster agent "which of my old accounts has sessions about the billing rework, and what state was that work left in?"
foster agent --yes "foster everything from my old account that touched the api-gateway repo, then clean up any duplicate copies"
```

It works the way Claude Desktop itself runs Code sessions, with the roles reversed: foster is the
parent process, it spawns the agent headlessly via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), and serves it an in-process
MCP server (`foster_session_mgmt`) over the same stdio pair. The agent sees nine tools — account and
session inventory, fostering status, app status, transcript reading, labelling, fostering,
returning, and a headless resume — and nothing else: no shell, no file access, no network.

**Mutations follow exactly the gates the CLI has.** Everything is a dry run unless _you_ started the
command with `--yes` — the model asking nicely does not count, and a gated attempt comes back to it
marked "writes are disabled" so it reports that instead of retrying. Removing copies still refuses
while Claude Desktop may hold them in memory, with the same message the CLI prints. The headless
resume (`claude -p --resume` against a conversation's transcript) counts as a write, and is
additionally refused when a live `claude` process is holding that conversation open — two writers on
one transcript is how transcripts get corrupted.

The Agent SDK is not part of foster's single-file release — it is megabytes of runtime with a
per-platform binary. Install it once with:

```bash
foster agent --setup
```

which runs a normal npm install into `~/.foster/agent`, where foster finds it from then on. The
model itself runs through your existing Claude Code sign-in (or `ANTHROPIC_API_KEY`). `--model`
overrides the model and `--max-turns` bounds the run (default 50).

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
- **It will not put the same conversation in a sidebar twice.** An account can already have its own
  card for the conversation being fostered — made when that work was resumed while signed into it —
  and the fostering key cannot see that, because the origin is the _other_ account's card and has
  never been fostered before. The result was two live rows for one conversation, differing only in
  which account watched which part of it. Fostering now refuses, naming what is already there
  (including when it is archived, where the answer is to unarchive rather than duplicate), and
  `--session` still overrides. For pairs already on disk, `status` counts them and
  `foster return --duplicates` removes the copies. Note that a `↪ ` in a title no longer proves a row
  is foster's: the app carries the title over when it makes a card of its own from one.
- **A copy is the same conversation, which is the point and the one hazard.** The copy carries the
  original's `cliSessionId`, so both rows open one transcript: work done under the other account is
  there when you open the original, and returning the copy loses none of it. What does not travel is
  the row itself — the app only writes the sessions of the account it is holding, so the original
  keeps the title and date it had when it was fostered until you open it. `status` marks a
  conversation that carried on, and `return` says so rather than letting an old date read as lost
  work. The hazard is only this: with two installations running, that one conversation has a row in
  two live sidebars, and opening it in both at once leaves the record branched instead of continued.
  `foster` warns when it writes a copy into an installation that is up alongside the one it came
  from. Work on a conversation in one place at a time.
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
npm run version:set 0.11.1
git commit -am "chore: release 0.11.1" && git tag -a v0.11.1 -m "foster v0.11.1"
git push && git push origin v0.11.1
```

Pushing the tag runs the release workflow, which refuses to publish unless the three versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with both assets. Run the
workflow manually from the Actions tab to exercise all of that without publishing anything.

## License

MIT — see [LICENSE](LICENSE).
