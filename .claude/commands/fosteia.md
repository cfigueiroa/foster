---
description: Bring every session from every other account into the one signed in now — archived and deleted included — and restart the app.
allowed-tools: PowerShell, Bash(node:*)
---

Run the full sweep into the account Claude Desktop is signed into right now. This is the
whole job: after it, every conversation that can be in this account's sidebar is.

**Do not read the repository.** Everything needed is below. Do not open the README, do not
grep the source, do not build anything.

**Do not ask the user to confirm anything.** `--yes` is the point of this command. Everything
the sweep writes is undone by `foster return`, so there is no decision to hand back. Ask only
if a step fails in a way these instructions do not cover.

**Use PowerShell.** `install.ps1` puts `foster` on the user PATH, so it is a plain command
there. It is usually _not_ resolvable from Bash on this machine — if you end up in a shell
without it, the installed bundle is `node "$LOCALAPPDATA/foster/foster.js"`. A `dist/foster.js`
in a checkout is usually older; do not reach for it, and do not build from source.

## Run it

```
foster doctor
foster sweep --yes --restart
```

That is the whole sweep. `foster sweep` copies every fosterable session from the other accounts
— **archived included**, which is where the volume is — brings back conversations the app
deleted that nothing still points at, re-scans to say whether either has anything left, and
counts what can never come at all.

`--restart` restarts Claude Desktop, which is what makes the copies visible. If this session is
a child of the app, foster will not restart it — that would kill this session part-way through —
and the output ends with the command to run in a terminal outside the app. Hand that line to the
user and say plainly that it is the last step.

## Report

Short, factual, in the user's language. Everything below is in the command's own output; pass it
on rather than re-deriving it:

- how many were fostered and how many restored;
- that the archived ones landed in the **archived view**, not Recents — otherwise they will look
  for rows that are not there;
- whether it said **"Nothing is left to sweep"**. If it said "Not finished" instead, run
  `foster sweep --yes` again and say why;
- the "can never come" line, when there is one: scheduled tasks, sessions never opened, files
  over the 10 MB the app refuses to load. Report the count rather than leaving a silent gap;
- whether the restart happened or is waiting on them.

## Never, in this command

- **`foster purge`.** It destroys transcripts irreversibly and is not part of any sweep.
  Not through the CLI, not through a shell.
- **`foster consolidate --yes`.** `sweep` reports forks and stops there on purpose: choosing
  which half of a fork survives hides records, and that is the user's decision. Pass the
  suggestion along and stop.
- **`foster live --stop`.** It is `taskkill /F /T`, so whatever that session had not written is
  lost. If `sweep` reports a live writer, pass it on — finishing there is the user's call, not a
  step for you to take.
