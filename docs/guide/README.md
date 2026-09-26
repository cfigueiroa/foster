# The foster guide

The long form behind the [README](../../README.md): why each command works the way it does, with the
measurements that decided it. Every section here used to live in the README itself; it moved here
verbatim when the README was redesigned.

1. [How foster works](how-it-works.md) — why sessions disappear, what a copy is, and why a copy is
   not marked in its own title.
2. [The sweep, forks and worktree claims](sweep-and-forks.md) — `foster sweep` pass by pass.
3. [Deleted conversations](deleted-conversations.md) — `restore`, and `purge`, the one command that
   destroys data.
4. [After a sweep or a crash](revive-and-rescue.md) — `revive` and `rescue`.
5. [Reports](reports.md) — `disk` and `stats`.
6. [Cloud sessions](cloud-sessions.md) — `cloud list` and `cloud pull`.
7. [One conversation, two files](two-file-conversations.md) — forks, second files,
   `consolidate`, `where` and `sweep --prove`.
8. [Restarting the app, and `--detach`](restart-and-detach.md) — why a restart is needed, and how
   to do one from inside the app.
9. [Pins, groups, routines and the filter menu](layout-pins-groups-settings.md) — `pin`, `layout`,
   `verify` and `view`.
10. [Accounts, clients and switching](accounts-and-clients.md) — what can and cannot switch
    accounts, several clients at once, and `switch`.
11. [Install and usage (long form)](usage.md) — the menu, the one-shot commands, naming accounts,
    scheduled tasks.
12. [The foster agent](agent.md) — `foster agent`, and the app's own session tools.
13. [Safety model](safety-model.md) — what foster writes, where, and what it never does.
14. [Development and releasing](development.md) — tests, CI, the coverage floor, releases.

Notes for an agent working in this repository or driving foster: [AGENTS.md](../../AGENTS.md).
