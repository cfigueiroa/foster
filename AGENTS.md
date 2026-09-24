# AGENTS.md

Notes for an agent working in this repository, or driving `foster` on the machine it is
installed on. The README explains _why_ everything works the way it does; this file is the
short version of _what to run_ and _what will bite you_.

## Which foster you are actually running

`install.ps1` puts `foster` on the user PATH, so in PowerShell it is a plain command. It is
often _not_ resolvable from Bash on the same machine — check before assuming, and fall back to
the installed bundle:

```
node "$LOCALAPPDATA/foster/foster.js" --version
```

One look-alike wastes time if you reach for it first: `dist/foster.js` in a checkout is
whatever was last built there, which is usually **older than the installed bundle**. Check both
with `--version` before trusting either. Git worktrees under `.claude/worktrees/` have **no
`node_modules`**, so `npm run dev` needs an install first — for operating on a real store,
prefer the installed bundle and build from source only to test a change.

Start any operational task with `foster doctor`, then `foster clients` and `foster stores` —
they answer "which store, which account, is the app running" in three lines.

## The registry: four new event kinds

`~/.foster/ledger.jsonl` (relocatable with `FOSTER_HOME`) is append-only and the only thing
foster writes on purpose; `project()` folds it into the state every command reads. This milestone
adds four kinds to it: `profile_registered` / `profile_forgotten` name a Desktop profile for
`--store` (folded into `LedgerState.profiles`), and `client_root_registered` /
`client_root_forgotten` name a CLI config directory — or, with `as: 'container'`, a directory
that holds one per child — for `clients` and launch (`LedgerState.clientRoots`). None of the four
ever carries an account uuid, a token, or a URL: the root outlives whatever account currently
sits inside it, and registering a name already in use is a rename, not a refusal — the fold keeps
only the latest root for it. `ui.json` and `update-check.json` stay the only other mutable files
under `~/.foster`, and neither is a registry — preference and an update-check cache, not a record
of writes.

## `--store <name>`: resolution order, and what it now reaches

Four sources feed `foster stores` / `foster clients`: the installed app, whatever is running,
every store the ledger has been fostered into before, and — new — the registered names.
`--store <arg>` tries, in order: an existing path; a registered profile name, exact — tried even
against a directory that has since gone, so it fails naming the profile rather than just "not
found"; an account (a label, an e-mail, or a unique uuid prefix); then a distinctive piece of a
path. An ambiguous match at any of the last three steps is refused rather than guessed at
(`resolveStoreArg`, `src/engine/stores.ts`).

Naming a profile widens what that profile's own verbs reach, nothing else. `--store work sweep`
scans and writes inside `work`'s own `claude-code-sessions` — two profiles, two independent
sweeps, neither seeing the other's cards. `--store work rescue` lists `work`'s stranded cards
(the transcripts still come from the shared, CLI-side `transcriptRoots`). `--store work
consolidate` / `return` still need `work`'s own app closed, refusal-to-self-close intact. None of
them picks up a **client** root just because a profile was named — `client register` is a
separate registry for that, and it never reaches `purge`, `restore` or `live` regardless of
`--store` (see next section).

## Fleet directories: `client register --container`, and what it does not reach

`foster client register <path>` remembers a config directory outside the `~/.claude*` siblings
`clients` enumerates on its own; `--container` remembers a directory that holds one client per
immediate child instead (`~/.claude-contas/<name>`, one folder per account) — each child still
has to pass `looksLikeClient` on its own, and nesting stops at one level. Either way this is
**listing and launch only** (`registeredClientDirs`, `src/store/configDirs.ts`): it is never
folded into `configDirCandidates`, so nothing it names reaches `purge`, `restore`,
`live --prune/--stop`, `switch`, `point`, or the transcript scan `sweep` runs — `--config-dir
<path>` is still the only door onto a registered root for any of those, on purpose
(`tests/clients.test.ts` guards the shape).

## Opening a terminal as an account

`foster client open <client> [-d <cwd>] [--follow-link] [--guard] [--print]` opens a Windows
Terminal tab with `CLAUDE_CONFIG_DIR` set for that tab alone — the one thing on this machine that
resolves name -> directory -> identity -> live writers -> junction target before it opens anything,
and refuses the cases that bite instead of opening into them. Nothing here signs in or switches an
account — a client that is signed out still opens, onto the CLI's own login — and nothing is
written to the ledger; `--guard` is the one opt-in exception, reaching the vault the same
read-then-remember way `foster guard` does.

A junction is a pointer, not a client (see "Fleet directories" above): opening straight on one is
refused, because a tab that started on the link keeps writing through it after the next `foster
point`. `--follow-link` opens on the target instead, and the warning that follows still names any
other junction currently pointed at that same target — a terminal opened directly there spends
that rotation's quota too.

Two measurements this rests on were never made, so the code assumes the more dangerous answer to
both. Not measured as of 05/09/2026:

- **P7** — whether `wt -w 0 new-tab` inherits the _target_ window's own environment rather than the
  one this process hands the new one. If it does, a `CLAUDE_CONFIG_DIR` already set there would leak
  into the new tab's shell before the `-Command` ever runs — so both the scrubbed spawn environment
  and a second `CLAUDE*` cleanup inside the `-Command` itself apply, not just one.
- **P11** — whether opening a terminal directly on a fleet junction's active target competes with
  that fleet's own rotation. This stays a warning, not a refusal, and there is no `--fleet` flag to
  make it stricter.

`foster clients --fragment` gives every client its own entry in the Windows Terminal menu instead,
by printing a fragment (JSON) for the Terminal to pick up. Create the fragment folder once, then
redirect into it — in that order, because `>` does not create a directory:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster" | Out-Null
foster clients --fragment > "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster\clients.json"
```

Three things that bite: the Terminal writes a stub of the profile into your own `settings.json` on
first load; `wt -p <name>` with a name that does not match opens the **default** profile silently,
so use `client open` instead when being certain matters; and the fragment has to stay UTF-8 —
Windows PowerShell 5.1's `>` writes UTF-16 and breaks it. Restart the Terminal if the entry does
not appear.

## A launched Claude.exe never inherits foster's own `CLAUDE*` env

Foster commonly runs from inside a Code session the app is itself hosting, and that session's
environment carries markers (`CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_USER_DATA_DIR`, and anything else starting with `CLAUDE`, case-insensitively) that tell
the app and its bundled CLI "I am hosted". Every launch foster starts — `app start`,
`app restart`, the default installation or a second profile — hands the child a copy of
`process.env` with those stripped (`scrubbedEnv`, `src/engine/launchEnv.ts`) instead of letting
it inherit them, so a profile started from inside a hosted session does not come up thinking it,
too, is hosted.

## The full sweep — "bring everything into this account"

One command:

```bash
foster sweep            # what it would do, writing nothing
foster sweep --yes      # do it
```

It copies every fosterable session from the other accounts — **archived included** — gives
every branch of a forked conversation a row of its own, brings back conversations the app
deleted that nothing points at, then re-scans to say whether anything is left. Archived copies
stay archived, so they arrive in the app's _archived_ view rather than in Recents; say so, or
the user will look for rows that are not there.

A fork is one conversation continued in more than one account, each continuation on a
transcript of its own. The sweep does not choose between them, and it no longer calls every
other branch stopped. Three outcomes, decided per branch:

- the **tip** — the branch holding most records no sibling holds — keeps its title;
- a branch whose own last **answer** is later than the tip's, and that holds records of its
  own, **went on after the tip**: it is retitled `(other branch, went on DD/MM HH:MM) …` — or
  whatever `--branch-prefix` says — and **stays in the sidebar**, unarchived. Measured on a
  real store, two of the 40 forks the sweep could see looked like this — the fresher half 50
  and 77 hours ahead — and the old rule filed exactly the half the user had been working in;
- only a branch that really did stop earlier is retitled `(stale, stopped DD/MM HH:MM) …` —
  `--stale-prefix` — and filed in the archived view, native rows included.

"Went on" is judged on the last answer, never the last record: opening a stale row appends a
user record to its transcript, so the last _message_ can be a click rather than work
(`divergedFrom`, `src/engine/branches.ts`). Nothing is hidden; `foster consolidate` is the
optional tidy-up for anyone who wants one row.

Which conversations are branches of each other is decided before any of that, and
`conversationRoot` — the first record a transcript holds — only answers it when the app copied
the conversation from its beginning. A fork begun in the middle opens on a middle record,
rewritten with no parent, and the halves disagree about their root while sharing thousands of
records. `Lineage.deepen` closes that: a root found _inside_ another conversation is filed as
that conversation's work. It reads every transcript it is given without parsing them — 6.7 GB in
about 5 seconds against 118 for a JSON walk — and `forksOf` calls it before grouping, which is
why a sweep on a large store takes about half a minute rather than nine seconds.

## One conversation can be two files, and the row can open the shorter one

A `cliSessionId` names a conversation; it does not name a file. The app opens the transcript
under the project directory for that card's **working directory**, so continuing one
conversation from a repository and from a worktree cut out of it leaves two files under one id —
not copies of each other, each holding what was written while its own card was in use. Measured
on this store, over the roots foster scans: 41 conversations hold more than one file, 24 have
records the first file does not, 6070 records were invisible, worst single case 1362.

Everything that measures a conversation now reads **every** file it occupies (`scanOf` unions the
record sets, `rootOf` takes every file's head and files the extras as aliases, `deepen` reads them
all), so `only`, `total` and the moment a stale row is stamped with describe the conversation
rather than whichever file the directory walk offered first.

The second half is about what a row can open, which is not the same question. An account can show
a conversation and still be unable to reach most of it — 90 cards here open a partial file, 19,398
records out of reach — so the refusal "this account already has that conversation" is lifted when
the offered card opens records **no** row here can (`Sidebar.unreached`, `Lineage.reachOf`). The
result is a second row for that conversation, one per working directory, and the line says why:
`(a second file of a conversation already here: N record(s) no row here could open)`. It is asked
of the directory the **copy** will open in (`copyCwd`), because a card cut from a worktree is
rewritten to open in the repository it came from — unless its own worktree file is the one that
reaches more. "More" is measured against this account, not by file size (`worktreeReachOf`):
measured 15/09/2026, a worktree card whose repository file was the bigger one (4872 records
against 4802) lost a whole night's work — 2116 records only the worktree file held — because
the copy would have opened the repository file this account already showed, and the card was
skipped as already here. The sweep needs it in two places: a fork held in
two files went to the branch pass, which decides on the id alone, and was retitled rather than
completed.

Which of those two rows to continue in is no longer left to the reader. A pass of its own
(`foster sweep`, `src/engine/fileCards.ts`) elects **the row whose last answer is the most
recent** — where the work was left — leaves its title clean, and marks every other row of that
conversation `(other file, stopped DD/MM HH:MM) ` (`--other-file-prefix`), filing it in the
archived view. Measured 19/09/2026 on a real store: 12 such pairs in one account, the repository's
file the fuller one in 7 of them and the worktree's in 5 — so "the worktree row is the fuller one"
is not a rule, and nothing here guesses from the shape of a path. Two refusals hold it honest: a
row the branch pass has already marked is left to that pass, since a row can be on the losing side
of both questions and its branch is what decides whether it belongs in the sidebar at all; and a
row opening the _same_ file as the elected one is a duplicate, not a second file, so it is left
alone. Nothing is merged — `consolidate` still does not join two files of one conversation.

One thing this does not do: it never repoints or rewrites a card the account already has — the
existing row keeps opening what it opened. What it does do is reach past `already fostered`: since
#63, `resolveExisting` (`src/engine/executor.ts`) asks `unreached` of a copy the ledger vouches
for and that is still on disk, too, and when the file the offered card would open holds records
beyond what this account reaches, it makes a second row instead of skipping — once, not once per
run. The test "brings the worktree file of a conversation whose earlier copy the ledger vouches
for" (`tests/executor.test.ts`, added in #109) walks that path.

**A mark written by an earlier run is recognised from the ledger, whatever words it used** (#35).
`CardRetitledEvent`/`FosteredEvent` now carry the `template` a mark was made from, and
`templatesSeen` (`src/domain/stale.ts`) falls back to deriving it from old entries that predate the
field — so a bare `foster sweep` recognises a row the `/fosteia` skill marked `(defasada, parou
{when}) `, and a Portuguese sweep recognises one the English default marked. Measured on a real
store: 10 rows would have been rewritten that way by one bare `foster sweep --yes` on 05/09/2026 —
before the fix. `--stale-prefix` and `--branch-prefix` still choose the words a _new_ mark is
written with; `--branch-prefix` defaults to English, and the `/fosteia` skill passes both in
Portuguese so a fresh mark reads in the language the sidebar is read in, not because passing only
one would stack any more. A row wearing a mark no known template can explain — a hand edit, or a
write from before this shipped — is skipped rather than guessed at, and named in the sweep's
summary so the words can be fixed by hand or the run repeated with the matching prefix.

You are done when it prints **"Nothing is left to sweep"**. It also counts what can never come —
scheduled tasks, sessions never opened, files over the 10 MB the app refuses to load — so report
that line rather than leaving the user to wonder what the gap was.

One invocation finishes what used to take three. Measured 24/09/2026: `/fosteia` printed "Not
finished" twice, and each re-run re-read 6.7 GB of transcripts. Two causes, two fixes. A round's
own writes can hand the next round work — a copy the ordinary pass brought completes a fork the
branch pass had already judged without it — so `runSweep` now takes up to `SWEEP_ROUNDS` (3)
rounds in the same process when its re-plan still finds work, reusing the lineage and every other
account's scan, and says "Took N rounds" when it did. The rest was the running app saving 10 of
49 fresh marks back over from memory within three minutes, after the run's own re-plan had
passed; that is `engine/marksBack.ts` in the layout gap, below.

The same day's profile: an 85-second dry run spent 42 s in the garbage collector. The store held
25,174 cards, 1 GB of JSON, 93% of it `remoteMcpServersConfig`, and the sweep kept every card of
every account alive for the whole run. A scan now leaves `BULKY_CARD_FIELDS`
(`store/sessionFile.ts`) out of what it keeps (`DiscoveredSession.slim`), and the one write that
copies a whole card reads them back from disk first (`withBulkyFields`, `executor.ts`) — any new
writer that spreads a scanned card's `data` into a file must do the same. `planUnclaim` and
`planTitleSync` take the cards the sweep already read instead of re-reading each off disk. With
`/fosteia`'s flags, a dry run went from 131 s to 45 s.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. When
foster is running inside the app it will not do that (see below) and the output ends with the
command to run elsewhere instead.

`sweep` deliberately never purges and never consolidates. Pass the "forked conversation" line
on as it is: rows added, rows retitled, and that the clean title is the row to continue in.

A fourth pass releases the worktree claim a copy already on disk inherited from its original,
before 0.38.0 taught fostering not to hand one out (`foster unclaim`, issue #26's second half).
It only ever touches copies — the ledger's own active fosterings decide that, never a scan — and
is folded into the same "nothing is left" check.

Releasing a claim takes no write guard, like `retitle`: it is allowed with Claude Desktop open,
never refused for it. A card the app rewrites in the meantime simply keeps (or regains) its claim
on disk, which the next `foster unclaim` or sweep pass finds and releases again — the change itself
only becomes visible at the app's next restart, the same as a retitle.

## You cannot restart the app from a session the app started — except through `--detach`

A Claude Code session launched from Claude Desktop's sidebar is a **child process of the
app**. `app quit` and `app restart` want the app closed, and closing it kills the session
part-way through — which is why foster refuses to close an app it is running inside.
`consolidate --yes` and `return` are narrower than they used to be: since #15 they hold only
what the app is actually holding — a native card, or a copy that already existed when the app
started — so the rule is **run them before the restart, not after**, and a card the app itself
made waits either way. `sweep --restart` asks first and hands over the command instead of
failing at the end of a run that already wrote everything.

`--detach` (on `app restart`, `layout`, `view set`, `view copy` and `sweep`) is the one way
around the refusal itself, not a way to skip asking. Measured end to end 22/09/2026:
`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments
@{CommandLine='wscript.exe "<vbs>"'}` starts a process whose parent is `WmiPrvSE.exe` — outside
the app's tree and its MSIX container — so it survives the app quitting. The `.vbs` runs
`cmd.exe /c "ping -n <delay+1> 127.0.0.1 >nul & echo … & node "<foster.js>" <args> & echo …"`
through `WScript.Shell.Run(cmd, 0, True)`: window style `0` is what actually hides it on this
machine, where Windows Terminal is the default terminal and a console process pops a window
even under `-WindowStyle Hidden`. What it launches is the same command again, minus `--detach`
— so `foster layout --yes --restart --detach` writes nothing itself; the detached re-run of
`foster layout --yes --restart`, outside the app a few seconds later, is what actually quits it,
writes in the gap, and starts it again. `sweep --detach` is narrower still: the sweep's own
writes happen now, in-process, as always — only the restart at the end is handed to the
detached process, as `foster app restart` or `foster layout --yes --restart` (whichever `sweep`
would otherwise have printed).

The cost is not optional and is said before it is paid: **every session the app hosts ends when
it quits, this one included**, with no way to warn one first and no undo. `--detach` reads the
live-session registry the way `foster live` does and refuses outright, naming them, if it would
end anything besides the session it is running in — `--detach-even-with-live` is the override,
and it then names every session it is ending before it launches. The `/fosteia` command passes
it on its final `foster layout --yes --restart --detach`, by the user's decision of 24/09/2026 —
that one command and no other; nothing else in this codebase adds it on its own initiative (see
the command's own "Never" list). Pitfall measured writing the `.vbs` generator: `Log` is a VBScript built-in
function, and a variable named `Log` kills the script with an error dialog before anything
runs — `src/engine/detach.ts` never names one of its own variables after a VBScript built-in
(`Log`, `Date`, `Time`, `Len`, …), and a test holds that promise.

The session that launched a detached restart is gone by the time it lands — there is no way for
it to say whether the write actually happened. `foster detached --last` is what reads that back,
from `<FOSTER_HOME>/detached/<stamp>-<verb>.log`: pending (no `start` line yet), running (`start`
with no `end`), or done. Read it in a **new** session, after the app is back.

Check before promising anything:

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p) { "$($p.ProcessId) $($p.Name) $($p.ExecutablePath)"; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
```

An ancestor under `WindowsApps\Claude_*` means the answer is: hand the user the command for
a terminal outside the app. Do not try to work around it.

That probe is PowerShell, and PowerShell is not always the tool that answers (see the next
section). When it is stuck, ask wmic the same question about one pid instead:
`wmic process where "ProcessId=<pid>" get ParentProcessId,Name,ExecutablePath /format:list`.

## A reported "live writer", and why the pid alone was not one

Foster decides a conversation has a live writer from a registry file under
`<configDir>/sessions/<pid>.json`. "Does that pid still exist" is not enough on its own —
Windows reissues pids quickly, and after a reboot much of a day-old registry names whatever
took the number next. So the record's own account of its writer is checked against what the
pid names now:

- the CLI writes the writer's creation time into the file (`procStart`). Two processes can
  share a pid but not a pid _and_ a creation instant, so a match is proof and a difference
  is proof of the opposite;
- with no creation time to check — an older CLI — a process that is not a Code CLI at all,
  or one that started after the record describing it was written, is a stranger.

Where there is no process table to read (anything that is not Windows), every entry stays
listed and `live --stop` refuses rather than guessing. Trust the warning; what it will not
do is name a writer that is not there.

`live --stop` is still `taskkill /F /T`, so whatever that session had not written is lost —
and it refuses a pid it could not identify, and the session foster is itself running in.

`foster live` and `app status` now also say **which store hosts** a live session, not just its
raw cwd: each registry entry is cross-referenced against every known installation's own card
(`hostedStoreFor`, `storeHoldsSession`) and printed as `hosted by <name|root> · last seen as
<label>`. An entry whose card cannot be found anywhere stays unlabelled rather than guessed at.

The same "prove it, don't just fail to look like something else" rule now guards `app
quit|restart` against the opposite mistake. A standalone `claude.exe` — someone's
`~/.local/bin/claude.exe`, run from a terminal, never installed as the app at all — used to pass
`isDesktopProcess` by elimination (not the Code CLI, therefore the app), and with the app closed
a machine carrying several of them turned each into an orphaned "desktop" row that
`app quit --terminate` could pick as the oldest and kill. It now demands positive proof instead:
a path under a known store root, under the app's own `\Packages\Claude...` directory, or a child
process carrying Electron's `--type=` — absence of the CLI's markers no longer counts as
presence of the app's.

## Reading processes no longer needs a live PowerShell

Symptom measured 05/09/2026 on this machine: PowerShell hangs at start-up (`InitializeDefaultDrives`
of the FileSystem provider, blocked on a WinFsp/Cryptomator drive that had stopped answering), every
`powershell.exe` invocation waits the full 20 s and then errors, and `foster app status`, `foster
live`, `foster stores` and `foster doctor` each pay that 20 s and then report an empty machine — a
lie, and a dangerous one for `live --stop`, which decides what to kill from that table.

`readProcesses()` now falls back: PowerShell first, then `wmic process get ... /format:list` (same
six fields — pid, parent pid, name, path, command line, start time), then `tasklist /fo csv /nh`
(pid and name only). A PowerShell that fails once is not retried for the rest of that run — the hang
is paid at most once. Run `foster doctor` and read the `process table` line: `via PowerShell` is the
healthy case, `via wmic — <reason>` means PowerShell was passed over but the table is still full,
`via tasklist (partial: ...)` means only pid and name are known, and `unreadable` means nothing
answered at all.

A table read through tasklist refuses rather than guesses: `app status` says it cannot tell the app
from a Claude Code session, `live --stop` will not touch a partial row, and `sweep --restart` hands
over the command instead of trying. Do not treat a partial table's empty path or command line as
evidence of anything — it means the reader could not report one, not that there was none.

When PowerShell is stuck and you need the answer directly, these run without it:

```
tasklist /fo csv /nh
wmic process get ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate /format:list
```

## Reviving what a usage limit stopped

`foster revive [--since 24h] [--json]` lists the sessions in the current account whose
conversation ends on the app's own limit record (`isApiErrorMessage: true`, `error:
"rate_limit"`) — read from the file each card opens, never from the card, whose `error`
fostering drops. One row per conversation and per repository branch, the latest stop kept;
live writers and the duplicates it dropped are named in `passedOver`. It writes nothing and
sends nothing: the `/retoma` skill, run inside Claude Desktop, delivers the "quota is back,
carry on by highest return" message with `send_message`. A headless resume is not a substitute
— it never reattaches the card (next section).

## Rescuing "cannot reach your computer" cards

`foster rescue` lists them; `--open` opens a terminal tab per conversation, stopped at the
resume prompt. Two facts that save wasted turns (both measured on a live store):

- `foster resume` / `claude -p --resume` **does not reconnect the card** — print mode never
  attaches to the app. It spends the tokens and the card stays unreachable.
- An agent running **inside Claude Desktop** can rescue without terminal tabs: deliver a
  message to the stranded card with the app's own session tools (`foster rescue --json` is
  the work list) and the app hosts the conversation itself, which re-links the card. The app
  refuses a card whose directory is gone — recreate the worktree first
  (`git worktree add --detach <path>`) — and delivery runs a full turn, so the message must
  say "do not resume any pending work".

  Finish the job while you are there: the fresh hosting card arrives **untitled** (it shows
  as "General coding session") and the husk keeps the real name. Copy the title over with
  `set_session_title` — drop a leading "↪ ", foster's old copy marker — and archive the husk
  with `archive_session`; it never reconnects. None of this can run from the CLI: the app
  creates the fresh card on its own, and the session tools only exist inside the app.

## What `foster agent` does and does not cover

`foster agent "<task>" --yes` exposes ten tools: `scan_accounts`, `list_sessions`,
`foster_status`, `app_status`, `read_transcript`, `label_account`, `foster_sessions`,
`sweep_everything`, `return_fosterings`, `resume_headless`. `sweep_everything` is the one to
reach for on "bring everything here": `foster_sessions` leaves archived sessions behind and
cannot reach deleted conversations at all. **`consolidate`, `purge` and `live` are not among
them** — `purge` is excluded on purpose and must not be reached through the shell either.

## The registry has two views

Measured on 2026-09-05, against a real MSIX install (`Claude_pzs8sxrjxfjjc`):

- Claude Desktop's manifest routes `claude://` through **package activation**, not the classic
  per-user registry key you would expect to find and edit — `HKCU\Software\Classes\claude\shell\
open\command` is not what actually decides where a callback lands.
- **Inside the app's container** — any process descended from it, including every Code session it
  hosts — that key exists anyway, holding the app's own executable. It is MSIX registry
  virtualization's private copy of the write Electron's `setAsDefaultProtocolClient` makes; a
  browser running outside the container never sees it. It is a decoy.
- **Outside the container** — an ordinary terminal — the `claude` class key exists with just a
  `URL Protocol` marker, and there is normally no `shell` subkey at all.

Any `reg` read `foster` does from inside a hosted session is the virtualized view: it can tell you
what the app's container believes, never what a browser on the same machine would actually reach.
`foster doctor` says so explicitly (`registry seen from inside the app's container: ...`) rather
than judging a handler it cannot trust.

## The packaged store's two paths fold, or they don't, depending on where you run

Measured 05/09/2026, same MSIX install: the packaged app answers to two paths — the
`Packages\Claude_<hash>\...` directory and the pre-virtualisation `%APPDATA%\Claude` one —
and `directoryKey` (`src/domain/paths.ts`) folds them into a single `foster stores` row only when
`statSync` reports the same device and inode for both. Inside the app's own container that is
true, because MSIX virtualisation makes `%APPDATA%\Claude` a view onto the package directory. From
an ordinary terminal it is false — the two are genuinely different directories, and `%APPDATA%\Claude`
is the real pre-MSIX store, still holding whatever was fostered into it before the app was packaged.
Run `foster stores` from inside a hosted Code session and you see one installation; run it from an
ordinary PowerShell on the same machine and you see two.

`isLegacyAppDataStore` (same file) is what keeps the second row honest: it labels `%APPDATA%\Claude`
`legacy (pre-MSIX)` only when a `Packages\Claude*` store is actually present on the machine and did
not fold into it — never from the shape of the path alone. That gate matters because
`%APPDATA%\Claude` (or its platform equivalent) is simply _the_ store on macOS, on Linux, and on a
Windows machine that was never packaged at all; calling it legacy there would be wrong, not just
imprecise.

## Signing a second profile in

Measured 05/09/2026, superseding the classic-key hypothesis above: what actually decides where a
`claude://` callback lands is a **packaged ProgID** — `HKCU\Software\Classes\AppX<hash>`, the key
Windows itself created when it registered the package — never the classic
`…\claude\shell\open\command` key, which `foster` no longer touches at all. The ProgID's `Shell\open`
subkey carries `AppUserModelID` (which package this is) and `Parameters`, the argument string
appended to the package's own executable at activation time, normally just `"%1"`.
`foster --store <profile> app login --yes` finds that key (`findProtocolProgId`), points
`Parameters` at `--user-data-dir=<profile> "%1"` for one sign-in, and puts back the exact value read
before it wrote — **the one registry VALUE this ever touches, never a key, never a level**: the key
always already exists, so there is nothing to create or delete. It waits until the sign-in lands or
Ctrl+C; `--timeout <seconds>` caps it. It needs `--yes` — without it, it only prints what it would
do. It refuses outright from inside Claude Desktop's own container (see above) — a change there is
invisible to the browser regardless of what follows.

A second, independent fact the same measurement uncovered: the callback process only _finds_ the
profile it means to forward to when that profile's own instance was itself started **with package
identity** (`Invoke-CommandInDesktopPackage`, not a bare `Claude.exe` child process) — `app start`
and `app login` both start a profile this way now on a real MSIX install, falling back to a direct
launch only when the cmdlet is missing or fails, and say which one won. `app login` refuses when the
running profile has no package identity rather than arming a handler whose callback cannot land;
`--restart-profile` closes it and starts it again the right way in one step. Separately, a profile
that comes back from a restart can come up with its window hidden (signed in, nothing visible); both
`app start` and `app login` give it a few seconds and, if it has not appeared, send one more launch
to raise it.

Edge and some Chrome profiles hold a standing permission to auto-launch `claude://` from claude.ai
with no dialog — so `app login` arms `Parameters` _before_ telling the user to click "Continue with
Google", never after, and its own instructions say an auto-opened Claude window is expected, not a
mistake.

**An agent must never run this**: it writes a machine-wide registry value and drives a sign-in only
the human at the keyboard can finish in the browser. **Never print a `claude://` URL: it carries a
single-use code** — not in `app login`'s own output, not in `app link`, not anywhere a log or a
transcript could keep it. `foster app login --restore --yes` is the way out of a login left routed
by a crash or a stray Ctrl+C; `foster doctor` reports the ProgID found and warns when `Parameters`
is still routed to a profile.

## Groups and routines: `foster layout`

Measured 22/09/2026, real MSIX store, app 2.2553.1.0.

Sidebar **groups** live in `<store.root>/claude_desktop_config.json`, at
`preferences.epitaxyPrefs["dframe-group-scopes"]["<accountUuid>/<organizationUuid>"]` — one scope per
account/org, holding `groups` (`{id, name}[]`, array order is sidebar order), `assignments` (card id
`code:local_<uuid>` -> group id) and an optional, partial `order` (group id -> card ids). The app owns
the file and rewrites the scope within seconds of a group being created through the UI — same rule as
`store/pinstate.ts`: write only while the app is closed, back up first (`store/groupScopes.ts`,
`writeGroupScope`, same "verify nothing else moved" discipline as `writeAppPref`). An archived card
cannot be shown in a group — the app's own tool refuses it — so a target whose only matching card is
archived is skipped and reported, never assigned.

**Groups live in three places**, not just the config file above: the same scope also sits in Local
Storage, once under its own key (`LSS-persisted.dframe-group-scopes`, keyed the same
`<accountUuid>/<organizationUuid>` way, wrapped in a `{value, tabId, timestamp}` envelope) and again
folded into `dframe-store`'s own `state.customGroupsByScope` — the same database the filter menu
below lives in. `applyLayout` (`localStorageGroupWrites`, `src/engine/layout.ts`) writes all three
together in one batch (`writeLocalStorageEntries`, one sequence number for every Local Storage key)
whenever a Local Storage database exists at all — skipped, not failed, on a store the sidebar's
filter menu has never touched yet.

**What the app trusts at startup: a fourth place, the server.** Measured 23/09/2026, 0.58.0, app
2.7032.0.0. A detached `foster layout --yes --restart` quit the app at 08:36:20, wrote the target's
scope to all three places, and the app started again at 08:36:22 — and at 08:36:25 rewrote the
config and both Local Storage keys **without** the target's scope; `list_groups` answered "No custom
sidebar groups". Routines, written in the same gap, survived. Not a write that lost the race: the
Local Storage `LOG` says LevelDB reopened at 08:36:23 reusing the very log foster had appended to,
with no corruption, and foster's records (5 groups, 27 rows) sit in the table it flushed next — one
sequence number before the app's own write that emptied them. The sidebar is claude.ai code, not
the desktop app's (`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/`, read that day):
`dframe-store` is a zustand store registered as a **server-synced store** (`ccd/dframe-store`, the
account's `/api/claude_code/organizations/<org>/user_settings`). At startup the page hydrates from
Local Storage, folds the config's scopes in only where Local Storage has none, then reconciles with
the server — and the server merge replaces the signed-in account's **list of groups** with the
server's, keeping a local `code:local_*` assignment only when its group id is one the server already
knows. Those assignments never go up (a local session is machine-local); the group list does. A
group foster minted had an id the server had never seen, so every assignment to it went with it.
Other accounts' scopes survive because only the signed-in account's scope is synced.

The page's own way out is the Local Storage key `ccd-sync-pending:ccd/dframe-store`, a bare string
(`DFRAME_SYNC_PENDING_KEY`, `src/store/localStorage.ts`). When it names the signed-in identity —
`<accountUuid>/<orgUuid>`, the same string `scopeKey` builds, or the wildcard `1` — startup uploads
the local state instead of taking the server's, and a `|migrate` suffix unions the server's groups
in first (`mergePendingSeed`), which is what the page itself writes when it migrates legacy groups.
The page sets it on every sidebar edit and deletes it once the upload lands. `applyLayout` now
writes `<scopeKey>|migrate` into the same batch as the two documents, and leaves alone a marker that
already names the target (it already uploads; turning it into a merge would bring back a group the
user deleted here). Under any other signed-in account the page clears the marker unused.
**Watched through a restart the same day, 09:36:** a group with a freshly minted id and one row,
written in the gap with the marker, came back with its row; 60 s after start the page had consumed
the marker (gone from Local Storage), and `dframe-store` held the local groups plus the server-only
ones `|migrate` had unioned in. The scope still held it after three more restarts. Even so, `foster
layout --yes --restart` no longer ends on "with the layout applied" on the strength of the write —
the page is claude.ai code and can change under it any day: it waits for
the app's own rewrite of the config (≤30 s, then 5 s quiet — `verifyLayoutGroups`,
`src/engine/layoutVerify.ts`), reads back every row it filed, and says how many the app dropped
and from which groups, exiting 1, when it dropped any. The recovery that held on 23/09 is still
the fallback: the app's own `create_group` + `move_sessions`, fed from `foster layout --json`'s
`assign` lists. Groups created that way with no rows never reach the config file (the page writes
only groups that hold a row), so a later `foster layout` still lists them as new.

**Routines** (scheduled tasks) live per account/org at
`<store.root>/claude-code-sessions/<accountUuid>/<orgUuid>/scheduled-tasks.json`
(`store/routines.ts`). Every account/org directory has one, often with an empty list. `filePath`
points at a `SKILL.md` under the shared CLI config dir, so the same path is valid from any account —
nothing here is Desktop-store-specific except the enable flag and the schedule. Same closed-app rule,
same backup-first convention.

`src/engine/layout.ts` (`planLayout`/`applyLayout`) does the planning and the write. A target card
already carrying any assignment is left alone regardless of which group a source proposes — the
user's own filing always wins, which is what makes a second `foster layout` plan nothing. A
conversation named for two different group names across sources is a conflict, resolved by the
source card with the latest `lastActivityAt`, and reported rather than silently picked. A routine
already known to the target (enabled or not) is left alone too, and a one-shot already overdue
(`fireAt <= now`, no `cronExpression`) is never brought — the app fires an overdue task at its next
launch, and a stale one firing unasked in an account that never scheduled it is worse than a gap.

**Pins** ride the same gap. The sweep marks a pinned row (a branch that stopped, or the other file)
and wants the pin on the row to continue in, but the pin list is the app's IndexedDB and a sweep
from inside the app can never write it. Measured 23/09/2026: that move used to be one line of the
summary and then forgotten. Now the sweep appends `pin_move_deferred` to the ledger and `foster
layout` writes every pending move while the app is down (`engine/pinMoves.ts`), settling each with
`pins_moved` — written, or found already undone by hand, so a row re-pinned on purpose is left alone.

**Marks** ride it too (`engine/marksBack.ts`). A retitle is written with the app open, and the app
can save a card it holds back over it: measured 24/09/2026, 10 of 49 fresh "(outro arquivo, …)"
marks were gone three minutes later with no foster event in between. In the gap — `foster layout`,
or `sweep --restart`'s own when the sweep marked anything — every card of the target whose last
ledger write is a retitle, and which now shows a title foster has seen it wear _before_ that
write, gets the write again (title and archived flag). Any other title was somebody's rename and
is left alone; a lifted archived flag under the right title is left alone too.

`foster layout --yes --restart` shares its quit-write-start machinery with `foster sweep --restart`
(`restartAround` in `src/cli/index.ts`) but runs the write **inside** the gap between quit and start,
since these two files are only safe to touch while the app is down — `sweep` writes everything
_before_ asking to restart, so it passes no callback into the same helper. `foster sweep` plans a
layout read-only alongside its own passes (`ops/sweep.ts`, never applied there) and mentions it in
`sweepSummary` when anything is pending; that line never counts toward "nothing is left to sweep",
because a layout needs the app closed and a sweep run from inside the app can never close it.

## The sidebar's filter menu: two stores

Measured 22/09/2026, same store/app; re-measured the same day via the app's own `set_view` tool
after an earlier pass over this file called two of the seven settings machine-wide or unsuffixed,
which was wrong on both counts. Seven settings in the Code sidebar's filter menu, split across two
stores that do not line up with how the menu reads:

- **Machine-wide**, in Chromium's Local Storage (`<store.root>/Local Storage/leveldb/`, key
  `dframe-store`) — only `groupByByMode.code` and `sortByByMode.code`. A second, sibling LevelDB
  database to the one `store/pinstate.ts` reads for pins, encoded more simply: no Blink envelope,
  no separate "exists" entry, just a one-byte string tag in front of the value.
  `store/localStorage.ts` reuses `store/format/leveldb.ts` for the read and the write; reading
  checks both the log and any compacted sorted table, same as pinning. The same record also carries
  `state.recentsStatusFilter` — a different list the app keeps for something else entirely; it is
  never read or written for the status filter, and `foster view` never touches it.
- **Per account**, in `claude_desktop_config.json`'s `preferences.epitaxyPrefs`, all five remaining
  settings, every one suffixed with the account uuid:
  `code-sessions-status-filter.<accountUuid>`, `code-sessions-state-activity-days.<accountUuid>`,
  `code-sessions-selected-environments-v2.<accountUuid>`,
  `code-sessions-show-empty-projects.<accountUuid>`, `code-sessions-show-pr-status.<accountUuid>`.
  Status and the activity window are the two an earlier reading of this file got wrong — the app's
  own `set_view` tool showed both suffixed the same as the other three. `store/viewPrefs.ts` reads
  and writes these, sharing the same "verify nothing else moved" write as `store/groupScopes.ts`.
  Four legacy, un-suffixed keys from an older build (`code-sessions-status-filter`,
  `code-sessions-selected-environments`, `code-sessions-show-empty-projects`,
  `code-sessions-state-activity-days`) still sit in the file on an installation old enough to have
  them; the UI no longer reads them, so `foster view` reports them as legacy and never writes them.

`src/engine/view.ts` plans and applies both halves through one call (`planViewSet`/`applyViewSet`),
and the per-account half alone (all five keys) through `planViewCopy`/`applyViewCopy` (`foster view
copy`). Grouping by "Estado" forces `status: active` — the app's own rule, not foster's invention —
so a request that sets `--group-by state` sets the status too when it is not already active. Both
files need the app closed to write, guarded the same way `foster layout` is, and `--restart` shares
the same `restartAround` helper. `foster layout` also carries the per-account half of this menu —
status and the activity window included — from the first other account that has any of it set, when
the target has none — the same "target already has one, leave it" rule groups follow; the
machine-wide half needs no copying, since one Local Storage record already covers every account on
the installation.

## The ledger is read once per instance, not once per call

Measured 24/09/2026, a real ledger: 23 MB, 30,445 events, reading and parsing it costs
160-290 ms depending on the machine, and `Ledger.read()` is called on the order of a dozen times
per sweep round (`ops/sweep.ts`), up to three rounds, plus once per copy in the branch pass
(`applyBranchCards` → `fosterSessions` → `project(ledger.read())`, `engine/executor.ts:175`,
`engine/branchCards.ts`). `Ledger` (`ledger/log.ts`) now caches its own parse, keyed on
`(size, mtimeMs)` from `statSync` rather than trusted blindly — a ledger changed from outside this
instance (a second `foster` process, a hand edit) still forces a reread. `append()` keeps the cache
in step by pushing the new event onto the same array and re-stating for the new key, instead of
dropping it, so a run that both reads and writes the ledger many times (a sweep round) reparses at
most once — but only once it has checked the file's size/mtime _before_ the write against what the
cache still claims: without that check, an event a second writer appended between this instance's
last `read()`/`append()` and this `append()` call would be silently dropped from this instance's
view forever, because the write's own post-append `statSync` would then make the cache's key match
the real file exactly and no later `read()` would ever re-fetch it to notice. A mismatch drops the
cache instead of growing it, so the next `read()` reparses from disk and picks up everything,
including the other writer's event (`tests/ledger.test.ts`, "does not lose a concurrent writer's
event..."). `read()` hands back the live cached array, never a defensive copy — checked across
`src/`, nothing mutates what it returns, only iterates it.

`project()` (`ledger/project.ts`) memoizes its own fold over the same array, by identity and
length (a `WeakMap`, so it does not keep an abandoned events array alive) — the same
"append pushes, does not replace" behaviour is what lets a `Ledger` instance's later `read()` still
hit this cache. Two existing callers mutate the `LedgerState` they get back mid-run to reconcile it
against what they are about to write — `fosterSessions` deletes a reconciled fostering from
`state.active` (`executor.ts:274`), `identifyHeldAccounts` adds a newly-seen identity to
`state.identities` (`cli/index.ts`, via `identify.ts:167`) — which used to be harmless because every
call got its own fresh Maps. Memoizing without defending against that would leak one call's
mutation into the next call's state whenever the two share a cache entry, which is exactly the
shape a dry-run batch with no ledger writes in between produces (several `fosterSessions` calls,
each `project(ledger.read())`, same array). So `project()` itself always returns a fresh shallow
copy of the memoized fold — new `Map`s, same entries — cheap next to the fold it is avoiding: on
the real ledger above, the fold itself costs 70-130 ms and a clone of its `Map`s a few ms.
Measured with a micro-benchmark standing in for the branch pass's per-copy call (50x
`project(ledger.read())` in a row, no writes between): 9.8 s uncached, 0.5 s cached, on the same
ledger.

`appendFileSync` does not check that the file it is growing already ends in a newline. A line left
torn on disk — the detached restart's `taskkill /F`, a power loss mid-write — glues to whatever is
appended next: the merged line is neither valid JSON nor separated from its neighbour, so
`parseLedgerEvent` drops it whole and _both_ events are lost, not just the one that was already
damaged. `Ledger` now checks the last byte of the file once, on its first `append()` per instance
(an `openSync`/seek/`readSync`, not a full read of a 23 MB file), and prefixes a newline first if it
is missing — nothing but this instance's own appends can retorn the file once that is fixed, so
later appends skip the check.

`doctor` used to read the process table twice — once through `inspectApp`, once through
`runningStores` a few lines later, each defaulting to `readProcesses` rather than the 5-second
`cachedProcesses` (`util/processes.ts`) — a second PowerShell spawn for an answer the first one
already gave. Both calls in `cli/index.ts` now pass `cachedProcesses` explicitly. `identifyHeldAccounts`
in the startup `preAction` hook (`NAMES_ACCOUNTS`, `cli/index.ts`) was already gated to the commands
that print an account by name — not every command — from #52, well before this; what it still pays
on those commands is one PowerShell spawn to unseal the Desktop's DPAPI-sealed token
(`store/credential.ts:183`), which has no process-table equivalent to cache.

Considered and dropped: `module.enableCompileCache()` in the bundle's banner. It persists V8's
compiled bytecode for modules loaded _after_ the call, which sounded like a real saving for a CLI
that is a new short-lived process each time — but it cannot cache the compilation of the script it
is running inside, which V8 has already fully parsed and compiled before any of that script's own
top-level statements execute. Measured directly: the built bundle's `foster --version`, timed over
multiple 20-run trials with a warmed persistent `NODE_COMPILE_CACHE` dir (the real-world
repeated-launch case the banner was meant for), was statistically indistinguishable with and
without the call. Since this bundle is a single self-contained file (`noExternal` above), the only
thing it could ever help is `src/agent/sdk.ts`'s own `import()` of the Agent SDK and zod — the
sole dynamic `import()` in this codebase, and not on the hot path of an ordinary command
(doctor/stores/clients/sweep/...) — so it was not worth the added banner complexity and the claim
was not worth keeping in this file.

`tests/setup.ts` now points `HOME`/`USERPROFILE` at a fresh `mkdtemp` directory before any test
file's own imports run. `configDirCandidates`, `inUseConfigDir` and the rest of
`store/configDirs.ts` default their `home` parameter to `os.homedir()`, which — unset — is this
machine's real profile: measured on this store, 13 GB under `~/.claude*` that a unit test has no
business scanning, and `os.homedir()` on win32 reads `USERPROFILE` first. Every default-`home` call
is a lazily-evaluated parameter, not cached at import time, so setting both env vars once at the top
of the setup file is enough. Measured 24/09/2026: the suite went from 39 s to 7-16 s (machine load
dependent) for the same ~1,631 green tests (1,641 with the tests this milestone adds), and
`tests/interactive.test.ts` alone from over a second to under one. Nothing in the suite depended on
the real home — a full `npm run check` with an empty temp `HOME`/`USERPROFILE` passes exactly as it
did before.

Real-data timings (`FOSTER_HOME` pointed at a scratch copy of `~/.foster`, never the real one; the
Desktop store read only): `doctor` 8.2-8.4 s before this milestone, 6.4-7.6 s after (removing the
doubled process-table read; the rest is PowerShell's own cold-start cost on this machine, unrelated
to any of this). A `sweep` dry run on a store with nothing left to bring (no fostering or branch-pass
copies to write, so the per-copy `project(ledger.read())` saving above does not get exercised) went
from 68.7 s to 62.6 s — the eight-or-so `read()`/`project()` calls per round are a much smaller share
of a real sweep's time than the branch pass's per-copy calls are, which the micro-benchmark above
measures in isolation.

## Before pushing

```bash
npm run check
```

`npm run privacy` is the one to remember when writing prose or fixtures: this repository is
public, and the guard rejects any Windows user-profile path, any UUID that does not look
obviously synthetic, and two personal identifiers that reached it once. Fixture uuids look
like `00000000-0000-4000-8000-00000000000a`.
