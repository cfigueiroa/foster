# The foster agent

## Agent

`foster agent` hands a task, in plain language, to a Claude agent that knows foster's domain and
carries foster's operations as first-class tools:

```bash
foster agent "which of my old accounts has sessions about the billing rework, and what state was that work left in?"
foster agent --yes "foster everything from my old account that touched the api-gateway repo, then clean up any duplicate copies"
foster agent --yes "bring everything here, archived and deleted included"
```

That last one used to be unanswerable: `restore` was never one of the agent's tools, so an agent
asked for the deleted ones could only tell you to run a command yourself. The sweep is a tool, so
it is one call.

It works the way Claude Desktop itself runs Code sessions, with the roles reversed: foster is the
parent process, it spawns the agent headlessly via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), and serves it an in-process
MCP server (`foster_session_mgmt`) over the same stdio pair. That server carries ten tools —
account and session inventory, fostering status, app status, transcript reading, labelling,
fostering, [sweeping](sweep-and-forks.md#the-whole-sweep), returning, and a headless resume — and alongside it the
agent has Claude Code's full toolset: shell, files, web. The foster tools remain the required path for anything touching the
session store, because they are what goes through the engine's gates and ledger; the general tools
are there for whatever else the task turns out to need.

**One switch governs all writing, and it is the same one the CLI has: `--yes`.** Without it the run
is read-only end to end — foster mutations are dry runs, and built-in tools that write or execute
(shell, edits, web fetches) are denied by the permission layer, since a headless run has no
terminal to ask in. The model asking nicely does not count: a gated attempt comes back marked
"writes are disabled" so it reports that instead of retrying. With `--yes`, foster mutations apply
and the general tools run unrestricted (the SDK's bypass-permissions mode) — give it the flag only
with a task you would be comfortable typing into Claude Code itself. Two gates hold even then:
removing copies still refuses while Claude Desktop may hold them in memory, with the same message
the CLI prints, and the headless resume (`claude -p --resume` against a conversation's transcript)
is refused when a live `claude` process is holding that conversation open — two writers on one
transcript is how transcripts get corrupted.

One honesty note: foster reads the credential in exactly one command (`foster usage` — see the safety
model), and nowhere else, including here; the agent is not handed the token or the reader. But an
agent with general read tools is as able to open files on your machine as any Claude Code session is.
`foster agent` is Claude Code with extra knowledge, not a sandbox.

The Agent SDK is not part of foster's single-file release — it is megabytes of runtime with a
per-platform binary. Install it once with:

```bash
foster agent --setup
```

which runs a normal npm install into `~/.foster/agent`, where foster finds it from then on. The
model itself runs through your existing Claude Code sign-in (or `ANTHROPIC_API_KEY`).

**The default model is Haiku** — the tools do the heavy lifting and most agent tasks here are
orchestration, so the cheap tier ($1/$5 per million tokens, roughly a fifth of Opus) is the right
default. Pass `--model sonnet` or `--model opus` when the task needs more judgment — cross-reading
many transcripts, deciding what is worth fostering — and `--max-turns` bounds the run (default 50).
And before reaching for the agent at all: if the task is a known, mechanical one, the deterministic
commands above do it for free.

### Related surface: the app's own session tools

The arrangement `foster agent` reverses is worth knowing in its own right: Claude Desktop injects
an MCP server of its own, `ccd_session_mgmt`, into every Code and Cowork session it opens (observed
August 2026 — the surface is undocumented, so treat the details as a snapshot, not a contract). Its
tools are the running app's view of the current account: list the other sessions, read their
transcripts, search them full-text — archived ones included — retitle or archive them, even send a
message into one. From inside a Desktop session, "which of my sessions talked about X" is answered
natively, with no foster involved.

Its limits are exactly the boundary between the two. It sees one account, only while the app is
running, and it never touches the store on disk — anything cross-account, anything against a closed
app, and any write that should carry a ledger entry stays foster's job. `foster agent` never meets
this server either: it runs headless through the Agent SDK, outside the app, so nothing here is a
capability the agent gains.

They do compose, though, in one direction: fostering feeds it. A copy, once the app has loaded it,
is one of the account's sessions like any other, and it opens the original's full transcript — so a
conversation lived under another account becomes something these tools can list, read and search
natively. foster adds no API to the app; it widens what the app's own API can know.
