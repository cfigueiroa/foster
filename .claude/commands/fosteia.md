---
description: Bring every session from every other account into the one signed in now — archived and deleted included — and restart the app.
allowed-tools: PowerShell, Bash(node:*)
---

Run the full sweep into the account Claude Desktop is signed into right now. This is the
whole job: after it, every conversation that can be in this account's sidebar is.

**Do not read the repository.** Everything needed is below. Do not open the README, do not
grep the source, do not build anything.

**Do not ask the user to confirm anything.** `--yes` is the point of this command. Every
write below is undone by `foster return`, so there is no decision to hand back. Ask only if
a step fails in a way these instructions do not cover.

**Use PowerShell.** `install.ps1` puts `foster` on the user PATH, so it is a plain command
there. It is usually _not_ resolvable from Bash on this machine — if you end up in a shell
without it, the installed bundle is `node "$LOCALAPPDATA/foster/foster.js"`. A `dist/foster.js`
in a checkout is usually older; do not reach for it, and do not build from source.

## 1. Sweep

Run these three, in order, and keep the counts from each:

```
foster doctor
foster foster --archived --yes
foster restore --yes
```

`--archived` is not optional here. Without it the sweep finds a fraction of what exists —
measured once at 15 sessions against 141 — because archiving excludes a session from the
default sweep by design. The copies arrive in the destination's **archived view**, not in
Recents.

`restore` brings back what the app deleted: the pointer is gone, the transcript is not. It
already reads every Claude config directory, so a second subscription needs no extra flag.

## 2. Confirm it is finished

```
foster foster --archived --dry-run
foster restore
```

Both must report **0**. If either does not, run the corresponding `--yes` again and say why.

## 3. Restart, or hand over the command

The copies are invisible until Claude Desktop re-reads its session directory. First find out
whether this session is a child of the app:

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p) { $p.ExecutablePath; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
```

- **No ancestor under `WindowsApps\Claude_*`** → run `foster app restart` and you are done.
- **An ancestor is the app** → restarting would kill this session part-way through, and
  foster refuses it anyway. Give the user `foster app restart` for a terminal outside the
  app, and say plainly that it is the last step.

## 4. Report

Short, factual, in the user's language. Cover:

- how many were fostered and how many restored;
- that the archived ones landed in the archived view, not Recents — otherwise they will look
  for rows that are not there;
- what can never come, from `foster list --all --json`: scheduled tasks, sessions never
  opened, files over the 10 MB the app refuses to load. Count them rather than leaving a
  silent gap;
- whether the restart happened or is waiting on them.

## Never, in this command

- **`foster purge`.** It destroys transcripts irreversibly and is not part of any sweep.
  Not through the CLI, not through a shell.
- **`foster live --stop`.** It is `taskkill /F /T` on a pid read from a registry file, and
  those files go stale: after a reboot the pid can belong to something else entirely. If the
  output warns that a conversation has a live writer, verify before repeating it as fact —
  a process whose `CreationDate` is later than the registry file's `LastWriteTime` is a
  recycled pid and the warning is false.
- **`foster consolidate --yes`.** It needs the app closed, and choosing which half of a fork
  survives hides records — that is a decision, which this command does not make. If the
  output mentions forks, pass the suggestion along and stop there.
