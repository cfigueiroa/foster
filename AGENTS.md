# AGENTS.md

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

## The registry: four new event kinds

`~/.foster/ledger.jsonl` (relocatable with `FOSTER_HOME`) is append-only and the only thing
foster writes on purpose; `project()` folds it into the state every command reads. This milestone
adds four kinds to it: `profile_registered` / `profile_forgotten` name a Desktop profile for
`--store` (folded into `LedgerState.profiles`), and `client_root_registered` /
`client_root_forgotten` name a CLI config directory — or, with `as: 'container'`, a directory
that holds one per child — for `clients` and launch (`LedgerState.clientRoots`). None of the four
ever carries an account uuid, a token, or a URL: the root outlives whatever account currently
sits inside it, and registering a name already in use is a rename, not a refusal — the fold keeps
only the latest root for it. `ui.json` and `update-check.json` stay the only other mutable files
under `~/.foster`, and neither is a registry — preference and an update-check cache, not a record
of writes.

## `--store <name>`: resolution order, and what it now reaches

Four sources feed `foster stores` / `foster clients`: the installed app, whatever is running,
every store the ledger has been fostered into before, and — new — the registered names.
`--store <arg>` tries, in order: an existing path; a registered profile name, exact — tried even
against a directory that has since gone, so it fails naming the profile rather than just "not
found"; an account (a label, an e-mail, or a unique uuid prefix); then a distinctive piece of a
path. An ambiguous match at any of the last three steps is refused rather than guessed at
(`resolveStoreArg`, `src/engine/stores.ts`).

Naming a profile widens what that profile's own verbs reach, nothing else. `--store work sweep`
scans and writes inside `work`'s own `claude-code-sessions` — two profiles, two independent
sweeps, neither seeing the other's cards. `--store work rescue` lists `work`'s stranded cards
(the transcripts still come from the shared, CLI-side `transcriptRoots`). `--store work
consolidate` / `return` still need `work`'s own app closed, refusal-to-self-close intact. None of
them picks up a **client** root just because a profile was named — `client register` is a
separate registry for that, and it never reaches `purge`, `restore` or `live` regardless of
`--store` (see next section).

## Fleet directories: `client register --container`, and what it does not reach

`foster client register <path>` remembers a config directory outside the `~/.claude*` siblings
`clients` enumerates on its own; `--container` remembers a directory that holds one client per
immediate child instead (`~/.claude-contas/<name>`, one folder per account) — each child still
has to pass `looksLikeClient` on its own, and nesting stops at one level. Either way this is
**listing and launch only** (`registeredClientDirs`, `src/store/configDirs.ts`): it is never
folded into `configDirCandidates`, so nothing it names reaches `purge`, `restore`,
`live --prune/--stop`, `switch`, `point`, or the transcript scan `sweep` runs — `--config-dir
<path>` is still the only door onto a registered root for any of those, on purpose
(`tests/clients.test.ts` guards the shape).

## Opening a terminal as an account

`foster client open <client> [-d <cwd>] [--follow-link] [--guard] [--print]` opens a Windows
Terminal tab with `CLAUDE_CONFIG_DIR` set for that tab alone — the one thing on this machine that
resolves name -> directory -> identity -> live writers -> junction target before it opens anything,
and refuses the cases that bite instead of opening into them. Nothing here signs in or switches an
account — a client that is signed out still opens, onto the CLI's own login — and nothing is
written to the ledger; `--guard` is the one opt-in exception, reaching the vault the same
read-then-remember way `foster guard` does.

A junction is a pointer, not a client (see "Fleet directories" above): opening straight on one is
refused, because a tab that started on the link keeps writing through it after the next `foster
point`. `--follow-link` opens on the target instead, and the warning that follows still names any
other junction currently pointed at that same target — a terminal opened directly there spends
that rotation's quota too.

Two measurements this rests on were never made, so the code assumes the more dangerous answer to
both. Not measured as of 05/09/2026:

- **P7** — whether `wt -w 0 new-tab` inherits the _target_ window's own environment rather than the
  one this process hands the new one. If it does, a `CLAUDE_CONFIG_DIR` already set there would leak
  into the new tab's shell before the `-Command` ever runs — so both the scrubbed spawn environment
  and a second `CLAUDE*` cleanup inside the `-Command` itself apply, not just one.
- **P11** — whether opening a terminal directly on a fleet junction's active target competes with
  that fleet's own rotation. This stays a warning, not a refusal, and there is no `--fleet` flag to
  make it stricter.

`foster clients --fragment` gives every client its own entry in the Windows Terminal menu instead,
by printing a fragment (JSON) for the Terminal to pick up. Create the fragment folder once, then
redirect into it — in that order, because `>` does not create a directory:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster" | Out-Null
foster clients --fragment > "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster\clients.json"
```

Three things that bite: the Terminal writes a stub of the profile into your own `settings.json` on
first load; `wt -p <name>` with a name that does not match opens the **default** profile silently,
so use `client open` instead when being certain matters; and the fragment has to stay UTF-8 —
Windows PowerShell 5.1's `>` writes UTF-16 and breaks it. Restart the Terminal if the entry does
not appear.

## A launched Claude.exe never inherits foster's own `CLAUDE*` env

Foster commonly runs from inside a Code session the app is itself hosting, and that session's
environment carries markers (`CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_USER_DATA_DIR`, and anything else starting with `CLAUDE`, case-insensitively) that tell
the app and its bundled CLI "I am hosted". Every launch foster starts — `app start`,
`app restart`, the default installation or a second profile — hands the child a copy of
`process.env` with those stripped (`scrubbedEnv`, `src/engine/launchEnv.ts`) instead of letting
it inherit them, so a profile started from inside a hosted session does not come up thinking it,
too, is hosted.

## The full sweep — "bring everything into this account"

One command:

```bash
foster sweep            # what it would do, writing nothing
foster sweep --yes      # do it
```

It copies every fosterable session from the other accounts — **archived included** — gives
every branch of a forked conversation a row of its own, brings back conversations the app
deleted that nothing points at, then re-scans to say whether anything is left. Archived copies
stay archived, so they arrive in the app's _archived_ view rather than in Recents; say so, or
the user will look for rows that are not there.

A fork is one conversation continued in more than one account, each continuation on a
transcript of its own. The sweep does not choose between them, and it no longer calls every
other branch stopped. Three outcomes, decided per branch:

- the **tip** — the branch holding most records no sibling holds — keeps its title;
- a branch whose own last **answer** is later than the tip's, and that holds records of its
  own, **went on after the tip**: it is retitled `(other branch, went on DD/MM HH:MM) …` — or
  whatever `--branch-prefix` says — and **stays in the sidebar**, unarchived. Measured on a
  real store, two of the 40 forks the sweep could see looked like this — the fresher half 50
  and 77 hours ahead — and the old rule filed exactly the half the user had been working in;
- only a branch that really did stop earlier is retitled `(stale, stopped DD/MM HH:MM) …` —
  `--stale-prefix` — and filed in the archived view, native rows included.

"Went on" is judged on the last answer, never the last record: opening a stale row appends a
user record to its transcript, so the last _message_ can be a click rather than work
(`divergedFrom`, `src/engine/branches.ts`). Nothing is hidden; `foster consolidate` is the
optional tidy-up for anyone who wants one row.

Which conversations are branches of each other is decided before any of that, and
`conversationRoot` — the first record a transcript holds — only answers it when the app copied
the conversation from its beginning. A fork begun in the middle opens on a middle record,
rewritten with no parent, and the halves disagree about their root while sharing thousands of
records. `Lineage.deepen` closes that: a root found _inside_ another conversation is filed as
that conversation's work. It reads every transcript it is given without parsing them — 6.7 GB in
about 5 seconds against 118 for a JSON walk — and `forksOf` calls it before grouping, which is
why a sweep on a large store takes about half a minute rather than nine seconds.

## One conversation can be two files, and the row can open the shorter one

A `cliSessionId` names a conversation; it does not name a file. The app opens the transcript
under the project directory for that card's **working directory**, so continuing one
conversation from a repository and from a worktree cut out of it leaves two files under one id —
not copies of each other, each holding what was written while its own card was in use. Measured
on this store, over the roots foster scans: 41 conversations hold more than one file, 24 have
records the first file does not, 6070 records were invisible, worst single case 1362.

Everything that measures a conversation now reads **every** file it occupies (`scanOf` unions the
record sets, `rootOf` takes every file's head and files the extras as aliases, `deepen` reads them
all), so `only`, `total` and the moment a stale row is stamped with describe the conversation
rather than whichever file the directory walk offered first.

The second half is about what a row can open, which is not the same question. An account can show
a conversation and still be unable to reach most of it — 90 cards here open a partial file, 19,398
records out of reach — so the refusal "this account already has that conversation" is lifted when
the offered card opens records **no** row here can (`Sidebar.unreached`, `Lineage.reachOf`). The
result is a second row for that conversation, one per working directory, and the line says why:
`(a second file of a conversation already here: N record(s) no row here could open)`. It is asked
of the directory the **copy** will open in (`copyCwd`), because a card cut from a worktree is
rewritten to open in the repository it came from — unless its own worktree file is the one that
reaches more. "More" is measured against this account, not by file size (`worktreeReachOf`):
measured 15/09/2026, a worktree card whose repository file was the bigger one (4872 records
against 4802) lost a whole night's work — 2116 records only the worktree file held — because
the copy would have opened the repository file this account already showed, and the card was
skipped as already here. The sweep needs it in two places: a fork held in
two files went to the branch pass, which decides on the id alone, and was retitled rather than
completed.

Which of those two rows to continue in is no longer left to the reader. A pass of its own
(`foster sweep`, `src/engine/fileCards.ts`) elects **the row whose last answer is the most
recent** — where the work was left — leaves its title clean, and marks every other row of that
conversation `(other file, stopped DD/MM HH:MM) ` (`--other-file-prefix`), filing it in the
archived view. Measured 19/09/2026 on a real store: 12 such pairs in one account, the repository's
file the fuller one in 7 of them and the worktree's in 5 — so "the worktree row is the fuller one"
is not a rule, and nothing here guesses from the shape of a path. Two refusals hold it honest: a
row the branch pass has already marked is left to that pass, since a row can be on the losing side
of both questions and its branch is what decides whether it belongs in the sidebar at all; and a
row opening the _same_ file as the elected one is a duplicate, not a second file, so it is left
alone. Nothing is merged — `consolidate` still does not join two files of one conversation.

**The election has two more fixes worth knowing about.** `scanConversation`'s `lastAssistantAt`
(`src/store/transcripts.ts`) used to count _any_ `type: 'assistant'` record, including the
usage-limit record the app writes in the model's own place (`isApiErrorMessage: true`, model
`<synthetic>`) and a subagent's sidechain turn (`isSidechain: true`) — `lastAnswer`, the tail
reader right above it, skips the sidechain record but deliberately surfaces the usage-limit one
(`revive.ts` reads its `error` field to know a rate limit, not a real answer, stopped the
session), so the two answer different questions on purpose. The whole-file scan not excluding the
usage-limit record too is what let a usage limit look like a fresh answer: a row opened from
`(stale…)`, typed "continue", hit the
weekly limit before a real answer came back, and the branch pass called that branch diverged,
archiving the row that actually held the work. Measured 24/09/2026 over 11,191 real transcripts on
this machine: 1,783 carry a synthetic usage-limit assistant record, 8,097 carry a sidechain one, and
`lastAssistantAt` changes under the fix for 8,502 of them — the large majority. The same function
also took the _last_ record in file order rather than the max timestamp, which `branches.ts`
already documents copies as not preserving; measured the same day, 4,320 real files have
out-of-order timestamps (rarely enough to move the final answer — only 30 changed `lastMessageAt` —
but a real, not theoretical, gap). `byContinuation`'s tie-break (`src/engine/fileCards.ts`) had the
same shape of bug one level up: on a tied `lastAssistantAt` it fell back to `lastMessageAt`, which a
mere click changes, so opening the row this pass had just filed away could flip the election on the
next run. `only` — what a file holds that its sibling does not, which a click never moves — is asked
before `lastMessageAt` now.

One thing this does not do: it never repoints or rewrites a card the account already has — the
existing row keeps opening what it opened. What it does do is reach past `already fostered`: since
#63, `resolveExisting` (`src/engine/executor.ts`) asks `unreached` of a copy the ledger vouches
for and that is still on disk, too, and when the file the offered card would open holds records
beyond what this account reaches, it makes a second row instead of skipping — once, not once per
run. The test "brings the worktree file of a conversation whose earlier copy the ledger vouches
for" (`tests/executor.test.ts`, added in #109) walks that path.

**A mark written by an earlier run is recognised from the ledger, whatever words it used** (#35).
`CardRetitledEvent`/`FosteredEvent` now carry the `template` a mark was made from, and
`templatesSeen` (`src/domain/stale.ts`) falls back to deriving it from old entries that predate the
field — so a bare `foster sweep` recognises a row the `/fosteia` skill marked `(defasada, parou
{when}) `, and a Portuguese sweep recognises one the English default marked. Measured on a real
store: 10 rows would have been rewritten that way by one bare `foster sweep --yes` on 05/09/2026 —
before the fix. `--stale-prefix` and `--branch-prefix` still choose the words a _new_ mark is
written with; `--branch-prefix` defaults to English, and the `/fosteia` skill passes both in
Portuguese so a fresh mark reads in the language the sidebar is read in, not because passing only
one would stack any more. A row wearing a mark no known template can explain — a hand edit, or a
write from before this shipped — is skipped rather than guessed at, and named in the sweep's
summary so the words can be fixed by hand or the run repeated with the matching prefix.

You are done when it prints **"Nothing is left to sweep"**. It also counts what can never come —
scheduled tasks, sessions never opened, files over the 10 MB the app refuses to load — so report
that line rather than leaving the user to wonder what the gap was.

One invocation finishes what used to take three. Measured 24/09/2026: `/fosteia` printed "Not
finished" twice, and each re-run re-read 6.7 GB of transcripts. Two causes, two fixes. A round's
own writes can hand the next round work — a copy the ordinary pass brought completes a fork the
branch pass had already judged without it — so `runSweep` now takes up to `SWEEP_ROUNDS` (3)
rounds in the same process when its re-plan still finds work, reusing the lineage and every other
account's scan, and says "Took N rounds" when it did. The rest was the running app saving 10 of
49 fresh marks back over from memory within three minutes, after the run's own re-plan had
passed; that is `engine/marksBack.ts` in the layout gap, below.

The same day's profile: an 85-second dry run spent 42 s in the garbage collector. The store held
25,174 cards, 1 GB of JSON, 93% of it `remoteMcpServersConfig`, and the sweep kept every card of
every account alive for the whole run. A scan now leaves `BULKY_CARD_FIELDS`
(`store/sessionFile.ts`) out of what it keeps (`DiscoveredSession.slim`), and the one write that
copies a whole card reads them back from disk first (`withBulkyFields`, `executor.ts`) — any new
writer that spreads a scanned card's `data` into a file must do the same. `planUnclaim` and
`planTitleSync` take the cards the sweep already read instead of re-reading each off disk. With
`/fosteia`'s flags, a dry run went from 131 s to 45 s.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. When
foster is running inside the app it will not do that (see below) and the output ends with the
command to run elsewhere instead.

`sweep` deliberately never purges and never consolidates. Pass the "forked conversation" line
on as it is: rows added, rows retitled, and that the clean title is the row to continue in.

A fourth pass releases the worktree claim a copy already on disk inherited from its original,
before 0.38.0 taught fostering not to hand one out (`foster unclaim`, issue #26's second half).
It only ever touches copies — the ledger's own active fosterings decide that, never a scan — and
is folded into the same "nothing is left" check.

Releasing a claim takes no write guard, like `retitle`: it is allowed with Claude Desktop open,
never refused for it. A card the app rewrites in the meantime simply keeps (or regains) its claim
on disk, which the next `foster unclaim` or sweep pass finds and releases again — the change itself
only becomes visible at the app's next restart, the same as a retitle.

## The ledger fold: one active fostering per copy, not per key

`LedgerState.active` (`src/ledger/project.ts`) is keyed on the copy's own session id, not on
`fosteringKey(originSessionId, target, cliSessionId)`. The second-file path above is exactly why:
`resolveExisting` (`src/engine/executor.ts`) legitimately writes a _second_ `fostered` event under
one idempotency key when the first copy is still on disk but the offered card's own file reaches
records it cannot — both copies are current, and keying the fold on the idempotency key let the
second event overwrite the first, silently dropping the older copy from `listActive` forever
(`return`, `unclaim`, `titleSync`, `consolidate` and everything else that reads `active` never saw
it again, though the file itself was still there). Measured against the real ledger: 275 `fostered`
events had overwritten a still-active key this way, all recovered by the fix with no migration
event — `activeByKey` (a `fosteringKey -> Set<copySessionId>` reverse index) is a pure fold over
the same log, folded fresh on every read. `isFostered` and the executor's own idempotency check
read `activeByKey`; nothing else needs it, since everything else already enumerates copies through
`listActive`/`active.values()`. `copySessionId` is what makes keying on it safe: every copy mints
one from `mintSessionId()` (`domain/fostering.ts`), global and never reused, so two copies can
never collide there the way two writes to the same idempotency key routinely do.

## Lineage precision: nested ids, incremental deepen, big files, deep roots

Four small correctness fixes to `src/store/transcripts.ts` and `src/engine/lineage.ts`, all
measured against a real store (2,759 transcripts under `.claude/projects` and `.claude-frota/projects`,
7.8 GB) rather than assumed.

**`idsMentionedIn` no longer aliases on a nested id.** It matched `"uuid":"…"` anywhere in a
transcript, so a structured `toolUseResult` — an MCP result object quoting another conversation's
head as a nested value — could alias a whole conversation onto work it never wrote, and `deepen`
trusted that enough to mark it stale. A hit is now confirmed against `recordFields` (the same
structural reader `scanConversation` uses, which only reports a key found at a record's own top
level) before it counts. Measured over the real store's ~2 million `"uuid":"…"` occurrences: one
genuine nested (non-top-level) hit — real, and exactly what this was written for, and rare enough
that validating only the candidates that already match `wanted` costs nothing on the common path.

**`idsMentionedIn` and `conversationRoot` stream instead of reading a whole file or a fixed head.**
`idsMentionedIn` used to `readFileSync` the whole transcript as one string; past V8's string-length
ceiling (today's largest transcript is 78 MB and growing) that throws, is caught, and answers
"mentions nothing" — the fork it belonged to silently disappears rather than erroring loudly. It
now reads in 16 MiB chunks with a 128-byte overlap (comfortably more than the 45 characters
`"uuid":"…"` can span), so a match split across a chunk boundary is still found, and a rare hit is
confirmed by seeking out its own line directly off disk (`ownerLine`) rather than by holding lines
in memory. An early version read line by line instead (reusing the line streamer `conversationRoot`
now uses); over the real store that measured slower than a few big chunk reads, which is why chunk
scanning stayed. Interleaved against one `readFileSync` per file on a warm disk cache, three
approaches (whole-file, 1 MiB chunks, 16 MiB chunks) landed within the same ±30% run-to-run noise
this machine has — nothing here beats the old whole-file read, only avoids losing to it while also
not crashing on a giant file. `conversationRoot` used to stop at a fixed 64 KB head; it now streams
until it finds a record with a `uuid`, capped at 4 MB. The task that asked for this fix cited 369 of
10,587 real transcripts answering wrong ("no root" when a root exists) under the old 64 KB cutoff —
a figure this pass did not itself reproduce, since it measured against a smaller corpus (the 2,759
transcripts named above). What this pass measured directly, old code against new over that corpus:
159 of the 2,759 went from "no root" to a real root once the cap moved, and none went the other way
— no regression, consistent with (if smaller in absolute count than) the cited figure.

**`deepen` compares a lone new id against transcripts from earlier rounds, not just its own
batch.** The sweep calls `Lineage.deepen` once per round (`runSweep`, up to `SWEEP_ROUNDS`) with
whatever cards that round knows about, and `deepen` itself already skips ids it has seen before —
but a round that hands it exactly one new id used to short-circuit (`heads.size < 2`) before
searching anywhere, so a card the app creates between rounds was never weighed against the work
already indexed. It now keeps every id's head it has ever been given (`deepenedHeads`) and searches
both directions on each call: this round's new heads against every transcript any round has read,
and every earlier round's heads against this round's own new transcripts.

That fix, by itself, made a later round with even one new id pay to re-read and re-scan every file
any earlier round had already read, from disk, every time — because `idsMentionedIn` never remembered
anything between calls, and a `wanted` set's size does not change how many bytes it reads. Measured
directly, old code against new, against this machine's own real store (2,523 conversations, 2,760
files, the same corpus the rest of this section cites) — a round holding back two ids to stand in for
"a card the app created between rounds", same as `runSweep`'s own rounds do: old code, an initial full
deepen ~12–13 s, a next round adding exactly one new id ~8–9 s, a third round adding one more ~8–9 s
again — reintroducing, on one new id, most of the cost `SWEEP_ROUNDS` exists to spread across up to
three passes instead of paying once. `deepen` now passes `idsMentionedIn` a `RecordIdCache`
(`src/store/transcripts.ts`) that remembers each file's chunked scan — every `"uuid":"…"` match and the
byte offset it sits at, unvalidated — the first time a round asks about that file, and every later
round's different `wanted` is answered from that memo instead of a fresh read: the same corpus, new
code, round 1 ~22 s (slower than old — building the full per-file occurrence map, not just the ids one
round happens to want, costs more up front), round 2 and round 3 ~0.18 s each. One new id went from
costing 8–9 s a round to costing under a fifth of a second, and the three rounds together dropped from
~30 s to ~23 s despite round 1 alone costing more — the saving `SWEEP_ROUNDS` was written to buy back.
Validating a hit still reads the current line off disk, same as before: only
the scan that finds candidate positions is cached, not the record content, so a file that grows between
rounds (an append, same as always happens to a live transcript) is read fresh for whatever position a
later round's own file-open covers — a match sitting only in bytes appended after a file's own first
scan is not found by a later round that reuses the cached scan of that file, which is deliberate and
covered by a test (`tests/lineage.test.ts`, "never sees a match added to an already-scanned file after
the scan") rather than assumed harmless.

## You cannot restart the app from a session the app started — except through `--detach`

A Claude Code session launched from Claude Desktop's sidebar is a **child process of the
app**. `app quit` and `app restart` want the app closed, and closing it kills the session
part-way through — which is why foster refuses to close an app it is running inside.
`consolidate --yes` and `return` are narrower than they used to be: since #15 they hold only
what the app is actually holding — a native card, or a copy that already existed when the app
started — so the rule is **run them before the restart, not after**, and a card the app itself
made waits either way. `sweep --restart` asks first and hands over the command instead of
failing at the end of a run that already wrote everything.

`--detach` (on `app restart`, `layout`, `view set`, `view copy` and `sweep`) is the one way
around the refusal itself, not a way to skip asking. Measured end to end 22/09/2026:
`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments
@{CommandLine='wscript.exe "<vbs>"'}` starts a process whose parent is `WmiPrvSE.exe` — outside
the app's tree and its MSIX container — so it survives the app quitting. The `.vbs` runs
`cmd.exe /c "ping -n <delay+1> 127.0.0.1 >nul & echo … & node "<foster.js>" <args> & echo …"`
through `WScript.Shell.Run(cmd, 0, True)`: window style `0` is what actually hides it on this
machine, where Windows Terminal is the default terminal and a console process pops a window
even under `-WindowStyle Hidden`. What it launches is the same command again, minus `--detach`
— so `foster layout --yes --restart --detach` writes nothing itself; the detached re-run of
`foster layout --yes --restart`, outside the app a few seconds later, is what actually quits it,
writes in the gap, and starts it again. `sweep --detach` is narrower still: the sweep's own
writes happen now, in-process, as always — only the restart at the end is handed to the
detached process, as `foster app restart` or `foster layout --yes --restart` (whichever `sweep`
would otherwise have printed).

The cost is not optional and is said before it is paid: **every session the app hosts ends when
it quits, this one included**, with no way to warn one first and no undo. `--detach` reads the
live-session registry the way `foster live` does and refuses outright, naming them, if it would
end anything besides the session it is running in — `--detach-even-with-live` is the override,
and it then names every session it is ending before it launches. The `/fosteia` command passes
it on its final `foster layout --yes --restart --detach`, by the user's decision of 24/09/2026 —
that one command and no other; nothing else in this codebase adds it on its own initiative (see
the command's own "Never" list). Pitfall measured writing the `.vbs` generator: `Log` is a VBScript built-in
function, and a variable named `Log` kills the script with an error dialog before anything
runs — `src/engine/detach.ts` never names one of its own variables after a VBScript built-in
(`Log`, `Date`, `Time`, `Len`, …), and a test holds that promise.

The session that launched a detached restart is gone by the time it lands — there is no way for
it to say whether the write actually happened. `foster detached --last` is what reads that back,
from `<FOSTER_HOME>/detached/<stamp>-<verb>.log`: pending (no `start` line yet), running (`start`
with no `end`), or done. Read it in a **new** session, after the app is back.

Check before promising anything:

```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p) { "$($p.ProcessId) $($p.Name) $($p.ExecutablePath)"; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
```

An ancestor under `WindowsApps\Claude_*` means the answer is: hand the user the command for
a terminal outside the app. Do not try to work around it.

That probe is PowerShell, and PowerShell is not always the tool that answers (see the next
section). When it is stuck, ask wmic the same question about one pid instead:
`wmic process where "ProcessId=<pid>" get ParentProcessId,Name,ExecutablePath /format:list`.

## A reported "live writer", and why the pid alone was not one

Foster decides a conversation has a live writer from a registry file under
`<configDir>/sessions/<pid>.json`. "Does that pid still exist" is not enough on its own —
Windows reissues pids quickly, and after a reboot much of a day-old registry names whatever
took the number next. So the record's own account of its writer is checked against what the
pid names now:

- the CLI writes the writer's creation time into the file (`procStart`). Two processes can
  share a pid but not a pid _and_ a creation instant, so a match is proof and a difference
  is proof of the opposite;
- with no creation time to check — an older CLI — a process that is not a Code CLI at all,
  or one that started after the record describing it was written, is a stranger.

Where there is no process table to read (anything that is not Windows), every entry stays
listed and `live --stop` refuses rather than guessing. Trust the warning; what it will not
do is name a writer that is not there.

`live --stop` is still `taskkill /F /T`, so whatever that session had not written is lost —
and it refuses a pid it could not identify, and the session foster is itself running in.

`staleRegistryEntries` and `pruneRegistry` used to trust one scan across both of them: a file
judged stale is a pid, and `<pid>.json` is the CLI's own naming, not foster's — nothing stops
Windows reissuing that exact pid to a brand-new `claude` process in the gap between the scan
and the delete, and that process registering itself under the very filename about to be
removed. `pruneRegistry` now re-reads each file's `procStart`/mtime immediately before
`unlinkSync` and skips the delete (reporting it under `failed`, not `removed`) when what it
finds no longer matches what made the file stale — the new session's own registration survives
instead of losing its fork protection the moment it takes effect. Tested with a synthetic
recycle (`tests/liveSessions.test.ts`, "does not delete a registry file whose pid was recycled
between the scan and the delete"); not reproduced against the real registry, since it is a race
that only a live scheduler can actually trigger.

`foster live` and `app status` now also say **which store hosts** a live session, not just its
raw cwd: each registry entry is cross-referenced against every known installation's own card
(`hostedStoreFor`, `storeHoldsSession`) and printed as `hosted by <name|root> · last seen as
<label>`. An entry whose card cannot be found anywhere stays unlabelled rather than guessed at.

The same "prove it, don't just fail to look like something else" rule now guards `app
quit|restart` against the opposite mistake. A standalone `claude.exe` — someone's
`~/.local/bin/claude.exe`, run from a terminal, never installed as the app at all — used to pass
`isDesktopProcess` by elimination (not the Code CLI, therefore the app), and with the app closed
a machine carrying several of them turned each into an orphaned "desktop" row that
`app quit --terminate` could pick as the oldest and kill. It now demands positive proof instead:
a path under a known store root, under the app's own `\Packages\Claude...` directory, or a child
process carrying Electron's `--type=` — absence of the CLI's markers no longer counts as
presence of the app's.

## Reading processes no longer needs a live PowerShell

Symptom measured 05/09/2026 on this machine: PowerShell hangs at start-up (`InitializeDefaultDrives`
of the FileSystem provider, blocked on a WinFsp/Cryptomator drive that had stopped answering), every
`powershell.exe` invocation waits the full 20 s and then errors, and `foster app status`, `foster
live`, `foster stores` and `foster doctor` each pay that 20 s and then report an empty machine — a
lie, and a dangerous one for `live --stop`, which decides what to kill from that table.

`readProcesses()` now falls back: PowerShell first, then `wmic process get ... /format:list` (same
six fields — pid, parent pid, name, path, command line, start time), then `tasklist /fo csv /nh`
(pid and name only). A PowerShell that fails once is not retried for the rest of that run — the hang
is paid at most once. Run `foster doctor` and read the `process table` line: `via PowerShell` is the
healthy case, `via wmic — <reason>` means PowerShell was passed over but the table is still full,
`via tasklist (partial: ...)` means only pid and name are known, and `unreadable` means nothing
answered at all.

A table read through tasklist refuses rather than guesses: `app status` says it cannot tell the app
from a Claude Code session, `live --stop` will not touch a partial row, and `sweep --restart` hands
over the command instead of trying. Do not treat a partial table's empty path or command line as
evidence of anything — it means the reader could not report one, not that there was none.

When PowerShell is stuck and you need the answer directly, these run without it:

```
tasklist /fo csv /nh
wmic process get ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate /format:list
```

## Reviving what a usage limit stopped

`foster revive [--since 24h] [--json]` lists the sessions in the current account whose
conversation ends on the app's own limit record (`isApiErrorMessage: true`, `error:
"rate_limit"`) — read from the file each card opens, never from the card, whose `error`
fostering drops. One row per conversation and per repository branch, the latest stop kept;
live writers and the duplicates it dropped are named in `passedOver`. It writes nothing and
sends nothing: the `/retoma` skill, run inside Claude Desktop, delivers the "quota is back,
carry on by highest return" message with `send_message`. A headless resume is not a substitute
— it never reattaches the card (next section).

That answer comes from `lastAnswer` (`src/store/transcripts.ts`), which reads a transcript's tail
looking for the last `assistant` record. The tail used to be a fixed 256 KB; the task that asked for
this fix cited 22 of 7,721 real transcripts with more than that much bookkeeping — queue operations,
retitles — written after the actual last answer, pushing it out of the window entirely and reading as
a session that finished cleanly. This pass did not reproduce that figure: its own 2,759-transcript
corpus held none of the long-tail-bookkeeping transcripts the fix targets, so old code against new gave
zero differences over it — no regression, but no direct confirmation of the benefit either. It now
widens the read (×4 each retry, capped at 8 MB) when a window comes back with no assistant record, so
a transcript like the cited 22 is found rather than missed; the ordinary transcript, whose answer is
already in the first 256 KB, pays nothing extra.

## Rescuing "cannot reach your computer" cards

`foster rescue` lists them; `--open` opens a terminal tab per conversation, stopped at the
resume prompt. Two facts that save wasted turns (both measured on a live store):

- `foster resume` / `claude -p --resume` **does not reconnect the card** — print mode never
  attaches to the app. It spends the tokens and the card stays unreachable.
- An agent running **inside Claude Desktop** can rescue without terminal tabs: deliver a
  message to the stranded card with the app's own session tools (`foster rescue --json` is
  the work list) and the app hosts the conversation itself, which re-links the card. The app
  refuses a card whose directory is gone — recreate the worktree first
  (`git worktree add --detach <path>`) — and delivery runs a full turn, so the message must
  say "do not resume any pending work".

  Finish the job while you are there: the fresh hosting card arrives **untitled** (it shows
  as "General coding session") and the husk keeps the real name. Copy the title over with
  `set_session_title` — drop a leading "↪ ", foster's old copy marker — and archive the husk
  with `archive_session`; it never reconnects. None of this can run from the CLI: the app
  creates the fresh card on its own, and the session tools only exist inside the app.

## What `foster agent` does and does not cover

`foster agent "<task>" --yes` exposes ten tools: `scan_accounts`, `list_sessions`,
`foster_status`, `app_status`, `read_transcript`, `label_account`, `foster_sessions`,
`sweep_everything`, `return_fosterings`, `resume_headless`. `sweep_everything` is the one to
reach for on "bring everything here": `foster_sessions` leaves archived sessions behind and
cannot reach deleted conversations at all. **`consolidate`, `purge` and `live` are not among
them** — `purge` is excluded on purpose and must not be reached through the shell either.

## The registry has two views

Measured on 2026-09-05, against a real MSIX install (`Claude_pzs8sxrjxfjjc`):

- Claude Desktop's manifest routes `claude://` through **package activation**, not the classic
  per-user registry key you would expect to find and edit — `HKCU\Software\Classes\claude\shell\
open\command` is not what actually decides where a callback lands.
- **Inside the app's container** — any process descended from it, including every Code session it
  hosts — that key exists anyway, holding the app's own executable. It is MSIX registry
  virtualization's private copy of the write Electron's `setAsDefaultProtocolClient` makes; a
  browser running outside the container never sees it. It is a decoy.
- **Outside the container** — an ordinary terminal — the `claude` class key exists with just a
  `URL Protocol` marker, and there is normally no `shell` subkey at all.

Any `reg` read `foster` does from inside a hosted session is the virtualized view: it can tell you
what the app's container believes, never what a browser on the same machine would actually reach.
`foster doctor` says so explicitly (`registry seen from inside the app's container: ...`) rather
than judging a handler it cannot trust.

## The packaged store's two paths fold, or they don't, depending on where you run

Measured 05/09/2026, same MSIX install: the packaged app answers to two paths — the
`Packages\Claude_<hash>\...` directory and the pre-virtualisation `%APPDATA%\Claude` one —
and `directoryKey` (`src/domain/paths.ts`) folds them into a single `foster stores` row only when
`statSync` reports the same device and inode for both. Inside the app's own container that is
true, because MSIX virtualisation makes `%APPDATA%\Claude` a view onto the package directory. From
an ordinary terminal it is false — the two are genuinely different directories, and `%APPDATA%\Claude`
is the real pre-MSIX store, still holding whatever was fostered into it before the app was packaged.
Run `foster stores` from inside a hosted Code session and you see one installation; run it from an
ordinary PowerShell on the same machine and you see two.

`isLegacyAppDataStore` (same file) is what keeps the second row honest: it labels `%APPDATA%\Claude`
`legacy (pre-MSIX)` only when a `Packages\Claude*` store is actually present on the machine and did
not fold into it — never from the shape of the path alone. That gate matters because
`%APPDATA%\Claude` (or its platform equivalent) is simply _the_ store on macOS, on Linux, and on a
Windows machine that was never packaged at all; calling it legacy there would be wrong, not just
imprecise.

## Signing a second profile in

Measured 05/09/2026, superseding the classic-key hypothesis above: what actually decides where a
`claude://` callback lands is a **packaged ProgID** — `HKCU\Software\Classes\AppX<hash>`, the key
Windows itself created when it registered the package — never the classic
`…\claude\shell\open\command` key, which `foster` no longer touches at all. The ProgID's `Shell\open`
subkey carries `AppUserModelID` (which package this is) and `Parameters`, the argument string
appended to the package's own executable at activation time, normally just `"%1"`.
`foster --store <profile> app login --yes` finds that key (`findProtocolProgId`), points
`Parameters` at `--user-data-dir=<profile> "%1"` for one sign-in, and puts back the exact value read
before it wrote — **the one registry VALUE this ever touches, never a key, never a level**: the key
always already exists, so there is nothing to create or delete. It waits until the sign-in lands or
Ctrl+C; `--timeout <seconds>` caps it. It needs `--yes` — without it, it only prints what it would
do. It refuses outright from inside Claude Desktop's own container (see above) — a change there is
invisible to the browser regardless of what follows.

A second, independent fact the same measurement uncovered: the callback process only _finds_ the
profile it means to forward to when that profile's own instance was itself started **with package
identity** (`Invoke-CommandInDesktopPackage`, not a bare `Claude.exe` child process) — `app start`
and `app login` both start a profile this way now on a real MSIX install, falling back to a direct
launch only when the cmdlet is missing or fails, and say which one won. `app login` refuses when the
running profile has no package identity rather than arming a handler whose callback cannot land;
`--restart-profile` closes it and starts it again the right way in one step. Separately, a profile
that comes back from a restart can come up with its window hidden (signed in, nothing visible); both
`app start` and `app login` give it a few seconds and, if it has not appeared, send one more launch
to raise it.

Edge and some Chrome profiles hold a standing permission to auto-launch `claude://` from claude.ai
with no dialog — so `app login` arms `Parameters` _before_ telling the user to click "Continue with
Google", never after, and its own instructions say an auto-opened Claude window is expected, not a
mistake.

**An agent must never run this**: it writes a machine-wide registry value and drives a sign-in only
the human at the keyboard can finish in the browser. **Never print a `claude://` URL: it carries a
single-use code** — not in `app login`'s own output, not in `app link`, not anywhere a log or a
transcript could keep it. `foster app login --restore --yes` is the way out of a login left routed
by a crash or a stray Ctrl+C; `foster doctor` reports the ProgID found and warns when `Parameters`
is still routed to a profile.

## Groups and routines: `foster layout`

Measured 22/09/2026, real MSIX store, app 2.2553.1.0.

Sidebar **groups** live in `<store.root>/claude_desktop_config.json`, at
`preferences.epitaxyPrefs["dframe-group-scopes"]["<accountUuid>/<organizationUuid>"]` — one scope per
account/org, holding `groups` (`{id, name}[]`, array order is sidebar order), `assignments` (card id
`code:local_<uuid>` -> group id) and an optional, partial `order` (group id -> card ids). The app owns
the file and rewrites the scope within seconds of a group being created through the UI — same rule as
`store/pinstate.ts`: write only while the app is closed, back up first (`store/groupScopes.ts`,
`writeGroupScope`, same "verify nothing else moved" discipline as `writeAppPref`). An archived card
cannot be shown in a group — the app's own tool refuses it — so a target whose only matching card is
archived is skipped and reported, never assigned.

**Groups live in three places**, not just the config file above: the same scope also sits in Local
Storage, once under its own key (`LSS-persisted.dframe-group-scopes`, keyed the same
`<accountUuid>/<organizationUuid>` way, wrapped in a `{value, tabId, timestamp}` envelope) and again
folded into `dframe-store`'s own `state.customGroupsByScope` — the same database the filter menu
below lives in. `applyLayout` (`localStorageGroupWrites`, `src/engine/layout.ts`) writes all three
together in one batch (`writeLocalStorageEntries`, one sequence number for every Local Storage key)
whenever a Local Storage database exists at all — skipped, not failed, on a store the sidebar's
filter menu has never touched yet.

**What the app trusts at startup: a fourth place, the server.** Measured 23/09/2026, 0.58.0, app
2.7032.0.0. A detached `foster layout --yes --restart` quit the app at 08:36:20, wrote the target's
scope to all three places, and the app started again at 08:36:22 — and at 08:36:25 rewrote the
config and both Local Storage keys **without** the target's scope; `list_groups` answered "No custom
sidebar groups". Routines, written in the same gap, survived. Not a write that lost the race: the
Local Storage `LOG` says LevelDB reopened at 08:36:23 reusing the very log foster had appended to,
with no corruption, and foster's records (5 groups, 27 rows) sit in the table it flushed next — one
sequence number before the app's own write that emptied them. The sidebar is claude.ai code, not
the desktop app's (`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/`, read that day):
`dframe-store` is a zustand store registered as a **server-synced store** (`ccd/dframe-store`, the
account's `/api/claude_code/organizations/<org>/user_settings`). At startup the page hydrates from
Local Storage, folds the config's scopes in only where Local Storage has none, then reconciles with
the server — and the server merge replaces the signed-in account's **list of groups** with the
server's, keeping a local `code:local_*` assignment only when its group id is one the server already
knows. Those assignments never go up (a local session is machine-local); the group list does. A
group foster minted had an id the server had never seen, so every assignment to it went with it.
Other accounts' scopes survive because only the signed-in account's scope is synced.

The page's own way out is the Local Storage key `ccd-sync-pending:ccd/dframe-store`, a bare string
(`DFRAME_SYNC_PENDING_KEY`, `src/store/localStorage.ts`). When it names the signed-in identity —
`<accountUuid>/<orgUuid>`, the same string `scopeKey` builds, or the wildcard `1` — startup uploads
the local state instead of taking the server's, and a `|migrate` suffix unions the server's groups
in first (`mergePendingSeed`), which is what the page itself writes when it migrates legacy groups.
The page sets it on every sidebar edit and deletes it once the upload lands. `applyLayout` now
writes `<scopeKey>|migrate` into the same batch as the two documents, and leaves alone a marker that
already names the target (it already uploads; turning it into a merge would bring back a group the
user deleted here). Under any other signed-in account the page clears the marker unused.
**Watched through a restart the same day, 09:36:** a group with a freshly minted id and one row,
written in the gap with the marker, came back with its row; 60 s after start the page had consumed
the marker (gone from Local Storage), and `dframe-store` held the local groups plus the server-only
ones `|migrate` had unioned in. The scope still held it after three more restarts. Even so, `foster
layout --yes --restart` no longer ends on "with the layout applied" on the strength of the write —
the page is claude.ai code and can change under it any day: it waits for
the app's own rewrite of the config (≤30 s, then 5 s quiet — `verifyLayoutGroups`,
`src/engine/layoutVerify.ts`), reads back every row it filed, and says how many the app dropped
and from which groups, exiting 1, when it dropped any. The recovery that held on 23/09 is still
the fallback: the app's own `create_group` + `move_sessions`, fed from `foster layout --json`'s
`assign` lists. Groups created that way with no rows never reach the config file (the page writes
only groups that hold a row), so a later `foster layout` still lists them as new.

**Routines** (scheduled tasks) live per account/org at
`<store.root>/claude-code-sessions/<accountUuid>/<orgUuid>/scheduled-tasks.json`
(`store/routines.ts`). Every account/org directory has one, often with an empty list. `filePath`
points at a `SKILL.md` under the shared CLI config dir, so the same path is valid from any account —
nothing here is Desktop-store-specific except the enable flag and the schedule. Same closed-app rule,
same backup-first convention.

`src/engine/layout.ts` (`planLayout`/`applyLayout`) does the planning and the write. A target card
already carrying any assignment is left alone regardless of which group a source proposes — the
user's own filing always wins, which is what makes a second `foster layout` plan nothing. A
conversation named for two different group names across sources is a conflict, resolved by the
source card with the latest `lastActivityAt`, and reported rather than silently picked. A routine
already known to the target (enabled or not) is left alone too, and a one-shot already overdue
(`fireAt <= now`, no `cronExpression`) is never brought — the app fires an overdue task at its next
launch, and a stale one firing unasked in an account that never scheduled it is worse than a gap.

**Pins** ride the same gap. The sweep marks a pinned row (a branch that stopped, or the other file)
and wants the pin on the row to continue in, but the pin list is the app's IndexedDB and a sweep
from inside the app can never write it. Measured 23/09/2026: that move used to be one line of the
summary and then forgotten. Now the sweep appends `pin_move_deferred` to the ledger and `foster
layout` writes every pending move while the app is down (`engine/pinMoves.ts`), settling each with
`pins_moved` — written, or found already undone by hand, so a row re-pinned on purpose is left alone.

Naming the tip's own row for that deferred move used to be scan order's to decide, and since #63 a
tip can legitimately have two rows here — one per file of its own conversation. `held[0]`
(`src/engine/branchCards.ts`) took whichever the scan happened to list first, so the pin could be
handed the archived "(other file…)" row's id instead of the clean one; `planPinMoves`'s own check
then required the named row to already be visible and settled the move as unwritable for good when
it was not, losing the pin permanently. Fixed two ways: `tipHeld` now prefers a held row
`fileCards.ts` has not filed as the other file and that is not archived, falling back to the first
only when every held row fails that; and `planPinMoves` (`src/engine/pinMoves.ts`) itself no longer
gives up the moment the named row is not shown — `redirectToVisible` looks once for another row of
the same conversation (same `cliSessionId`, not archived, most recently active) before settling.

**Marks** ride it too (`engine/marksBack.ts`). A retitle is written with the app open, and the app
can save a card it holds back over it: measured 24/09/2026, 10 of 49 fresh "(outro arquivo, …)"
marks were gone three minutes later with no foster event in between. In the gap — `foster layout`,
or `sweep --restart`'s own when the sweep marked anything — every card of the target whose last
ledger write is a retitle, and which now shows a title foster has seen it wear _before_ that
write, gets the write again (title and archived flag). Any other title was somebody's rename and
is left alone; a lifted archived flag under the right title is left alone too.

`foster layout --yes --restart` shares its quit-write-start machinery with `foster sweep --restart`
(`restartAround` in `src/cli/index.ts`) but runs the write **inside** the gap between quit and start,
since these two files are only safe to touch while the app is down — `sweep` writes everything
_before_ asking to restart, so it passes no callback into the same helper. `foster sweep` plans a
layout read-only alongside its own passes (`ops/sweep.ts`, never applied there) and mentions it in
`sweepSummary` when anything is pending; that line never counts toward "nothing is left to sweep",
because a layout needs the app closed and a sweep run from inside the app can never close it.

## One rewrite path for `claude_desktop_config.json`

`appPrefs.ts`, `groupScopes.ts` and `viewPrefs.ts` each used to carry their own copy of the same
shape — read twice, refuse on a lossy number literal, mutate, back up, compare every key the write
was not meant to touch, write. The three had already drifted: `writeAppPref` alone was missing the
number-literal guard (`util/jsonNumbers.ts`), so a `1.0` or an integer past
`Number.MAX_SAFE_INTEGER` sitting anywhere else in the file would have been silently rewritten by
an app-pref change while `writeGroupScope` and `writeEpitaxyPrefs` already refused on it.
`store/desktopConfig.ts`'s `rewriteDesktopConfig(store, kind, allowedPaths, mutate)` is now the one
path all three go through: `allowedPaths` names every chain of keys `mutate` is allowed to change
(`[['preferences', 'menuBarEnabled']]` for one app pref, one entry per key for
`writeEpitaxyPrefs`'s several at once), and everything else, at every level, is refused if it moved.
`writeAppPref` no longer writes its own backup next to the file (`<file>.bak-<minute stamp>`,
inside the app's own store) — it goes through `backupFile` under `~/.foster/backups`, the same as
the other two.

That backup naming had its own bug: `util/backups.ts`'s destination name was
`<kind>-<millisecond>-<process-lifetime counter>`, unique within one process but not across two —
a detached `foster layout --restart` and the in-app process it is restarting around can both
compute a backup in the same millisecond, and `copyFileSync` silently overwrote whichever landed
second. `backupFile` now folds `process.pid` into the name and opens the destination
`COPYFILE_EXCL`-only, retrying up to five times under a `-r<n>` suffix on `EEXIST` rather than
overwriting.

## The sidebar's filter menu: two stores

Measured 22/09/2026, same store/app; re-measured the same day via the app's own `set_view` tool
after an earlier pass over this file called two of the seven settings machine-wide or unsuffixed,
which was wrong on both counts. Seven settings in the Code sidebar's filter menu, split across two
stores that do not line up with how the menu reads:

- **Machine-wide**, in Chromium's Local Storage (`<store.root>/Local Storage/leveldb/`, key
  `dframe-store`) — only `groupByByMode.code` and `sortByByMode.code`. A second, sibling LevelDB
  database to the one `store/pinstate.ts` reads for pins, encoded more simply: no Blink envelope,
  no separate "exists" entry, just a one-byte string tag in front of the value.
  `store/localStorage.ts` reuses `store/format/leveldb.ts` for the read and the write; reading
  checks both the log and any compacted sorted table, same as pinning. The same record also carries
  `state.recentsStatusFilter` — a different list the app keeps for something else entirely; it is
  never read or written for the status filter, and `foster view` never touches it.
- **Per account**, in `claude_desktop_config.json`'s `preferences.epitaxyPrefs`, all five remaining
  settings, every one suffixed with the account uuid:
  `code-sessions-status-filter.<accountUuid>`, `code-sessions-state-activity-days.<accountUuid>`,
  `code-sessions-selected-environments-v2.<accountUuid>`,
  `code-sessions-show-empty-projects.<accountUuid>`, `code-sessions-show-pr-status.<accountUuid>`.
  Status and the activity window are the two an earlier reading of this file got wrong — the app's
  own `set_view` tool showed both suffixed the same as the other three. `store/viewPrefs.ts` reads
  and writes these, sharing the same "verify nothing else moved" write as `store/groupScopes.ts`.
  Four legacy, un-suffixed keys from an older build (`code-sessions-status-filter`,
  `code-sessions-selected-environments`, `code-sessions-show-empty-projects`,
  `code-sessions-state-activity-days`) still sit in the file on an installation old enough to have
  them; the UI no longer reads them, so `foster view` reports them as legacy and never writes them.

`src/engine/view.ts` plans and applies both halves through one call (`planViewSet`/`applyViewSet`),
and the per-account half alone (all five keys) through `planViewCopy`/`applyViewCopy` (`foster view
copy`). Grouping by "Estado" forces `status: active` — the app's own rule, not foster's invention —
so a request that sets `--group-by state` sets the status too when it is not already active. Both
files need the app closed to write, guarded the same way `foster layout` is, and `--restart` shares
the same `restartAround` helper. `foster layout` also carries the per-account half of this menu —
status and the activity window included — from the first other account that has any of it set, when
the target has none — the same "target already has one, leave it" rule groups follow; the
machine-wide half needs no copying, since one Local Storage record already covers every account on
the installation.

## LevelDB reads and writes: a table that fails to read is not harmless when a write follows

Measured 24/09/2026, real MSIX store. `pinstate.ts` and `localStorage.ts` both read a key's
current value by scanning every `.ldb` sorted table and the log, keeping whichever copy carries
the highest sequence number, and both used to skip a table that failed to read — an
unimplemented compression, a flipped bit — the same way they skip one LevelDB itself left
half-written after a killed compaction. That conflation is fine for a read that only lists (a
warning and a shorter answer is the honest outcome either way), but not for the read a write
starts from: if the table that failed to open happened to hold the newest copy of the record, the
older value the other tables and the log agree on is reported as current, and a write built from
it carries that stale copy forward — erasing whatever the unreadable table actually held, with no
error at any point.

Both readers now track which tables they could not open (`tablesUnreadable`, populated by the
shared `newestValue` in the new `src/store/leveldbDb.ts`) and carry it on the `PinState` /
`LocalStorageRecord` they return. Reading still degrades the same way it always did — the value
found elsewhere, plus a notice naming the table. `writePinState` and `writeLocalStorageEntries`
now refuse outright when `tablesUnreadable` is non-empty, before touching the log. `currentLog`
(the write target `applyLayout` builds for a key nothing has read yet) never scans a table at all,
so it always hands back an empty `tablesUnreadable` and is never refused on that account.

`readBlock` (`store/format/leveldb.ts`) read a sorted table block's trailing checksum and threw it
away without ever comparing it, despite the module's own docstring claiming every block is "read,
verified and (if compressed) decompressed in full" — a flipped bit inside a block used to look like
an ordinary, if oddly shaped, record rather than the corruption it was. It now verifies the masked
crc32c the way `table/format.cc`'s `ReadBlock` does: over the block's own bytes followed by the
one-byte compression tag (`data ++ [type]`, not `[type] ++ data` — the opposite order from a log
record's checksum, and the detail most likely to be gotten backwards). `tests/helpers/leveldb.ts`'s
`makeTable` used to write a zeroed four-byte checksum that nothing ever checked; it now computes a
real one, or every existing test built on it would have started failing the moment the check was
added.

`pinstate.ts`'s `writePinState` encoded its JSON payload with `Buffer.from(text, 'latin1')`
unconditionally — silently truncating any character above `0xFF` to its low byte rather than
erroring, since V8 stores such a string with its two-byte tag and this module only ever writes the
one-byte envelope `readPinState` recognises. Session ids and JSON punctuation are ASCII, so this
was only reachable through a field the app itself might add to the persisted document that foster
carries forward without understanding (`extra`/`futureField` in the tests) — but a future app
version doing exactly that would have had its setting silently corrupted on the next `foster pin`
write. It now refuses the write instead, naming the field problem rather than encoding it wrong;
`localStorage.ts`'s `encodeText` already handled this correctly (it upgrades to the `TWO_BYTE_STRING`
tag when the content does not fit Latin-1), so only the pin-state side needed the fix.

`locate`/`logsIn`/the tables-then-log newest-value scan were duplicated near-verbatim between the
two files; both now call the same `logsIn`/`locateLog`/`newestValue`/`nextWriteSequence` in
`src/store/leveldbDb.ts`, parameterised by which error class and "no database" message each
caller wants. Validated read-only against a copy of the real installed store (`IndexedDB` and
`Local Storage` directories copied to scratch, never the live ones): 96 pinned ids and the
sidebar's `group-by: custom` setting, both matching what the installed (pre-fix) `foster` bundle
reports against the live store — `tablesUnreadable` came back empty on every real table read,
so the refusal path itself is unexercised by real data and rests on the synthetic-corruption
tests in `tests/pinstate.test.ts`, `tests/localStorage.test.ts` and `tests/leveldbDb.test.ts`.

## Before pushing

```bash
npm run check
```

`npm run privacy` is the one to remember when writing prose or fixtures: this repository is
public, and the guard rejects any Windows user-profile path, any UUID that does not look
obviously synthetic, and two personal identifiers that reached it once. Fixture uuids look
like `00000000-0000-4000-8000-00000000000a`. `scripts/privacy.mjs` is the one implementation
(issue #134, `tests/privacy.test.ts`): `git grep --untracked` (honours `.gitignore`) so it sees
what the next `git add -A` would commit, not only what is already tracked — a fixture written but
not `git add`-ed used to pass here and only fail once CI saw it tracked, after the push. CI's
`privacy-guard` job runs this same script rather than a second copy of the patterns.

## CI: Node matrix, the build-smoke gate, and the coverage floor

`.github/workflows/ci.yml`'s `check` job runs on Node 22 and 24, on Ubuntu and Windows — Node 20
(EOL April 2026) was dropped from the matrix, not kept alongside these, because vitest 5 (picked
up to clear three high-severity advisories — `@vitest/mocker`'s path-traversal fix required the
major bump) requires Node `^22.12.0 || ^24.0.0 || >=26.0.0` and refuses to start under 20 at all.
`package.json`'s own `"engines": ">=20"` is untouched: that floor is a promise about the _built_
CLI (`dist/foster.js`), which carries no vitest dependency, not about the dev toolchain a
contributor runs `npm test` with. `release.yml`'s own `setup-node` step needed the same bump, for
the same reason — it runs `npm test` too, ahead of the smoke test.

The `check` job's own test step is `npm run coverage`, not a plain `npm test`: `vitest run` alone
never passes `--coverage`, so without it the thresholds below are configured but never collected
or enforced — a PR could drop coverage to zero and every job would still pass. `npm run check`
(`package.json`) runs the same `npm run coverage`, so a local run fails exactly when CI would.

Two more gates moved into `ci.yml`, both previously exercised only by `release.yml` on a tag push:
a `build-smoke` job (`npm run build` then `scripts/smoke-bundle.sh` — single-file bundle,
`--version` matches, starts with no stderr noise) so a packaging mistake is caught on the PR that
made it, not on the release that ships it; and an `audit` job running `npm audit --omit=dev
--audit-level=high`, scoped to the two runtime dependencies (`commander`, `picocolors`) since the
dev toolchain (vitest, tsup, the agent SDK, ...) carries advisories of its own that never reach
anything foster installs or executes on a user's machine. `scripts/smoke-bundle.sh` is the one
implementation of the smoke test too, now — `release.yml` calls the same file instead of carrying
its own copy of the bash block. Unlike `check`, `build-smoke` runs no vitest at all, so it carries
none of vitest 5's Node floor — its matrix is `[20, 24]`, not `[22, 24]`, because Node 20 is the
one version `package.json`'s `"engines"` actually promises about `dist/foster.js`, the one thing
this job executes; pinning it to 24 only would have verified the shipped bundle on a newer Node
than the CLI claims to support, and never on its own stated floor.

`vitest.config.ts`'s coverage now includes `src/cli/**`, previously excluded — the exclusion made
`npm run coverage` read 88% when the real figure, CLI entrypoints included, measured 66.6%
statements (2026-09-24). The naive fix — pin `coverage.thresholds` to that exact measured level —
does not hold, and not just at the last decimal: several `src/store` and `src/engine` paths branch
on what actually exists under the home directory and on OS, so the percentage genuinely moves with
the environment `npm run coverage` runs in. Measured the same day, all real: a normal populated
Windows `$HOME` (66.60 / 60.52 / 71.51 / 67.82 — statements/branches/functions/lines), an empty
`mktemp`'d Windows `$HOME` + `%USERPROFILE%` (66.59 / 60.46 / 71.51 / 67.84), GitHub Actions
`windows-latest` (66.49 / 60.35 / 71.46 / 67.78), and GitHub Actions `ubuntu-latest` — the real low
point — at 66.31 / 60.16 / 71.23 / 67.61. A first pass at this floor was pinned to the two Windows
numbers and failed both `ubuntu-latest` cells the first time this PR actually ran in CI (`check`
had never run `npm run coverage` before, so nothing had caught this). The configured thresholds
(statements 66.0 / branches 59.8 / functions 71.0 / lines 67.3) sit with margin under the
`ubuntu-latest` figures, the real low point among the four measurements, not under whichever
environment happened to be measured most recently: a genuine drop still fails CI without the floor
itself flaking on environment alone; raise it as coverage improves by more than that margin, never
lower it to let a real drop through.
