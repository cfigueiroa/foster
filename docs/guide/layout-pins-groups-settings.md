# Pins, groups, routines and the filter menu

## Pinned sessions

A pinned session is not a session with a flag set. The session file has no field for it and the
app's config never mentions it: pinning is state of the **window**, kept in Chromium's IndexedDB
under one key, holding one JSON array of session ids.

That makes it the one thing a copy cannot inherit. `foster` mints a fresh `sessionId` for every copy
— which is exactly what keeps deleting the copy from ever reaching the original — and the pin is
keyed on the id. So a pinned session, fostered, arrives unpinned, and the entry left behind still
points at the original. `foster pin` is the way to put it back:

```bash
foster pin                                    # what is pinned, with titles
foster pin --session 14f73ab6 --yes           # pin it
foster pin --remove --session 14f73ab6 --yes  # unpin it
```

Reading is always safe. Writing needs **Claude Desktop closed** — not for the usual reason, but
because LevelDB keeps recent writes in memory and flushes them on its own schedule, so a change made
underneath a running app would simply be overwritten. The database is copied into `~/.foster/backups`
before anything is written, and the write itself only ever **appends**: LevelDB replays its log in
order, so a record added at the end supersedes the earlier one without a single existing byte being
rewritten. The worst an interrupted write can leave is a torn record at the end of the file, which is
the one kind of damage that format is designed to discard.

Reading has to look in **both halves** of the database, and this is the part that is easy to get
wrong. LevelDB writes to a log and, once that log grows, folds it into a sorted table and forgets it.
A reader that only knows about logs therefore answers "nothing has ever been pinned" for any
installation that has been running long enough to compact — which is every installation that has been
running for a while. It was the first thing to break here against a real profile, with ten sessions
visibly pinned in the sidebar and the log holding no trace of them. So `foster` reads the sorted
tables too, decompresses them, and takes whichever copy of the record carries the higher sequence
number. The same number is what a write has to climb above: a record appended to the log but numbered
below the table's is read as the older of the two, and the change quietly does nothing.

A sorted table that fails to read — a compression this does not implement, a corrupt block — is
skipped for a read that only lists, the same as LevelDB's own half-written tables from a killed
compaction. Writing is different: if the table that failed happened to hold the newest copy of the
record, the value found elsewhere is older than it looks, and a write built from it would erase
whatever that table actually held. `foster pin --yes` refuses outright rather than write from a
read like that, naming the table; re-run once it reads cleanly.

One thing `foster` deliberately will not do: write a pin list into an installation that has **never
pinned anything**. The record carries Blink's serialisation envelope, and with no record there is
nothing to copy it from — inventing one is guessing at a serialiser version. Pin any session in the
sidebar by hand, once, and the rest follows.

There is no LevelDB dependency, and it would not have helped: the database declares the comparator
`idb_cmp1`, and a stock binding refuses to open a database whose comparator it does not recognise.
The pieces actually needed are implemented directly — the log record format, the sorted-table format,
Snappy decompression, and IndexedDB's key encoding, which stores its strings as UTF-16 big-endian
while every other multi-byte field in the file is little-endian.

## Sidebar groups and routines: `foster layout`

Two more things a copy cannot inherit, for the same reason pinning cannot: neither is a field on the
session file. A sidebar **group** lives in `claude_desktop_config.json`, in a scope keyed by account
and organization; a **routine** (a scheduled task) lives in its own `scheduled-tasks.json`, one file
per account. `foster layout` brings both from every other account into the one signed in now:

```bash
foster layout                    # what would be brought, writing nothing
foster layout --yes              # write it — refuses if the app is running
foster layout --yes --restart    # quit Claude Desktop, write, start it again
```

A group is matched **by name**: an existing target group of that name is reused, a new one is minted
only when none matches. A routine is matched by its own **id**. Either way, bringing the same thing
twice is a no-op, not a duplicate — and a target the user has already filed or already has, however it
got there, is left exactly as it is. That is the same "the user's own choice wins" rule the sweep
keeps for a copy's title. The one exception is a row foster itself filed earlier: when the source
has since moved it to another group, it moves too. New groups arrive in the most recently active
source's own order.

The same run brings the rest of what makes two accounts look alike: the **pins** the most recently
active other account shows on each conversation (and removes only a pin foster itself added), the
sidebar's group-by and sort as that account last showed them, and per-account app settings the
target has no entry for yet. Everything is under the same rule — a value changed here by hand is
never overwritten — and `foster verify` reads all of it back after the restart.

A routine that is a one-shot (`fireAt`, no `cronExpression`) and already overdue is not brought at
all: the app runs an overdue task the moment it next launches, and a stale one firing unasked in an
account that never scheduled it is worse than one left behind. The copy also drops `lastRunAt`,
`lastScheduledFor` and `notifySessionId` — another account's history, a count that could make the app
believe a run was missed here, and a session id that names nothing in this account.

A group is not just that one config scope, either — the same scope sits in Local Storage too, once
under its own key and again folded into the filter menu's own `dframe-store` record below. `foster
layout` writes all three together whenever a Local Storage database exists at all, and skips the Local
Storage pair (writing only the config copy) on a store the sidebar's filter menu has never touched yet.

None of the three is what the app trusts at startup, as it turned out. The sidebar is claude.ai's own
code, and `dframe-store` is synced with the account's settings on the server: when the app starts, the
server's list of groups for the signed-in account replaces the local one, and a row stays filed only
under a group the server already knows. A group foster minted is not one of those — measured
23/09/2026, every group one `foster layout --yes --restart` wrote was gone three seconds after the app
came back. The page keeps a marker of its own for "this device has an edit the server has not seen",
and when that marker names the signed-in account, startup uploads the local groups instead of
replacing them; `foster layout` now sets it, in the same write as the groups. Watched through a real
restart the same day, a group foster minted that way came back with its row and stayed through three
more restarts. The page is claude.ai's code and can change without notice, though, so `--restart`
still checks: it waits
for the app to rewrite its config, reads every row back, and when any were dropped it says how many
and from which groups, and exits non-zero, instead of reporting the layout applied. The way that
held on 23/09 still works when it does: file them from inside the app, with its own group tools.

Both files are the app's own, and it rewrites them from memory the same way it does the pin database
and its other preferences — so, like `foster pin`, a write needs the app **closed**, and `foster
layout --yes` refuses outright while it is running rather than writing something the next flush would
undo. `--restart` is the one command that does the whole thing itself: quit, write, start again — the
write happens in the gap, which is the only moment either file is safe to touch. `foster sweep`
plans a layout alongside its own passes (never writing it) and says so in its summary when anything is
waiting.

### Checking a restart did not undo anything: `foster verify`

Two different runs have now written something in the closed-app gap and watched the app save part of
it straight back over once it came up: marks (24/09/2026, ten of forty-nine "other file" marks gone
three minutes later, no foster event in between) and sidebar groups (23/09/2026, the paragraph
above). `foster verify` is the one command that reads back, after the fact, whether any of what
foster wrote to this account has since been undone:

```bash
foster verify            # read-only; writes nothing
foster verify --json
```

Titles, archived flags and pins are checked exactly, because the ledger alone proves reversion for
them: a card is back under a title it wore _before_ foster ever touched it (`planMarksBack`), or a pin
move a sweep deferred still has not landed (`planPinMoves`) — the same two functions `foster layout`
itself calls to close the gap, read back here rather than re-derived.

Groups and routines cannot be checked as exactly, and `foster verify` says so rather than pretending
otherwise: the ledger keeps only counts of what one `layout_applied` run brought, never which card
went into which group, so "is this one assignment still there" has no ledger-only answer once the
process that made it has exited — that is what `layoutVerify.ts`'s own check does, inside the same
run that wrote it, and it cannot be repeated cold. What `foster verify` flags instead is the one
shape actually measured on a real store: an account that has had groups or routines applied to it
before, now showing **none**, while a fresh plan still wants to bring some. A non-empty scope with
more merely pending is reported as such and left out of the exit code — it cannot be told apart from
another account simply having gained a group since the last run, and asserting undone on a guess is
worse than saying "pending".

Exits 1 the moment anything above was found undone. Run it after `foster layout --yes --restart` (or
`sweep --restart`) — the `/fosteia` skill's own last step now does.

## The sidebar's filter menu: two stores

The Code sidebar's filter menu — status, group by, sort, environment, empty groups, PR status,
activity window — is seven settings split across two stores, and the split is not the one you would
guess from the menu itself. Re-measured 22/09/2026 via the app's own `set_view` tool: an earlier
reading of this section put status and the activity window in the wrong column — both are per
account, not machine-wide or shared — and `dframe-store`'s own `recentsStatusFilter` is a different
list the app keeps for something else, never this menu's status filter.

| Setting                                    | Where                       | Key                                                    |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------ |
| Group by (Data/Pasta/Estado/Custom/Nenhum) | machine-wide, Local Storage | `groupByByMode.code`                                   |
| Sort by (Recência/Nome/Recém-criados)      | machine-wide, Local Storage | `sortByByMode.code`                                    |
| Status (Ativo/Arquivado/Todos)             | per account                 | `code-sessions-status-filter.<accountUuid>`            |
| Activity window (only with group-by state) | per account                 | `code-sessions-state-activity-days.<accountUuid>`      |
| Environment                                | per account                 | `code-sessions-selected-environments-v2.<accountUuid>` |
| Show empty groups                          | per account                 | `code-sessions-show-empty-projects.<accountUuid>`      |
| Show PR status                             | per account                 | `code-sessions-show-pr-status.<accountUuid>`           |

The first two live in Chromium's Local Storage for the app's own origin — a second LevelDB database
next to the one `foster pin` reads, encoded more simply (no Blink envelope, no separate "exists"
record). The other five are ordinary keys under `preferences.epitaxyPrefs` in
`claude_desktop_config.json`, every one of them carrying the account uuid as a suffix because the
filter they hold belongs to one account's own view of the sidebar. Four more keys without the
account suffix or the `-v2` are left over from an older build; the app no longer reads them, so
`foster view` only ever reports them as legacy, never writes them.

```bash
foster view                 # all seven, this account's value, and where each lives
foster view set --status archived --sort name --env local,ssh --yes
foster view copy --from <accountUuid> --yes    # per-account half (all five) only; the machine-wide half needs no copying
```

Grouping by "Estado" only makes sense with the active filter, and the app enforces that itself —
`foster view set --group-by state` sets `status active` along with it, and says so. Both files are
the app's own, so both need it closed to write, and `--restart` does the same quit-write-start `foster
layout` does. `foster layout` also carries the per-account half of this menu — status and the
activity window included — from another account when the target has none of it set yet — the
machine-wide half needs no copying, since it already applies to every account on the installation.
