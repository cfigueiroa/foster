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

Three commands, each with a dry run first. Every one of them defaults to a dry run, so the
`--yes` is the only difference.

```bash
node "%LOCALAPPDATA%\foster\foster.js" foster --archived --dry-run
node "%LOCALAPPDATA%\foster\foster.js" foster --archived --yes
node "%LOCALAPPDATA%\foster\foster.js" restore --yes
```

**`--archived` is where the volume is.** Archiving is opt-in for a good reason (see the
README), but a request phrased as "bring _everything_" means it: on one real store the same
sweep offered 15 sessions without the flag and 141 with it. The copies land in the
destination's _archived_ view, not in Recents — say so, or the user will look for rows that
are not there.

`restore` covers what the app deleted: the pointer is gone, the transcript is not. It reads
every Claude config directory (`~/.claude`, its `~/.claude*` siblings), so a second
subscription is included without extra flags.

You are done when both dry runs report **0**. Some sessions never come, by design —
scheduled tasks, sessions never opened, and files over the 10 MB the app refuses to load.
`list --all --json` counts them by reason; report them rather than leaving the user to
wonder what the gap was.

Finally, the copies are invisible until Claude Desktop re-reads its directory:

```bash
node "%LOCALAPPDATA%\foster\foster.js" app restart
```

## You cannot restart the app from a session the app started

A Claude Code session launched from Claude Desktop's sidebar is a **child process of the
app**. `app quit`, `app restart`, `consolidate --yes` and `return` all want the app closed,
and closing it kills the session part-way through — which is why foster refuses to close an
app it is running inside.

Check before promising anything:

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p) { "$($p.ProcessId) $($p.Name) $($p.ExecutablePath)"; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
```

An ancestor under `WindowsApps\Claude_*` means the answer is: hand the user the command for
a terminal outside the app. Do not try to work around it.

## A reported "live writer" is not proof of one

Foster decides a conversation has a live writer from a registry file under
`<configDir>/sessions/<pid>.json` plus "does that pid still exist". On Windows pids recycle,
so after a reboot a stale file can point at an unrelated process. Verify before believing
the warning, and **always** before `live --stop`, which is `taskkill /F /T` on that pid:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object Name,CreationDate
```

A registry file is written by its own process, so `CreationDate` **later** than the file's
`LastWriteTime` means the pid was recycled and the entry is dead. A second signal: the
conversation's own `.jsonl` under `<configDir>/projects/` has not been appended to.

## What `foster agent` does and does not cover

`foster agent "<task>" --yes` exposes nine tools: `scan_accounts`, `list_sessions`,
`foster_status`, `app_status`, `read_transcript`, `label_account`, `foster_sessions`,
`return_fosterings`, `resume_headless`. **`restore`, `consolidate`, `purge` and `live` are
not among them** — a sweep that has to reach deleted conversations is a CLI job, not an
agent one. `purge` is excluded on purpose and must not be reached through the shell either.

## Before pushing

```bash
npm run check
```

`npm run privacy` is the one to remember when writing prose or fixtures: this repository is
public, and the guard rejects any `C:\Users\<name>` path, any UUID that does not look
obviously synthetic, and two personal identifiers that reached it once. Fixture uuids look
like `00000000-0000-4000-8000-00000000000a`.
