# Cloud sessions

## Cloud sessions: `foster cloud list` / `foster cloud pull`

```bash
foster cloud list                         # every cloud session (code.claude.com) this account can see
foster cloud pull <id> --into <cwd>       # dry run: what pulling this session would write
foster cloud pull <id> --into <cwd> --yes # fabricate a local transcript + sidebar card from it
foster cloud pull <id> --undo --yes       # undo a pull, the same way import-codex --undo does
```

Reads the CLI's own credential — `.credentials.json`'s access token plus `.claude.json`'s cached
organization uuid, never the Desktop app's — and never refreshes it: an expired token is reported,
with the directory to re-run `claude` in to refresh it, rather than foster rotating it itself. A
pull fabricates a transcript and a sidebar card the same way `import-codex` does — files first,
ledger only once they land, undoable the same way — because a cloud session already carries
Claude-shaped records (teleported off whatever machine it last ran on), not something to convert
from scratch. A re-pull of a session whose history grew reuses the id it minted the first time, so
it overwrites in place instead of leaving an orphaned pair behind. Nothing here is a published API:
see AGENTS.md's own "Cloud sessions" section for the endpoints, the credential, and what a pull
does and does not do.
