import { describe, expect, it } from 'vitest';
import { scrubbedEnv } from '../src/engine/launchEnv.js';

describe('scrubbedEnv', () => {
  it('drops every CLAUDE* variable, case-insensitively', () => {
    const env = {
      CLAUDECODE: '1',
      CLAUDE_PID: '4242',
      CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-00000000000a',
      CLAUDE_CODE_HOST_SESSION_ID: '00000000-0000-4000-8000-00000000000b',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_TOKEN: 'shh',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'shh',
      CLAUDE_CODE_EXECPATH: 'C:\\home\\claude.exe',
      CLAUDE_AGENT_SDK_VERSION: '1.0.0',
      CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-contas\\work',
      CLAUDE_USER_DATA_DIR: 'C:\\home\\AppData\\Roaming\\Claude',
      // Mixed case: the cut is on the name, not on a fixed spelling.
      claude_code_oauth_scopes: 'user:profile',
      ClAuDe_pid: '1',
    };

    expect(scrubbedEnv(env)).toEqual({});
  });

  it('keeps everything that is not CLAUDE*', () => {
    const env = {
      PATH: 'C:\\Windows\\System32',
      HOME: 'C:\\home',
      NOT_CLAUDE_RELATED: 'kept',
      CLAUDE_CODE_HOST_SESSION_ID: '00000000-0000-4000-8000-00000000000a',
    };

    expect(scrubbedEnv(env)).toEqual({
      PATH: 'C:\\Windows\\System32',
      HOME: 'C:\\home',
      NOT_CLAUDE_RELATED: 'kept',
    });
  });

  it('does not mutate the environment it was given', () => {
    const env = { CLAUDE_CODE_HOST_SESSION_ID: '1', PATH: 'kept' };
    scrubbedEnv(env);
    expect(env).toEqual({ CLAUDE_CODE_HOST_SESSION_ID: '1', PATH: 'kept' });
  });
});
