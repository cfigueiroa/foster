# Safety model

## Safety model

- **Reads and writes are separated.** The scanner never writes. All mutation goes through a single
  engine module, and every completed operation is appended to a ledger (`~/.foster/ledger.jsonl`) so
  it can be replayed in reverse. The write comes first and only a finished write is recorded: a
  ledger entry for a write that failed would mark the session as fostered for ever, with no file to
  show for it.
- **The originals are never modified.** Fostering only ever _adds_ a file to the current account's
  folder. There is no move, and no rewrite of anything under the old account.
- **Naming a profile or a client root is a write; opening one is not.** The ledger's four newest
  event kinds — `profile_registered`, `profile_forgotten`, `client_root_registered`,
  `client_root_forgotten` — are append-only records of what foster calls something, never of an
  account or a credential; folding them (`LedgerState.profiles`, `LedgerState.clientRoots`) is
  what lets `--store <name>` and `foster clients` still find a root days after the command that
  named it. `profile new`, `profile register`, `profile forget`, `client register` and
  `client forget` all follow `client new`'s shape: blockers first, a dry run by default, `--yes`
  to apply, the ledger entry only after a finished write. Starting an instance, opening a terminal,
  or handing it a link is not a write at all — `app start`, `app restart`, `app link` and
  `client open` never touch the ledger, because launching a profile or a client that already exists
  changes nothing foster remembers about it.
- **One system setting is ever touched, and only for the length of one sign-in.** The `Parameters`
  value under the packaged ProgID's `Shell\open` key (`HKCU\Software\Classes\AppX<hash>\Shell\open`)
  is the only registry value, or setting of any kind outside `~/.foster`, that `foster` ever writes —
  never a key, never a level: the key always already exists, because it is the app's own
  registration. What the run is about to overwrite is recorded in the ledger, verbatim, before it
  happens, then undone once the sign-in lands or the wait gives up — the real previous value is
  written back exactly as read. `app login --restore` and the warning `foster doctor` prints when
  `Parameters` is still routed cover the run that does not get to undo it itself. It also refuses to
  run at all from inside Claude Desktop's own container, where the registry it would read and write
  is MSIX's private, virtualized copy — a change there could never reach the browser in the first
  place.
- **One command destroys data, and it is the only one.** `purge` deletes conversations the app has
  already deleted the cards for, and nothing brings them back — no backup, no ledger copy, no undo.
  It is fenced off accordingly: candidates are limited to transcripts nothing on disk points at,
  `--yes` alone will not run it, and the agent is not allowed near it. Every other command in
  foster adds a file, removes one foster itself wrote, or — in the case of `switch` — replaces one
  whose previous contents it put in the vault first, in that order, so that the step after the
  crash is always a command rather than a login.
- **Adding is safe while the app runs; removing is the case that is not.** Every copy carries a
  session id the app has never seen, so a running app neither reads that file (it is past its one
  read) nor writes it (it only writes sessions it holds) — it is simply invisible until the app
  starts again. A copy the app _did_ load is different: it may be written back at any time, which
  would recreate a file `foster` had just deleted. So `return` refuses for copies that already
  existed when the app started, and offers to close it for you.
- **It will not put the same conversation in a sidebar twice.** An account can already have its own
  card for the conversation being fostered — made when that work was resumed while signed into it —
  and the fostering key cannot see that, because the origin is the _other_ account's card and has
  never been fostered before. The result was two live rows for one conversation, differing only in
  which account watched which part of it. Fostering now refuses, naming what is already there
  (including when it is archived, where the answer is to unarchive rather than duplicate), and
  `--session` still overrides. For pairs already on disk, `status` counts them and
  `foster return --duplicates` removes the copies. Note that a `↪ ` in a title no longer proves a row
  is foster's: the app carries the title over when it makes a card of its own from one.
- **Nor the same conversation under two identifiers.** The check above compares `cliSessionId`, which
  is the one field a branch changes — so for a while the pair it existed to prevent was arriving
  through the branch. One conversation is forked (see below), each half ends up in a different
  account, and fostering both puts two identical-looking rows in one sidebar with nothing to tell
  them apart. What a branch cannot change is the conversation it was forked from: the two transcripts
  share every record up to the moment they parted, so the first `uuid` in the file identifies the
  work rather than the file. Fostering compares that too, and refuses with `already has a branch`
  rather than pretending it is the same conversation — because it is not, quite. Each side holds
  turns the other never got, so read both before choosing; `--session` overrides, and for pairs
  already on disk `status` counts them and `foster return --branches` removes them.

  Refusing it is right for `foster foster`, and refusing it silently was not, because the account
  keeps whichever half reached it first. When the half being turned away is the one that carried
  on, the command weighs the two and says so — how many records each holds that the other does not
  — and names `foster consolidate`. The other direction gets no such line: skipping the half that
  stopped is simply correct, and a note under every refusal would bury the handful that matter.
  `foster sweep` does not refuse at all: it brings every branch as its own row, the branch that
  carried on under its title and the rest marked stale, so the account never keeps the wrong half
  by accident.

  Removal keeps one row per piece of work, always: a card foster did not write if there is one,
  otherwise the half that carried on after the fork — measured by the records it holds that no
  sibling holds, not by which file was written last, which the app moves whenever a card is opened.
  Reporting every row of a group is true of each and ruinous together, and would have taken the work
  out of the sidebar entirely.

- **One card may be rewritten, and only in one field.** `foster consolidate` moves a card onto the
  half of a fork that carried on, which is the single place foster writes to a file it did not
  create. It changes the pointer and the date and carries every other key through untouched; it
  refuses outright while an app holding the card is running, because a card in memory is written back
  from memory; it records where the card was, so `--undo` restores it without reading anything but
  the ledger; and it leaves a second card the _app_ made for the same work alone, reported rather
  than removed. It also refuses to collapse a fork whose halves are both substantial — see
  [When one conversation becomes two](two-file-conversations.md#when-one-conversation-becomes-two).

- **A copy is the same conversation, which is the point and the one hazard.** The copy carries the
  original's `cliSessionId`, so both rows open one transcript: work done under the other account is
  there when you open the original, and returning the copy loses none of it. What does not travel is
  the row itself — the app only writes the sessions of the account it is holding, so the original
  keeps the title and date it had when it was fostered until you open it. `status` marks a
  conversation that carried on, and `return` says so rather than letting an old date read as lost
  work. The hazard is only this: **a conversation can be continued in one place at a time**, and a
  second card opened while something else is writing it makes the app branch instead — a new
  transcript, a new id, and that card moved onto the branch. It takes two installations for two
  sidebars to be live at once, and `foster` warns about that. But it takes only a **running Code
  session** for a conversation to have a writer, and that needs no second installation at all: foster
  a session you are working in, switch account, open the copy, and the copy becomes a snapshot that
  stops at the moment you opened it while your work carries on where you left it. `foster` warns when
  a copy it is making has a live writer, before and after writing, in the command and in the menu —
  and names it, with the pid and the directory it was started in, because "finish there first" is not
  advice anyone can act on without knowing where _there_ is. A pid on its own would not carry that
  claim: Windows hands them back out, so a registry file left behind by a crash can name an unrelated
  process. The record keeps the creation time of the process that wrote it, and that is what foster
  checks, so the warning is about a writer that is actually there. When finishing is not possible,
  `foster live --stop <id>` ends the writer. That is a kill and says so: the CLI has no window to
  close politely, so whatever the session had not yet written is lost, while everything already in
  the transcript stays. It refuses the session foster is itself running in, for the same reason it
  refuses to close the app it is running inside.

  When it does happen, nothing is lost — both transcripts are on disk — and foster notices. A copy
  the app has repointed at another conversation is recognised rather than counted as still standing,
  and what happens next depends on **what it now holds**:

  - **A branch of the very work it was fostered for.** The card is still one row, still showing that
    work, and further along than the original — so foster follows it. The fostering goes on tracking
    the same file, with its pointer moved onto the branch, and the sweep says
    `the app branched it and the copy here follows the branch`. This is a fix, and the bug it fixes
    was foster's worst: the fostering used to be dropped, the next sweep found the origin session
    untracked, and it wrote a **second** copy of the half the card had just moved off. One
    conversation, two rows in one sidebar, created by the run that was meant to tidy up. Measured on
    a real store, every one of the six copies the app had branched came back as a duplicate row. The
    record of the move is deliberately not the one `consolidate --undo` reads: the app moved that
    card, not foster, and offering to put it back would promise something foster cannot honour — and
    where foster _had_ moved that card earlier, the app overtaking it ends the undo claim rather than
    leaving a stale one for `--undo` to act on.

    Tracking it again does not make it ordinary. A sweep-wide `foster return` skips it, because the
    conversation on that card was born from opening that row and usually has no other card anywhere:
    removing it would take the work out of every sidebar, and `restore` could not offer it back,
    since a file foster unlinks leaves no deletion marker for that scan to find. Naming it with
    `--session` still reaches it — the same line foster draws around a copy you deleted in the app.

  - **Anything else.** Then the copy really is gone as a copy — it is a working card for unrelated
    work — and the conversation it was made for can be fostered again instead of being refused as
    "already fostered" forever. The card itself is left exactly where it is: the app made it what it
    is now, and removing it would delete something you can see.

- **It never ends the app behind your back.** Where a polite close would work (tray off) it uses one;
  where it would not, it says so and waits for an explicit yes rather than quietly escalating, and it
  names what that costs. `foster` refuses outright to close an app it is running inside — detected
  both from the process tree and from the environment the app stamps on the sessions it spawns,
  because an exited intermediate can break the first signal and the failure mode is killing the
  caller mid-write.
- **It handles credentials in named places, for named reasons, and never mints one.** For most of
  its life foster refused to touch an OAuth token at all, and everything else in this file grew up
  under that rule. The rule has been widened twice — first to read one, then to move one — and both
  times deliberately, so it is worth being exact about what changed and what did not.

  **The two credentials are not the same file, and the difference decides everything.** The Desktop
  app's token is a sealed blob in its config; foster reads it and could not usefully write it,
  because the app holds its account in memory and re-seals on its own schedule. The CLI's token is
  plain JSON at `<configDir>/.credentials.json`; every `claude` reads it at birth, which is what
  makes replacing it a switch and what makes it worth handling at all.

  **What reads the app's:** one command, `foster usage` (and the matching "Usage right now" in the
  menu). Nothing else does — not `foster`, `return`, `restore`, `purge`, `scan`, `status`, `whoami`,
  `accounts`, `guard`, or the agent. `guard` copies the CLI's own credential (see "What copies the
  CLI's" below); it never touches the app's sealed token. The reader lives in one file,
  `store/credential.ts`.

  `foster stores` and `foster doctor` come closer than any of those and still stop short on
  purpose: `signedIn` in `--json` (and "gone"/"not signed in" in the text) says only whether a
  config carries a cached OAuth token entry at all — checked directly against the parsed JSON's
  own keys, the value itself never assigned anywhere — which is presence, not proof, and a
  different question from what the token is worth. Listing installations never doubles as reading
  one of them.

  **What copies the CLI's:** `switch`, `guard`, and `client open --guard`, which runs the same
  read-then-remember pair `guard` does before opening the tab. All of them go through
  `store/cliCredential.ts` and `engine/vault.ts`, and what they do is _copy bytes_: foster never
  mints a credential, never refreshes one, never removes one, and never signs anyone in. OAuth is
  interactive and stays yours.
  The bytes are copied verbatim rather than re-serialised, because a field this version does not know
  about is a field a rewrite would drop — and a dropped field in a credential produces a file that
  parses, looks right and does not authenticate.

  **Where the copies rest:** `~/.foster/vault`, under your own profile, one append-only JSONL file
  per `(client, account)`, each record naming whose it is so the vault can be listed without opening
  anything. It is not encrypted, and that is a choice rather than an omission: the file it copies is
  sitting unencrypted in the config directory already, so encrypting the copy would protect the shelf
  and not the shop, while adding a key foster would then have to keep somewhere.

  **The honest shape of the risk**, since it grew: the vault keeps every credential it has ever seen
  rather than the minimum, which is a deliberate trade of a larger at-rest footprint for the property
  that nothing foster does can make a credential unrecoverable. That makes it worth more to an
  attacker who already has your user account than a positional vault would be — and worth exactly
  nothing to one who does not, since it never leaves your machine, is never written to the
  repository, never logged, never printed, and never put on a command line. `foster vault` warns when
  `FOSTER_HOME` has moved it outside your profile. The credential object refuses to serialise itself
  through either of Node's two paths, so a future `--json` or stray `console.log` cannot leak one by
  accident. The ledger records that a switch happened, between which addresses, and how old the
  installed credential was; it never records a token, a refresh token, or their shape.

  **The agent is fenced off from all of it**, on the same footing as `purge`: `switch`, `point`,
  `client new` and `vault` are not among its tools and it is told not to reach for them through the
  shell. Changing who you are signed in as is not a step on the way to something else, and a
  credential is not a file for a model to move. The same fence covers naming an installation and
  opening one: `profile new|register|forget`, `client register|forget`, `profile open` and
  `client open` start interactive programs or change what foster remembers about accounts, so
  none of them is a tool either — the system prompt names all four families and tells the model to
  say which account needs an app or a terminal open and let the user do it, rather than reach for
  the shell. The read-only half — `clients`, `accounts`, `usage`, `renewals`, `identify` — answers
  "which account has quota" without any of it.

  **What it does with it:** decrypts the token in memory, sends it as a bearer credential on two
  read-only `GET`s to `api.anthropic.com` — `/api/oauth/profile` and `/api/oauth/usage` — and drops
  it. The token is never written to disk, never logged, never put on a command line, and never sent
  to any host but `api.anthropic.com`. What it buys is the only data no cached file holds: your live
  5-hour and weekly limits, and a profile that is current rather than whatever the app last persisted.
  `identify` asks the same `/api/oauth/profile` for a different reason — to put a name on an account
  foster has never seen signed in. It works by presenting a credential that account itself left
  behind, in a CLI client or in foster's own vault, and keeping the answer only when the profile's
  own `accountUuid` matches the account asked about; a token belonging to someone else is discarded,
  never recorded against the wrong account. Like the rest of this half it goes to the network only
  when you run it, never on its own.

  **What still stops it cold:** the token is not stored in the open. Claude Desktop keeps it the way
  Chromium keeps a cookie — an AES-256-GCM blob under a key sealed with Windows DPAPI in `Local
State` — so reading it needs the Windows user who sealed it, on the machine that sealed it. A
  profile copied to another machine cannot be unsealed there, and neither can foster do it off a
  backup. It is Windows-only, current-account-only, and returns nothing rather than guessing when the
  token is absent or expired. `claude.ai`'s own billing endpoints (next charge, card, cancellation)
  sit behind a browser bot-check that foster does not attempt to defeat, so those remain unreachable
  from here and only `api.anthropic.com` is used.

  None of this reaches the app's account, which stays unswitchable for the reasons in
  [What about switching accounts?](accounts-and-clients.md#what-about-switching-accounts), and it changes none of the write-path
  guarantees above.

- **A copy shares one thing with its original: the conversation.** That is the point — it is what
  makes the copy open the real thing rather than an empty session — but it means the file is not
  private to either of them. `foster` only ever reads it. The app does write to it: renaming a
  session syncs the new title into the transcript, and its own import rewrites the file in place. So
  renaming a copy is not confined to the copy. Nothing is lost by it; it is simply not the isolation
  the word "copy" suggests, and you should know which part is shared.
- **Scheduled-task sessions are treated separately.** Sessions carrying a `scheduledTaskId` are not
  listed in the sidebar's recents and are excluded from ordinary fostering.
- **One request, and only about versions.** Because the install URL pins a tag, an install would
  never learn about later releases on its own. So `foster` asks GitHub for the latest release tag,
  at most once a day, and tells you when you are behind. It sends nothing beyond the request itself,
  gives up after 2.5s, and stays silent if it fails — being offline never slows anything down.
  Set `FOSTER_NO_UPDATE_CHECK=1` to turn it off.

### What is not supported

**Cowork sessions are not supported — but not for the reason this file used to give.** Earlier
versions said the Cowork list came from the server and so could never be restored locally. That was
wrong: `local-agent-mode-sessions/<accountUuid>/<organizationUuid>/local_<id>.json` is the
authoritative store, and the app builds the list by reading those folders, exactly as it does for
Code sessions.

So the mechanism probably transfers. It is not supported because it has not been established that it
_works_, and there are specific reasons to check rather than assume: a Cowork session owns a sandbox
whose state a copy does not carry, and the app picks between full and shortened directory names for
that tree, so writing into the wrong one would produce a copy it never reads. Until someone verifies
it end to end, this remains a Code-session tool — which is a different statement from the one that
was here before, and an honest one.
