# Reports: disk and stats

## Reports: where the bytes are, and where the tokens went

Two read-only commands, across every account this store has — neither writes anything, and
neither decides what is safe to remove:

```bash
foster disk            # cards and transcripts: bytes per account, per project, and what is bulky
foster disk --json     # the same report, machine-readable

foster stats                        # token usage over the last 30 days, by account
foster stats --by model             # the same window, grouped by model instead
foster stats --by week --since 90d  # a longer window, grouped by week
foster stats --json                 # the same report, machine-readable
```

`foster disk` measures every session card and every transcript this store can see: bytes per
account and per working directory, how much of a card's own JSON is `BULKY_CARD_FIELDS`
(measured on a real store: 97%, nearly all of it `remoteMcpServersConfig`), transcripts no
card in any account still points at (broader than `purge`'s orphans — this counts one without
requiring a tombstone), transcript files that are byte-for-byte copies of each other (only
files that already share a size are hashed, and the hash itself streams a file rather than
reading it whole), and session cards already over the app's own 10 MB load limit. Measured on
a real store: five pairs of byte-identical transcripts, each pair a repository and a worktree
cut from it that never diverged after the branch was cut — exactly the "one conversation, two
files" shape `sweep` already knows about, seen here from the disk-usage side instead.

`foster stats` reads every transcript's assistant records for their own `usage` field (input,
output and cache tokens, and the model that produced them) and every place a conversation
ended on the app's own usage-limit record — `foster revive`'s own detection
(`isApiErrorMessage: true`, `error: "rate_limit"`), over the whole transcript rather than only
its last answer. The motivation is a per-model weekly limit locking an account before its
general week does — measured on a real account: 53% used on the week, 100% used on one model
— which an account-wide number alone never shows. An account here is the account a _native_
card of the conversation belongs to; a fostered copy only proves the conversation reached that
sidebar, not that its tokens were spent under it, and a conversation no card anywhere claims
natively counts as unattributed rather than guessed at. Reading a transcript a live session is
still appending to returns a snapshot, same as any other reader here — a re-run once the
session is idle sees the rest.
