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

It copies every fosterable session from the other accounts — **archived included** — brings back
conversations the app deleted that nothing points at, then re-scans to say whether anything is
left. Archived copies stay archived, so they arrive in the app's _archived_ view rather than in
Recents; say so, or the user will look for rows that are not there.

You are done when it prints **"Nothing is left to sweep"**. It also counts what can never come —
scheduled tasks, sessions never opened, files over the 10 MB the app refuses to load — so report
that line rather than leaving the user to wonder what the gap was.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. When
foster is running inside the app it will not do that (see below) and the output ends with the
command to run elsewhere instead.

`sweep` deliberately never purges and never consolidates. If it reports forks, pass that on and
stop there.

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
