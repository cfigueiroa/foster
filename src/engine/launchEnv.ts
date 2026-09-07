/**
 * The environment a launched Claude.exe gets, and what it does not get.
 *
 * foster routinely runs from inside a session the app is itself hosting — a
 * Code tab opened from the Desktop sidebar. That session's environment carries
 * markers the app and its bundled CLI use to recognise "I am hosted":
 * `CLAUDE_CODE_HOST_SESSION_ID` is what `hostedByDesktop` (desktop.ts) reads to
 * decide "this process is inside an app"; `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
 * is what makes a `claude` CLI register itself as hosted, which `rescue`, `live`
 * and `sweep` would then read back as a Desktop card that was never opened from
 * one; `CLAUDE_USER_DATA_DIR` would contradict a `--user-data-dir` switch handed
 * to the very same process. None of that is meant for a fresh instance foster is
 * starting on purpose — a new profile, a new client's terminal — so every launch
 * hands the child a copy of the environment with those variables removed,
 * instead of letting it inherit `process.env` as spawned children do by default.
 *
 * The cut is by name, not by an enumerated list: anything starting with
 * `CLAUDE`, case-insensitively, goes. That is deliberately wider than the
 * handful measured in this hosted session (`CLAUDECODE`, `CLAUDE_PID`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`,
 * `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`,
 * `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_SDK_*`, `CLAUDE_CODE_OAUTH_*`,
 * `CLAUDE_CODE_EXECPATH`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CONFIG_DIR`,
 * `CLAUDE_USER_DATA_DIR`) — a name this session has never seen is still a name a
 * launched instance has no business inheriting from whatever happened to start
 * it.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^claude/i.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}
