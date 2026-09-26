# Deleted conversations: restore and purge

## Undoing a deletion

Deleting a session in the app removes the pointer and **keeps the conversation**. The transcript
stays under `~/.claude/projects`, and the app records the deletion by writing a `deleted_<id>` marker
next to the sessions — one per identifier the session carried, each holding only the time.

Those markers exist to stop the app's own recovery scan from offering back something you threw away
on purpose. They stop the _scan_ only: a `claude://resume` link imports a tombstoned conversation
without complaint, and nothing stops a session file that points at one from being written and
loaded. So for an accidental deletion, writing a fresh pointer is the route left, and it is the one
`foster restore` takes:

```bash
foster restore          # what could come back, writing nothing
foster restore --yes    # bring them back
```

Title, working directory and dates are read out of the transcript itself, so the restored session
arrives named and dated rather than blank — and it sorts into its real place in Recents instead of
jumping to the top with today's date. Recovering the working directory does more than label it: the
session opens with its repository and branch bound again, reading the diff and offering to open a
pull request. It comes back resumable, not merely readable.

What cannot come back is what was never in the conversation: the model it ran, its permission mode,
and any MCP configuration. The marker is left exactly where it is — it is the app's record, not
`foster`'s to erase — and the restored session is an ordinary copy, so `foster return` undoes it
like any other.

A conversation that some session still points at is not offered: it is not lost, and restoring it
would only produce a duplicate.

## Deleting for real

`restore` is also the uncomfortable proof of something: deleting a session in the app does not
delete the conversation. Everything that was said is still in a file, and a tool that can list those
files and put them back in your sidebar is a tool that just demonstrated they were never gone.
Sometimes gone is what you actually wanted.

```bash
foster purge                        # what could be destroyed, writing nothing
foster purge --yes --confirm 19     # destroy it
```

This deletes the transcripts themselves — every copy of them — and nothing else in foster can bring
them back. There is no backup, deliberately: a command whose purpose is to make something
unrecoverable cannot quietly keep a copy and still be that command.

Two gates stand in front of it, and they are not the usual ones.

**It only ever considers conversations the app has already deleted.** The candidates are exactly
what `restore` would offer: a deletion marker exists, the transcript is still on disk, and no
session file anywhere points at it. That last check is asked of **every installation foster knows
about**, not just the one in use — a card in a profile you are not signed into is still a card, and
the session it opens is one restart away. `--this-store-only` narrows it, and is a worse question to
ask. A conversation a live `claude` process is holding open is skipped as well, and said so out
loud.

**`--yes` is not enough on its own.** Every other writing command in foster is undone by the command
next to it, so one flag is a fair price; here the same flag would put "destroy every conversation I
ever threw away" one word away from "copy them into my sidebar". So `purge` also wants
`--confirm <count>` — the number the dry run printed. A count is the one confirmation that can fail
for a reason other than intent: it cannot be pasted from documentation or typed from memory, and if
the set moved between reading and running — something else deleted in the app in the meantime, a
filter that matches more than it did — the number no longer agrees and nothing happens.

Narrow it with `--title` or `--session <id...>`, and `--json` lists the candidates with their sizes
without destroying anything.

What it leaves behind is the app's own deletion marker, for the same reason `restore` does: that
record belongs to the app. And the ledger gets one line saying a conversation was destroyed here —
an id, a file count, a byte count, and nothing else. Not the title, not the working directory, not a
word of the text. A ledger that kept those would be the backup this command promises not to keep.

`foster agent` cannot do this. It is not one of the agent's tools, and the agent is told not to
reach for it through the shell either: an irreversible delete is not a thing to hand to a model
working from a one-line description of what you wanted.

Conversations are looked for in every Claude config directory that has them, not just the one this
process happens to be running under. Running a second Claude Code account means pointing the CLI at
its own `CLAUDE_CONFIG_DIR`, and each of those keeps a separate `projects/` tree — searching only one
would produce a shorter list that looks complete. Siblings of `~/.claude` are picked up when they
actually contain transcripts, and `--config-dir <path...>` adds any that live elsewhere.
`foster clients` is the map of those directories, and of who is signed into each.
