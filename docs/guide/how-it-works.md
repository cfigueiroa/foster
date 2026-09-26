# How foster works

Bring your **Claude Code sessions from a previous local account** back into the sidebar of the
account you are signed into now — **without moving or modifying the originals**.

If you switched Claude Desktop accounts and your old sessions vanished from the sidebar, they are
almost certainly still on your disk. `foster` finds them and exposes them under your current account,
reversibly.

> **Status:** early. Windows-only for now (that is where Claude Desktop ships as an MSIX package).
> Read [Safety model](safety-model.md#safety-model) before running anything that writes.

## Why the sessions disappear

Claude Desktop stores each Code session as a small JSON file, in a directory tree keyed by account
and organization:

```
<userData>/claude-code-sessions/<accountUuid>/<organizationUuid>/local_<sessionId>.json
```

There is **no account field inside the session file**. The only thing binding a session to an account
is _the folder it sits in_, and which folder that is comes from the account you are signed into.
(The `lastKnownAccountUuid` in the app's config is a cached copy of that answer, not the source of
it — which is why no local edit can switch accounts.)

So when you sign in with a different account, the app reads a different folder — and everything you
did under the old account becomes invisible, while remaining perfectly intact on disk.

The conversation transcript is not in that JSON at all. It lives outside the account tree, under
`~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl`, and is **account-agnostic**. That is why a
session can be re-attributed locally: only a pointer has to move, not the content.

## What `foster` does

For each session you select, it writes a **copy** of the session JSON into your current account's
folder, with:

- a **fresh `sessionId`**, so the copy is a distinct object the server has never seen (deleting it
  can never reach the original);
- the **same `cliSessionId`**, so it opens the real transcript;
- `error` / `errorAt` **stripped**, so a stale failure from the old account does not show up as a
  warning badge on the restored session;
- an optional **title prefix** (`--prefix`), off by default — see below for why a copy is no
  longer marked in its own title;
- a `_foster` key recording where it came from.

That last one is a hint, not a record. The app rebuilds a session from a fixed list of fields when
it saves one, so the first time it writes a copy back — a rename, a focus, any activity at all —
`_foster` is dropped and the copy becomes indistinguishable on disk from a session the app made
itself. Measured on a live store: of 364 copies, 21 had lost it, and they were exactly the 21 that
had been opened. What is authoritative is foster's own ledger, which the app cannot reach; the
marker earns its place by covering the one case the ledger cannot, a crash between writing the copy
and recording it.

The original file is never touched. `foster return` deletes the copy and the session is simply gone
from the current account again.

### Why a copy is not marked in its own title

Copies used to be titled `↪ <original>`. The prefix still exists as `--prefix`, but it is off by
default, for two reasons that only showed up at scale.

It stopped separating anything. On a swept store, 704 of the 764 rows in the account in use were
copies — the marker was on 92% of the sidebar, and the 60 native rows, the ones worth picking out,
were the unmarked ones. A mark that nearly everything carries is not a mark.

And it was never reliable, for the same reason `_foster` is not: the title belongs to the app. A
copy the app renames loses the prefix, and a session the app forks from a copy inherits one while
being no copy at all. On that same store the titles disagreed with the ledger in five places, in
both directions, with nobody having edited anything by hand.

Nothing ever decided anything by it — `return` selects from the ledger, and `--title` filters on
`originalTitle`, which never carried a prefix. So the marker was a display choice competing with a
display that cannot be wrong: foster's own list, which draws its arrow from the ledger.
