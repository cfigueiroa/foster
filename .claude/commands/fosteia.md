---
description: Bring every session from every other account into the one signed in now — archived, deleted and forked included — and restart the app.
allowed-tools: PowerShell, Bash(node:*)
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

One command, one tool call:

```
foster sweep --yes --restart --stale-prefix "(defasada, parou {when}) " --branch-prefix "(outro ramo, seguiu {when}) "
```

Pass **both** prefixes, always. They are two different verdicts on a branch, and a run that
names only one marks the other in English on a sidebar read in Portuguese — worse, a later run
with a different wording stacks a second mark in front of the first instead of replacing it,
because a mark is only recognised when the run is told the words it was written with.

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
- whether it said **"Nothing is left to sweep"**. If it said "Not finished" instead, run the same
  command again and say why;
- the "can never come" line, when there is one: scheduled tasks, sessions never opened, files
  over the 10 MB the app refuses to load. Report the count rather than leaving a silent gap;
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
  `foster client register|forget`, `app start` and opening a terminal in another client are not
  part of this command either. The account signed into right now is the whole target; naming or
  launching another one is a decision for the user to make, not this sweep.
