# Install and usage (long form)

## Install

```powershell
irm https://github.com/cfigueiroa/foster/releases/latest/download/install.ps1 | iex
```

That URL always serves the installer from the newest release. The installer itself pins the tag it
was published from and verifies the downloaded bundle's SHA256 against that release's checksum before
running anything, so the integrity check is unaffected by the URL being version-independent. To pin a
specific version instead, fetch it by tag:
`https://raw.githubusercontent.com/cfigueiroa/foster/v0.11.1/install.ps1`.

When it finishes it opens the menu straight away; pass `-NoLaunch` to skip that. For development,
clone the repo and use `npm run dev -- <command>`.

## Usage

Run it with no arguments for a guided menu that stays open — tick the accounts to
read from, choose sessions, review, confirm, and carry on without relaunching:

```bash
foster
```

You do not have to close Claude Desktop first. When the copies are written it
offers to restart the app so they show up.

The source screen is ticked rather than chosen: an account, one of its
organizations, several accounts at once, or the row that stands for every account
in the installation. One pass reads them all, so consolidating three accounts is
one run rather than three.

Copies go to the account you are signed into by default. The confirmation names
the destination and the title prefix, and either can be changed from there — any
organization of any account is a valid target, though copies written outside the
account in use only appear once you switch to it.

Sessions can also come from **another installation or profile**. A second profile
is a separate store that nothing in this one points at, so the source picker
offers it as its own entry: the profiles running right now are listed, and one
that is not running can be given by path. It is a scan of its own rather than one
more tick — a run reads one installation, and asking for both at once is refused
instead of quietly resolved to one. Copies made that way record which store they
came from, because two installations can hold the same account identifier.

"Work on another installation" goes further and points the whole menu at a
different profile — everything after it reads and writes there — so a second
account is not a reason to quit and relaunch.

The same operations are available as one-shot commands, for scripting. `--help` files them under
these same headings, so the list below and the one the program prints are the same shape:

```bash
# Start here
foster doctor    # environment check: store location, app state, whether it is running
foster stores    # installations foster knows about, and what to pass to --store
foster clients   # the CLI's config directories, and who is signed into each
foster clients --fragment # print a Windows Terminal fragment (JSON), one profile per client

# Bringing conversations in
foster sweep     # the whole job: every account, archived and deleted included
foster sweep --sync-titles # also re-title copies whose original has been renamed since
foster sweep --prove # after planning, independently check every conversation is fully reachable
foster sweep --cloud # also pull every other signed-in account's cloud sessions into local rows
foster sweep --no-archive-sync # leave archived flags alone (on by default: they follow the
                 #   account last used on each conversation)
foster scan      # read-only inventory of accounts, organizations and sessions
foster list      # sessions from other accounts that are available to foster
foster foster    # create the copies
foster restore   # bring back sessions deleted in the app

# After the sweep
foster where <query> # every account/store holding a card for one conversation, and which to
                 #   continue in (a session id, a cliSessionId prefix, or a title fragment)
foster verify    # after a restart, check nothing foster wrote (marks, pins, groups, routines)
                 #   was undone
foster return    # remove fostered copies, restoring the previous state
foster consolidate # one row per piece of work, on the branch that carried on
foster unclaim   # release the worktree claim a copy inherited from its original
foster status    # what is currently fostered
foster pin       # pin sessions in the sidebar, or see what is pinned
foster purge     # destroy the conversations behind deleted sessions, permanently

# Accounts
foster accounts  # every account here: who, which plan, whether it is still paid for
foster whoami    # the signed-in account's name, email and plan, from the app's own cache
foster identify  # name an account by asking the API with a credential already on the machine
foster label     # give an account a human name (--clear takes it back, --forget drops the sighting)
foster labels    # the name each account goes by — a label you gave, or its e-mail
foster usage     # the signed-in account's live 5-hour and weekly limits, from the API
foster renewals  # usage resets and billing dates across every account, in one place

# Credentials and clients
foster switch    # sign a client in as another account, without a logout
foster vault     # the credentials foster is holding, and whose they are
foster guard     # record the account a client holds, so it can be put back later
foster point     # repoint a directory link at another client
foster client new  # seed a config directory that is a working client
foster client register|forget # remember (or withdraw) a directory outside ~/.claude* for clients/launch
foster client open # a Windows Terminal tab signed in as one client (--print shows the command)
foster profile   # name a Desktop profile — new|register|forget|list — for --store

# Live sessions
foster live      # conversations a claude process is holding open right now (--stop ends one,
                 #   --prune clears registry entries whose process is gone)
foster rescue    # conversations stranded by a crash, and the resumes that bring them back
                 #   (--open puts each one in its own Windows Terminal tab)
foster unstarted # background-task requests whose session died before answering once
foster transcript  # read a conversation's transcript, by cliSessionId
foster resume    # send one prompt to an existing conversation, headlessly
foster grep      # search every transcript on this machine by what was actually said
foster export    # render one conversation to Markdown, HTML or JSONL

# Reports
foster disk      # bytes per account and per project, for cards and transcripts
foster stats     # token usage, sessions and usage-limit stops, from the transcripts

# Cloud sessions
foster cloud list             # every cloud session (code.claude.com) this account can see
foster cloud pull <id> --into <cwd> --yes  # fabricate a local transcript + sidebar card from one

# The app
foster app       # status | quit | start | restart — drive Claude Desktop itself
foster app login # sign a second profile in through the ordinary browser flow (--restore undoes
                 #   an interrupted run)
foster agent     # hand a task to a Claude agent that drives the operations above
```

`return` only touches copies in the installation it is pointed at; copies written into another
profile are counted and left alone unless you pass `--all-stores`. The ledger spans every
installation, and quietly deleting from one while working in another is not something a tool should
do on its own.

It also reads the axis the copies were written along. `foster` chooses a destination with `--to`, so
`return --to <accountUuid>` removes the copies in one account and leaves the rest — which is what
"clean up the account I stopped using" means, and what the unfiltered command cannot express: with
several accounts fostered into, a bare `return` removes the copies in the one you are using too.

```bash
foster return --to 00000000          # dry run, scoped to that account
foster return --to 00000000 --yes    # with Claude Desktop closed
```

### Naming accounts, and when foster can do it for you

Accounts are UUIDs here because that is all the directory names carry. The app knows better — it
shows the account's email under your avatar — and the plainest copy of that email on this disk is
inside `oauth:tokenCache` in the app's config, which the safety model does not read as a shortcut to
a name. (It is not in the config as plain text, not in the logs, and not in any file keyed by
account; the one other copy is buried in an opaque IndexedDB blob that describes only the account
currently signed in.) So a name comes from one of three places, in the order foster prefers them: a
label you set, an identity foster read from the app's own profile cache, or — new — an answer the API
gave when foster presented a credential the account itself left behind (see `identify`, below). Only
when none of those is available does the pairing fall to you — and even then only the name, because
foster already knows which account the sidebar is reading:

```bash
foster label "John · johndoe@…"           # names the account you are signed into
foster label 00000000 "old personal"      # names any other
```

An identifier given on its own is refused rather than recorded as a name. From then on the name
appears in `scan`, `status` and the menu, and "Name an account" starts on the account in use —
the one whose email you can actually go and read right now.

`foster whoami` reads your name, email and plan for you, from the app's own cache rather than off the
screen — `John · johndoe@… · Max`, the same pieces the app shows under your avatar. The
authoritative copy is behind the API; `whoami` chooses not to spend the token on it (that is
`identify`'s and `usage`'s job, on request) and reads the app's own download instead — having fetched
its profile once, the app keeps a copy at rest in the web-origin storage under `Local Storage/` and
`IndexedDB/`, which is page data rather than a credential, so foster may read it offline. `foster label --from-cache` names the signed-in account with what it finds, and
the menu's "Name an account" pre-fills the same suggestion.

It is read the crudest way that cannot fail: the files are loaded as bytes, capped by size, and
searched as text. Parsing that storage as a database — which an earlier version did, with the reader
foster uses for the pin list — corrupted the heap on a real table and crashed the process outright,
because the format is the app's to change and foster's reader was built for one narrow database.
Reading bytes trusts nothing: it finds less (a value hidden inside a compressed block is missed) and
crashes never.

**It reads and remembers, because the source is volatile.** The profile lands in that storage when
the app fetches it and leaves when Chromium compacts the database: measured here, the plan was
readable minutes after signing in and absent from every non-credential file an hour later. No amount
of careful parsing finds what is no longer written down, so `whoami` records what it sees in
foster's own ledger and falls back to that when the cache has forgotten. A remembered answer says
so, with the date it was last confirmed — that is a different claim from a fresh reading, and the
difference is worth keeping visible.

Remembering is also what makes the **other** accounts nameable. Web storage only ever describes the
session in front of you, so the cache alone can name one account; the ledger accumulates them, one
per visit, and `label` offers what it knows for whichever account you pick.

`foster identify` closes part of that gap without a visit. An account foster has never seen signed in
is a bare UUID because the app never fetched its profile here — but a credential _for_ that account
may already be on the machine, in a CLI client (`foster clients` lists them) or in foster's own
vault. The profile endpoint answers for whatever token it is given, so foster presents those
credentials and keeps the answer only when the profile's own `account.uuid` matches the account
asked about. That match is the safety: a token belonging to someone else is discarded, never written
against the account that was asked. The sighting lands in the ledger the same way a sign-in's would,
so the dashboard, `accounts` and the menu pick it up. `foster identify <account>` names one,
`foster identify --all` sweeps every account that has no identity yet, and the menu offers "Identify
it" on an unnamed account when a key to ask with is on hand. When foster holds no live credential for
an account it says so rather than guessing.

It also asks on its own, ahead of the commands that print an account by name — `accounts`, `labels`,
`stores`, `live`, `status`, `sweep`, `scan`, `clients`, `doctor`, `whoami`. What makes that
affordable is asking per _credential_ rather than per account: a token answers with its own
`account.uuid`, so a single round names everyone it can reach, where asking per account would be one
request per pair. A credential whose owner is already on disk — the app's own config hint, a client's
cached profile, a vault entry the API has answered for before — is skipped once that owner has an
identity, so on the ordinary machine, after the first time, the run asks nothing at all. Failures are
silent: a name is a courtesy, and the command you actually asked for runs regardless. `purge`,
`return`, `switch` and the rest never trigger it — they act on ids and paths, and a run that only
means to move files should not be waiting on the network.

And a name, once known, is used. Every screen used to print eight hex digits for an account whose
e-mail was already sitting in the ledger, because it read the labels map and nothing else. The order
now is the label first — someone sat down and chose it — then the e-mail the API answered with, then
the abbreviation. Only the `label` field in JSON still means strictly what a person named, because
that is what it promises.

**Two servers, and why only one of them answers.** This is worth understanding, because it is the
line between what `identify` and `accounts` can tell you and what they cannot. Anthropic runs the
account behind two different hosts, and they are not interchangeable:

- **`api.anthropic.com`** is the programmatic host. The OAuth token the app holds was _issued to
  talk to it_, so a request there is authenticated, expected, and ordinary — no trick involved. It
  answers with **identity, plan, subscription status and live usage**. This is the front door, and
  it is the only one foster ever knocks on: `usage`, `renewals` and `identify` all go here.
- **`claude.ai`** is the website you open in a browser. The **billing** details — next charge date,
  card on file, cancellation — live only here, and this host sits behind a **bot-check**: the
  "confirm you're human" challenge (Cloudflare's) that a browser passes silently and a script does
  not. For a program to read billing off `claude.ai` it would have to _defeat that challenge_ —
  impersonate a human-driven browser. **foster does not do that, by policy.** So billing is
  reachable only when the app itself already fetched it and left a copy on disk (which is why you may
  see a card and a renewal date for the account signed in now, and never for one that was only
  identified over the API).

Put plainly: identity, plan and usage come through the front door and `identify` can fetch them for
any account whose key is on this machine; billing is behind the bot-check, so it is only ever read
from a cache the app already filled, never fetched by foster. The card and renewal you saw on the
signed-in account are the app's own download at rest — not something foster went to `claude.ai` to
get.

Two honesties beyond that. It is **best-effort**: a version that keeps the profile differently makes
`whoami` find nothing new rather than something wrong, and the manual `label` is always there. And
what it extracts is tied to the account by proximity — the email must sit beside the account’s own
UUID, and the name and plan beside that email — so a correspondent’s address quoted in a conversation
cannot end up as the account’s name, and a workspace called "Sales" cannot end up as its owner.

**Where it actually reads.** The app keeps its own profile in two places and only one of them is
current. It used to persist the answer into Local Storage, inside the React Query cache, and that is
what the byte search was built for; on a machine running today that cache persists _empty_ and the
live copy is a cached HTTP response body under `Cache/`. So the profile is read from there first —
gzip or brotli, decompressed, and then **parsed**, because it is JSON and an object either carries
`account.uuid` equal to the account being asked about or it does not. That is a comparison rather
than a guess, which is why this source is preferred over everything below it. What it yields is the
whole profile: name, email, organization, the raw tier, the subscription's status and start date.

`foster accounts` (and **"Who each account is"** in the menu) is that, for every account in the
installation at once — plan, subscription, card and renewal where they are known, sessions and
organizations always. One honesty runs through the screen: a response cache holds what was
_fetched_, and the app only ever fetches the profile of the session it is in, so exactly one row can
be read fresh. The others show what foster recorded on the visit that saw them, dated. An account
never signed into on this machine shows its directories and nothing else — not because the read gave
up, but because that account's profile has never been on this disk. Signing into it once fills the
row in for good.

Proximity is not the whole of it, because these files are not text. Local Storage is a stack of
compressed blocks read as raw bytes, so most of what a pattern sees is rubble — and rubble spells
email addresses: across one real store, 350 of 676 matches for a plain address were decompression
noise, things like `3@T.tf` and `6@ai.television.ses`. Nearness cannot tell those from a profile,
since noise is nearer to the account id than the profile ever is. So the email is read only out of a
field that says it is an email, from a value that is an address all the way to both quotes.

Remembering has its own failure, and it needs a way out. A sighting that was wrong outlives the cache
that produced it, and a later reading can only correct a field by finding a different value for it —
which it cannot do once the app has compacted the profile away. `foster label <accountUuid> --forget`
discards what is remembered about an account and leaves the name you chose alone; the sighting stays
in the log, and the next real reading starts the record over.

`--clear` is the opposite half: it drops the name **you** gave and leaves the sighting, so the
account goes back to being called by its e-mail. That only became worth having once an unlabelled
account is named by its e-mail rather than by eight hex digits — clearing a label is now a choice to
be called what the API calls you, not a choice to be anonymous. The log is append-only, so taking a
name back is a line saying so (`account_labelled` with an empty label) rather than a line removed;
`label` itself refuses an empty name, so `--clear` is the only thing that ever writes one.

`status` answers the same question the other way round. It summarises by account by default —
how many copies, and where — because with a few hundred of them a line per copy is not an answer
anyone can read. `status --all` prints the full list, `status --to <accountUuid>` narrows to one
account, and `--json` is always complete.

`foster`, `restore`, `return` and `purge` are dry runs unless you pass `--yes`: they print exactly
what would be written or removed and touch nothing. (`label` only records a name in
foster's own ledger, so it writes immediately; `purge` wants `--confirm` as well as
`--yes`.) Add `--restart` to any of the first three to restart Claude Desktop when it
finishes.

Narrow what gets fostered with `--title`, `--cwd`, `--since 30d`, `--session <id...>`,
`--from <accountUuid>` or `--from-org <organizationUuid>`, and choose where the copies land with
`--to <accountUuid>` / `--to-org <organizationUuid>`. Identifiers may be abbreviated to any unique
prefix; an ambiguous one is reported rather than guessed at.

`--from-store <path>` reads the sessions from a different installation or profile while still
writing into the store `--store` names, which is how sessions move between two profiles:

```bash
foster --store "$env:LOCALAPPDATA\Claude-Work" foster --from-store "<the default store>" --yes
```

An account can hold several organizations and the sidebar only reads one of them, so any
organization other than that one is a valid source — including another organization of the account
you are already signed into. Sessions that could not appear in the sidebar are excluded by default —
scheduled tasks, sessions that were never opened, and sessions whose file is over the 10 MB the app
refuses to load. `list --all` shows them anyway, and `--include-scheduled` brings the first of the
three across as ordinary conversations.

Archived sessions are excluded too, but for a different reason and with a way out. Archiving is a
decision you made, not a limitation of the file: the session has a place in the app, just not in
Recents. A sweep should not drag back what you tucked away, so `--archived` is opt-in — and when the
only card a conversation has left is archived in an account you are not signed into, it is the only
way to reach it at all. The copy keeps the flag and lands in the destination's archived view, which
brings the conversation across without undoing your decision about it.

### A scheduled task's conversation

A scheduled task is excluded for a reason that turns out to be narrower than it looks. What the app
refuses to list under Recents is the **card**, because it carries a `scheduledTaskId`; the
conversation behind it is an ordinary transcript. So a copy of one is only invisible if it keeps
that field — and `--include-scheduled` drops it, along with giving the copy a focus time, since a
card without one counts as never opened and is the other way to be correct and invisible.

It is opt-in because the copy is not the task. The schedule, its trigger and its history stay in
the account that owns them, and nothing runs again; what crosses is the reading of what it did.
That is a different thing from what the row meant in its own account, so it is asked for rather
than swept up. The original is left untouched, still a scheduled task where it belongs.

### A copy can be the last card its conversation has

Copies are not sources. Fostering one would make a second copy of a conversation whose original is
right there, with a longer provenance chain and nothing gained. That rule is right until the
original stops existing — deleted in the app, or never there at all because the copy came from
`restore` — and then it strands the conversation: it sits in one account, perfectly readable, and no
sweep will ever offer it again. Moving to a third account leaves it behind for good.

So the rule is about the conversation rather than the file. A copy is refused while its conversation
still has a card of its own **somewhere in the store**, and is a legitimate source once it does not.
That question can only be answered by looking at every account, including the ones not being
offered — deciding it from the source account alone would call a copy stranded while its original
sat in the account the copies were going to. Two stranded copies of one conversation are both
eligible and the destination check still allows only one row, so nothing doubles.

`--store` and `--from-store` take a distinctive piece of a path as well as the whole thing, matched
against the installations below — `--store work` finds `D:\Claude-Work`. A piece that matches two of
them is reported rather than guessed at, and one that matches nothing and is not a directory is an
error rather than an empty store.

`foster stores` lists the installations it can name without being told, from **four** sources: the
installed app; whatever is running right now; the profiles the ledger has already been fostered
into; and — new — the ones registered on purpose, `foster profile new` or `profile register`,
for a profile that has neither run nor been fostered into yet. Each line carries the account it
holds, which is the question a second profile exists to answer, and the menu offers the same
list, so a profile you have worked in once never has to be typed again.

```
* C:\…\Claude_…\LocalCache\Roaming\Claude  (installed app, running) last seen as 9866b1e8
  D:\Claude-Work                           (profile, running) last seen as not signed in
  work                                     (registered, gone) last seen as not signed in
```

A registered name is the one row that survives its own directory disappearing — `(registered,
gone)` above — because a name is the one thing foster remembers on purpose past that; `foster
profile forget` is how you stop hearing about it. `--json` adds `signedIn`: whether that
installation's config carries a cached OAuth token entry at all, presence only, the same
existence check `doctor` reports and never the token itself — reading that stays `usage`'s job
alone (see [Safety model](safety-model.md#safety-model)).

On Windows, the packaged app answers to two paths — a `Packages\Claude_<hash>\...` directory and
the pre-virtualisation `%APPDATA%\Claude` one — and whether those fold into a single row or list
as two depends on where this command runs. Run from inside the app's own container (a Code
session it hosts), MSIX virtualisation makes them the same physical directory and one row is
printed. Run from an ordinary terminal, the virtualisation does not apply and the two are genuinely
different directories on disk — so `%APPDATA%\Claude` gets its own row, marked `(installed app,
legacy (pre-MSIX))`: it is the store from before the app was packaged, and a `sweep` run inside the
app never sees whatever conversations are still sitting in it. That label only appears when a
packaged install is actually present on the same machine; on macOS and Linux, and on a Windows
machine that was never packaged at all, `%APPDATA%\Claude` (or its platform equivalent) is simply
the store, unlabelled.

`--store` resolves an argument against exactly this list, trying each in turn: a path that
exists is always taken as a path; failing that, a registered name, exact, tried before a path
piece that happens to match too; failing that, an account — a label, an e-mail, or a unique uuid
prefix, the same three `foster clients` already prints; and last, a distinctive piece of a path,
because a profile's is long and nobody remembers it exactly. A piece matching more than one
installation is reported rather than guessed at, the same as an ambiguous session identifier,
because with `--store` the guess decides which installation gets written to.

**What `--store <name>` means for the verbs that already existed: they now act on that profile
instead of the installed app, by design.** `foster --store work sweep` scans **that** profile's
other accounts and writes the copies inside it — each profile keeps its own
`claude-code-sessions`, so two profiles mean two independent sweeps, and neither ever sees the
other's cards — and `sweep --restart` already restarts the instance that was actually named.
`foster --store work rescue` lists that profile's stranded cards; the transcripts it reads for
them still come from `transcriptRoots`, which is CLI-side and shared, so one transcript can
legitimately show up under two profiles. `foster --store work consolidate` and
`foster --store work return` still require **that** profile's own app closed, with the
refuse-to-close-the-one-you-are-running-inside rule intact. None of these verbs learns a new
**client** directory from a profile — that stays `client register`'s job, a separate registry on
purpose (see [More than one client at once](accounts-and-clients.md#more-than-one-client-at-once)); what changes here is
only which store they read and write.

`foster clients` is the same list for the CLI: its config directories — one per account — with who
is signed into each, read from each client's own cached profile; the credential contributes only its
existence. Everything that reads conversations already searches every client, so this is the map of
what those commands will look at, and `--config-dir` adds a directory that lives where naming
cannot find it.

`transcript`, `resume` and `live` are the deterministic counterparts of what the agent (below) does
with its tools — for when you know exactly what you want and a model in the middle would only add
cost. `foster transcript <cliSessionId>` prints the most recent part of a conversation (`--head` for
the start, `--chars` for how much; the id comes from `list --json` or `status --json`).
`foster resume <cliSessionId> "<prompt>"` runs `claude -p --resume` behind the same gate the agent
has: it refuses while a live `claude` process holds that conversation, because two writers on one
transcript is how transcripts get corrupted. `foster live` shows exactly what is being held.

That gate rests on the CLI's own registry — a file per running session under `<configDir>/sessions/`,
naming the pid holding the conversation — and a pid on its own is not an identity. Windows reissues
pids quickly, and after a reboot a day-old registry file points at whatever took the number next: a
service worker, a git process, the desktop app. So the pid is checked against the creation time the
record kept for its writer (`procStart`, Windows' own clock): two processes can share a pid, but not
a pid and a creation instant. Records too old to carry one fall back to what the pid is now and
whether it is even older than the record describing it. An entry that fails is not a live writer,
and `foster live --stop` will not end a process it cannot identify — the kill is `taskkill /F /T`,
and the tree it takes with it would be a stranger's. Reading the process table is the Windows half
of foster: anywhere else there is none, every entry stays listed, and `--stop` refuses everything
rather than guessing.

Reading the table itself has its own fallback. PowerShell's `Get-CimInstance Win32_Process` answers
first — it is the only reader that reports a parent pid — but PowerShell can hang at start-up rather
than fail quickly: measured 05/09/2026, a machine whose PowerShell was blocked at start-up by a
WinFsp/Cryptomator drive that had stopped answering made every `powershell.exe` invocation wait 20 s
and then error, and every foster command that reads the process table reported an empty machine as a
result. When PowerShell fails or is missing, `wmic` answers next with the same six fields (pid,
parent pid, name, path, command line, start time); when wmic also fails or is not installed (it is a
Feature on Demand as of Windows 11 24H2, so a fresh install may not have it), `tasklist` answers with
pid and name only. A table read through `wmic` changes nothing; a table read through `tasklist`
changes what foster is willing to conclude from it: `app status` reports that it cannot tell the app
from a Claude Code session rather than guessing "not running", `live --stop` refuses a partial row
outright rather than risk `taskkill /F /T` against the wrong process, and `sweep --restart` hands
over the command instead of trying. `foster doctor` names which reader actually answered and why the
ones before it were passed over. A PowerShell that fails once is not retried for the rest of that
run — the hang is paid at most once, not once per read. The native readers decode their output as
`latin1` rather than Unicode, so a path or command line containing non-ASCII characters can come back
wrong; the ASCII markers foster actually greps for are unaffected.

The session foster is running in is never ended, for the same reason it refuses to close the app it
runs inside — the kill would take the command with it, part-way through. That used to be answered by
walking parent links, which breaks the moment any process in the chain has exited: launched through
a wrapper whose shell was gone, `--stop` offered to end the session it was running in. The CLI marks
every process it starts with the conversation and the pid holding it, however deep, so the question
is now answered outright.

`foster live --prune` clears the files whose process is provably gone or provably somebody else;
without `--yes` it only lists them. That includes the peer key a session leaves beside its record —
it carries the same creation time, so it is answerable by the same rule, and it is what a machine
that has been up for a week is actually full of: the CLI clears records it finds stale but never
the keys.

`scan`, `list`, `status`, `stores`, `clients`, `doctor`, `app status`, `transcript`, `live`,
`purge` and `whoami` take `--json`.
