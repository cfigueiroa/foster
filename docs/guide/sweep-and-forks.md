# The sweep, forks and worktree claims

## The whole sweep

The request behind most runs never varies — _bring everything here_ — and answering it used to
mean three commands in the right order plus one flag that was easy to miss. `foster sweep` is that
sequence as a command:

```bash
foster sweep          # what it would do, writing nothing
foster sweep --yes    # do it
```

It copies every fosterable session from the other accounts, **archived ones included**, gives every
branch of a forked conversation a row of its own, brings back conversations the app deleted that
nothing still points at, and then re-scans to say whether any pass has anything left. That last part
is the reason it exists as a command rather than as advice: measured on one real store, the same
sweep offered 15 sessions without `--archived` and 141 with it, so anyone who did not know the flag
finished with a tenth of the work done and no way to tell.

Archived copies **stay archived**. They arrive in the app's archived view rather than reappearing in
Recents — bringing the conversation across is the point, not undoing the decision to tuck it away.

A forked conversation — one piece of work continued in more than one account, each continuation on
a transcript of its own — gets **one row per branch**, and the rows say which one to open. The
branch that carried on keeps its title untouched. Every other branch is retitled
`(stale, stopped DD/MM HH:MM) …`, stamped with the moment of its last answer, and filed in the
archived view — the row already in the account included, whoever made it. Nothing is chosen and
nothing is hidden: the stale rows still open, they just no longer look like the row to continue in.
The one branch that gets no row of its own is one holding nothing of its own — every record of it
already in the branch that carried on — because a row for it would open nothing the clean row does
not.
`--stale-prefix` changes the words a fresh mark is written with, and `--branch-prefix` does the same
for a branch that went on rather than stopped; `{when}` is where the moment goes in either. Measured
on the store that prompted this: the row the user had pinned held 328 records while the branches in
two other accounts held 3157 and 2564, and every previous sweep had reported that nothing was left to
do.

Recognising a mark an _earlier_ run wrote never depends on being told those same words again. The
ledger already says what a row was actually marked with, so a bare `foster sweep` — the English
defaults — still recognises a row the `/fosteia` skill marked in Portuguese last week, and leaves it
exactly as it is rather than stacking a second mark in front of the first: `--stale-prefix` and
`--branch-prefix` only ever choose the words a _new_ mark is written with (#35). Measured on a real
store: 10 rows would have been rewritten that way by one bare `foster sweep --yes` on 05/09/2026. A row
wearing a mark no known template can explain — a hand edit, or a foster too old to have recorded one —
is left alone and named in the sweep's summary, rather than guessed at.

It also counts what a sweep does not bring: scheduled tasks, sessions never opened, and files over
the 10 MB the app refuses to load. Those are a real gap in the sidebar, and a run that leaves them
unmentioned reads as having brought everything. One of the three has a way out — see
[scheduled tasks](usage.md#a-scheduled-tasks-conversation) — and the count says so rather than filing it
under a flat "never".

`--prove` audits the sweep instead of trusting it: for every conversation the store holds a card
for, it reads every file the id occupies end to end and compares that union against what the
account this run targets can actually reach, independently of the sweep's own bookkeeping — see
[proving a sweep](two-file-conversations.md#proving-a-sweep). It exits 1 the moment any record is unreachable, excluding the
documented never-fosterable classes above, which it reports separately.

```bash
foster sweep --prove            # plan, then check — writes nothing
foster sweep --yes --prove      # write, then check what actually landed
```

A fourth pass releases the worktree claim a copy already on disk inherited from its original,
before fostering learned not to hand one out — see
[Copies that still claim a worktree](#copies-that-still-claim-a-worktree). It runs last, against
whatever the first three passes just wrote, and is counted in the same "nothing is left" check.

The archived flag follows the account last used on each conversation, on by default
(`--no-archive-sync` turns it off): a row is archived or unarchived to match whichever other account
was most recently active on it — never a row changed here by hand since foster last wrote it, never
one used here more recently than anywhere else, and never on a tie between two sources that
disagree. `--cloud` adds a source no local pass can see: every cloud session (code.claude.com) any
other signed-in CLI credential on this machine can reach, pulled into a local row in the checkout
whose git remote matches the session's repository. Those continue locally, not in the cloud.

A fifth pass, `--sync-titles`, brings a copy's title back into step with the original's. A copy
carries the name of the instant it was made, and every later sweep sees it as already fostered and
walks past — so a conversation renamed where it came from keeps the old name in every other account
for ever, and the sidebar reads as if the work were missing when only its name is.

Whose name wins is decided from the ledger, never from reading the strings: a copy still wearing the
last title foster itself wrote is rewritten. That is `card_retitled.to` when the branch pass has
marked the card since, and the fostering's `originalTitle` otherwise. On the store this was measured
against, 875 of 911 copies still matched, 9 wore a mark, and the one that had been renamed by hand
was exactly the row that must not be trampled.

That test alone was too narrow. Open a copy in this account and the app generates a title for it,
which matches no baseline — so a conversation renamed where it came from stayed out of step for
ever, and the run reported it as "renamed here" when nobody had renamed anything. The card records
who named it: `titleSource` is `auto` when the app generated the name, `user` when somebody renamed
the row in the sidebar, `tool` when `set_session_title` wrote it, and absent on copies older than
the field. So a second rule follows the first — **a name a person chose beats a name the app
generated**, whichever side each is on, and a name chosen on both sides is a conflict the run prints
with both names rather than settling. Authorship is the only question that can be answered here:
nothing records _when_ a title changed (there is no `titleUpdatedAt`, and `lastActivityAt` moves when
a conversation is merely opened), so "the newer rename wins" is not available at all.

Marks survive it and never travel. The mark a branch wears is not part of its name, so it is put
back in front of the new title; a mark the _original_ happens to wear is dropped, or the two would
stack. Both are derived by subtracting the title from the record that carries it, which is what
keeps this clear of the [prefix problem](two-file-conversations.md#when-one-conversation-becomes-two) — a run does not have to
be told the words a mark was written with to recognise one. When a card has been marked twice and the
mark can no longer be told from the title beneath it, the copy is left alone rather than rewritten
with a guess. It is off by default because the first run on a store fostered into for weeks rewrites
in bulk, and only shows at the next restart.

Two things it deliberately does not do. It never [purges](deleted-conversations.md#deleting-for-real), which destroys
transcripts and is part of no sweep. And it never [consolidates](two-file-conversations.md#when-one-conversation-becomes-two):
with a row per branch nothing is hidden, so collapsing a fork to one row is a tidy-up for whoever
wants one, not a decision the sweep has to leave open.

One scan, one lineage, one walk of the transcript tree per run. The passes used to build their own,
and a `--yes` run read every card in the store five times over and walked the transcript tree six —
on a store of eleven accounts, half a minute of the run was spent reading what it had just read.

`--restart` restarts Claude Desktop at the end, which is what makes the copies visible. A Claude
Code session started from the app's sidebar is a child process of the app, so restarting from
inside one would kill the caller part-way through; the sweep asks first and ends with the command
to run from a terminal outside the app instead of failing after writing everything.

## Copies that still claim a worktree

A card names the worktree it holds in `worktreePath` / `worktreeName`, but the lease itself lives
in the app's own store of worktrees, keyed by the session id that took it out. A copy used to
carry the claim without the lease — a fresh id naming a directory it cannot hold — so when the app
reached the second card on that branch it refused with `fatal: 'claude/<branch>' is already used
by worktree at '<path>'` and dropped the session into the main repository, uncommitted work and
all. Fostering has not made that mistake since 0.38.0: a fresh copy drops the claim and opens in
the repository the worktree was cut from instead.

What that fix could not reach is what was already on disk. `foster unclaim` is the repair:

```bash
foster unclaim          # what it would release, writing nothing
foster unclaim --yes    # release it
```

Only **copies** are ever touched — the candidates are the active fosterings foster's own ledger
already tracks, never a card discovered by scanning the store, so a native card carrying the same
stale claim is left exactly as it is. The write removes the three claim fields and moves `cwd` to
the repository the worktree was cut from, the same relocation `buildFosterCopy` makes for a copy
being minted fresh, and carries every other key on the card through untouched.

The release is recorded, so it can be put back: `foster unclaim --undo --yes` restores the claim
and the directory, refusing a card that has since moved on — repointed, retitled into a different
`cwd`, or handed a fresh worktree by the app — rather than overwriting it.

Releasing a claim takes no write guard, unlike a repoint — it is allowed with Claude Desktop open,
the same as [a retitle](two-file-conversations.md#when-one-conversation-becomes-two). The app reads the session directory once,
at startup, and only ever rewrites a card it is holding in memory, whole, the next time something
about it changes. A release that write overwrites is not lost: `planUnclaim` re-derives the claim
from whatever is on disk, so a card the app hands the fields back to is simply one the next plan
finds again, and the next `foster unclaim` — or the next sweep — releases it a second time. The
change becomes visible at the app's next restart either way, exactly like a retitle.

`foster sweep` runs this as its fourth pass, on the destination store, after the other three have
written — so "bring everything here" also stops a freshly arrived copy from fighting its original
over a branch. Two follow-ups from the original issue (#26) stay open: the `branch` a stale, archived
row still claims, and the cosmetic `keptDirtyWorktree` a copy cannot really have.
