---
description: After a sweep, tell every session a usage limit stopped in the last 24h that the quota is back, and to carry on by highest return.
allowed-tools: PowerShell, Bash(node:*), mcp__ccd_session_mgmt__send_message, mcp__ccd_session_mgmt__set_session_title
---

The step after `/fosteia`. The sweep brings every conversation into the account signed in
now, and the ones that were working when their old account ran out arrive exactly where they
stopped: ending on the app's own "You've hit your limit" line, waiting for a turn nobody is
going to give them. This command gives each of them that turn.

**Do not read the repository.** Everything needed is below. Do not open the README, do not
grep the source, do not build anything.

**Do not ask the user to confirm anything.** Running this command is the decision. Ask only
if a step fails in a way these instructions do not cover.

**Use PowerShell.** `foster` is on the user PATH there. If it is not, the installed bundle is
`node "$LOCALAPPDATA/foster/foster.js"`. Do not use a `dist/foster.js` from a checkout.

## 1. The work list

One command, one tool call:

```
"[retoma] $(Get-Date -Format 'dd/MM HH:mm')"; $c = foster whoami --json | ConvertFrom-Json; $e = $c.email; if (-not $e) { try { $e = (foster identify $c.accountUuid --json | ConvertFrom-Json).name } catch { } }; "[conta] $(if ($e) { $e } else { $c.accountUuid.Split('-')[0] })"; foster revive --json
```

`foster revive` lists the sessions in this account whose conversation ended on a usage limit
in the last 24 hours, read from the transcript itself — the card cannot say, because fostering
drops the card's error. It already keeps one row per conversation and one per git branch of a
repository, the most recent stop, because two agents on one branch commit over each other. It
leaves out archived rows, scheduled tasks, and anything a live `claude` is writing, and names
those in `passedOver`. Do not second-guess the list and do not add sessions to it.

If the user named a different window ("the last 3 days"), pass `--since 3d`.

If `stopped` is empty, say so in one line and stop: there is nothing to revive.

## 2. One message per row

For every entry in `stopped`, call `send_message` with `session_id` set to its `sessionId`,
and this message, with `<conta>` replaced by the `[conta]` line:

```
Cota nova: esta sessão parou no limite de uso e agora roda na conta <conta>, com cota. Retome o trabalho de onde parou e vá pelo maior ROI: primeiro o que entrega mais valor com menos esforço. Antes de seguir, confira o estado atual (git status, PR, CI): a sessão ficou parada e outras sessões podem ter mexido no mesmo repositório.
```

If the user asked for different words, or for a different priority, use theirs.

Send them all in one turn, as parallel calls. Each result says `delivered` or `queued`; both
mean it arrived. A result that says anything else is a failure for that row — report it, and
**do not send the same row again**: a message reported as undelivered to a live session can
still arrive, and a second one doubles the work. A session that is archived does not receive
messages at all, which is why the list leaves those out.

## 3. Name this conversation

With `set_session_title` on `session_id: "self"`:

```
Retoma DD/MM HH:MM - <the account's e-mail>
```

Copy both halves from the `[retoma]` and `[conta]` lines. If `set_session_title` is not among
your tools, skip this silently.

## Report

Short, in the user's language:

- how many sessions got the message, and their titles;
- any that failed, and why;
- what `passedOver` held, by reason: a live writer (already running — nothing to do), or a
  second row of the same conversation or branch (the fresher row got the message instead);
- that these sessions now run at the same time on this account's quota — many at once, most
  of them in one repository, spend it quickly.

## Never, in this command

- **Never resume a session headless** (`claude -p --resume`, `foster resume`): it runs the
  turn but never reattaches the card, so the row keeps showing the stop.
- **Never unarchive a row to message it.** Archived means put away on purpose.
- **Never stop, archive or retitle** any of these sessions. This command only delivers the
  message.
