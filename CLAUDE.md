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
transcript of its own. The sweep does not choose between them: the branch that carried on
keeps its title, and every other branch is retitled `(stale, stopped DD/MM HH:MM) …` — or
whatever `--stale-prefix` says — and filed in the archived view, native rows included. Nothing
is hidden; `foster consolidate` is the optional tidy-up for anyone who wants one row.

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

## Before pushing

```bash
npm run check
```

`npm run privacy` is the one to remember when writing prose or fixtures: this repository is
public, and the guard rejects any Windows user-profile path, any UUID that does not look
obviously synthetic, and two personal identifiers that reached it once. Fixture uuids look
like `00000000-0000-4000-8000-00000000000a`.
