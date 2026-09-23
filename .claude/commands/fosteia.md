---
description: Bring every session from every other account into the one signed in now — archived, deleted and forked included — and restart the app.
allowed-tools: PowerShell, Bash(node:*), mcp__ccd_session_mgmt__set_session_title
---

Run the full sweep into the account Claude Desktop is signed into right now. This is the
whole job: after it, every conversation that can be in this account's sidebar is. The clean
title holds the body of a conversation; when a branch of it went on afterwards, that branch
wears the mark saying so, and it — not the clean title — is the row to continue in.

**Do not read the repository.** Everything needed is below. Do not open the README, do not
grep the source, do not build anything.

**Do not ask the user to confirm anything.** `--yes` is the point of this command. Every copy
the sweep writes is undone by `foster return`, so there is no decision to hand back. Ask only
if the command fails in a way these instructions do not cover.

**Use PowerShell.** `install.ps1` puts `foster` on the user PATH, so it is a plain command
there. It is usually _not_ resolvable from Bash on this machine — if you end up in a shell
without it, the installed bundle is `node "$LOCALAPPDATA/foster/foster.js"`. A `dist/foster.js`
in a checkout is usually older; do not reach for it, and do not build from source.

## First: this text and the installed foster must be the newest

Claude Desktop hands a session a worktree it parked earlier, and that worktree can hold an old
copy of this very file. Measured 23/09/2026: a `/fosteia` ran from a worktree at 0.54.0 while
`origin/main` and the installed foster were at 0.58.0, so it skipped the `--other-file-prefix`
below (45 rows marked in English) and the detached restart at the end. One command, before
anything else — the only look at the repository this command makes:

```
git fetch -q origin 2>$null; $f = '.claude/commands/fosteia.md'; git diff --quiet HEAD origin/main -- $f 2>$null; if ($LASTEXITCODE -eq 1) { '[texto] STALE — follow the text below, not the one you loaded'; git show "origin/main:$f" } else { '[texto] current' }; $want = (git show origin/main:package.json | ConvertFrom-Json).version; "[foster] installed $(foster --version), origin/main $want"
```

- `[texto] STALE`: the file you loaded is older than `origin/main`, and the text printed after
  that line is the current command. Follow **that** text from its top instead of anything below
  here, skipping only its own "First" section — you have just run it.
- `[foster]` with the installed version older than `origin/main`'s: a `SessionStart` guard on
  this machine normally updates it before the session starts, so this means it could not. Update
  it here, then go on:

  ```
  & ([scriptblock]::Create((irm "https://raw.githubusercontent.com/cfigueiroa/foster/v$want/install.ps1"))) -Version "v$want" -NoLaunch
  ```

  If that fails because the release is not published yet, go on with the installed one and say
  so in the report.

## Run it

One command, one tool call. What runs before the sweep is not decoration: those two lines are
the name this conversation gets at the end, measured rather than remembered.

```
"[fosteia] $(Get-Date -Format 'dd/MM HH:mm')"; $c = foster whoami --json | ConvertFrom-Json; $e = $c.email; if (-not $e) { try { $e = (foster identify $c.accountUuid --json | ConvertFrom-Json).name } catch { } }; "[conta] $(if ($e) { $e } else { $c.accountUuid.Split('-')[0] })"; foster sweep --yes --sync-titles --restart --stale-prefix "(defasada, parou {when}) " --branch-prefix "(continuou, até {when}) " --other-file-prefix "(outro arquivo, parou {when}) "
```

Pass **all three** prefixes, always. They are three different verdicts — two on a branch of a
fork, one on the other file of a conversation shown here twice — and a run that names only some
of them marks the rest in English on a sidebar read in Portuguese.

`--sync-titles` is what keeps a row findable by name. A copy carries the title of the instant
it was made, and every later sweep sees it as already fostered and walks past — so a
conversation renamed where it came from keeps the old name here for ever, and the sidebar
reads as if the work were missing when only its name is. That is the exact confusion this
command exists to end, and it is why the flag is on here even though the CLI leaves it off:
only a copy still wearing the last title foster itself wrote is rewritten, so a row **you**
renamed is never touched, and the mark a branch wears is put back in front of the new title.

That is the whole sweep. It copies every fosterable session from the other accounts —
**archived included**, which is where the volume is — gives every branch of a forked
conversation a row of its own, says which row to continue in when one conversation is shown
here more than once, brings back conversations the app deleted that nothing still points at,
re-scans to say whether anything is left, and counts what can never come at all.
It takes about half a minute on a large store: it reads every transcript it can see once, to
catch forks that began in the middle of a conversation.
Do not run `foster doctor` first and do not run anything to confirm afterwards: the sweep
fails loudly on its own and confirms itself.

`--restart` in the one-liner above is kept, but it is harmless rather than the thing that finishes
the job: this session is a child of the app, so foster will not restart it in-process from here —
that would kill this session part-way through — and the sweep says so rather than trying. The
actual last step of this whole command is `foster layout --yes --restart --detach`, in "Finish
it" below, run only after the rename and the report.

## Name this conversation

Every run used to leave a row called just "Fosteia", so a sidebar holding several sweeps could
not tell them apart — and the sweep is exactly the command someone runs again and again. Give
this session a name of its own, with `set_session_title` on `session_id: "self"`:

```
Fosteia DD/MM HH:MM - <the account's e-mail>
```

Both halves are already printed by the call you made: the `[fosteia]` line is the timestamp and
the `[conta]` line is the account. Copy them; do not re-derive either.

Why the account takes two commands rather than one: `foster whoami` reads the app's own cache,
and on an account the app has not written a profile for yet it answers with a null e-mail — the
case measured here, on the account in use. `foster identify <uuid>` asks the API with a
credential foster already holds, returns the e-mail as `name`, and fills that cache, so every
later run gets it from `whoami` directly. If both come back empty the line falls back to the
first block of the uuid, and the sweep's own **"Sweeping into"** line is still there to read.

Rename as soon as the sweep returns, before writing the report. If `set_session_title` is not
among your tools — this command run outside Claude Desktop — skip the rename silently; it is a
label on a sidebar row, never a reason to stop or to reach for another way.

Write the report next, in full, **before** running the command in "Finish it" below — this
session ends within about 20 seconds of that command launching, along with the app it restarts,
and nothing said after it launches will be read.

## Report

Short, factual, in the user's language. Everything below is in the command's own output; pass it
on rather than re-deriving it:

- how many were fostered, how many restored, and — from the "forked conversation" line — how
  many rows were added or retitled for branches;
- that the archived ones landed in the **archived view**, not Recents — otherwise they will look
  for rows that are not there;
- what a fork looks like now, which is three outcomes and not two: the branch holding most work
  of its own keeps its title; a branch that **stopped earlier** wears "(defasada, parou DD/MM
  HH:MM)" and sits in the archived view; and a branch that **went on after it** wears "(continuou,
  até DD/MM HH:MM)" and stays in the sidebar — that last one is where the most recent work is, so
  say it plainly, and say it as the row to open rather than as a lesser one: it holds the newest
  work, and the clean title holds the bulk of the history. More than one branch can wear that mark
  at once — it is measured against the branch that carried on, not against the other branches — so
  never call it "the newest": it says what that branch did, not how it ranks. If a row they had
  pinned was archived as stale, the current row needs pinning again;
- **how many conversations were shown here more than once, and which row to continue in.** One
  conversation can occupy two files — continued from a repository and from a worktree cut out of
  it — and the sweep brings a row for each on purpose, because each opens records the other
  cannot. The row whose **last answer is the most recent** keeps its clean title and is the one to
  open; the others now wear "(outro arquivo, parou DD/MM HH:MM)" and sit in the archived view.
  Say it as one sentence, not as a defect: nothing is merged, and the marked row still opens its
  own half of the work. `foster consolidate` does **not** join these two, so never offer it here;
- how many titles were brought back into step with their original, when the run names any, and
  that a copy renamed by hand is left alone on purpose;
- whether it said **"Nothing is left to sweep"**. If it said "Not finished" instead, run the same
  command again and say why;
- the "can never come" line, when there is one: scheduled tasks, background tasks, sessions
  never opened, files over the 10 MB the app refuses to load. Report the count rather than
  leaving a silent gap — and pass on the ways out the line itself offers, because most of that
  count has one: `--include-scheduled` for the scheduled ones, `--include-spawned` for the
  background ones;
- **what is behind anything still counted as never opened.** That reason is a missing focus
  time and nothing else, so an abandoned record and a conversation that ran its whole life
  outside the app look identical in the count. Measure before calling it a loss:

  ```
  foster list --all --json
  ```

  Each row carries `transcriptBytes` for those sessions — `0` means there is genuinely nothing
  there, and anything substantial is work with no card anywhere. Name the ones that are not
  empty, with their size; do not report them as an unreachable gap without saying what is in
  them. This is not hypothetical: one such session held 1.4 MB of finished work whose change
  had already been merged;

- how many copies were released from a stale worktree claim, if the line names any — a copy
  already on disk that used to fight its original over a branch, now fixed rather than added;
- if the sweep printed a `Layout:` line, say what is waiting (groups, routines, or both) — it is
  about to be applied by the command in "Finish it" below, along with the restart;
- say plainly, in this report, that the app is about to close and reopen (about 20 seconds after
  the next command runs), that this session closes with it, and that once it is back the way to
  confirm the restart actually landed is `foster detached --last` — in a new session, since this
  one is gone by then;
- the next step, in one line: once the app has restarted, `/retoma` tells every session a
  usage limit stopped in the last 24 hours that the quota is back and to carry on. Do not run
  it yourself — it spends this account's quota on every one of them at once, and that is the
  user's call.

## Finish it

The one command that actually restarts the app, run only after the rename and the report above
are both done:

```
foster layout --yes --restart --detach
```

It applies whatever the sweep's `Layout:` line named (a no-op, harmlessly, when there was
nothing pending) and restarts Claude Desktop from a process tree outside it — the one way to
finish this from a session the app itself hosts, which this one is. About 20 seconds after it
launches, the app closes and reopens, and this session closes with the app; nothing after this
command is read by anyone.

If it refuses instead of launching — because another live session, not this one, would be ended
by the restart — it names them. **Do not add `--detach-even-with-live` on your own**: pass the
list of sessions it named on to the user in the report, and hand over the same command,
`foster layout --yes --restart --detach`, for them to run themselves once those are dealt with,
exactly the way an earlier version of this command handed over a plain restart line.

## Proving nothing was left behind

If asked afterward to prove the sweep actually brought a specific conversation — "did it all come
through?" — three things look like proof and are not:

- **`foster list --json`** marks `fosterable: true` for a conversation that is already in the
  destination under a _different_ card. It lists what exists elsewhere, not what is still
  missing — a false negative, not a false positive.
- **`originSessionId`** from `foster status --json` errs by design: the same conversation can
  live in several accounts, and the copy on hand may trace to any of them. Matching on it reports
  copies as missing that are already there.
- **The `_foster` block on a card's own file.** It is not durable: the Desktop app rewrites a
  card through a fixed field list, and the first time it resaves one it has loaded — a title
  change, a focus, any activity — `_foster` is dropped and the copy looks native
  (`KnownCopies` in `src/store/scanner.ts`; measured on a live store, 21 of 364 copies had lost
  it, exactly the 21 that had been opened). This is why production dedup never trusts that field
  alone — it cross-checks the ledger. An ad-hoc audit reading card files directly has no ledger
  to cross-check against, so it will call a real copy native.

The one field that survives all three: **`cliSessionId`**. Read every
`claude-code-sessions/<accountUuid>/*/*.json` under the destination account and the source
account(s) — `foster stores --json` gives the account uuids — and match on `cliSessionId`,
regardless of what `_foster` says or which card the title is attached to. An id with no card in
the destination is missing.

Same id on both sides is the same conversation, and **not yet the same content**. A
`cliSessionId` names a conversation, not a file: a card opens `projects/<dir>/<cliSessionId>.jsonl`
under the project directory its **own `cwd`** encodes to — every `\`, `/`, `:`, `.` and `_`
becomes `-`, compared regardless of case (`projectDirName` and `fileOpenedFrom` in
`src/store/transcripts.ts`). A conversation continued from a repository and from a worktree cut
out of it is therefore two files under one id, each holding what its own card wrote. So for every
matched id with more than one file under the CLI's `projects/` trees (`~/.claude` and any
`~/.claude-*` sibling that has one), take the file each card opens and compare the `uuid`s of its
records (lines with no `uuid` are the app's bookkeeping; skip them): a record in the file a source
card opens that no destination card opens makes the id **diverged**, not matched. Measured on a
real store on 15/09/2026: the same `cliSessionId` was in both accounts, and 2116 records — a whole
night of one session's work — existed only in the worktree's file, which no destination row
opened; matching on the id alone would have called it matched. A card whose `cwd` encodes to no
file, or to more than one, cannot be told either way — say so rather than counting it as matched.

Report matched / missing / diverged from that; never from re-running the sweep, and never from
`foster list` alone.

## Never, in this command

- **`foster purge`.** It destroys transcripts irreversibly and is not part of any sweep.
  Not through the CLI, not through a shell.
- **`foster consolidate --yes`.** Not part of this command. With one row per branch nothing is
  hidden, so collapsing a fork to one row is an optional tidy-up the user runs when they want it.
- **`foster live --stop`.** It is `taskkill /F /T`, so whatever that session had not written is
  lost. If `sweep` reports a live writer, pass it on — finishing there is the user's call, not a
  step for you to take.
- **Never open a profile or a terminal.** `foster profile new|register|forget`,
  `foster client register|forget`, `foster client open`, and `app start` are not part of this
  command either. The account signed into right now is the whole target; naming or launching
  another one is a decision for the user to make, not this sweep.
- **`foster layout --yes` without `--restart --detach`, run from inside this session.** Plain
  `--restart` refuses on its own — the app it would need to write past is the one hosting this
  very session — so there is nothing to gain by trying it here without `--detach` too.
- **`--detach-even-with-live`, unless the user explicitly asks for it.** When `foster layout
--yes --restart --detach` refuses because of another live session, that refusal is the correct
  answer — ending someone else's session without asking is not this command's call to make. Pass
  the list on in the report and hand over the command; do not add the override yourself.
