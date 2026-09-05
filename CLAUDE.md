# CLAUDE.md

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
  real store, 111 of 209 forks looked like this, and the old rule filed exactly the half the
  user had been working in;
- only a branch that really did stop earlier is retitled `(stale, stopped DD/MM HH:MM) …` —
  `--stale-prefix` — and filed in the archived view, native rows included.

"Went on" is judged on the last answer, never the last record: opening a stale row appends a
user record to its transcript, so the last _message_ can be a click rather than work
(`divergedFrom`, `src/engine/branches.ts`). Nothing is hidden; `foster consolidate` is the
optional tidy-up for anyone who wants one row.

You are done when it prints **"Nothing is left to sweep"**. It also counts what can never come —
scheduled tasks, sessions never opened, files over the 10 MB the app refuses to load — so report
that line rather than leaving the user to wonder what the gap was.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. When
foster is running inside the app it will not do that (see below) and the output ends with the
command to run elsewhere instead.

`sweep` deliberately never purges and never consolidates. Pass the "forked conversation" line
on as it is: rows added, rows retitled, and that the clean title is the row to continue in.

## You cannot restart the app from a session the app started

A Claude Code session launched from Claude Desktop's sidebar is a **child process of the
app**. `app quit`, `app restart`, `consolidate --yes` and `return` all want the app closed,
and closing it kills the session part-way through — which is why foster refuses to close an
app it is running inside. `sweep --restart` asks first and hands over the command instead of
failing at the end of a run that already wrote everything.

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

## Before pushing

```bash
npm run check
```

`npm run privacy` is the one to remember when writing prose or fixtures: this repository is
public, and the guard rejects any Windows user-profile path, any UUID that does not look
obviously synthetic, and two personal identifiers that reached it once. Fixture uuids look
like `00000000-0000-4000-8000-00000000000a`.
