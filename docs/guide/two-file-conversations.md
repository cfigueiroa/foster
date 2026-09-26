# One conversation, two files: where and prove

## When one conversation becomes two

A conversation that already has a writer cannot be continued from a second card. Asked to open one,
the app forks instead: it copies the history into a new transcript with a new `cliSessionId` and
points that card at the fork. From then on there are two conversations where there was one, the two
halves usually live in different accounts, and fostering between those accounts puts both in the same
sidebar — one piece of work, several rows, nothing to tell them apart but a date.

`foster sweep` answers this without choosing: one row per branch, the branch that carried on under
its own title and every other branch retitled stale and filed in the archived view — see
[the whole sweep](sweep-and-forks.md#the-whole-sweep). The retitle is the one write the sweep makes to a card it did
not create, and it changes only the title and the archived flag; the ledger records both before
and after, native or not, and a stale row that later carries on gets its title back and, if it was
foster that filed it away, its place in Recents.

`foster consolidate` is the tidy-up for anyone who wants one row per account instead, on the half
that carried on:

```bash
foster consolidate                  # what it would do, writing nothing
foster consolidate --yes            # do it, with Claude Desktop closed
foster consolidate --undo --yes     # put every moved card back
```

It moves the card rather than adding one. A copy of the other half would be a second row, which is
the problem; the row you already have simply starts opening the conversation that kept going. The
card keeps its identity, its title and its pins, and only two fields change: the pointer, and the
date, so it stops sorting in Recents by the day it was interrupted.

### Which half carried on

The measure is **records a branch holds that no sibling holds**. The two obvious alternatives are
both wrong, and were measured to be wrong on a real store rather than reasoned about:

- **The file's modification time.** The app rewrites its own bookkeeping — `custom-title`, `mode`,
  `last-prompt` — into a transcript every time its card is opened, so a conversation nobody has added
  a word to gets a fresh timestamp. One fork here had its stale half stamped a day _after_ the half
  that had been running all morning, purely because the stale row had just been clicked. Anything
  ranked by mtime can be flipped by looking at the wrong answer.
- **The common prefix.** A branch is a copy of the history, so walking both files in step until they
  differ looks exact. It is not — the app does not write the copy in the original's order. On one
  fork the ordered prefix ran 169 records while the two files had 1255 in common.

`foster return --branches` used to pick its survivor by mtime and now uses the same measure, which
means it can no longer keep the row you happened to open and drop the one holding the work.

### What one row costs, and when it is not worth paying

Choosing a half hides what the others hold alone — from the sidebar, and only from the sidebar. The
transcripts stay on disk and `foster transcript <cliSessionId>` still reads them. Every line of the
dry run says both numbers, because "keeps 2802 records, hides 105" is the whole decision and printing
only the first half would be an advertisement.

When both halves are substantial that trade is not one to make quietly, so it is not made. Two tests
decide it, and a fork has to pass both:

- `--max-lost` (200 records by default) — how much the losing halves may hold between them;
- `--max-lost-share` (33% by default) — how much they may be worth _beside the half that stays_.

The second is there because the first measures the wrong thing on its own. What makes a merge safe
is not that the losing half is small but that it is insignificant next to the one that survives, and
those two come apart at the ends: hiding 200 records of a 210-record conversation passes a
`--max-lost` of 200 and is 95% of the work, while hiding 250 of 30,000 is a rounding error and fails
it. Both gaps turn out to be wide. Across a store of 591 conversations the forks worth collapsing
left between 3 and 158 records behind — 0.3%, 8% and 15% of what stayed — while the one that was
genuinely two pieces of work, 2352 records on one side and 3609 on the other with 770 in common,
left 2352: 54%.

A fork that fails either test is reported with its numbers and left exactly as it is, naming the
test that stopped it so the flag offered is the one that would lift it. Merging the two transcripts
would be the only way to keep everything, and rewriting the record of a conversation is not
something this tool does.

### The one write to a card foster did not make

Everywhere else, foster removes only what foster wrote. A repoint is the exception, and it carries
the guarantees that exception has to earn.

It refuses to rewrite a card a running app is holding, because that card will be written back from
memory, pointer and all, and the move would not survive. That question is asked of each card rather
than of the installation, the same way `return` asks it: a card the app wrote is held for as long as
the app runs, and so is a copy that already existed when it started, but a copy foster wrote
afterwards was never read — the app is past its one read of the directory, which is why it takes a
restart to appear and why nothing can retitle or refocus it in the meantime.

The practical shape of that: **consolidate before the restart, not after**. A sweep and the tidy-up
that follows it can run back to back on one closed-then-reopened app, where doing it the other way
round hands every fresh copy to the app first and then finds them all held. What cannot be helped is
a card the app itself made; those wait, and are reported as waiting rather than taking the rest of
the batch down with them.

The ledger records where the card was, the date it wore and where to find it, so `--undo` needs no
scan and works for an account nobody is signed into. A card moved twice still goes back to where the
app had it, not to where it stopped along the way.

What it will not touch is a second card the _app_ made for the same work. Those are reported and left
alone, for the reason `return` leaves them alone: deleting somebody else's file on the strength of a
heuristic is exactly the kind of help nobody asked for.

One shape is out of reach by construction. A fork is visible here only while both halves have a card
somewhere in the store, because that is where the list of conversations comes from. A branch nothing
points at is a conversation with no row at all, which is `foster restore`'s question rather than this
one's.

### Finding one conversation: `foster where`

Before `foster where` this was a recipe run by hand, three separate measurements in whatever order
occurred to whoever was doing it: grep every account's cards for the id or a piece of the title, look
in the transcript directory to see how many files the conversation occupies, and weigh those files
against each other to guess which row was still worth opening.

```bash
foster where <query>          # a session id, a cliSessionId prefix, or a title fragment
foster where <query> --json
```

It searches every installation `foster` already knows about — the installed app, anything running,
every store the ledger has been fostered into before, every registered profile — not only the one
`--store` would resolve to, and lists every account and store holding a card for the match: which
file each one opens, how many records that file holds against the conversation's own total, and what
the ledger knows about it (a fostering, a mark). A query matching more than one _conversation_ lists
the candidates and exits 1 rather than guessing; two matches sharing a root are not two conversations
— a fork, or the same id opened from two working directories, both covered below — so ambiguity is
judged on the root, never on the count of matching cards.

Which row to continue in is answered by the exact election `foster sweep`'s own fileCards pass runs
(`byContinuation`, imported rather than reimplemented, so the two can never disagree) — the last
answer, then records a row's file holds that no sibling's file holds, then the last message of any
kind, then sheer size — asked once across the whole family (every id sharing the conversation's root,
every file any of them occupies) rather than choosing a fork-election path or a file-election path up
front. `byContinuation` decides between files, not between two rows that open the same one; when the
election is still tied because several rows across different accounts open the very same file, the
row in the account `--store` resolves to (the signed-in account) wins — its own visible row first, its
own archived row next, ahead of any other account's row either way — and only then the row id. Read-only
throughout.

### Proving a sweep

`foster sweep --prove` is the audit that used to live only in a skill's own hand-run recipe, after
three incidents where a sweep that reported "nothing is left" had not, in fact, brought everything —
once losing 2116 records nobody noticed until the file was compared by hand.

It is deliberately not built from the sweep's own bookkeeping (`Outcome.beyond`, `Sidebar.unreached`,
the passes' own plans): two of those three incidents were bugs _in_ that bookkeeping, so checking
with the same arithmetic would have missed the same bugs the same way. Instead, for every
conversation the store holds a card for, it reads the id's own transcript files end to end — the same
set-difference primitive `foster sweep`'s branch and second-file passes are built on, asked fresh,
with no sweep state in between — and compares that union against what the account this run targets
can actually reach through its own cards. Anything short of the whole union is a gap, named with its
title and how many records short it is; `foster sweep --prove` exits 1 the moment any conversation
has one, excluding the same never-fosterable classes an ordinary sweep already counts and reports
separately (see [the whole sweep](sweep-and-forks.md#the-whole-sweep)).

A fork is out of scope on purpose: whether every branch of one got a row is the branch pass's own
question, already in the sweep's report. This measures the other thing that pass does not — one id
split across two working directories, and whether the target's cards for it, together, reach every
record either file holds.

On a dry run this measures the account **before** the plan above runs, which is exactly the work
that plan exists to close; on `--yes` it measures what was actually written. Read-only either way —
nothing about `--prove` itself writes.
