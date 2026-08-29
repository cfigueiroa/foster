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

- whether the restart happened or is waiting on them.

## Never, in this command

- **`foster purge`.** It destroys transcripts irreversibly and is not part of any sweep.
  Not through the CLI, not through a shell.
- **`foster consolidate --yes`.** `sweep` reports forks and stops there on purpose: which half
  of a fork the sidebar shows is the user's call, not yours. Pass it on as something they can
  act on rather than as a dead end — `foster consolidate --dry-run` lists the forks with their
  record counts, the defaults (`--max-lost 200`, `--max-lost-share 33`) already leave a fork
  alone when the discarded half is worth more than a third of the one that stays, and
  `foster consolidate --undo` puts the cards back. It wants the app closed, so it belongs in
  the same terminal as the restart.
- **`foster live --stop`.** It is `taskkill /F /T`, so whatever that session had not written is
  lost. If `sweep` reports a live writer, pass it on — finishing there is the user's call, not a
  step for you to take.
