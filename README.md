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

## The whole sweep

The request behind most runs never varies — _bring everything here_ — and answering it used to
mean three commands in the right order plus one flag that was easy to miss. `foster sweep` is that
sequence as a command:

```bash
foster sweep          # what it would do, writing nothing
foster sweep --yes    # do it
```

It copies every fosterable session from the other accounts, **archived ones included**, brings back
conversations the app deleted that nothing still points at, and then re-scans to say whether either
pass has anything left. That last part is the reason it exists as a command rather than as advice:
measured on one real store, the same sweep offered 15 sessions without `--archived` and 141 with it,
so anyone who did not know the flag finished with a tenth of the work done and no way to tell.

Archived copies **stay archived**. They arrive in the app's archived view rather than reappearing in
Recents — bringing the conversation across is the point, not undoing the decision to tuck it away.

It also counts what can never come: scheduled tasks, sessions never opened, and files over the
10 MB the app refuses to load. Those are a real gap in the sidebar, and a run that leaves them
unmentioned reads as having brought everything.

Two things it deliberately does not do. It never [purges](#deleting-for-real), which destroys
transcripts and is part of no sweep. And it never [consolidates](#when-one-conversation-becomes-two):
choosing which half of a fork survives hides records, and that is a reading decision — forks are
counted, reported, and left alone.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. A Claude
Code session started from the app's sidebar is a child process of the app, so restarting from
inside one would kill the caller part-way through; the sweep asks first and ends with the command
to run from a terminal outside the app instead of failing after writing everything.

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

## When one conversation becomes two

A conversation that already has a writer cannot be continued from a second card. Asked to open one,
the app forks instead: it copies the history into a new transcript with a new `cliSessionId` and
points that card at the fork. From then on there are two conversations where there was one, the two
halves usually live in different accounts, and fostering between those accounts puts both in the same
sidebar — one piece of work, several rows, nothing to tell them apart but a date.

`foster consolidate` reduces that to one row per account, on the half that carried on:

```bash
foster consolidate                  # what it would do, writing nothing
foster consolidate --yes            # do it, with Claude Desktop closed
foster consolidate --undo --yes     # put every moved card back
```

It moves the card rather than adding one. A copy of the other half would be a second row, which is
the problem; the row you already have simply starts opening the conversation that kept going. The
card keeps its identity, its title and its pins, and only two fields change: the pointer, and the
date, so it stops sorting in Recents by the day it was interrupted.

### Which half carried on

The measure is **records a branch holds that no sibling holds**. The two obvious alternatives are
both wrong, and were measured to be wrong on a real store rather than reasoned about:

- **The file's modification time.** The app rewrites its own bookkeeping — `custom-title`, `mode`,
  `last-prompt` — into a transcript every time its card is opened, so a conversation nobody has added
  a word to gets a fresh timestamp. One fork here had its stale half stamped a day _after_ the half
  that had been running all morning, purely because the stale row had just been clicked. Anything
  ranked by mtime can be flipped by looking at the wrong answer.
- **The common prefix.** A branch is a copy of the history, so walking both files in step until they
  differ looks exact. It is not — the app does not write the copy in the original's order. On one
  fork the ordered prefix ran 169 records while the two files had 1255 in common.

`foster return --branches` used to pick its survivor by mtime and now uses the same measure, which
means it can no longer keep the row you happened to open and drop the one holding the work.

### What one row costs, and when it is not worth paying

Choosing a half hides what the others hold alone — from the sidebar, and only from the sidebar. The
transcripts stay on disk and `foster transcript <cliSessionId>` still reads them. Every line of the
dry run says both numbers, because "keeps 2802 records, hides 105" is the whole decision and printing
only the first half would be an advertisement.

When both halves are substantial that trade is not one to make quietly, so it is not made. A fork
whose losing halves hold more than `--max-lost` records between them (200 by default) is reported
with its numbers and left exactly as it is. The gap turns out to be wide: across a store of 591
conversations, the seven forks worth collapsing left between 3 and 158 records behind, while the one
that was genuinely two pieces of work — 2352 records on one side, 3609 on the other, 770 in common —
left 2352. Merging the two would be the only way to keep everything, and rewriting the record of a
conversation is not something this tool does.

### The one write to a card foster did not make

Everywhere else, foster removes only what foster wrote. A repoint is the exception, and it carries
the guarantees that exception has to earn.

It refuses while an app holding the card is running — stricter than `return`, which can reason about
which copies the app could have loaded. A card being repointed is by definition a row you can see,
which means the app read it at startup and will write it back from memory, pointer and all. The
ledger records where the card was, the date it wore and where to find it, so `--undo` needs no scan
and works for an account nobody is signed into. A card moved twice still goes back to where the app
had it, not to where it stopped along the way.

What it will not touch is a second card the _app_ made for the same work. Those are reported and left
alone, for the reason `return` leaves them alone: deleting somebody else's file on the strength of a
heuristic is exactly the kind of help nobody asked for.

One shape is out of reach by construction. A fork is visible here only while both halves have a card
somewhere in the store, because that is where the list of conversations comes from. A branch nothing
points at is a conversation with no row at all, which is `foster restore`'s question rather than this
one's.

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

Nothing on your disk can switch **the app's** account — not `foster`, not anything else. This is
worth stating precisely, because it is the first thing people try, and because the answer for the
CLI is now the opposite one: a config directory's account is a file, `foster` moves it, and
[Switching a client's account](#switching-a-clients-account) is that section. The two answers differ
because the two programs keep the account in different places, and the rest of this section is why.

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

`foster client new` makes a better one than `mkdir` does. A bare directory plus a login
authenticates, but sessions run there quietly have fewer capabilities than sessions run anywhere
else: no settings, no `CLAUDE.md`, no agents, and — the one that actually bites — no skills, with
nothing in any output saying so. So settings, instructions, agents, commands and output styles are
copied, and `skills/` is **linked** rather than copied, because skills are a warehouse and a copy
starts drifting the day either side changes.

Three things are never copied, and each exclusion is load-bearing. The credential, because one
account living in two directories is the exact state the vault rule below exists to prevent.
`projects/`, because that is the whole conversation history and a second copy of it is a second set
of transcripts for every other command here to find. And `.claude.json`, because it holds the cached
profile `foster clients` reads — copy it and a directory nobody has signed into reports somebody
else's identity.

```bash
foster client new ~\.claude-work            # dry run
foster client new ~\.claude-work --yes      # make it, signed out
```

### Switching a client's account

A client's account is one file. `<configDir>/.credentials.json` is plain JSON of about 1.4 KB, every
`claude` process reads it at birth, and nothing else binds a directory to an account — so replacing
it replaces who the next process runs as, with no logout, no restart, and nothing else touched.

The obvious way to do that by hand is a logout and a login, and it is the wrong way: a logout throws
away a working credential to make room for one you then have to go and get. `foster switch` moves
them instead.

```bash
foster switch                               # who is here, and what the vault holds
foster switch alice@example.com             # dry run
foster switch alice@example.com --yes       # swap
```

The credential that was there is recorded in foster's vault; the one asked for is installed from it.
Two rules decide the shape of that vault, and both were arrived at the hard way.

**The identity of a credential is `(client, account)`, not an account.** One account signed into two
config directories has two independent token families, from two separate logins, whose refresh tokens
rotate separately — so a credential taken from one client cannot be installed into another, and
foster will not offer it. Keyed by account alone, a single `guard` on the second client would
overwrite the first's copy with a credential that does not work there.

**Nothing in the vault is ever replaced or removed.** The obvious design is positional — one live
copy per account, a swap trades one for the other — and foster implemented that first, for a real
reason: a refresh token can be rotated on every renewal, so a copy left on a shelf quietly stops
working. But positional means destructive. Every swap deletes a credential, and a deleted credential
is one that no later feature can reach and no operator can fall back on. So the vault is
**append-only**, in the same idiom as foster's ledger: one JSONL file per `(client, account)`, newest
line wins, and every version before it stays legible underneath.

> **The cost, plainly.** This keeps more credentials at rest than the minimum, for ever, and
> unencrypted — which makes the vault a more valuable target than a positional one would be. It also
> means a stale record can be installed and fail. Both are accepted deliberately: staleness is
> detectable, because every record carries when it was taken and a switch verifies before it commits,
> while deletion is not detectable at all — and nothing foster does can make a credential
> unrecoverable.

Foster never logs in. An account it has no record of is a login you do once, in that directory, after
which it can be switched to freely. Two things write to the vault, and no command that merely reads
does: **a switch** records the account it displaces, and **`foster guard`** records the account in
use. So the first account to become switchable is the one `guard` sees. A credential that has not
changed since the last look appends nothing, so `guard` is cheap to run on a timer.

A credential that has sat unused can expire on its own, so the swap is **verified against the API**,
not against the file it just wrote: a stored credential that no longer authenticates is put back, and
you are asked for a fresh login rather than told it worked. For the same reason foster **refuses to
switch at all** while it cannot verify who is signed in — an unverified answer is not good enough to
file the outgoing credential under, and filing it wrong would overwrite another account's entry. That
is also why `--offline` plans but never applies.

One thing a switch cannot fix, and says so instead: the CLI caches its own profile in `.claude.json`
and only rewrites it when it next runs, so `foster clients` keeps naming the previous account until
then. Foster will not edit the app's cache to cover for itself.

**The failure the vault is really for** is the one with no other answer: another `claude` process,
started before the switch, holds its token in memory and rewrites the credential file when it
renews — putting its account back over yours, minutes later, silently. Foster cannot prevent that; no
lock exists to take. So it does the two things it can. It names the processes that could do it, with
pids and working directories, before writing:

```
  ! 2 live session(s) in this client can rewrite the credential:
      pid 4242  D:\work\api-gateway
```

And the account that gets overwritten is already recorded, so the damage is a command to undo rather
than a login to redo. That is the whole argument for keeping history: the process that clobbers you
cannot reach what the vault has already written down.

`foster vault` lists what is held — grouped by client, newest first, with how many versions stand
behind each — read from each record's own fields rather than its filename, and without opening a
credential. `foster guard` records the account a client currently holds, for anything that wants a
fixed cadence; it is what makes an account switchable in the first place, since foster can only
install a credential it has seen.

The record shape is documented because it is the way back if foster is ever gone. Each line is a JSON
object with `surface`, `email`, `savedAt` and the credential verbatim under `credential`, so
recovering one by hand is one command in any shell:

```powershell
(Get-Content <file> | Select-Object -Last 1 | ConvertFrom-Json).credential |
  Set-Content ~\.claude\.credentials.json
```

**The other kind of switch changes it for one consumer rather than for the machine.** Give each
account its own directory, log into each once, and point a junction at whichever is active:

```bash
foster point ~\.claude-live --to ~\.claude-accounts\alice --yes
```

Anything running with `CLAUDE_CONFIG_DIR` set to the link follows the flip; your own terminals carry
on wherever they were. No credential moves and nothing is logged out. One property is worth knowing
because it is counter-intuitive: the path is resolved on **every** file open, so a process that
started before the flip writes through it after. A link does not isolate a running process from a
switch — only a directory that the process's own environment names does that.

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
foster accounts  # every account here: who, which plan, whether it is still paid for
foster usage     # the signed-in account's live 5-hour and weekly limits, from the API
foster renewals  # usage resets and billing dates across every account, in one place
foster whoami    # the signed-in account's name, email and plan, from the app's own cache
foster clients   # the CLI's config directories, and who is signed into each
foster switch    # sign a client in as another account, without a logout
foster vault     # the credentials foster is holding, and whose they are
foster guard     # record the account a client holds, so it can be put back later
foster point     # repoint a directory link at another client
foster client new  # seed a config directory that is a working client
foster sweep     # the whole job: every account, archived and deleted included
foster foster    # create the copies
foster restore   # bring back sessions deleted in the app
foster purge     # destroy the conversations behind deleted sessions, permanently
foster return    # remove fostered copies, restoring the previous state
foster consolidate # one row per piece of work, on the branch that carried on
foster status    # what is currently fostered
foster pin       # pin sessions in the sidebar, or see what is pinned
foster app       # status | quit | start | restart — drive Claude Desktop itself
foster transcript  # read a conversation's transcript, by cliSessionId
foster resume    # send one prompt to an existing conversation, headlessly
foster live      # conversations a claude process is holding open right now (--stop ends one,
                 #   --prune clears registry entries whose process is gone)
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

### Naming accounts, and when foster can do it for you

Accounts are UUIDs here because that is all the directory names carry. The app knows better — it
shows the account's email under your avatar — and the plainest copy of that email on this disk is
inside `oauth:tokenCache` in the app's config, which the safety model does not read as a shortcut to
a name. (It is not in the config as plain text, not in the logs, and not in any file keyed by
account; the one other copy is buried in an opaque IndexedDB blob that describes only the account
currently signed in.) So a name comes from one of three places, in the order foster prefers them: a
label you set, an identity foster read from the app's own profile cache, or — new — an answer the API
gave when foster presented a credential the account itself left behind (see `identify`, below). Only
when none of those is available does the pairing fall to you — and even then only the name, because
foster already knows which account the sidebar is reading:

```bash
foster label "John · johndoe@…"           # names the account you are signed into
foster label 00000000 "old personal"      # names any other
```

An identifier given on its own is refused rather than recorded as a name. From then on the name
appears in `scan`, `status` and the menu, and "Name an account" starts on the account in use —
the one whose email you can actually go and read right now.

`foster whoami` reads your name, email and plan for you, from the app's own cache rather than off the
screen — `John · johndoe@… · Max`, the same pieces the app shows under your avatar. The
authoritative copy is behind the API; `whoami` chooses not to spend the token on it (that is
`identify`'s and `usage`'s job, on request) and reads the app's own download instead — having fetched
its profile once, the app keeps a copy at rest in the web-origin storage under `Local Storage/` and
`IndexedDB/`, which is page data rather than a credential, so foster may read it offline. `foster label --from-cache` names the signed-in account with what it finds, and
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

`foster identify` closes part of that gap without a visit. An account foster has never seen signed in
is a bare UUID because the app never fetched its profile here — but a credential _for_ that account
may already be on the machine, in a CLI client (`foster clients` lists them) or in foster's own
vault. The profile endpoint answers for whatever token it is given, so foster presents those
credentials and keeps the answer only when the profile's own `account.uuid` matches the account
asked about. That match is the safety: a token belonging to someone else is discarded, never written
against the account that was asked. The sighting lands in the ledger the same way a sign-in's would,
so the dashboard, `accounts` and the menu pick it up. `foster identify <account>` names one,
`foster identify --all` sweeps every account that has no identity yet, and the menu offers "Identify
it" on an unnamed account when a key to ask with is on hand. Like `usage`, it goes to the network
only when you run it — never on its own — and when foster holds no live credential for an account it
says so rather than guessing.

**Two servers, and why only one of them answers.** This is worth understanding, because it is the
line between what `identify` and `accounts` can tell you and what they cannot. Anthropic runs the
account behind two different hosts, and they are not interchangeable:

- **`api.anthropic.com`** is the programmatic host. The OAuth token the app holds was _issued to
  talk to it_, so a request there is authenticated, expected, and ordinary — no trick involved. It
  answers with **identity, plan, subscription status and live usage**. This is the front door, and
  it is the only one foster ever knocks on: `usage`, `renewals` and `identify` all go here.
- **`claude.ai`** is the website you open in a browser. The **billing** details — next charge date,
  card on file, cancellation — live only here, and this host sits behind a **bot-check**: the
  "confirm you're human" challenge (Cloudflare's) that a browser passes silently and a script does
  not. For a program to read billing off `claude.ai` it would have to _defeat that challenge_ —
  impersonate a human-driven browser. **foster does not do that, by policy.** So billing is
  reachable only when the app itself already fetched it and left a copy on disk (which is why you may
  see a card and a renewal date for the account signed in now, and never for one that was only
  identified over the API).

Put plainly: identity, plan and usage come through the front door and `identify` can fetch them for
any account whose key is on this machine; billing is behind the bot-check, so it is only ever read
from a cache the app already filled, never fetched by foster. The card and renewal you saw on the
signed-in account are the app's own download at rest — not something foster went to `claude.ai` to
get.

Two honesties beyond that. It is **best-effort**: a version that keeps the profile differently makes
`whoami` find nothing new rather than something wrong, and the manual `label` is always there. And
what it extracts is tied to the account by proximity — the email must sit beside the account’s own
UUID, and the name and plan beside that email — so a correspondent’s address quoted in a conversation
cannot end up as the account’s name, and a workspace called "Sales" cannot end up as its owner.

**Where it actually reads.** The app keeps its own profile in two places and only one of them is
current. It used to persist the answer into Local Storage, inside the React Query cache, and that is
what the byte search was built for; on a machine running today that cache persists _empty_ and the
live copy is a cached HTTP response body under `Cache/`. So the profile is read from there first —
gzip or brotli, decompressed, and then **parsed**, because it is JSON and an object either carries
`account.uuid` equal to the account being asked about or it does not. That is a comparison rather
than a guess, which is why this source is preferred over everything below it. What it yields is the
whole profile: name, email, organization, the raw tier, the subscription's status and start date.

`foster accounts` (and **"Who each account is"** in the menu) is that, for every account in the
installation at once — plan, subscription, card and renewal where they are known, sessions and
organizations always. One honesty runs through the screen: a response cache holds what was
_fetched_, and the app only ever fetches the profile of the session it is in, so exactly one row can
be read fresh. The others show what foster recorded on the visit that saw them, dated. An account
never signed into on this machine shows its directories and nothing else — not because the read gave
up, but because that account's profile has never been on this disk. Signing into it once fills the
row in for good.

Proximity is not the whole of it, because these files are not text. Local Storage is a stack of
compressed blocks read as raw bytes, so most of what a pattern sees is rubble — and rubble spells
email addresses: across one real store, 350 of 676 matches for a plain address were decompression
noise, things like `3@T.tf` and `6@ai.television.ses`. Nearness cannot tell those from a profile,
since noise is nearer to the account id than the profile ever is. So the email is read only out of a
field that says it is an email, from a value that is an address all the way to both quotes.

Remembering has its own failure, and it needs a way out. A sighting that was wrong outlives the cache
that produced it, and a later reading can only correct a field by finding a different value for it —
which it cannot do once the app has compacted the profile away. `foster label <accountUuid> --forget`
discards what is remembered about an account and leaves the name you chose alone; the sighting stays
in the log, and the next real reading starts the record over.

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

That gate rests on the CLI's own registry — a file per running session under `<configDir>/sessions/`,
naming the pid holding the conversation — and a pid on its own is not an identity. Windows reissues
pids quickly, and after a reboot a day-old registry file points at whatever took the number next: a
service worker, a git process, the desktop app. So the pid is checked against the creation time the
record kept for its writer (`procStart`, Windows' own clock): two processes can share a pid, but not
a pid and a creation instant. Records too old to carry one fall back to what the pid is now and
whether it is even older than the record describing it. An entry that fails is not a live writer,
and `foster live --stop` will not end a process it cannot identify — the kill is `taskkill /F /T`,
and the tree it takes with it would be a stranger's. Reading the process table is the Windows half
of foster: anywhere else there is none, every entry stays listed, and `--stop` refuses everything
rather than guessing.

The session foster is running in is never ended, for the same reason it refuses to close the app it
runs inside — the kill would take the command with it, part-way through. That used to be answered by
walking parent links, which breaks the moment any process in the chain has exited: launched through
a wrapper whose shell was gone, `--stop` offered to end the session it was running in. The CLI marks
every process it starts with the conversation and the pid holding it, however deep, so the question
is now answered outright.

`foster live --prune` clears the files whose process is provably gone or provably somebody else;
without `--yes` it only lists them. That includes the peer key a session leaves beside its record —
it carries the same creation time, so it is answerable by the same rule, and it is what a machine
that has been up for a week is actually full of: the CLI clears records it finds stale but never
the keys.

`scan`, `list`, `status`, `stores`, `clients`, `doctor`, `app status`, `transcript`, `live`,
`purge` and `whoami` take `--json`.

## Agent

`foster agent` hands a task, in plain language, to a Claude agent that knows foster's domain and
carries foster's operations as first-class tools:

```bash
foster agent "which of my old accounts has sessions about the billing rework, and what state was that work left in?"
foster agent --yes "foster everything from my old account that touched the api-gateway repo, then clean up any duplicate copies"
foster agent --yes "bring everything here, archived and deleted included"
```

That last one used to be unanswerable: `restore` was never one of the agent's tools, so an agent
asked for the deleted ones could only tell you to run a command yourself. The sweep is a tool, so
it is one call.

It works the way Claude Desktop itself runs Code sessions, with the roles reversed: foster is the
parent process, it spawns the agent headlessly via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), and serves it an in-process
MCP server (`foster_session_mgmt`) over the same stdio pair. That server carries ten tools —
account and session inventory, fostering status, app status, transcript reading, labelling,
fostering, [sweeping](#the-whole-sweep), returning, and a headless resume — and alongside it the
agent has Claude Code's full toolset: shell, files, web. The foster tools remain the required path for anything touching the
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

One honesty note: foster reads the credential in exactly one command (`foster usage` — see the safety
model), and nowhere else, including here; the agent is not handed the token or the reader. But an
agent with general read tools is as able to open files on your machine as any Claude Code session is.
`foster agent` is Claude Code with extra knowledge, not a sandbox.

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
  foster adds a file, removes one foster itself wrote, or — in the case of `switch` — replaces one
  whose previous contents it put in the vault first, in that order, so that the step after the
  crash is always a command rather than a login.
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
- **Nor the same conversation under two identifiers.** The check above compares `cliSessionId`, which
  is the one field a branch changes — so for a while the pair it existed to prevent was arriving
  through the branch. One conversation is forked (see below), each half ends up in a different
  account, and fostering both puts two identical-looking rows in one sidebar with nothing to tell
  them apart. What a branch cannot change is the conversation it was forked from: the two transcripts
  share every record up to the moment they parted, so the first `uuid` in the file identifies the
  work rather than the file. Fostering compares that too, and refuses with `already has a branch`
  rather than pretending it is the same conversation — because it is not, quite. Each side holds
  turns the other never got, so read both before choosing; `--session` overrides, and for pairs
  already on disk `status` counts them and `foster return --branches` removes them.

  Refusing it is right and refusing it silently was not, because the account keeps whichever half
  reached it first. When the half being turned away is the one that carried on, the sweep now weighs
  the two and says so — how many records each holds that the other does not — and names
  `foster consolidate`, which is what moves the row you have onto the half that kept going. The other
  direction gets no such line: skipping the half that stopped is simply correct, and a note under
  every refusal would bury the handful that matter.

  Removal keeps one row per piece of work, always: a card foster did not write if there is one,
  otherwise the half that carried on after the fork — measured by the records it holds that no
  sibling holds, not by which file was written last, which the app moves whenever a card is opened.
  Reporting every row of a group is true of each and ruinous together, and would have taken the work
  out of the sidebar entirely.

- **One card may be rewritten, and only in one field.** `foster consolidate` moves a card onto the
  half of a fork that carried on, which is the single place foster writes to a file it did not
  create. It changes the pointer and the date and carries every other key through untouched; it
  refuses outright while an app holding the card is running, because a card in memory is written back
  from memory; it records where the card was, so `--undo` restores it without reading anything but
  the ledger; and it leaves a second card the _app_ made for the same work alone, reported rather
  than removed. It also refuses to collapse a fork whose halves are both substantial — see
  [When one conversation becomes two](#when-one-conversation-becomes-two).

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
  advice anyone can act on without knowing where _there_ is. A pid on its own would not carry that
  claim: Windows hands them back out, so a registry file left behind by a crash can name an unrelated
  process. The record keeps the creation time of the process that wrote it, and that is what foster
  checks, so the warning is about a writer that is actually there. When finishing is not possible,
  `foster live --stop <id>` ends the writer. That is a kill and says so: the CLI has no window to
  close politely, so whatever the session had not yet written is lost, while everything already in
  the transcript stays. It refuses the session foster is itself running in, for the same reason it
  refuses to close the app it is running inside.

  When it does happen, nothing is lost — both transcripts are on disk — and foster notices. A copy
  the app has repointed at another conversation is recognised rather than counted as still standing,
  and what happens next depends on **what it now holds**:

  - **A branch of the very work it was fostered for.** The card is still one row, still showing that
    work, and further along than the original — so foster follows it. The fostering goes on tracking
    the same file, with its pointer moved onto the branch, and the sweep says
    `the app branched it and the copy here follows the branch`. This is a fix, and the bug it fixes
    was foster's worst: the fostering used to be dropped, the next sweep found the origin session
    untracked, and it wrote a **second** copy of the half the card had just moved off. One
    conversation, two rows in one sidebar, created by the run that was meant to tidy up. Measured on
    a real store, every one of the six copies the app had branched came back as a duplicate row. The
    record of the move is deliberately not the one `consolidate --undo` reads: the app moved that
    card, not foster, and offering to put it back would promise something foster cannot honour — and
    where foster _had_ moved that card earlier, the app overtaking it ends the undo claim rather than
    leaving a stale one for `--undo` to act on.

    Tracking it again does not make it ordinary. A sweep-wide `foster return` skips it, because the
    conversation on that card was born from opening that row and usually has no other card anywhere:
    removing it would take the work out of every sidebar, and `restore` could not offer it back,
    since a file foster unlinks leaves no deletion marker for that scan to find. Naming it with
    `--session` still reaches it — the same line foster draws around a copy you deleted in the app.

  - **Anything else.** Then the copy really is gone as a copy — it is a working card for unrelated
    work — and the conversation it was made for can be fostered again instead of being refused as
    "already fostered" forever. The card itself is left exactly where it is: the app made it what it
    is now, and removing it would delete something you can see.

- **It never ends the app behind your back.** Where a polite close would work (tray off) it uses one;
  where it would not, it says so and waits for an explicit yes rather than quietly escalating, and it
  names what that costs. `foster` refuses outright to close an app it is running inside — detected
  both from the process tree and from the environment the app stamps on the sessions it spawns,
  because an exited intermediate can break the first signal and the failure mode is killing the
  caller mid-write.
- **It handles credentials in named places, for named reasons, and never mints one.** For most of
  its life foster refused to touch an OAuth token at all, and everything else in this file grew up
  under that rule. The rule has been widened twice — first to read one, then to move one — and both
  times deliberately, so it is worth being exact about what changed and what did not.

  **The two credentials are not the same file, and the difference decides everything.** The Desktop
  app's token is a sealed blob in its config; foster reads it and could not usefully write it,
  because the app holds its account in memory and re-seals on its own schedule. The CLI's token is
  plain JSON at `<configDir>/.credentials.json`; every `claude` reads it at birth, which is what
  makes replacing it a switch and what makes it worth handling at all.

  **What reads the app's:** one command, `foster usage` (and the matching "Usage right now" in the
  menu). Nothing else does — not `foster`, `return`, `restore`, `purge`, `scan`, `status`, `whoami`,
  `accounts`, or the agent. The reader lives in one file, `store/credential.ts`.

  **What copies the CLI's:** `switch` and `guard`. Both go through `store/cliCredential.ts` and
  `engine/vault.ts`, and what they do is _copy bytes_: foster never mints a credential, never
  refreshes one, never removes one, and never signs anyone in. OAuth is interactive and stays yours.
  The bytes are copied verbatim rather than re-serialised, because a field this version does not know
  about is a field a rewrite would drop — and a dropped field in a credential produces a file that
  parses, looks right and does not authenticate.

  **Where the copies rest:** `~/.foster/vault`, under your own profile, one append-only JSONL file
  per `(client, account)`, each record naming whose it is so the vault can be listed without opening
  anything. It is not encrypted, and that is a choice rather than an omission: the file it copies is
  sitting unencrypted in the config directory already, so encrypting the copy would protect the shelf
  and not the shop, while adding a key foster would then have to keep somewhere.

  **The honest shape of the risk**, since it grew: the vault keeps every credential it has ever seen
  rather than the minimum, which is a deliberate trade of a larger at-rest footprint for the property
  that nothing foster does can make a credential unrecoverable. That makes it worth more to an
  attacker who already has your user account than a positional vault would be — and worth exactly
  nothing to one who does not, since it never leaves your machine, is never written to the
  repository, never logged, never printed, and never put on a command line. `foster vault` warns when
  `FOSTER_HOME` has moved it outside your profile. The credential object refuses to serialise itself
  through either of Node's two paths, so a future `--json` or stray `console.log` cannot leak one by
  accident. The ledger records that a switch happened, between which addresses, and how old the
  installed credential was; it never records a token, a refresh token, or their shape.

  **The agent is fenced off from all of it**, on the same footing as `purge`: `switch`, `point`,
  `client new` and `vault` are not among its tools and it is told not to reach for them through the
  shell. Changing who you are signed in as is not a step on the way to something else, and a
  credential is not a file for a model to move. The read-only half — `clients`, `accounts`, `usage`,
  `renewals`, `identify` — answers "which account has quota" without any of it.

  **What it does with it:** decrypts the token in memory, sends it as a bearer credential on two
  read-only `GET`s to `api.anthropic.com` — `/api/oauth/profile` and `/api/oauth/usage` — and drops
  it. The token is never written to disk, never logged, never put on a command line, and never sent
  to any host but `api.anthropic.com`. What it buys is the only data no cached file holds: your live
  5-hour and weekly limits, and a profile that is current rather than whatever the app last persisted.
  `identify` asks the same `/api/oauth/profile` for a different reason — to put a name on an account
  foster has never seen signed in. It works by presenting a credential that account itself left
  behind, in a CLI client or in foster's own vault, and keeping the answer only when the profile's
  own `accountUuid` matches the account asked about; a token belonging to someone else is discarded,
  never recorded against the wrong account. Like the rest of this half it goes to the network only
  when you run it, never on its own.

  **What still stops it cold:** the token is not stored in the open. Claude Desktop keeps it the way
  Chromium keeps a cookie — an AES-256-GCM blob under a key sealed with Windows DPAPI in `Local
State` — so reading it needs the Windows user who sealed it, on the machine that sealed it. A
  profile copied to another machine cannot be unsealed there, and neither can foster do it off a
  backup. It is Windows-only, current-account-only, and returns nothing rather than guessing when the
  token is absent or expired. `claude.ai`'s own billing endpoints (next charge, card, cancellation)
  sit behind a browser bot-check that foster does not attempt to defeat, so those remain unreachable
  from here and only `api.anthropic.com` is used.

  None of this reaches the app's account, which stays unswitchable for the reasons in
  [What about switching accounts?](#what-about-switching-accounts), and it changes none of the write-path
  guarantees above.

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
