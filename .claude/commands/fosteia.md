---
description: Bring every session from every other account into the one signed in now — archived, deleted and forked included — and restart the app.
allowed-tools: PowerShell, Bash(node:*), mcp__ccd_session_mgmt__set_session_title
---

Run the full sweep into the account Claude Desktop is signed into right now. This is the
whole job: after it, every conversation that can be in this account's sidebar is, and the row
to continue in is the one with the clean title.

**Do not read the repository.** Everything needed is below. Do not open the README, do not
grep the source, do not build anything.

**Do not ask the user to confirm anything.** `--yes` is the point of this command. Every copy
the sweep writes is undone by `foster return`, so there is no decision to hand back. Ask only
if the command fails in a way these instructions do not cover.

**Use PowerShell.** `install.ps1` puts `foster` on the user PATH, so it is a plain command
there. It is usually _not_ resolvable from Bash on this machine — if you end up in a shell
without it, the installed bundle is `node "$LOCALAPPDATA/foster/foster.js"`. A `dist/foster.js`
in a checkout is usually older; do not reach for it, and do not build from source.

## Run it

One command, one tool call. What runs before the sweep is not decoration: those two lines are
the name this conversation gets at the end, measured rather than remembered.

```
"[fosteia] $(Get-Date -Format 'dd/MM HH:mm')"; $c = foster whoami --json | ConvertFrom-Json; $e = $c.email; if (-not $e) { try { $e = (foster identify $c.accountUuid --json | ConvertFrom-Json).name } catch { } }; "[conta] $(if ($e) { $e } else { $c.accountUuid.Split('-')[0] })"; foster sweep --yes --sync-titles --restart --stale-prefix "(defasada, parou {when}) " --branch-prefix "(outro ramo, seguiu {when}) "
```

Pass **both** prefixes, always. They are two different verdicts on a branch, and a run that
names only one marks the other in English on a sidebar read in Portuguese.

`--sync-titles` is what keeps a row findable by name. A copy carries the title of the instant
it was made, and every later sweep sees it as already fostered and walks past — so a
conversation renamed where it came from keeps the old name here for ever, and the sidebar
reads as if the work were missing when only its name is. That is the exact confusion this
command exists to end, and it is why the flag is on here even though the CLI leaves it off:
only a copy still wearing the last title foster itself wrote is rewritten, so a row **you**
renamed is never touched, and the mark a branch wears is put back in front of the new title.

That is the whole sweep. It copies every fosterable session from the other accounts —
**archived included**, which is where the volume is — gives every branch of a forked
conversation a row of its own, brings back conversations the app deleted that nothing still
points at, re-scans to say whether anything is left, and counts what can never come at all.
It takes about half a minute on a large store: it reads every transcript it can see once, to
catch forks that began in the middle of a conversation.
Do not run `foster doctor` first and do not run anything to confirm afterwards: the sweep
fails loudly on its own and confirms itself.

`--restart` restarts Claude Desktop, which is what makes the copies visible. If this session is
a child of the app, foster will not restart it — that would kill this session part-way through —
and the output ends with the command to run in a terminal outside the app. Hand that line to the
user and say plainly that it is the last step.

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

## Report

Short, factual, in the user's language. Everything below is in the command's own output; pass it
on rather than re-deriving it:

- how many were fostered, how many restored, and — from the "forked conversation" line — how
  many rows were added or retitled for branches;
- that the archived ones landed in the **archived view**, not Recents — otherwise they will look
  for rows that are not there;
- what a fork looks like now, which is three outcomes and not two: the branch holding most work
  of its own keeps its title; a branch that **stopped earlier** wears "(defasada, parou DD/MM
  HH:MM)" and sits in the archived view; and a branch that **went on after it** wears "(outro
  ramo, seguiu DD/MM HH:MM)" and stays in the sidebar — that last one is where the most recent
  work is, so say it plainly. If a row they had pinned was archived as stale, the current row
  needs pinning again;
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
- whether the restart happened or is waiting on them.

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
