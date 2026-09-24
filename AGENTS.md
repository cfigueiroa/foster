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
under `~/.foster` that are a registry or a preference; `~/.foster/cache` (relocatable with
`FOSTER_HOME`, same as the ledger) is a third kind, a pure performance cache with nothing it would
be a loss to delete — see the section below.

## The persistent scan cache, and why it is safe to lose

`~/.foster/cache` holds two files: `cards.ndjson` (slim `readSessionCard` results,
`store/cache/cardCache.ts`) and `transcripts.bin` (`scanConversation` and `idsMentionedIn`
results, `store/cache/transcriptCache.ts`). Both are keyed on a file's absolute path plus its size
and mtime — the transcript cache additionally resumes from a stored byte offset on growth, after
verifying the last 4 KB before that offset still reads the same, so an actively-growing JSONL log
is read once and topped up rather than reread whole every run. Neither file is a registry: nothing
here is folded by `project()`, nothing is ever read to decide what foster does, only to skip
re-reading a file whose content is already known. Deleting the directory (`foster cache clear`, or
by hand) costs the next run its head start and nothing else — the next scan reads from disk and
rebuilds it, the same as an entry a schema or version mismatch already ignores.

`--no-cache` (or `FOSTER_NO_CACHE=1`) skips it entirely, both reads and writes, and is the answer
whenever the cache itself is suspect. Measured 24/09/2026 on a real store (25k+ cards, 1000+
transcripts): a dry-run `/fosteia`-flagged sweep went from 55–79 s uncached to 34–36 s warm —
smaller than the roughly 3-4× a store this size's read cost alone would suggest, because most of
the remaining time is the sweep's own in-memory planning (fork detection, the file-card and
title-sync passes), which the cache does not touch. Cold, warm and `--no-cache` produced
byte-identical `--json` and text output on that store (`runSweep`'s dry-run always mints a fresh
random id for the copy it previews, on every call regardless of caching — the one deliberate
source of variation, and not what this compares).

Residual risk, stated once here rather than at every call site: a card or transcript rewritten
with the exact same size inside the same mtime tick as its previous write reads as unchanged.
Nothing keyed on size and mtime alone can tell that apart from no change at all.

A first design combined the transcript cache's two halves into one entry, computing and keeping
`idsMentionedIn`'s superset for every file `scanConversation` touched instead of only the handful
`Lineage.deepen` ever asks about. Measured the same day: that ran a real dry-run sweep out of the
default heap (`Ineffective mark-compacts near heap limit`) on a store the uncached sweep read in
78 s. The two are independent caches now, growth-resumed separately, so a `scanConversation`-only
run never pays for or retains data nobody asked for.

`TranscriptCache.idsMentionedIn`'s own persisted entry only proves an id-shaped string occurs
somewhere in a file — it does not survive far enough to say whether an occurrence is a record's own
`uuid` or a copy quoted inside another one, the nested-alias case "Lineage precision" (above) fixed
for the live `idsMentionedIn`. Serving a cache hit without the same structural check would have
quietly brought that bug back for anything routed through this cache. It is now never trusted on
its own: a candidate the persisted entry turns up is handed to the live, `recordFields`-validated
`idsMentionedIn`, over only the (typically tiny) set of ids the cache actually narrowed things down
to — never the whole file's own `wanted` set, so a miss still costs nothing beyond the persisted
lookup. `Lineage.deepen` itself does not call through this cache for mentions at all: it uses the
live `idsMentionedIn` together with its own per-run `RecordIdCache` (see "Lineage precision"),
which already remembers a file's scan for the lifetime of one sweep and needs no cross-run
persistence to make repeated rounds cheap. `TranscriptCache`'s mention half stays available for a
future caller with a genuinely cross-run "ask the same file about a shifting id set" shape, now
correct as well as persisted; only `scanConversation`/`scanConversationFiles` are wired into
`Lineage` today, for `scanOf`/`reachOf`'s much larger population.

## The ledger's `account_identity_seen`: what it holds

Four top-level fields — `accountUuid`, `email`, `name`, `plan` — plus a nested `profile`
(`AccountProfile`, `domain/profile.ts`) carrying whatever else the app's response cache or a
live API answer said: organization, subscription status, the raw rate-limit tier, the renewal
and plan-ending dates, currency, billing interval. All of it exists to answer one question —
whose account this is, and what it is worth checking `usage`/`renewals` against — for an
account you are not signed into right now, which is the only reason anything is written down at
all (see "The human name behind an account UUID" in `store/identity.ts`).

What it does **not** hold, since the agent-safety package (24/09/2026): the card brand and last
four digits (`AccountProfile.cardBrand`/`cardLast4`). `forLedger` (`domain/profile.ts`) strips
both before every write, and every place that writes `account_identity_seen` —
`cli/flows.ts`'s `labelAccount`, the two sightings in `cli/index.ts` (`whoami`,
`recordCurrentIdentity`), and `cli/screens.ts`'s `recordFreshIdentity` — goes through
`forLedgerSighting` (`domain/identity.ts`) rather than calling `forLedger` on the profile alone,
so the "is this worth writing" check (`worthRecording`, `store/identity.ts`) and the write
itself agree on the same card-free shape. Comparing a fresh cache read (which still has the
card) against an already-stripped ledger record would otherwise look like a change on every
single run — the exact log-spam `worthRecording` exists to prevent. Nothing here needed the
card: identity matching runs on `accountUuid`, never on billing detail. Existing lines from
before this shipped are not rewritten — the ledger stays append-only — so an account sighted
earlier can still show a card in `foster accounts`/`whoami` until a fresh sighting supersedes
that one field (`ledger/project.ts` merges `profile` field by field, not wholesale).

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
  into the new tab's shell before the pwsh command ever runs — so both the scrubbed spawn environment
  and a second `CLAUDE*` cleanup inside the pwsh command itself apply, not just one.
- **P11** — whether opening a terminal directly on a fleet junction's active target competes with
  that fleet's own rotation. This stays a warning, not a refusal, and there is no `--fleet` flag to
  make it stricter.

A third thing in the same neighbourhood, also unmeasured against a real `wt` (opening one from a
script is exactly the irreversible-if-wrong action this whole module exists to avoid), but closed
off rather than left as a warning: `wt`'s own command-line parser splits on a literal `;` to chain
multiple actions (`wt new-tab ; split-pane ...`), and per `wt`'s own docs that split is not scoped
by argv boundaries — a `;` sitting inside what `CreateProcess` delivered as one quoted argument can
still end the `new-tab` action early. The pwsh command this module builds is a `;`-joined sequence
of statements by construction, so handing it to `wt` as `pwsh -Command "<script>"` risks the
`$env:CLAUDE_CONFIG_DIR=...` statement landing on the losing side of that split — the new tab could
come up on the CLI's already-cached default account rather than the one `client open` resolved,
with nothing on screen to say so. `planLaunch` (`src/engine/launch.ts`) never hands `wt` that text:
the pwsh command is base64-encoded UTF-16LE (`encodePsCommand`, `src/util/powershell.ts`) and passed
as `pwsh -EncodedCommand <base64>`, which has no `;` of its own for `wt` to split on. `--print`
still shows the readable command (`plan.psCommand`) — only the real argv changes.

`foster rescue --open`'s per-conversation tab has the same `wt` exposure through a different door:
its `--title` is filled from a card's own title, read off disk and therefore untrusted the same way
any other file content is. `sanitizeTitle` (`src/engine/rescue.ts`) replaces a semicolon, a literal
double quote, and any control character in it before it ever reaches `wt`'s argv.

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

A further round, 24/09/2026, on the same real store (25,178 cards): `planLayout` was still its own
gap in that accounting. `planGroups`/`cardReader` (`engine/layout.ts`) called `scanAccount` on the
target and on every source account WHOLE, on top of the SLIM scan the sweep had just taken — a
standalone timing probe against the real store measured 3.1–3.6 s a call, every one of them. Only
`sessionId`, `cliSessionId`, `title`, `isArchived` and `lastActivityAt` are ever read off what
`planGroups` gets back, none of them a bulky field, so it now reads SLIM and takes the run's own
`ScanCache` (new, `store/scanner.ts`) — a file the sweep already read is served from memory instead
of read and `JSON.parse`d again, and only a file whose `mtime`/`size` moved since (a pass in this
same run wrote it) is read fresh. The same probe measured a warm call at 260–310 ms — about the same
plan, twelve times faster. `runDates` (`ops/sweep.ts`) shares the same cache for its own store-wide
scan, and now takes the sweep's own `kin` instead of building a second `Lineage` from
`transcriptRoots(env)` alone, which had been missing the sweep's `configDirs`. `sweep --dates`
(dry run, real store) went from 127 s to 95–101 s across repeated runs; a plain `sweep` (no
`--dates`, so `runDates` never runs) showed no measurable change, because the always-present
transcript walk `kin` does for fork detection dwarfs what `planLayout` alone ever cost. Two more
places kept re-deriving what one card's row already gives them: `engine/sidebar.ts` used to walk
every card of the target per candidate for `reason`/`shows`/`unreached`, now three small indices
(exact id, lower-cased id, and a lazily built one by conversation root — `kin.rootOf` is never
asked for just to build an index, which broke the one caller whose `Lineage` answers only
`reachOf`) plus a memoised `unreached` `held` set per (id, except); `engine/lineage.ts`'s
`canonical` no longer allocates a cycle-guard `Set` for a root with no alias at all, which is the
common case by far.

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

The `.vbs` is written as UTF-16LE with a byte-order mark (`'﻿' + text` encoded `'utf16le'`),
not plain UTF-8. `wscript.exe` reads a `.vbs` with no BOM as the system's ANSI code page, and a
non-ASCII `FOSTER_HOME` or node install path corrupted the script silently — no error dialog, no
log line, because the corruption lands in the very statements that would open the log. Verified
on this machine 24/09/2026: a throwaway `.vbs` carrying "ô" in a comment, written as UTF-8 with no
BOM and run through `wscript.exe`, echoed it back as two garbled bytes (`0xC7 0xEF`) through a
codepage-mangled double translation; the same text written as UTF-16LE with the BOM echoed the
correct single OEM byte (`0x93`, cp850's "ô" — the same byte PowerShell's own OEM output uses,
see two sections up). The `CMD_UNSAFE` check that guards `planDetached`'s cmd.exe compound line
used to run only over the caller's own `argv`; it now also covers `logPath` (which folds in
`FOSTER_HOME`), `execPath` and `scriptPath` — a `%` in any of those reached the line unescaped
before.

`launchWithFallback`'s PowerShell step (`Invoke-CimMethod ... Win32_Process Create`) submits the
request to WMI independently of the PowerShell client waiting for the reply: a client that times
out does not undo a `Create` that had already gone through by the time the timeout fired. Falling
straight to the `wmic` fallback on every timeout, as this used to, risked launching a SECOND
detached process — two quit/restart cycles, the first one started by the call this treated as
failed. On a timeout specifically (never a `missing` or outright `failed` result, which never got
far enough to plausibly have submitted anything), it now checks the process table for a
`wscript.exe` already running the exact `.vbs` this call was about to launch, and reuses that pid
instead of launching a second one.

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

## CLI: one restart path, and the gaps that had each grown their own

Four places used to restart the app on their own terms; three of the four are now `restartAround`
(`src/ops/restart.ts`) end to end, and the fourth (the TUI's `offerRestart`, `src/cli/desktopUi.ts`)
stays separate on purpose — it asks the user before closing anything, and the write it is offered
after has already landed, so it has no `duringGap` to run and nothing `restartAround` would add.

- **`finish()`** (`src/cli/index.ts`) is the shared tail of `foster`, `restore`, `return`,
  `consolidate`, `import-codex` and `sweep --undo-retitles` — every write command with no
  `--detach` of its own. It used to call `restartDesktop` → `quitDesktop` directly, which throws
  `DesktopControlError` from inside a hosted session; that reached `main()`'s generic catch and
  printed "Nothing was changed." **after** the write had already happened. It now goes through
  `restartAround`, which never throws — it reports what was written and hands over the command to
  finish the restart from outside the app.
- **`sweep --undo-retitles --detach`** used to validate `--detach` (`detachNeedsRestart`/
  `detachNeedsYes`) and then simply never look at it again — the undo fell straight into
  `finish()`, which cannot detach. It now runs the same `runDetach` every other command does,
  re-running its own invocation (`process.argv`, `--detach*` stripped) from outside the app.
- **`foster app pref --restart`** (`src/cli/appPrefCommand.ts`) had its own hand-rolled
  quit/write/start: a `writeAppPref` that threw after `quitDesktop` succeeded left `startDesktop`
  never called at all (the app stayed closed, silently); the tray refusal said "Re-run with
  --terminate", a flag this command has never had (`--terminate` belongs to `app quit`/`app
restart`); and `startDesktop`'s own boolean was thrown away, so it printed "is up" whether or
  not it actually was. Also now `restartAround`, with the command reconstructed from the actual
  argv (`restartCommandFromArgv`, next section) rather than a name nobody could run.

**`sweepDetachArgv`** (`src/engine/detach.ts`) built `['layout', '--yes', '--restart']` or
`['app', 'restart']` from nothing — no `--store`, no `--ledger`, no `--to`/`--to-org`. Measured
24/09/2026: `foster --store work sweep --yes --restart --detach` restarted the **default**
installation, silently, while the sweep itself had written into `work`. It now takes a `carry`
(`{store, ledger, to, toOrg}`, read from `this.optsWithGlobals()` and the sweep's own resolved
target) and forwards it into whichever command it hands off to — `--to`/`--to-org` only for
`layout`, which is the only one of the two that takes a destination; `--store`/`--ledger` either
way. The same `carry` also builds the plain-text `restartCommand` sweep hands over on a
self-hosted refusal, not just what it detaches to.

**`restartCommandFromArgv`** (`src/engine/detach.ts`) replaces three literal template strings —
`layout`'s `'foster layout --yes --restart'`, `view set`'s `'foster view set --yes --restart'`,
and `app pref`'s hand-built one — with the actual `process.argv`, `--detach*` stripped and
`--yes`/`--restart` guaranteed present. The template for `view set` in particular dropped every
filter flag the run actually carried, so the handed-over command read "Nothing to change." — the
run had nothing to change **as printed**, having lost `--status`/`--group-by`/etc along the way.
`view copy`'s own `viewCopyRestartCommand` (`src/cli/render.ts`) stays hand-built, because it
needs the two accounts it actually _resolved_ (a label or a default, not necessarily what `--to`
said) rather than an argv echo — it was just missing `--to-org`, which an account holding two
organizations needs to disambiguate `--to` at all.

**`--detach` with the tray on is a no-op**, and was until this: the detached re-run calls
`quitDesktop` without `terminate`, which — tray on, `closingWindowQuits` false — returns
`needs-terminate` rather than closing anything, and nothing after that ever runs. Checked directly
against this machine's own default installation 24/09/2026: `menuBarEnabled` is **unset** there —
absent means the app default, tray on — so the bug was live here too, not just somewhere else;
nothing about this machine's own setup had been shielding it. `runDetach` now checks
`closingWindowQuits(store)` before writing or launching anything
(`detachNeedsTerminate`, `src/engine/detach.ts`) and refuses up front: `app restart` is told to
add `--terminate` (it already rides straight through `stripDetachFlags`, so once it is on the
command line the detached re-run inherits it — nothing new had to forward it); every other
command has no `--terminate` of its own, so it is told to close the app by hand first, or to run
`foster app restart --detach --terminate` instead.

**Measured, not assumed:** a process WMI's `Win32_Process.Create` starts does **not** inherit the
calling process's own environment — a marker set only via `$env:` in the calling PowerShell shell
never reached a child launched this way, though the logged-on user's persistent variables did. A
`FOSTER_HOME` set only for one session (a test harness, a relocated ledger for one shell) was
silently dropped the moment a restart detached: the re-run read and wrote the **default**
`~/.foster`, not the one the original invocation meant. `planDetached` now writes `set
FOSTER_HOME=<value>&` into the launch line whenever the calling process has one, checked against
the same `cmd.exe`-unsafe-character guard the rest of the argv already gets.

**Four repeats folded into one each**, all in `src/cli/index.ts`: `addDetachOptions(cmd)` adds the
three `--detach*` options every `--detach`-capable command declared by hand (`--restart`/
`--terminate` stay each command's own — the help text, and for `app restart` the very name,
differ by what the command already does); `checkDetachPrereqs(opts)` is the
`detachNeedsRestart`/`detachNeedsYes` pair every one of them checked the same way;
`refuseIfAppRunning(store)` is the "close it or add --restart" throw `layout`, `view set` and
`view copy` each wrote out by hand, word for word; `detachJson(outcome)` is the six-field
`--json` shape of a `DetachOutcome`, built once instead of copied at the `sweep --json` and
`layout --json` sites (`printDetachResult`'s own `--json` branch now calls it too).

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

## The process table's PowerShell reader forces UTF-8 output

Measured 24/09/2026: `powershell.exe`'s redirected stdout is the console's OEM code page
(cp850 on this machine), never UTF-8, regardless of what `util/processes.ts` decodes it as
(`'utf8'`, throughout that file). `Write-Output 'ô'` piped to a file and read back as UTF-8
comes back as the single byte `0x93` — U+FFFD, the replacement character — where the correct
UTF-8 encoding of "ô" is the two bytes `0xC3 0xB4`. A profile whose path holds a non-ASCII
character (a surname, say) had its `--user-data-dir` corrupted on the way in: `isDesktopProcess`
and `resolveStoreArg` compare the corrupted string against the real path and never match, so
`inspectDesktopFor` reports the profile not running, `app restart` starts a second instance
beside the live one, and `app quit` has nothing it recognises to quit.

The fix is one line, `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`, prefixed to every
PowerShell script this module and `engine/desktop.ts` run (the process-table query,
`processPackageIdentity`, `mainWindowVisible`, and the new `Get-AppxPackage` lookup in
`desktopExecutable`) — verified against a real `powershell.exe` on this machine: without the
prefix `Write-Output 'ô'` round-trips as the single mangled byte above; with it, the correct
two UTF-8 bytes come back and decode to "ô" again.

`mainWindowVisible` and `processPackageIdentity` used to ignore the process-table reader's own
`ReaderMemory` (`skipPowerShell`), so a hung PowerShell cost each of them the full 20 s on every
call — `startDesktop`'s window-raise poll can call `mainWindowVisible` up to six times in three
seconds. Both now default to the _same_ `ReaderMemory` `readProcesses()` writes to: once any one
of the three has recorded a PowerShell failure this run, the other two skip straight to their
own negative answer (`'unknown'` / `undefined`) without spawning anything. A caller that wants
its own isolated memory (tests, mainly) still passes one explicitly.

`inspectDesktopFor` (`src/engine/desktop.ts`) used to read the process table itself and then hand
its own `hostedElsewhere` helper a separate `ProcessLister`, which called `runningStores` and read
the table again — a real PowerShell spawn each time, twice per `inspectDesktopFor` call in
production. `hostedElsewhere` now takes the rows `inspectDesktopFor` already read, and
`runningStores`'s own matching logic moved to `runningStoresFromRows` so both call sites (the
exported `runningStores(list)` and `hostedElsewhere`) share it without either reading twice.

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

## `foster disk` and `foster stats`: read-only reports across every account

Neither writes anything, and neither decides what is safe to remove — that judgement stays
`purge`'s (`src/engine/diskUsage.ts`, `src/engine/stats.ts`, both self-contained: no import from
`store/orphans.ts` or `store/transcripts.ts`'s private `streamLines`, on purpose, so a parallel
change to either module cannot land under these two without a review noticing).

`foster disk` scans a full (non-slim) `scanStore` once and measures bytes per account and per
`projectDirName` bucket, for cards and for the transcripts each account's cards reach. It also
measures `BULKY_CARD_FIELDS` — the field's own `JSON.stringify` length, not a share of the whole
card — and reports it per field; measured 24/09/2026 on a real store (25,178 cards grown to
1011 MB, one grown since the field was added): 97%, `remoteMcpServersConfig` at 951 MB of it. An
"orphan" here is broader than `findOrphanedConversations`: a transcript no card in any account
(and no Cowork session — `agentSessionReferences` is duplicated locally rather than imported, see
above) points at, counted with or without a tombstone. Duplicate transcripts are found by
grouping same-size files first and hashing only those groups (`sha256`, streamed in 1 MB chunks,
same technique as `store/transcripts.ts`'s `streamLines`) — measured on a real store: five pairs,
every one a repository/worktree split of one conversation that never diverged after the branch
was cut, the same shape `fileCards.ts` already handles from the sidebar-row side.

`foster stats` reads every transcript's assistant records for `message.usage` and for the usage-
limit stop `foster revive` already detects (`USAGE_LIMIT` imported from `engine/revive.ts`, not
redefined) — over the _whole_ transcript, not just the tail `lastAnswer` reads, since the report
wants every stop a conversation hit, not only its last. The line-prefilter (`'"usage"'` or the
literal `rate_limit` substring, checked before `JSON.parse`) is the same trick
`recordFields`/`idsMentionedIn` use elsewhere in this codebase for the same reason: most lines in
a transcript are tool calls and results, and skipping the parse for lines that cannot match is
the whole saving. A conversation is attributed to the account whose _native_ card names it —
`ownersOf` — because a fostered copy only proves the conversation reached that sidebar, not that
the tokens were spent under it; one no card anywhere claims natively is bucketed `unattributed`,
never guessed at. Cross-checked 24/09/2026 against an independent Python re-parse of the same
transcripts: card and transcript byte totals matched exactly, the usage-limit stop count matched
exactly (1635 of 1635), and the one file whose token sum first looked off was a session still
being written to _during_ the comparison — a live-growing file read twice moments apart, not a
parsing bug; both readers agreed to the token once the file stopped moving.

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

## `foster grep`: a regex over every transcript, not the raw JSONL

`foster grep <regex> [--account <a>] [--since <age>] [--cwd <fragment>] [--role user|assistant]
[--json] [--limit <n>]` searches every transcript reachable from every client `configDirCandidates`
finds — every conversation any account on this machine ever ran, archived and deleted included,
because a transcript outlives the card that opened it (`store/transcripts.ts`'s own point). Each hit
is matched against a `user`/`assistant` message's _decoded_ text — `textOf(record.message)` — never
against the raw JSONL, so a search cannot fire on a `\n` inside a JSON escape or a `uuid` quoted
inside a tool result; a tool call's own name and arguments are never message text and never match.

Two passes per file, coarse then real, in the shape `idsMentionedIn` already reads a transcript in
for lineage. What makes the coarse pass fast enough for a corpus this size is _how_ coarse it is:
one `Buffer#includes` — raw bytes, no decode — against the whole file at once, before the file is
ever split into lines; only a file that fails it is skipped, unopened for anything more. A pattern
with real regex syntax (anything `[.*+?^${}()|[\]\\]` matches) falls back to one `RegExp#test` scan
instead, which still stops at its first hit rather than collecting every one the way `idsMentionedIn`
does. Only a line the coarse pass flags is ever `JSON.parse`d, and the real match is asked of the
message text `textOf` pulls out of it, decoded with the same `Buffer.from(line,
'latin1').toString('utf8')` round trip `recordFields`' comments describe — the latin1 read never
changed a byte, so writing those char codes back out and decoding _that_ as UTF-8 reconstructs
exactly what was on disk.

Measured 24/09/2026 against a real corpus — two client directories, 11,202 transcripts, 13.6 GB:
a term absent from all of it (the case that matters, since a search worth running is usually for
something rare) answered in 7–9 s. The first cut of this — `readFileSync(file, 'latin1')`, which
allocates a JS string the length of every byte before any check runs — cost 30 s for the same
query; reading as a `Buffer` and only decoding a file the coarse check flags cut that in half again,
close to the ~10.6 s a bare read of 13.6 GB off this disk costs with nothing else happening at all.

The one cost that stayed high: attaching "the card(s) that open it" — title, account, archived —
needs a `scanStore` of the whole Desktop store, and on this machine that is **25 accounts, 25,174
cards**, over 13 s on its own, dwarfing the search. `grepTranscripts` (`engine/grep.ts`) runs the
whole transcript search _before_ ever calling `scanStore`, and skips it outright when nothing
matched — so the common case, a rare term that matches nothing, never pays it; a term with real
hits (measured: `rioprev`, this machine's own project name) does, and takes on the order of the
scan's own cost on top, which is a store-specific number a smaller install would not see.

`--account` narrows the _report_ to conversations with a card in that account (a `resolveStoreArg`-
style accountUuid prefix, via `matchAccountPrefix`) — it does not narrow which transcripts get
searched, since a conversation's card and its transcript live in different trees entirely. `--cwd`
and the conversation's own working directory shown in a JSON result both come from
`readTranscriptFacts` of the first file a conversation occupies, asked only once a conversation has
a hit — the same "cost tied to what was found, not to the corpus" reasoning. `--since` is a plain
`stat().mtimeMs` check per file, ahead of ever opening one.

## `foster export`: one conversation, unioned and rendered

`foster export <id|title fragment> [--format md|html|jsonl] [--out <file>]` renders one conversation.
The id is resolved the way `--store` resolves a name (`resolveStoreArg`'s own order): a conversation
id — `cliSessionId` — exact or an unambiguous prefix, tried even against a conversation with no card
left anywhere, because a deleted conversation naming its own id is the ordinary case here; then a
card's own id, the app's `local_<uuid>`; then a case-insensitive fragment of a title. More than one
candidate at any step refuses rather than guesses, naming every candidate. No `foster where` exists
on `main` yet to share this with, so it lives on its own in `engine/resolveConversation.ts` — the
shape a future `where` would want too.

Rendering unions every file the conversation occupies (AGENTS.md's own "One conversation can be two
files", above) rather than trusting whichever one `resolveConversation` happened to be pointed at —
`readConversationRecords` (`engine/exportConversation.ts`) reads every file whole, deduplicates by
`uuid` (a record written to two files by construction is the same record), and orders by timestamp,
which is what makes the render read as one conversation rather than two interleaved fragments. `md`
shows `user`/`assistant` turns as headings, a tool call collapsed to one line (`> tool: <name>`) and
nothing dumped from its raw input; `html` is the same, in one self-contained file — no external
stylesheet or script, so it opens on its own; `jsonl` is every record, deduplicated and ordered, exactly
the shape a real transcript already is, which is what makes it round-trip back through anything that
reads a transcript. `--out` writes to a file; without it the render goes to stdout so the command
pipes cleanly, the same convention `transcript` already uses.

## What `foster agent` does and does not cover

`foster agent "<task>" --yes` exposes ten tools: `scan_accounts`, `list_sessions`,
`foster_status`, `app_status`, `read_transcript`, `label_account`, `foster_sessions`,
`sweep_everything`, `return_fosterings`, `resume_headless`. `sweep_everything` is the one to
reach for on "bring everything here": `foster_sessions` leaves archived sessions behind and
cannot reach deleted conversations at all. **`consolidate`, `purge` and `live` are not among
them** — `purge` is excluded on purpose and must not be reached through the shell either.

`--yes` used to loosen more than the mutation gate on those ten tools. Before the agent-safety
package (24/09/2026), a run started with `--yes` still got the full Claude Code built-in
toolset — Bash included — with `permissionMode: 'bypassPermissions'` the only thing between the
model and the machine, and the system prompt's own "never run this through the shell" rules
(`purge`, `switch`, `vault`, …) the only thing standing between a task and one of them run
directly, plus `read_transcript` feeding arbitrary transcript text into context as a
prompt-injection surface. `buildToolOptions` (`agent/run.ts`) now makes `--yes` narrower than
that: `tools` drops from the full preset to `['Read', 'Glob', 'Grep']`, so Bash, Write, Edit,
WebFetch and WebSearch are never offered to the model at all, and a `canUseTool` denies any call
whose name is not one of those three or one of the ten foster MCP tools — a second, independent
gate on top of the trimmed toolset, not a replacement for it, in case something resolves a tool
name outside `tools` some other way. Without `--yes`, none of this changed: the full preset
stays, `permissionMode: 'default'` auto-denies whatever would have asked (headless, there is no
terminal to ask in), and that auto-deny is what keeps a read-only run read-only, same as before.

`resume_headless` (and `foster resume`, which shares the same engine, `engine/resume.ts`) no
longer risks leaving a second writer on a transcript after a timeout. Measured: the previous
implementation ran `claude -p --resume` through `execFileSync` with `shell: true` — required on
Windows, where the CLI resolves through a `.cmd` shim that Node refuses to spawn directly — and
its own `timeout` option. That timeout's kill signal reached only the process Node started
directly, `cmd.exe`; `cmd.exe` never forwarded it to the `claude` process it had gone on to
start, which kept writing to the transcript after the caller believed the run was over — a
second writer, exactly what this module exists to prevent. `runClaudeResume` now uses an async
`spawn` and a timer the function owns: on timeout it runs `taskkill /PID <pid> /T /F` against
the pid `spawn()` itself returned, `/T` walking down to every process that shell went on to
start, `claude` included, and never touching a pid the call did not spawn itself. The spawned
process's environment is `scrubbedEnv` (`engine/launchEnv.ts`) now too — it was inherited
unscrubbed before, so a resume run from inside a hosted session could start `claude` believing
itself hosted (see "A launched Claude.exe never inherits foster's own `CLAUDE*` env" above).

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

Reading `Parameters` back used to shell out to `reg.exe query` and decode its stdout as `utf8`.
`reg.exe` writes console output in the OS's OEM code page, not UTF-8, and `--user-data-dir=<profile>`
carries whatever the profile directory is spelled — a name with an accent or another non-ASCII
character in it decoded wrong, so the read-back in `runLogin` never matched what `writeValue` had
just written correctly (the write itself goes through `execFileSync`'s argv, which Windows always
delivers as UTF-16 regardless of code page — only the read was ever wrong). `registryHandlerIo.readValue`
(`src/engine/protocolHandler.ts`) now reads through PowerShell's own registry provider instead
(`Get-ItemPropertyValue`, run via `-EncodedCommand` for the same reason `client open` uses it — see
above) and hands the value back base64-of-UTF-8, which has no code page of its own to get wrong.
Not reproduced against a real non-ASCII profile path on this machine (every profile registered here
happens to be plain ASCII); the fix and its test (`parseRegistryReadOutput` in
`tests/protocolHandler.test.ts`) work from the documented fact that `reg.exe`'s console output is
code-page-encoded, not from a repro.

Before this, a mismatched read-back — this bug, or any other reason the two strings disagreed — threw
`could not arm the handler` and returned from `runLogin` _after_ `io.writeValue` had already pointed
the machine-wide handler at the arming profile, with everything that would have put `previous` back
sitting below the throw, unreached: the handler stayed armed with nothing to undo it short of
`foster app login --restore`. The arm-write's own read-back check, and the whole wait that follows
it, now sit inside one `try`/`finally` (`runLogin`), so a restore is attempted on every way out of
that block — the mismatched-read-back throw included — except the one case where restoring would be
wrong: `handler-rewritten`, meaning the poll loop already found something _other than_ the armed
value sitting in the key, which is somebody else's change to leave alone.

The CLI's own `app login` action (`src/cli/index.ts`) had a matching gap on the way out: Ctrl+C was
caught with `process.once('SIGINT', ...)`, which Node auto-removes after it fires once — so a
second Ctrl+C from someone impatient had no listener left and fell through to Node's default SIGINT
handling, which ends the process immediately, before `runLogin`'s own `finally` above ever runs.
Closing the terminal window outright was never caught at all: Windows delivers that as `SIGHUP` (or
`SIGBREAK` for Ctrl+Break), and with no listener for either, Node's default action is the same
immediate termination. `armAbortOnSignals` (`src/util/signals.ts`) arms all three with `.on`, never
`.once`, behind one shared guard so the abort fires exactly once regardless of how many of them go
off or in what order, and stays armed for as many signals as arrive.

## Quoting a profile path for `Invoke-CommandInDesktopPackage`

`launchProfileAppWithIdentity` (`src/engine/desktop.ts`) builds its `-Args` value — the
`--user-data-dir` switch — as a plain PowerShell string, with no inner quoting of the path and no
escaping of a `'` in it. `-Args` is itself parsed as a command line by the OS when the packaged
app is actually activated, so a profile at `D:\Claude Work` used to launch the WRONG store: the
unquoted switch split into two argv tokens, `--user-data-dir=D:\Claude` and `Work`, and the app
fell back to its default userData. `userDataDirArg` now wraps the path in `"…"` (so a space
survives the OS's own splitting) and doubles any `'` in it (so it does not end the PowerShell
single-quoted string literal this value is itself embedded in early) — unit-tested directly
(`tests/desktop.test.ts`), since the function that embeds it spawns real PowerShell.

## Finding the installed executable from outside the app's container

`desktopExecutable` used to try only the classic registry key (`readProtocolCommand`, which only
exists inside the app's own MSIX container — see "The registry has two views" above) and then the
process table. From an ordinary terminal, with the app closed, both were empty: measured
24/09/2026, `--store work app restart` run from a plain PowerShell quit the running default
installation and then failed to start it back up, because nothing could name its executable.

It now tries `Get-AppxPackage`'s `InstallLocation` for the package family `installedAppId`
already derives (from a known store root, or a running row's own `\WindowsApps\` path — neither
needs the registry or the app to be running), ahead of the process table. The executable sits at
`<InstallLocation>\app\Claude.exe`; verified against this machine's real install 24/09/2026:
`Get-AppxPackage | Where-Object PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc'` answers
`C:\Program Files\WindowsApps\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc`, and
`...\app\claude.exe` exists under it.

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

## The ledger is read once per instance, not once per call

Measured 24/09/2026, a real ledger: 23 MB, 30,445 events, reading and parsing it costs
160-290 ms depending on the machine, and `Ledger.read()` is called on the order of a dozen times
per sweep round (`ops/sweep.ts`), up to three rounds, plus once per copy in the branch pass
(`applyBranchCards` → `fosterSessions` → `project(ledger.read())`, `engine/executor.ts:175`,
`engine/branchCards.ts`). `Ledger` (`ledger/log.ts`) now caches its own parse, keyed on
`(size, mtimeMs)` from `statSync` rather than trusted blindly — a ledger changed from outside this
instance (a second `foster` process, a hand edit) still forces a reread. `append()` keeps the cache
in step by pushing the new event onto the same array and re-stating for the new key, instead of
dropping it, so a run that both reads and writes the ledger many times (a sweep round) reparses at
most once — but only once it has checked the file's size/mtime _before_ the write against what the
cache still claims: without that check, an event a second writer appended between this instance's
last `read()`/`append()` and this `append()` call would be silently dropped from this instance's
view forever, because the write's own post-append `statSync` would then make the cache's key match
the real file exactly and no later `read()` would ever re-fetch it to notice. A mismatch drops the
cache instead of growing it, so the next `read()` reparses from disk and picks up everything,
including the other writer's event (`tests/ledger.test.ts`, "does not lose a concurrent writer's
event..."). `read()` hands back the live cached array, never a defensive copy — checked across
`src/`, nothing mutates what it returns, only iterates it.

`project()` (`ledger/project.ts`) memoizes its own fold over the same array, by identity and
length (a `WeakMap`, so it does not keep an abandoned events array alive) — the same
"append pushes, does not replace" behaviour is what lets a `Ledger` instance's later `read()` still
hit this cache. Two existing callers mutate the `LedgerState` they get back mid-run to reconcile it
against what they are about to write — `fosterSessions` deletes a reconciled fostering from
`state.active` (`executor.ts:274`), `identifyHeldAccounts` adds a newly-seen identity to
`state.identities` (`cli/index.ts`, via `identify.ts:167`) — which used to be harmless because every
call got its own fresh Maps. Memoizing without defending against that would leak one call's
mutation into the next call's state whenever the two share a cache entry, which is exactly the
shape a dry-run batch with no ledger writes in between produces (several `fosterSessions` calls,
each `project(ledger.read())`, same array). So `project()` itself always returns a fresh shallow
copy of the memoized fold — new `Map`s, same entries — cheap next to the fold it is avoiding: on
the real ledger above, the fold itself costs 70-130 ms and a clone of its `Map`s a few ms.
Measured with a micro-benchmark standing in for the branch pass's per-copy call (50x
`project(ledger.read())` in a row, no writes between): 9.8 s uncached, 0.5 s cached, on the same
ledger.

`appendFileSync` does not check that the file it is growing already ends in a newline. A line left
torn on disk — the detached restart's `taskkill /F`, a power loss mid-write — glues to whatever is
appended next: the merged line is neither valid JSON nor separated from its neighbour, so
`parseLedgerEvent` drops it whole and _both_ events are lost, not just the one that was already
damaged. `Ledger` now checks the last byte of the file once, on its first `append()` per instance
(an `openSync`/seek/`readSync`, not a full read of a 23 MB file), and prefixes a newline first if it
is missing — nothing but this instance's own appends can retorn the file once that is fixed, so
later appends skip the check.

`doctor` used to read the process table twice — once through `inspectApp`, once through
`runningStores` a few lines later, each defaulting to `readProcesses` rather than the 5-second
`cachedProcesses` (`util/processes.ts`) — a second PowerShell spawn for an answer the first one
already gave. Both calls in `cli/index.ts` now pass `cachedProcesses` explicitly. `identifyHeldAccounts`
in the startup `preAction` hook (`NAMES_ACCOUNTS`, `cli/index.ts`) was already gated to the commands
that print an account by name — not every command — from #52, well before this; what it still pays
on those commands is one PowerShell spawn to unseal the Desktop's DPAPI-sealed token
(`store/credential.ts:183`), which has no process-table equivalent to cache.

Considered and dropped: `module.enableCompileCache()` in the bundle's banner. It persists V8's
compiled bytecode for modules loaded _after_ the call, which sounded like a real saving for a CLI
that is a new short-lived process each time — but it cannot cache the compilation of the script it
is running inside, which V8 has already fully parsed and compiled before any of that script's own
top-level statements execute. Measured directly: the built bundle's `foster --version`, timed over
multiple 20-run trials with a warmed persistent `NODE_COMPILE_CACHE` dir (the real-world
repeated-launch case the banner was meant for), was statistically indistinguishable with and
without the call. Since this bundle is a single self-contained file (`noExternal` above), the only
thing it could ever help is `src/agent/sdk.ts`'s own `import()` of the Agent SDK and zod — the
sole dynamic `import()` in this codebase, and not on the hot path of an ordinary command
(doctor/stores/clients/sweep/...) — so it was not worth the added banner complexity and the claim
was not worth keeping in this file.

`tests/setup.ts` now points `HOME`/`USERPROFILE` at a fresh `mkdtemp` directory before any test
file's own imports run. `configDirCandidates`, `inUseConfigDir` and the rest of
`store/configDirs.ts` default their `home` parameter to `os.homedir()`, which — unset — is this
machine's real profile: measured on this store, 13 GB under `~/.claude*` that a unit test has no
business scanning, and `os.homedir()` on win32 reads `USERPROFILE` first. Every default-`home` call
is a lazily-evaluated parameter, not cached at import time, so setting both env vars once at the top
of the setup file is enough. Measured 24/09/2026: the suite went from 39 s to 7-16 s (machine load
dependent) for the same ~1,631 green tests (1,641 with the tests this milestone adds), and
`tests/interactive.test.ts` alone from over a second to under one. Nothing in the suite depended on
the real home — a full `npm run check` with an empty temp `HOME`/`USERPROFILE` passes exactly as it
did before.

Real-data timings (`FOSTER_HOME` pointed at a scratch copy of `~/.foster`, never the real one; the
Desktop store read only): `doctor` 8.2-8.4 s before this milestone, 6.4-7.6 s after (removing the
doubled process-table read; the rest is PowerShell's own cold-start cost on this machine, unrelated
to any of this). A `sweep` dry run on a store with nothing left to bring (no fostering or branch-pass
copies to write, so the per-copy `project(ledger.read())` saving above does not get exercised) went
from 68.7 s to 62.6 s — the eight-or-so `read()`/`project()` calls per round are a much smaller share
of a real sweep's time than the branch pass's per-copy calls are, which the micro-benchmark above
measures in isolation.

## `--json` that tells the truth, and a Commander option can be silently unreachable

Measured 24/09/2026, fixed together (0.62.0 development).

**`consolidate --yes --json` (and `consolidate --undo --yes --json`) used to print the plan and
return before `repointCards`/`returnFosterings` ever ran** — `--yes --json` together wrote
nothing, silently, and exited 0. The fix follows the order `unclaim`/`dates`/`sweep
--undo-retitles` already used: with `--json` and a dry run, print the plan; with `--json` and
`--yes`, do the write first and shape the JSON from what was actually written
(`tests/consolidateCli.test.ts` proves the write landed on disk, not just in the printed plan —
`index.ts` runs the program on import, so this is a real subprocess test, not a call into the
engine functions `consolidate.test.ts` already covers).

**A parent command's own option can make an identically-named option on its subcommand
unreachable, silently, regardless of where the flag lands on the command line.** `view` (the bare
command) already declared `--to` and `--json`; `view set`/`view copy` also each declared their
own `--to`, and — once this milestone added it — their own `--json`. Commander resolves a flag
against the first command in the chain that declares it, so `foster view set --to X --json`
handed both flags to the _parent_, and `set`'s own `this.opts()` came back with neither `to` nor
`json` at all — proven with a minimal two-line Commander repro before it was trusted, not assumed
from reading the parser's docs. `--to` on `view set`/`view copy` had been silently broken this way
since it was added, with no test to catch it: a `--to` that named a real account was accepted and
then quietly ignored, falling back to the signed-in one. The fix is `this.optsWithGlobals()` in
place of `this.opts()` on both actions — it merges every ancestor command's own opts in, so the
flag reaches the action no matter which level actually parsed it, and needs no change to either
command's option declarations. `tests/viewCli.test.ts` guards both the new `--json` and the
`--to` fix, as a subprocess for the same reason `consolidateCli.test.ts` is one. No other command
in this CLI has a parent with its own `.option()` and a subcommand redeclaring the same name —
checked directly against the source, not assumed — so this pattern exists nowhere else here.

**`layout --detach --json` printed the plan as plain text before checking `opts.json`**,
so `--detach --json` together produced a stream that was half plain text, half JSON. The text
lines are now printed only when `--json` was not passed, matching every other branch of that
command.

**Exit codes**: `sweep`, `foster`, `restore`, `return` and `consolidate` used to exit 0 even when
their own `counts.failed` was greater than zero — a caller checking only the exit code had no way
to tell a partially-failed run from a clean one. Each now sets `process.exitCode = 1` on a real
(non-dry-run) failure, without changing what is printed; `sweep`'s own failures are spread across
several phases (`fostered`, `branches`, `restored`, `worktreeClaims`, `titleSync`, `dates`), folded
into one count by the new `sweepFailedCount` (`src/ops/sweep.ts`). `identify <unknown prefix>`
printed plain text and exited 0 even under `--json`; it now respects `--json` (an `{error, message}`
object) and exits 1, for the "no match", "ambiguous" and "name an account or pass --all" cases
alike. `client open --json` reported `ok: false` on a failed launch without setting the exit code
the text output already did for the same case (`outcome.outcome === 'failed'`; `not-windows` was
never a failure and still isn't).

`doctor --json` omitted the claude:// handler state entirely — the "still armed"/"still routed"
warning `foster doctor`'s text output prints is exactly the fact AGENTS.md elsewhere promises
`doctor` reports, and `--json` simply never carried it. It is now included as `handler`
(`inspectHandler`'s own shape), computed once and shared by both outputs.

`foster app pref --set ... --yes --json` (and the dry-run preview) printed only the plain-text
lines regardless of `--json` — a scripted caller had no way to read back what was actually
written, or that a preference was one of the guarded ones. Both paths now carry a JSON object
(`guarded`, `changes`/`written`, and on the real write, `closed`/`restarted`) instead of silence.

**The TUI's own sweep flow** (`sweepFlow`, `src/cli/flows.ts`) decided "nothing to sweep" and,
after writing, "did anything change" from a narrower count than `foster sweep --yes` itself uses —
left out `files.retitled` (the second-file "(other file…)" marks) and `titleSync`. A run whose
only pending work was one of those read as "Nothing to sweep: everything that can be in this
account already is." even though `foster sweep --yes` would have written it. Fixed by counting
both, the same way `sweepMarked` (moved from `src/cli/index.ts` to `src/ops/sweep.ts` and exported,
alongside `pendingOf` and the new `sweepFailedCount`) already does for the CLI's own restart gap.
That gap itself — `deferredSweepGap` (renamed from `deferredPinsGap`, same file) — is now shared
with the TUI flow too: `offerRestart`/`restartFlow` (`src/cli/desktopUi.ts`) take an optional
`duringGap` callback, run once the app is closed and before it starts again, so a sweep run from
the TUI writes back deferred pin moves and app-undone marks the same closed-app window
`foster sweep --restart` already used — previously it left them pending for the next
`foster layout`.

**The `preAction` hook matched a command by `command.name()` alone** — the bare leaf name — so
`foster app status` (a subcommand of `app`) tripped `identifyHeldAccounts` (a network call) every
time, purely because a _different_, top-level `status` command is the one `NAMES_ACCOUNTS` means
to cover; both leaves are named `status`. Fixed with `commandPath` (`src/cli/commandPath.ts`,
pulled into its own module so it is testable — `index.ts` runs the program on import and so cannot
be driven directly in a test, `tests/helpGroups.test.ts`'s own note), which walks a command's
`.parent` chain and joins the names with spaces (`app status` vs. `status`). Checked against every
name in `NAMES_ACCOUNTS`: all nine are top-level commands whose path equals their bare name, so
none of them changed behaviour — only `app status` (and, by the same fix, any future subcommand
sharing a name with a top-level one) stopped being caught by a set that was never meant to include
it. (`installations` in that set has never matched anything, before or after this fix — no command
is actually named that; it names a description on `profile list`, an unrelated pre-existing gap.)

**Review found two more, both fixed the same day.** `consolidate --yes --restart --json` (and
`--undo --yes --restart --json`) wrote correctly — the fix above is otherwise sound — but returned
before `finish` ever ran, the same shape `sweep --undo-retitles` had pre-existing (its own
`--json`/`--restart` combination is `cli-restart`'s to fix, not touched here). `--restart` was
silently dropped whenever `--json` was also passed: no error, no field saying so. Fixed by calling
`restartAround` (already imported; no change to `restartAround`, `finish` or detach themselves)
with no `duringGap` — the write already happened by this point, so this is exactly `sweep`'s own
`sweepRestart` shape, never `layout`/`view set`'s write-in-the-gap one — and folding the result
into the JSON as `restart`, on both the forward and `--undo` paths. `restartAround(store, false,
...)` short-circuits before it ever reads the process table, so this costs nothing when `--restart`
was not asked for; only `--restart --json` together used to be the case with no test at all.

`sweepFailedCount` (added the same day sweep's own exit code was fixed, above) missed two of the
places a write can fail: `branches.counts.failed` is `summariseOutcomes(branches.outcomes)` — the
copy/fostering outcomes of the branch pass — a different array from `branches.retitled`, that same
pass's own marks (`"(stale, stopped …)"`/`"(other branch, went on …)"`); `files` (the second-file
pass) has no `counts` at all, only `files.retitled`. Either can carry `status: 'failed'` on a real
write error (`engine/retitle.ts`), and the text output already marks one with a red `x`
(`render.ts`), but the count backing the exit code never saw it — a failed mark in either pass left
`foster sweep --yes` (text or `--json`) exiting 0. Both are now folded in.

## `foster where`, `foster verify`, and `sweep --prove`

Added 24/09/2026, replacing three hand-run recipes: "which account holds this conversation and
which row do I open" (`.claude/commands/fosteia.md`'s audit steps), "did the restart undo what
`foster layout` just wrote" (no command existed), and "did a sweep that said 'nothing is left'
actually bring everything" (the incidents 06/09, 14/09 and 15/09/2026 the memory
`foster-auditar-completude-do-sweep` names — 2116 records lost once, #114).

**`foster where <query>`** (`src/engine/where.ts`) searches every store `knownStores` names —
installed app, running, used-before, registered — not just the one `--store` resolves to, and every
account within each. A query is an id/cliSessionId prefix or a title fragment; `local_` is stripped
from both sides before comparing, the same convention `selectByKey` (`domain/filter.ts`) already
keeps. Two matching cards are ambiguous only when they root to two different conversations —
`resolveWhereQuery` roots every matched id with `Lineage.deepen`/`rootOf` before counting, so a fork
or a same-id-two-cwds pair (which share a root) resolve to one report rather than a false
ambiguity. `buildWhereReport` then ranks every card in the whole family (every id sharing the root,
every file any of them occupies) with one measure — `weighScans` keyed by file, tie-broken the same
way `fileCards.ts`'s `byContinuation` and `branches.ts`'s `byAdvancement` each are — rather than
choosing a fork-election path or a file-election path up front, since a query does not know in
advance which kind of "shown twice" it is asking about. Read-only; the search phase uses
`scanAccount(..., { slim: true })`, the same perf seam sweep uses (#116/#117).

Cross-checked against a real store 24/09/2026: `foster where` on a title fragment reported "1 file,
255 record(s) total"; an independent `grep`-and-`sort -u` of the transcript's own `uuid` fields
counted 255 distinct ids out of 374 lines. On a two-file conversation it reported "12335 record(s)
total"; hand-summing the union of both files' `uuid` sets, independently, gave 12335. The same run
surfaced a conversation (`83b273f9…`, "INSSIST R5") where **every** card in **every** account on the
machine — eleven of them — opened the same one file of a two-file conversation; nothing anywhere had
ever opened the other, larger file. Not a bug in `where` — a real gap `restore`/a fresh card would
close — but exactly the shape `sweep --prove` (below) is for.

**`foster verify`** (`src/engine/verify.ts`) reads back, in a fresh process, whether the app undid a
write `foster layout`/`sweep --restart` made in the closed-app gap. Titles/archived flags and pins
are checked exactly, by calling `planLayout` and reading its `.marks`/`.pins` back out — the same two
values `foster layout` itself uses to decide what to write, not a re-derivation. Groups and routines
cannot be checked as exactly: `layout_applied` carries only counts, never which card went into which
group (`project()`'s fold explicitly never reads a `layout_applied` event's fields — see
`LayoutAppliedEvent`'s own comment), so there is no ledger record of "this card, this group" to
compare a later read against. What `verifyFromPlan` flags instead is the one shape actually measured
on 23/09/2026: a `layout_applied` event exists for this target with `groupsCreated > 0`, the store's
current scope (`readGroupScopes`) now has zero groups, **and** a fresh `planLayout` still wants to
create some. Anything short of that — a non-empty scope with more merely pending — is reported, not
asserted as undone: it cannot be told apart from another account having simply gained a group since.
Cross-checked 24/09/2026 against a real store (scratch-copied ledger, live store read-only): `foster
verify` reported "a fresh `foster layout` would still bring 6 group(s)"; an independent `foster
layout` dry run against the same store proposed exactly 6 new groups.

**`sweep --prove`** (`src/ops/prove.ts`) is the sweep audit, deliberately not built from the sweep's
own bookkeeping (`Outcome.beyond`, `Sidebar.unreached`) — two of the three incidents above were bugs
_in_ that bookkeeping, so checking with the same arithmetic would have missed the same bugs the same
way. For every `cliSessionId` any card in the store names, it reads `Lineage.scanOf(id)` (every file
the id occupies, end to end, fresh) and compares that union against what the target account's own
cards reach (`Lineage.reachOf` per card, unioned). A gap whose only cards outside the target are all
blocked by a `NEVER_COMES` reason (`ops/sweep.ts`'s own list — scheduled task, spawned task, never
opened, too large) is reported separately as never-fosterable rather than counted as a gap; a gap
with no card at all outside the target (every card the missing file's id has is the target's own) is
reported as a gap on the same basis, not guessed into either bucket — see the module's own comment.
Scoped to one id at a time, the same way `fileCards.ts` is: whether every branch of a _fork_ got a
row is the branch pass's own question, already in `SweepReport.branches`; this measures the other
thing — one id split across two working directories — that the branch pass does not.

Measured 24/09/2026 against the real store (scratch ledger, `--yes` never passed): a full dry-run
`sweep --prove` took 1m54s and surfaced real gaps, `83b273f9…` above included (0 of 12335 reached by
the currently-signed-in account through its own cards, at the time of the run — the ordinary sweep
pass above it in the same run is what would close most of them; the second file nobody has ever
opened is what it cannot). On a dry run this measures the account **before** the plan runs, which is
the work that plan exists to close, not a simulation of what the plan would leave — said plainly in
`--prove`'s own `--help` text so a dry-run gap is not mistaken for a `--yes` run's own failure.

## Cloud sessions: `foster cloud list` / `foster cloud pull`

Measured 24/09/2026 against the installed CLI (`@anthropic-ai/claude-code` 2.1.278,
`bin/claude.exe`, a bundled Node binary) and against seven real cloud sessions on one signed-in
account. `src/engine/cloudApi.ts`'s own module comment carries the detail; this is the summary.

**The endpoints are private and undocumented.** Nothing here is a published spec — it is a byte
search for literal strings the minified bundle cannot obfuscate away (`/v1/code/sessions`, header
names, the functions that build them: `bot`, `iar`, `gL`, `qv` in the 2.1.278 build). They can
change under a future CLI release with no notice to foster, unlike `engine/anthropicApi.ts`'s two
endpoints, which are treated as more durable. `list` sends `Authorization`, `Content-Type`,
`anthropic-version` and `anthropic-client-platform` and nothing else — measured against the real
list and single-session endpoints, neither sends `x-organization-uuid`. `teleport-events` and its
`session_ingress` fallback both add it; the fallback's own behaviour (its response shape, whether
it is ever actually reached) is read out of the bundle alone, since every real session probed here
answered the primary endpoint directly. `errorFrom`'s `untrusted_device`/`session_stale_relogin`
codes are assumed to arrive as `error.type` on the response body — named in the bundle's own error
copy as reasons a device or sign-in is no longer trusted, but never actually seen fire against a
real account, so a body that does not carry a recognised `type` falls back to a plain status read
rather than guessing.

**The credential this reads is the CLI's, not the Desktop app's**: `.credentials.json`'s
`accessToken` plus `.claude.json`'s cached `oauthAccount.organizationUuid` (`store/cloudAuth.ts`,
the same two files and the same default-client candidate order `store/clients.ts` already uses for
`readClientIdentity`). **Never refreshed.** An expired token is reported, not renewed — renewing
rotates the refresh token in a file every `claude` process in that config directory reads at birth
(`store/cliCredential.ts`'s own warning), and a fleet of clients sharing one account's login is
exactly the kind of shared, live file foster's other write paths go out of their way not to
disturb. The refusal names the directory: "run claude in `<dir>` to refresh" is the only fix, and
it is the user's to run, not foster's. Measured on this machine: of three config directories with a
credential at all, one (`~/.claude`) had a live token with the `user:sessions:claude_code` scope;
one (`~/.claude-frota`) had an expired one, which `cloud list` reported per-row rather than failing
the whole run. Cloud sessions need a `claude.ai` sign-in — an API key is rejected outright by the
API itself (`gL`'s own guard: "Cloud sessions are only available on the first-party Anthropic API
provider"), a condition `readCloudAuth` cannot even produce since it only ever hands this module a
token read from `.credentials.json`.

**`foster cloud pull <id> --into <cwd>`** fabricates a transcript and a sidebar card the same way
`import-codex` does (`engine/codexImportWrite.ts`): files first, ledger only after they land, guarded
by `_fosterImport` (now carrying `source: 'cloud'`) and undone the same way (`conversation_imported`
/ `conversation_import_undone` — `undoCodexImports` is reused as-is for a cloud pull's undo, since
its body never referenced anything Codex-specific). The one real difference from a Codex import: a
teleport event's `payload` is already shaped like a Claude transcript record — `uuid`, `parentUuid`,
`sessionId`, `timestamp`, `type`, `isSidechain`, and per-type fields — because the cloud session
_is_ a CLI conversation, teleported off whatever machine it last ran on; conversion
(`engine/cloudTranscript.ts`) is mostly pass-through rather than built from scratch. Three things are
done to it: sidechains are dropped (`isSidechain: true`), a freshly minted uuid replaces `sessionId`
everywhere and `cwd` is rewritten to `--into` (a cloud id like `cse_…` is not shaped like the uuid a
local transcript's filename is expected to be, and the source `cwd` names a path on a container this
machine does not have), and the CLI's own "continued from another machine" notice is appended —
copied verbatim out of the bundle's `k$o()`. A **re-pull of a session whose history changed** reuses
the uuid minted the first time rather than minting a new one, so it overwrites in place instead of
orphaning the previous pair — the same reasoning `codexImportWrite.ts` gets for free from reusing the
rollout's own id, made explicit here since a cloud pull's minted id is not otherwise stable across
runs. No git operation runs here — the repo and branch the session last ran against
(`config.sources[].url`, `config.outcomes[].git_info`) are printed as a hint, not checked out.

**Payloads are personal data.** Every raw response saved while measuring this (list, one
single-session detail, one session's full teleport-events) went to a local scratch directory only,
never committed; the fixtures in `tests/cloud*.test.ts` have every id, path and message text replaced
with synthetic values. Treat any future manual probe of these endpoints the same way.

**`X-Trusted-Device-Token` is a known, deliberate gap, not an oversight.** The bundle sends it on
`teleport-events` and its `session_ingress` fallback when one is available (`bot`, `Bkn` in the
2.1.278 build), but it is not a value sitting in `.credentials.json` or `.claude.json` for foster to
read and forward: it comes from `getTrustedDeviceToken()`, a function dynamically imported from a
separate bundled chunk and itself gated behind a feature flag (`isViolinWoodEnabled`) read from yet
another chunk — machine attestation the CLI computes itself, not a stored credential. Confirmed
24/09/2026 by locating `getTrustedDeviceToken`'s call site in the same `bin/claude.exe` build this
module's module comment measures against; reproducing it would mean reverse-engineering an
attestation scheme, not reading a file foster already opens. `cloud list`/`cloud pull` proceed
without it, so an account whose organization requires device trust gets `untrusted_device` (403)
from `teleport-events` — reported the same way any other `CloudApiError` is, not silently swallowed.

**`--client` never reaches a `foster client register`ed fleet root**, `--container` children
included — only `foster clients`' own name list (`resolveCloudClient`, same reasoning
`listClients`' `registeredDirs` argument documents for `identify`: a default that quietly grew to
cover registered roots would hand a fleet credential to an external API call without anyone naming
that root here on purpose). `--config-dir <path>` is not accepted by `cloud` either. A registered
root's credential is reachable only by pointing `CLAUDE_CONFIG_DIR` at it directly and running
`foster cloud` from inside that shell.

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
