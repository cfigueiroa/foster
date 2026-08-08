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
- a `_foster` key recording where it came from.

That last one is a hint, not a record. The app rebuilds a session from a fixed list of fields when
it saves one, so the first time it writes a copy back — a rename, a focus, any activity at all —
`_foster` is dropped and the copy becomes indistinguishable on disk from a session the app made
itself. Measured on a live store: of 364 copies, 21 had lost it, and they were exactly the 21 that
had been opened. What is authoritative is foster's own ledger, which the app cannot reach; the
marker earns its place by covering the one case the ledger cannot, a crash between writing the copy
and recording it.

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

## Deleting for real

`restore` is also the uncomfortable proof of something: deleting a session in the app does not
delete the conversation. Everything that was said is still in a file, and a tool that can list those
files and put them back in your sidebar is a tool that just demonstrated they were never gone.
Sometimes gone is what you actually wanted.

```bash
foster purge                        # what could be destroyed, writing nothing
foster purge --yes --confirm 19     # destroy it
```

This deletes the transcripts themselves — every copy of them — and nothing else in foster can bring
them back. There is no backup, deliberately: a command whose purpose is to make something
unrecoverable cannot quietly keep a copy and still be that command.

Two gates stand in front of it, and they are not the usual ones.

**It only ever considers conversations the app has already deleted.** The candidates are exactly
what `restore` would offer: a deletion marker exists, the transcript is still on disk, and no
session file anywhere points at it. That last check is asked of **every installation foster knows
about**, not just the one in use — a card in a profile you are not signed into is still a card, and
the session it opens is one restart away. `--this-store-only` narrows it, and is a worse question to
ask. A conversation a live `claude` process is holding open is skipped as well, and said so out
loud.

**`--yes` is not enough on its own.** Every other writing command in foster is undone by the command
next to it, so one flag is a fair price; here the same flag would put "destroy every conversation I
ever threw away" one word away from "copy them into my sidebar". So `purge` also wants
`--confirm <count>` — the number the dry run printed. A count is the one confirmation that can fail
for a reason other than intent: it cannot be pasted from documentation or typed from memory, and if
the set moved between reading and running — something else deleted in the app in the meantime, a
filter that matches more than it did — the number no longer agrees and nothing happens.

Narrow it with `--title` or `--session <id...>`, and `--json` lists the candidates with their sizes
without destroying anything.

What it leaves behind is the app's own deletion marker, for the same reason `restore` does: that
record belongs to the app. And the ledger gets one line saying a conversation was destroyed here —
an id, a file count, a byte count, and nothing else. Not the title, not the working directory, not a
word of the text. A ledger that kept those would be the backup this command promises not to keep.

`foster agent` cannot do this. It is not one of the agent's tools, and the agent is told not to
reach for it through the shell either: an irreversible delete is not a thing to hand to a model
working from a one-line description of what you wanted.

Conversations are looked for in every Claude config directory that has them, not just the one this
process happens to be running under. Running a second Claude Code account means pointing the CLI at
its own `CLAUDE_CONFIG_DIR`, and each of those keeps a separate `projects/` tree — searching only one
would produce a shorter list that looks complete. Siblings of `~/.claude` are picked up when they
actually contain transcripts, and `--config-dir <path...>` adds any that live elsewhere.
`foster clients` is the map of those directories, and of who is signed into each.

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

With only one organization there is still a way, because the re-read is not guarded by a
"sessions are already loaded" flag: when the account and organization it resolves are the same ones
it already has, the app takes a branch that loads the directory again anyway. Signing out and back
in reaches it. Nothing external can force it — the organization change is noticed through an
in-process cookie event, so writing that cookie from outside emits nothing, and a same-value change
is discarded by two separate guards. It is a second door, not a cheaper one: the sign-in is more
disruptive than the restart it saves.

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

## Pinned sessions

A pinned session is not a session with a flag set. The session file has no field for it and the
app's config never mentions it: pinning is state of the **window**, kept in Chromium's IndexedDB
under one key, holding one JSON array of session ids.

That makes it the one thing a copy cannot inherit. `foster` mints a fresh `sessionId` for every copy
— which is exactly what keeps deleting the copy from ever reaching the original — and the pin is
keyed on the id. So a pinned session, fostered, arrives unpinned, and the entry left behind still
points at the original. `foster pin` is the way to put it back:

```bash
foster pin                                    # what is pinned, with titles
foster pin --session 14f73ab6 --yes           # pin it
foster pin --remove --session 14f73ab6 --yes  # unpin it
```

Reading is always safe. Writing needs **Claude Desktop closed** — not for the usual reason, but
because LevelDB keeps recent writes in memory and flushes them on its own schedule, so a change made
underneath a running app would simply be overwritten. The database is copied into `~/.foster/backups`
before anything is written, and the write itself only ever **appends**: LevelDB replays its log in
order, so a record added at the end supersedes the earlier one without a single existing byte being
rewritten. The worst an interrupted write can leave is a torn record at the end of the file, which is
the one kind of damage that format is designed to discard.

Reading has to look in **both halves** of the database, and this is the part that is easy to get
wrong. LevelDB writes to a log and, once that log grows, folds it into a sorted table and forgets it.
A reader that only knows about logs therefore answers "nothing has ever been pinned" for any
installation that has been running long enough to compact — which is every installation that has been
running for a while. It was the first thing to break here against a real profile, with ten sessions
visibly pinned in the sidebar and the log holding no trace of them. So `foster` reads the sorted
tables too, decompresses them, and takes whichever copy of the record carries the higher sequence
number. The same number is what a write has to climb above: a record appended to the log but numbered
below the table's is read as the older of the two, and the change quietly does nothing.

One thing `foster` deliberately will not do: write a pin list into an installation that has **never
pinned anything**. The record carries Blink's serialisation envelope, and with no record there is
nothing to copy it from — inventing one is guessing at a serialiser version. Pin any session in the
sidebar by hand, once, and the rest follows.

There is no LevelDB dependency, and it would not have helped: the database declares the comparator
`idb_cmp1`, and a stock binding refuses to open a database whose comparator it does not recognise.
The pieces actually needed are implemented directly — the log record format, the sorted-table format,
Snappy decompression, and IndexedDB's key encoding, which stores its strings as UTF-16 big-endian
while every other multi-byte field in the file is little-endian.

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

### More than one client at once

The CLI has none of this awkwardness. One `claude` is one config directory — `CLAUDE_CONFIG_DIR`
when it is set, `~/.claude` otherwise — and credential, settings and conversations all live inside
it, so a second directory is a second account, and the two run side by side without ceremony. The
CLI's sign-in never rides `claude://`: the browser hands back a code you paste into the terminal,
which is exactly the transport the app's second profile is missing.

Two things the pattern does not say out loud. The browser authorizes whichever claude.ai account it
is already signed into, so the first login of a new client belongs in a private window — the only
moment it matters. And a second account multiplies usage limits only if it has a plan, or API
credits, of its own.

`foster clients` lists the directories that exist and who is signed into each:

```
* ~\.claude        You · you@example.com · Max  (default, 2 live, 348 conversations, used today)
  ~\.claude-work   not signed in  (0 conversations)
```

The identity is read from the client's own `.claude.json` — the profile the CLI cached for itself,
the same at-rest category as the session files — and the credential beside it is not read, here or
anywhere: its presence is what "signed in" means. The rest of foster already treats clients as
first-class sources: `restore`, `purge` and `live` search all of them, which is how a machine with
two clients gets the whole answer rather than the default's half.

Launching stays in the shell, where an interactive program belongs. A function that sets the
variable, hands every argument through, and puts the environment back whatever happens is all it
takes — the two halves the obvious one-liner gets wrong are the `finally` and the `@args`:

```powershell
function claude-as {
  param([string]$Client)
  if (-not $Client) { Write-Error 'usage: claude-as <client> [claude args]'; return }
  $dir = Join-Path $env:USERPROFILE ".claude-$Client"
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Write-Error "client '$Client' does not exist ($dir). If it is meant to: mkdir $dir"
    return
  }
  $prev = $env:CLAUDE_CONFIG_DIR
  try {
    $env:CLAUDE_CONFIG_DIR = $dir
    claude @args
  } finally {
    $env:CLAUDE_CONFIG_DIR = $prev
  }
}
```

`claude-as work`, `claude-as work --resume`, and a new client is `mkdir ~\.claude-<name>` — the list
of clients is the directories that exist, so there is nothing to register anywhere.

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

Run it with no arguments for a guided menu that stays open — tick the accounts to
read from, choose sessions, review, confirm, and carry on without relaunching:

```bash
foster
```

You do not have to close Claude Desktop first. When the copies are written it
offers to restart the app so they show up.

The source screen is ticked rather than chosen: an account, one of its
organizations, several accounts at once, or the row that stands for every account
in the installation. One pass reads them all, so consolidating three accounts is
one run rather than three.

Copies go to the account you are signed into by default. The confirmation names
the destination and the title prefix, and either can be changed from there — any
organization of any account is a valid target, though copies written outside the
account in use only appear once you switch to it.

Sessions can also come from **another installation or profile**. A second profile
is a separate store that nothing in this one points at, so the source picker
offers it as its own entry: the profiles running right now are listed, and one
that is not running can be given by path. It is a scan of its own rather than one
more tick — a run reads one installation, and asking for both at once is refused
instead of quietly resolved to one. Copies made that way record which store they
came from, because two installations can hold the same account identifier.

"Work on another installation" goes further and points the whole menu at a
different profile — everything after it reads and writes there — so a second
account is not a reason to quit and relaunch.

The same operations are available as one-shot commands, for scripting:

```bash
foster doctor    # environment check: store location, app state, whether it is running
foster scan      # read-only inventory of accounts, organizations and sessions
foster list      # sessions from other accounts that are available to foster
foster label     # give an account a human name
foster labels    # list the names given so far
foster whoami    # the signed-in account's name, email and plan, from the app's own cache
foster foster    # create the copies
foster restore   # bring back sessions deleted in the app
foster purge     # destroy the conversations behind deleted sessions, permanently
foster return    # remove fostered copies, restoring the previous state
foster status    # what is currently fostered
foster pin       # pin sessions in the sidebar, or see what is pinned
foster app       # status | quit | start | restart — drive Claude Desktop itself
foster transcript  # read a conversation's transcript, by cliSessionId
foster resume    # send one prompt to an existing conversation, headlessly
foster live      # conversations a claude process is holding open right now (--stop ends one)
foster agent     # hand a task to a Claude agent that drives the operations above
```

`return` only touches copies in the installation it is pointed at; copies written into another
profile are counted and left alone unless you pass `--all-stores`. The ledger spans every
installation, and quietly deleting from one while working in another is not something a tool should
do on its own.

It also reads the axis the copies were written along. `foster` chooses a destination with `--to`, so
`return --to <accountUuid>` removes the copies in one account and leaves the rest — which is what
"clean up the account I stopped using" means, and what the unfiltered command cannot express: with
several accounts fostered into, a bare `return` removes the copies in the one you are using too.

```bash
foster return --to 00000000          # dry run, scoped to that account
foster return --to 00000000 --yes    # with Claude Desktop closed
```

### Naming accounts, and why foster cannot do it for you

Accounts are UUIDs here because that is all the directory names carry. The app knows better — it
shows the account's email under your avatar — and foster deliberately does not go and look. The only
copy of that email on this disk is inside `oauth:tokenCache` in the app's config, and reading token
caches is precisely what the safety model promises not to do. (It is not in the config as plain
text, not in the logs, and not in any file keyed by account; the one other copy is buried in an
opaque IndexedDB blob that describes only the account currently signed in.)

So the pairing has to come from you — but only once per account, and only the name, because foster
already knows which account the sidebar is reading:

```bash
foster label "John · johndoe@…"           # names the account you are signed into
foster label 00000000 "old personal"      # names any other
```

An identifier given on its own is refused rather than recorded as a name. From then on the name
appears in `scan`, `status` and the menu, and "Name an account" starts on the account in use —
the one whose email you can actually go and read right now.

`foster whoami` reads your name, email and plan for you, from the app's own cache rather than off the
screen — `John · johndoe@… · Max`, the same pieces the app shows under your avatar. The
authoritative copy is behind the API, and the token that reaches it is a credential foster will not
touch — but the app, having fetched its own profile once, keeps a copy at rest in the web-origin
storage under `Local Storage/` and `IndexedDB/`, which is page data rather than a credential, so
foster may read it. `foster label --from-cache` names the signed-in account with what it finds, and
the menu's "Name an account" pre-fills the same suggestion.

It is read the crudest way that cannot fail: the files are loaded as bytes, capped by size, and
searched as text. Parsing that storage as a database — which an earlier version did, with the reader
foster uses for the pin list — corrupted the heap on a real table and crashed the process outright,
because the format is the app's to change and foster's reader was built for one narrow database.
Reading bytes trusts nothing: it finds less (a value hidden inside a compressed block is missed) and
crashes never.

**It reads and remembers, because the source is volatile.** The profile lands in that storage when
the app fetches it and leaves when Chromium compacts the database: measured here, the plan was
readable minutes after signing in and absent from every non-credential file an hour later. No amount
of careful parsing finds what is no longer written down, so `whoami` records what it sees in
foster's own ledger and falls back to that when the cache has forgotten. A remembered answer says
so, with the date it was last confirmed — that is a different claim from a fresh reading, and the
difference is worth keeping visible.

Remembering is also what makes the **other** accounts nameable. Web storage only ever describes the
session in front of you, so the cache alone can name one account; the ledger accumulates them, one
per visit, and `label` offers what it knows for whichever account you pick.

Two honesties beyond that. It is **best-effort**: a version that keeps the profile differently makes
`whoami` find nothing new rather than something wrong, and the manual `label` is always there. And
what it extracts is tied to the account by proximity — the email must sit beside the account’s own
UUID, and the name and plan beside that email — so a correspondent’s address quoted in a conversation
cannot end up as the account’s name, and a workspace called "Sales" cannot end up as its owner.

`status` answers the same question the other way round. It summarises by account by default —
how many copies, and where — because with a few hundred of them a line per copy is not an answer
anyone can read. `status --all` prints the full list, `status --to <accountUuid>` narrows to one
account, and `--json` is always complete.

`foster`, `restore`, `return` and `purge` are dry runs unless you pass `--yes`: they print exactly
what would be written or removed and touch nothing. (`label` only records a name in
foster's own ledger, so it writes immediately; `purge` wants `--confirm` as well as
`--yes`.) Add `--restart` to any of the first three to restart Claude Desktop when it
finishes.

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

Archived sessions are excluded too, but for a different reason and with a way out. Archiving is a
decision you made, not a limitation of the file: the session has a place in the app, just not in
Recents. A sweep should not drag back what you tucked away, so `--archived` is opt-in — and when the
only card a conversation has left is archived in an account you are not signed into, it is the only
way to reach it at all. The copy keeps the flag and lands in the destination's archived view, which
brings the conversation across without undoing your decision about it.

### A copy can be the last card its conversation has

Copies are not sources. Fostering one would make a second copy of a conversation whose original is
right there, with a longer provenance chain and nothing gained. That rule is right until the
original stops existing — deleted in the app, or never there at all because the copy came from
`restore` — and then it strands the conversation: it sits in one account, perfectly readable, and no
sweep will ever offer it again. Moving to a third account leaves it behind for good.

So the rule is about the conversation rather than the file. A copy is refused while its conversation
still has a card of its own **somewhere in the store**, and is a legitimate source once it does not.
That question can only be answered by looking at every account, including the ones not being
offered — deciding it from the source account alone would call a copy stranded while its original
sat in the account the copies were going to. Two stranded copies of one conversation are both
eligible and the destination check still allows only one row, so nothing doubles.

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

`foster clients` is the same list for the CLI: its config directories — one per account — with who
is signed into each, read from each client's own cached profile; the credential contributes only its
existence. Everything that reads conversations already searches every client, so this is the map of
what those commands will look at, and `--config-dir` adds a directory that lives where naming
cannot find it.

`transcript`, `resume` and `live` are the deterministic counterparts of what the agent (below) does
with its tools — for when you know exactly what you want and a model in the middle would only add
cost. `foster transcript <cliSessionId>` prints the most recent part of a conversation (`--head` for
the start, `--chars` for how much; the id comes from `list --json` or `status --json`).
`foster resume <cliSessionId> "<prompt>"` runs `claude -p --resume` behind the same gate the agent
has: it refuses while a live `claude` process holds that conversation, because two writers on one
transcript is how transcripts get corrupted. `foster live` shows exactly what is being held.

`scan`, `list`, `status`, `stores`, `clients`, `doctor`, `app status`, `transcript`, `live`,
`purge` and `whoami` take `--json`.

## Agent

`foster agent` hands a task, in plain language, to a Claude agent that knows foster's domain and
carries foster's operations as first-class tools:

```bash
foster agent "which of my old accounts has sessions about the billing rework, and what state was that work left in?"
foster agent --yes "foster everything from my old account that touched the api-gateway repo, then clean up any duplicate copies"
```

It works the way Claude Desktop itself runs Code sessions, with the roles reversed: foster is the
parent process, it spawns the agent headlessly via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), and serves it an in-process
MCP server (`foster_session_mgmt`) over the same stdio pair. That server carries nine tools —
account and session inventory, fostering status, app status, transcript reading, labelling,
fostering, returning, and a headless resume — and alongside it the agent has Claude Code's full
toolset: shell, files, web. The foster tools remain the required path for anything touching the
session store, because they are what goes through the engine's gates and ledger; the general tools
are there for whatever else the task turns out to need.

**One switch governs all writing, and it is the same one the CLI has: `--yes`.** Without it the run
is read-only end to end — foster mutations are dry runs, and built-in tools that write or execute
(shell, edits, web fetches) are denied by the permission layer, since a headless run has no
terminal to ask in. The model asking nicely does not count: a gated attempt comes back marked
"writes are disabled" so it reports that instead of retrying. With `--yes`, foster mutations apply
and the general tools run unrestricted (the SDK's bypass-permissions mode) — give it the flag only
with a task you would be comfortable typing into Claude Code itself. Two gates hold even then:
removing copies still refuses while Claude Desktop may hold them in memory, with the same message
the CLI prints, and the headless resume (`claude -p --resume` against a conversation's transcript)
is refused when a live `claude` process is holding that conversation open — two writers on one
transcript is how transcripts get corrupted.

One honesty note: foster's own engine never reads credentials, and that promise is unchanged — but
an agent with general read tools is as able to open files on your machine as any Claude Code
session is. `foster agent` is Claude Code with extra knowledge, not a sandbox.

The Agent SDK is not part of foster's single-file release — it is megabytes of runtime with a
per-platform binary. Install it once with:

```bash
foster agent --setup
```

which runs a normal npm install into `~/.foster/agent`, where foster finds it from then on. The
model itself runs through your existing Claude Code sign-in (or `ANTHROPIC_API_KEY`).

**The default model is Haiku** — the tools do the heavy lifting and most agent tasks here are
orchestration, so the cheap tier ($1/$5 per million tokens, roughly a fifth of Opus) is the right
default. Pass `--model sonnet` or `--model opus` when the task needs more judgment — cross-reading
many transcripts, deciding what is worth fostering — and `--max-turns` bounds the run (default 50).
And before reaching for the agent at all: if the task is a known, mechanical one, the deterministic
commands above do it for free.

### Related surface: the app's own session tools

The arrangement `foster agent` reverses is worth knowing in its own right: Claude Desktop injects
an MCP server of its own, `ccd_session_mgmt`, into every Code and Cowork session it opens (observed
August 2026 — the surface is undocumented, so treat the details as a snapshot, not a contract). Its
tools are the running app's view of the current account: list the other sessions, read their
transcripts, search them full-text — archived ones included — retitle or archive them, even send a
message into one. From inside a Desktop session, "which of my sessions talked about X" is answered
natively, with no foster involved.

Its limits are exactly the boundary between the two. It sees one account, only while the app is
running, and it never touches the store on disk — anything cross-account, anything against a closed
app, and any write that should carry a ledger entry stays foster's job. `foster agent` never meets
this server either: it runs headless through the Agent SDK, outside the app, so nothing here is a
capability the agent gains.

They do compose, though, in one direction: fostering feeds it. A copy, once the app has loaded it,
is one of the account's sessions like any other, and it opens the original's full transcript — so a
conversation lived under another account becomes something these tools can list, read and search
natively. foster adds no API to the app; it widens what the app's own API can know.

## Safety model

- **Reads and writes are separated.** The scanner never writes. All mutation goes through a single
  engine module, and every completed operation is appended to a ledger (`~/.foster/ledger.jsonl`) so
  it can be replayed in reverse. The write comes first and only a finished write is recorded: a
  ledger entry for a write that failed would mark the session as fostered for ever, with no file to
  show for it.
- **The originals are never modified.** Fostering only ever _adds_ a file to the current account's
  folder. There is no move, and no rewrite of anything under the old account.
- **One command destroys data, and it is the only one.** `purge` deletes conversations the app has
  already deleted the cards for, and nothing brings them back — no backup, no ledger copy, no undo.
  It is fenced off accordingly: candidates are limited to transcripts nothing on disk points at,
  `--yes` alone will not run it, and the agent is not allowed near it. Every other command in
  foster adds a file or removes one foster itself wrote.
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
  work. The hazard is only this: **a conversation can be continued in one place at a time**, and a
  second card opened while something else is writing it makes the app branch instead — a new
  transcript, a new id, and that card moved onto the branch. It takes two installations for two
  sidebars to be live at once, and `foster` warns about that. But it takes only a **running Code
  session** for a conversation to have a writer, and that needs no second installation at all: foster
  a session you are working in, switch account, open the copy, and the copy becomes a snapshot that
  stops at the moment you opened it while your work carries on where you left it. `foster` warns when
  a copy it is making has a live writer, before and after writing, in the command and in the menu —
  and names it, with the pid and the directory it was started in, because "finish there first" is not
  advice anyone can act on without knowing where _there_ is. When finishing is not possible,
  `foster live --stop <id>` ends the writer. That is a kill and says so: the CLI has no window to
  close politely, so whatever the session had not yet written is lost, while everything already in
  the transcript stays. It refuses the session foster is itself running in, for the same reason it
  refuses to close the app it is running inside.

  When it does happen, nothing is lost — both transcripts are on disk — and foster now notices. A
  copy the app has repointed at another conversation is recognised as **repurposed** rather than
  counted as still standing, so the conversation it was made for can be fostered again instead of
  being refused as "already fostered" forever. The branch's card is left exactly where it is: the app
  made it, it is a working row for the branch, and removing it would delete something you can see.

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
