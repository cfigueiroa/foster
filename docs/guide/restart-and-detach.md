# Restarting the app, and --detach

## Why a restart is needed

Claude Desktop reads its session directory **once**, while it initialises, and keeps what it found in
memory. Nothing watches the directory afterwards, so a file that appears later is invisible until the
app initialises again. Reloading the window (F5) does not help: the list it redraws comes from the
app, not from disk.

`foster` will do the restart for you — from the menu, or with `--restart`. It will not close an app
it is running inside, because that would kill the session that asked.

### Restarting from inside a hosted session: `--detach`

Add `--detach` to `app restart`, `layout --yes --restart`, `view set/copy --yes --restart` or
`sweep --restart` and the restart happens anyway, from outside the app: a small `.vbs` launched
through WMI, in a process tree the app quitting cannot take down, waits a few seconds and then
re-runs the same command from there. The write itself still happens in that second, detached run
— this call only launches it and returns immediately, so the session that asked ends a few
seconds later along with the app it restarted.

Every session the app hosts ends when it quits, this one included — there is no way to warn one
first and no undo — so `--detach` reads the live-session registry first and refuses, naming them,
if restarting would end any session besides its own. `--detach-even-with-live` overrides that.
`--detach-delay <seconds>` sets how long it waits before firing (default 20, 5–300).

`foster detached [--last] [--json]` lists what `--detach` has launched from this machine —
pending, running or done, with the log's own tail — which is how a session that ended before the
restart landed finds out whether it actually did.

With the tray **on** — the default — `--detach` alone cannot finish: the detached re-run asks
Claude Desktop to close the ordinary way, which the tray only hides, and the run ends having
written nothing. `foster` refuses up front rather than spending the wait: on `app restart` add
`--terminate` as well (it rides straight through to the detached re-run); the other commands
have no `--terminate` of their own, so close Claude Desktop yourself first, or run
`foster app restart --detach --terminate` instead. Checked directly against this machine's own
default installation 24/09/2026: `menuBarEnabled` is unset there, meaning the app default (tray
**on**) — so the bug was live on the very machine this codebase is developed on, and the fix was
never validated by "try it and see" here alone.

`--detach` carries `--store`/`--ledger` (and, for `sweep`, the account it just wrote into) into
the command it detaches to — `foster --store work sweep --yes --restart --detach` used to hand
the detached process a bare `foster layout --yes --restart` with no `--store` at all, which
restarted the _default_ installation while `work` was the one actually swept. Measured
24/09/2026, fixed the same day.

Closing it is less polite than it should be, and `foster` says so rather than pretending otherwise.
Claude Desktop's window-close handler quits the app **only when its tray icon is turned off**; with
the tray on — the default — it cancels the close and hides the window. So asking politely would make
your window vanish and leave the process running. `foster` does not send that request at all: it
tells you the situation and asks for an explicit yes to end the process. Session files survive
either way (they are written through a temporary and renamed), but ending the process skips the
app's own shutdown, so a title or timestamp changed in the last few seconds may not be saved and
Cowork sandboxes are not stopped cleanly. Quitting from the tray icon yourself avoids all of that.

If your account has **more than one organization**, switching organization and switching back also
makes the app re-read the directory, with no restart. It ends any session that is running, so it is
not free either.

With only one organization there is still a way, because the re-read is not guarded by a
"sessions are already loaded" flag: when the account and organization it resolves are the same ones
it already has, the app takes a branch that loads the directory again anyway. Signing out and back
in reaches it. Nothing external can force it — the organization change is noticed through an
in-process cookie event, so writing that cookie from outside emits nothing, and a same-value change
is discarded by two separate guards. It is a second door, not a cheaper one: the sign-in is more
disruptive than the restart it saves.

### The app's own import, and why `foster` does not use it

Claude Desktop registers a deep link, `claude://resume?session=<cliSessionId>`, which imports a CLI
transcript into the current account **live** — no restart, appears immediately. It looks like the
perfect answer. Running it once on a real conversation is what settles it:

- **It deletes part of the conversation.** The import rewrites the `.jsonl` in place to strip
  reasoning. Measured on a 58,678-byte transcript: 22 records became 19, three assistant records
  containing only reasoning were removed, and 9,677 bytes went with them. Nothing else changed — no
  message or answer was touched — but the file is the one the original session also points at, and
  those records are not coming back. This is the reason `foster` will not call it.
- **The title does not survive.** It carries the working directory and nothing else, so the session
  arrives with no title at all — which the app displays as "General coding session", the same label
  every other untitled session gets. The transcript holds the real title the whole time; the import
  simply does not read it.
- **The dates are reset** to the moment of the import, and the model and permission mode are gone.
- **It takes over your window.** The app navigates to the imported session and focuses the composer,
  so whatever you were reading is replaced.

`foster restore` reads the same transcript and writes a pointer at it instead: the real title, the
real dates, a fresh identity, and the transcript's modification time left exactly where it was.

The deep link is still worth knowing about — it is the only thing that puts a session on screen
without a restart. It is not a way to move three hundred, and it is not free.

Relatedly: the app has a built-in recovery scan that offers importable transcripts, and it will
never offer these ones. Before scanning it collects every `cliSessionId` referenced by every account
and organization on disk and treats those as already known — so a session that still exists under
your old account is excluded by the very fact that it still exists.
