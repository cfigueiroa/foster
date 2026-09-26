# After a sweep or a crash: revive and rescue

## After a sweep: sessions a usage limit stopped

A sweep moves every conversation into the account signed in now, and the ones that were working
when their old account ran out arrive exactly where they stopped — ending on the app's own
"You've hit your limit" line, waiting for a turn nobody is going to give them. The card cannot
tell you which ones they are: fostering drops the card's error so a copy does not show a stale
warning. The transcript can. A conversation cut off by a limit ends on a record the app writes
in the model's place, `isApiErrorMessage: true` with `error: "rate_limit"`, and `foster revive`
lists the sessions whose conversation ends that way:

```bash
foster revive                 # stopped on a limit, or cut off mid-turn, in the last 24 hours
foster revive --since 3d      # a longer window; sessions you archived need --archived
foster revive --json          # the work list the /retoma skill reads
```

It reads the file each card actually opens, keeps one row per conversation and one per git
branch of a repository — the most recent stop, since two agents on one branch would commit over
each other — and names what it left out: a session a live `claude` is writing, a second row
of work already on the list, or a row whose folder is gone (the app refuses a message to it).
A session a restart cut off mid-turn — its transcript ends on a tool result or a prompt nothing
answered — is listed too, as `why: "cut-off"` beside `why: "limit"`.

Nothing here sends the message that revives them. Only Claude Desktop can deliver a turn to a
session and keep its card attached; a headless `claude --resume` runs the turn and leaves the
row showing the stop. The `/retoma` skill in this repository is the other half: run inside the
app, it reads `foster revive --json` and tells each session that the quota is back and to carry
on, highest return first.

## After a crash: cards that cannot reach the computer

A session card with a remote-control mirror is a live link — the app shows the conversation
through the process hosting it. When that process dies without closing (a crash, a reboot),
the server keeps the mirror and the card can only say it cannot reach your computer. Nothing
client-side reattaches the old mirror: the device key, bridge URL and authentication all
survive a crash unchanged, and the card stays unreachable anyway, because the link is
per-session, not per-device.

What works is resuming the conversation — the transcript on disk is complete, and the first
turn of a resume mints a fresh mirror. `foster rescue` finds the conversations in that state:
cards that had a mirror, were active inside the window, and have no live writer now. Each row
names the directory the resume must run in, read from the transcript's own tail rather than
from the card — a session that moved between worktrees is filed under the directory it moved
to, and the card still names the one it started in. A directory that has since been removed
(worktrees usually are, once their session is archived) is said out loud instead of failing
inside a closing terminal tab.

```bash
foster rescue                 # the list, with a resume command per conversation
foster rescue --since 7d      # a longer window; sessions you archived need --archived
foster rescue --open          # one Windows Terminal tab per conversation, resume running
```

Each tab stops at the CLI's own resume prompt, so nothing is consumed until a human picks
summary or full there; `/desktop` inside a resumed session hands it back to the app. The old
unreachable card never reconnects — archive it. The empty mirror cards named after the device
("no messages yet") are the same husk seen from the other side: they hold nothing and are
archived, not rescued.

Two things that look like shortcuts, measured against a live store:

- **Headless resume does not reconnect the card.** `foster resume` (and `claude -p --resume`
  generally) appends a real turn to the transcript, but print mode never attaches to the app,
  so the card stays unreachable and the tokens are spent anyway. Use it to _talk_ to a
  conversation, not to rescue one.
- **The app can rescue its own cards, one paid turn each.** A Claude session running inside
  Claude Desktop has session tools this CLI does not: asking it to deliver a message to a
  stranded card makes the app itself host the conversation, which re-links the card with no
  terminal tab and no human at a resume prompt. `foster rescue --json` gives such a session
  the work list. Two conditions, both measured: the app refuses a card whose directory no
  longer exists (recreate the worktree first — `git worktree add --detach <path>`), and
  delivery runs a full turn in the target conversation, so say in the message that nothing
  should be resumed or acted on.

A rescued conversation leaves a second card behind: the app's fresh hosting card, which has
no mirror history. `rescue` reads that card as the app's own proof of reachability and keeps
the conversation off the list — the husk alone would put it right back on every run once its
host went idle and exited.
