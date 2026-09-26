# Accounts, clients and switching

## What about switching accounts?

Nothing on your disk can switch **the app's** account — not `foster`, not anything else. This is
worth stating precisely, because it is the first thing people try, and because the answer for the
CLI is now the opposite one: a config directory's account is a file, `foster` moves it, and
[Switching a client's account](#switching-a-clients-account) is that section. The two answers differ
because the two programs keep the account in different places, and the rest of this section is why.

Inside one installation the account is not stored anywhere. The app keeps it in memory only —
deliberately non-persistent, and cleared whenever its web view navigates — and just three things ever
set it: an IPC call the app's own signed-in page makes, the app noticing that page navigate to
`/logout`, and a backfill that asks the server who you are using the cookies you already have. The
`lastKnownAccountUuid` in the config is a leftover of that answer, not the source of it: nothing reads
it to decide who you are signed in as. (It is not entirely dead — it feeds a check against reusing a
token across identities — but it selects nothing, and `foster` reads it only as a hint about which
directory the sidebar is on.) So there is no file to edit and no flag to pass. Deep links,
command-line arguments, environment variables, config files and group policy were each checked, and
none of them selects an account.

**A second profile does give you a second account, with one manual step.** Both
`CLAUDE_USER_DATA_DIR` and the `--user-data-dir` switch relocate `userData` outright: the profile
starts, populates its own store, takes its own instance lock, and runs beside the default
installation without disturbing it.

Signing in is where it gets awkward, and it is worth understanding why rather than giving up at the
symptom. Claude Desktop ships as an MSIX package, and Windows resolves the `claude://` protocol
through **package activation**, not the classic per-user registry key you might expect to find and
edit — that key still exists, but it is MSIX registry virtualization's private copy, visible only
from inside the app's own container, and a browser running outside the container never sees it. So
the browser's OAuth callback always lands on package activation, which starts an instance on
whichever `userData` the packaged registration currently names — normally the default installation.
The profile never receives its own callback and sits on the sign-in screen forever.

**Measured on 05/09/2026 (Claude Desktop 1.46388.2, foster 0.40.0): two Claude Desktop windows
signed into two accounts, the second through the ordinary Google flow.** Three facts made it work:

- What actually decides the destination is a **packaged ProgID** —
  `HKCU\Software\Classes\AppX<hash>`, the key Windows creates when it registers the package for
  `claude://` — not the classic `…\claude\shell\open\command` key. Its `Shell\open` subkey carries
  `AppUserModelID` (which package this is) and `Parameters`, the argument string appended to the
  package's own executable the moment a link is activated — normally just `"%1"`.
- `Parameters` is the user's own registry value (`FullControl`, no elevation needed), so pointing it
  at `--user-data-dir=<profile> "%1"` for the length of one sign-in routes the very next callback to
  that profile. This is the one registry **value** `foster` ever writes — never a key, never a
  level — restored verbatim once the sign-in lands, times out, or is cancelled.
- The callback process only _finds_ the profile it is meant to forward to when that profile's own
  instance was itself started **with package identity** (`Invoke-CommandInDesktopPackage`, not a
  bare `Claude.exe` child process). A profile started by running the executable directly never sees
  the callback at all and ends up a second, broken instance on the same `userData`. `foster app
start` and `foster app login` both start a profile this way now, falling back to a direct launch
  only when the cmdlet is missing or fails.

```bash
foster --store work app login --yes
```

**Arm first, then sign in.** `app login` only prints the instruction to click "Continue with
Google" once the handler is actually routed — not a moment before — because Edge and some Chrome
profiles hold a standing permission to auto-launch `claude://` from claude.ai with no dialog in
between, so the routing has to already be in place before the sign-in can possibly fire the
callback. If the browser opens Claude by itself the instant you start the Google flow, that is
expected: the link is routed. Success is detected without reading the callback at all — the
profile's own token cache appears, or its account changes, either of which ends the wait early and
restores `Parameters` on the spot; `--timeout <seconds>` caps the wait instead of leaving it open
until Ctrl+C. If the profile is running without package identity, `app login` refuses rather than
arming a handler whose callback cannot land — `--restart-profile` closes it and starts it again the
right way in one step. There is one hazard worth knowing regardless: if any Claude window restarts
while the login is armed (an app update or repair), the packaged registration gets rewritten out
from under it, and `app login` says so rather than overwriting what the app just wrote. A login left
routed by a crash, or by Ctrl+C reaching something other than this process, is what
`foster app login --restore --yes` and the warning in `foster doctor` are for.

For the cases `app login` cannot change the routing for — an installed app that already owns the
handler, or a machine where the registry value cannot be touched — manual delivery and the e-mail
code are the fallbacks. Manual delivery works off what the packaged registration actually is:

```
HKCU\Software\Classes\AppX<hash>\Shell\open
  AppUserModelID = Claude_<publisher>!Claude
  Parameters     = "%1"
```

Just an argument string appended to the package's own executable at activation — no broker beyond
that. And a second invocation carrying the same `--user-data-dir` finds that profile's
single-instance lock and forwards its argv to the instance holding it (again, only when that
instance was itself started with package identity). So the callback can simply be delivered by hand:

```powershell
& "…\app\Claude.exe" --user-data-dir="<profile>" "claude://<the callback URL>"
```

The profile started the login, so it is the instance holding the pending state; the URL only ever
needed to reach it. Capture the URL from the browser's network tab (or a fallback link on the page),
cancel the browser's "Open Claude?" prompt so the default instance never sees it, and run that. The
authorization code is single-use and short-lived, so do it promptly.

`foster` does that part for you, without needing the executable's path:

```bash
foster --store "D:\Claude-Work" app link "claude://<the callback URL>"
```

It refuses anything that is not a `claude://` link, and never prints or records the URL — the same
rule `app login` follows: a single-use sign-in code has no business in foster's own output.

This has been demonstrated both ways — the browser flow above, and hand-delivering the callback URL
— with two accounts signed in simultaneously in the same Windows session, each in its own instance,
the default installation untouched. An account whose organization requires SSO will still refuse —
that is the account's policy, not this mechanism.

`foster` works in either profile. It looks at `CLAUDE_USER_DATA_DIR` first when that is set;
for a profile started with the `--user-data-dir` switch instead, `foster doctor` lists the
directories of every running instance so you know what to pass to `--store` — or give it a name
once with `foster profile new|register` so you never have to retype the path (see `foster stores`
under [Usage](usage.md#usage)).

It can also start one. `foster --store <profile> app start` prefers
`Invoke-CommandInDesktopPackage` when the executable found is a real MSIX install — see the package
identity fact above — falling back to running the executable directly, and says which one it used;
`app restart` works there too:

```bash
foster --store "D:\Claude-Work" app restart --terminate
```

A profile that comes back from a restart can come up with its window hidden (signed in, but nothing
visible — the "closed to tray" state carried across the relaunch); `app start` and `app login` both
give it a few seconds to appear and, if it has not, send one more launch to raise it, and say so.

Everything that inspects or closes an app is scoped to the store you name. The installed app is the
one whose main process carries no switch; a profile is matched by its own path. And `foster` refuses
to close the app it is running inside — which, with two instances up, means the one holding the Code
session that started it, not both of them.

If you are simply moving between accounts on one profile, staging still works and is the shortest
path: send copies to the other account first (`--to`, or "Send them somewhere else" in the menu),
then sign into it. They are waiting when you arrive.

### More than one client at once

The CLI has none of this awkwardness. One `claude` is one config directory — `CLAUDE_CONFIG_DIR`
when it is set, `~/.claude` otherwise — and credential, settings and conversations all live inside
it, so a second directory is a second account, and the two run side by side without ceremony. The
CLI's sign-in never rides `claude://`: the browser hands back a code you paste into the terminal,
which is exactly the transport the app's second profile is missing.

Two things the pattern does not say out loud. The browser authorizes whichever claude.ai account it
is already signed into, so the first login of a new client belongs in a private window — the only
moment it matters. And a second account multiplies usage limits only if it has a plan, or API
credits, of its own.

`foster clients` lists the directories that exist and who is signed into each:

```
* ~\.claude        You · you@example.com · Max  (default, 2 live, 348 conversations, used today)
  ~\.claude-work   not signed in  (0 conversations)
```

The identity is read from the client's own `.claude.json` — the profile the CLI cached for itself,
the same at-rest category as the session files — and the credential beside it is not read, here or
anywhere: its presence is what "signed in" means. `restore`, `purge` and `live` already search
every `~/.claude*` sibling this way, which is how a machine with two such clients gets the whole
answer rather than the default's half — but a root added with `foster client register`, below,
does not join that search: it feeds `clients` and launch only, and `--config-dir` is still how
`restore`, `purge` and `live` reach it, on purpose (see the `foster stores` section above).

Launching can stay in the shell, or go through `foster client open <client>`, which alone knows
name -> directory -> identity -> live writers -> junction target, and refuses the cases that bite
instead of opening into them. Staying in the shell is the portable option: a function that sets the
variable, hands every argument through, and puts the environment back whatever happens is all it
takes — the two halves the obvious one-liner gets wrong are the `finally` and the `@args`:

```powershell
function claude-as {
  param([string]$Client)
  if (-not $Client) { Write-Error 'usage: claude-as <client> [claude args]'; return }
  $dir = Join-Path $env:USERPROFILE ".claude-$Client"
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Write-Error "client '$Client' does not exist ($dir). If it is meant to: mkdir $dir"
    return
  }
  $prev = $env:CLAUDE_CONFIG_DIR
  try {
    $env:CLAUDE_CONFIG_DIR = $dir
    claude @args
  } finally {
    $env:CLAUDE_CONFIG_DIR = $prev
  }
}
```

`claude-as work`, `claude-as work --resume`, and a new client is `mkdir ~\.claude-<name>` — a
`~/.claude*` sibling needs no registration, `foster clients` finds it on its own. A directory
that does not live there — `~\.claude-contas\<name>`, or a whole folder of them — does:
`foster client register <path>` names one directory, `--container` names a directory that holds
one client per immediate child, and `foster client forget <path>` withdraws either without
touching anything underneath it. Both are dry runs unless you pass `--yes`, in the shape below.

```bash
foster client register ~\.claude-contas --container            # dry run
foster client register ~\.claude-contas --container --yes      # list its children in `clients`
foster client forget ~\.claude-contas --yes                     # stop listing them
```

`foster client new` makes a better one than `mkdir` does. A bare directory plus a login
authenticates, but sessions run there quietly have fewer capabilities than sessions run anywhere
else: no settings, no `CLAUDE.md`, no agents, and — the one that actually bites — no skills, with
nothing in any output saying so. So settings, instructions, agents, commands and output styles are
copied, and `skills/` is **linked** rather than copied, because skills are a warehouse and a copy
starts drifting the day either side changes.

Three things are never copied, and each exclusion is load-bearing. The credential, because one
account living in two directories is the exact state the vault rule below exists to prevent.
`projects/`, because that is the whole conversation history and a second copy of it is a second set
of transcripts for every other command here to find. And `.claude.json`, because it holds the cached
profile `foster clients` reads — copy it and a directory nobody has signed into reports somebody
else's identity.

```bash
foster client new ~\.claude-work            # dry run
foster client new ~\.claude-work --yes      # make it, signed out
```

#### One entry per client in the Windows Terminal menu

`foster clients --fragment` prints a Windows Terminal fragment (JSON) with one profile per client
this machine lists — registered roots included, a junction resolved to its target — so every client
gets its own entry in the `wt` menu without hand-editing `settings.json`. Run these two commands in
this order: the `Fragments` folder does not exist until something creates it, and PowerShell's `>`
does not create one on the way.

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster" | Out-Null
foster clients --fragment > "$env:LOCALAPPDATA\Microsoft\Windows Terminal\Fragments\foster\clients.json"
```

Three things worth knowing before you rely on it. The Terminal writes a stub of the profile into
your own `settings.json` the first time it loads the fragment, so this is not without side effects
on a file that is yours. `wt -p <name>` with a name that does not match opens the **default**
profile silently (microsoft/terminal#6086) — on a machine where `~/.claude` is the default, that is
a tab on the wrong account with no error at all, so prefer `foster client open` when being certain
matters more than a menu entry. And the fragment has to stay UTF-8: PowerShell 7's `>` writes it
that way, but Windows PowerShell 5.1's writes UTF-16 and breaks the file.

Restart Windows Terminal if the entry does not appear.

### Switching a client's account

A client's account is one file. `<configDir>/.credentials.json` is plain JSON of about 1.4 KB, every
`claude` process reads it at birth, and nothing else binds a directory to an account — so replacing
it replaces who the next process runs as, with no logout, no restart, and nothing else touched.

The obvious way to do that by hand is a logout and a login, and it is the wrong way: a logout throws
away a working credential to make room for one you then have to go and get. `foster switch` moves
them instead.

```bash
foster switch                               # who is here, and what the vault holds
foster switch alice@example.com             # dry run
foster switch alice@example.com --yes       # swap
```

The credential that was there is recorded in foster's vault; the one asked for is installed from it.
Two rules decide the shape of that vault, and both were arrived at the hard way.

**The identity of a credential is `(client, account)`, not an account.** One account signed into two
config directories has two independent token families, from two separate logins, whose refresh tokens
rotate separately — so a credential taken from one client cannot be installed into another, and
foster will not offer it. Keyed by account alone, a single `guard` on the second client would
overwrite the first's copy with a credential that does not work there.

**Nothing in the vault is ever replaced or removed.** The obvious design is positional — one live
copy per account, a swap trades one for the other — and foster implemented that first, for a real
reason: a refresh token can be rotated on every renewal, so a copy left on a shelf quietly stops
working. But positional means destructive. Every swap deletes a credential, and a deleted credential
is one that no later feature can reach and no operator can fall back on. So the vault is
**append-only**, in the same idiom as foster's ledger: one JSONL file per `(client, account)`, newest
line wins, and every version before it stays legible underneath.

> **The cost, plainly.** This keeps more credentials at rest than the minimum, for ever, and
> unencrypted — which makes the vault a more valuable target than a positional one would be. It also
> means a stale record can be installed and fail. Both are accepted deliberately: staleness is
> detectable, because every record carries when it was taken and a switch verifies before it commits,
> while deletion is not detectable at all — and nothing foster does can make a credential
> unrecoverable.

Foster never logs in. An account it has no record of is a login you do once, in that directory, after
which it can be switched to freely. Two things write to the vault, and no command that merely reads
does: **a switch** records the account it displaces, and **`foster guard`** records the account in
use. So the first account to become switchable is the one `guard` sees. A credential that has not
changed since the last look appends nothing, so `guard` is cheap to run on a timer.

A credential that has sat unused can expire on its own, so the swap is **verified against the API**,
not against the file it just wrote: a stored credential that no longer authenticates is put back, and
you are asked for a fresh login rather than told it worked. For the same reason foster **refuses to
switch at all** while it cannot verify who is signed in — an unverified answer is not good enough to
file the outgoing credential under, and filing it wrong would overwrite another account's entry. That
is also why `--offline` plans but never applies.

One thing a switch cannot fix, and says so instead: the CLI caches its own profile in `.claude.json`
and only rewrites it when it next runs, so `foster clients` keeps naming the previous account until
then. Foster will not edit the app's cache to cover for itself.

**The failure the vault is really for** is the one with no other answer: another `claude` process,
started before the switch, holds its token in memory and rewrites the credential file when it
renews — putting its account back over yours, minutes later, silently. Foster cannot prevent that; no
lock exists to take. So it does the two things it can. It names the processes that could do it, with
pids and working directories, before writing:

```
  ! 2 live session(s) in this client can rewrite the credential:
      pid 4242  D:\work\api-gateway
```

And the account that gets overwritten is already recorded, so the damage is a command to undo rather
than a login to redo. That is the whole argument for keeping history: the process that clobbers you
cannot reach what the vault has already written down.

`foster vault` lists what is held — grouped by client, newest first, with how many versions stand
behind each — read from each record's own fields rather than its filename, and without opening a
credential. `foster guard` records the account a client currently holds, for anything that wants a
fixed cadence; it is what makes an account switchable in the first place, since foster can only
install a credential it has seen.

The record shape is documented because it is the way back if foster is ever gone. Each line is a JSON
object with `surface`, `email`, `savedAt` and the credential verbatim under `credential`, so
recovering one by hand is one command in any shell:

```powershell
(Get-Content <file> | Select-Object -Last 1 | ConvertFrom-Json).credential |
  Set-Content ~\.claude\.credentials.json
```

**The other kind of switch changes it for one consumer rather than for the machine.** Give each
account its own directory, log into each once, and point a junction at whichever is active:

```bash
foster point ~\.claude-live --to ~\.claude-accounts\alice --yes
```

Anything running with `CLAUDE_CONFIG_DIR` set to the link follows the flip; your own terminals carry
on wherever they were. No credential moves and nothing is logged out. One property is worth knowing
because it is counter-intuitive: the path is resolved on **every** file open, so a process that
started before the flip writes through it after. A link does not isolate a running process from a
switch — only a directory that the process's own environment names does that.
