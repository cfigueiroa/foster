import { describe, expect, it } from 'vitest';
import { buildToolOptions, denyOutsideAllowlist } from '../src/agent/run.js';

/**
 * `runAgent` itself spawns the real Agent SDK and is not something a unit
 * test drives — `buildToolOptions` is the tool-related half of its query
 * options, split out precisely so the object it builds (and the second gate
 * it wires up for --yes) can be checked without loading the SDK or spending
 * a model turn.
 */

const FOSTER_TOOLS = [
  'mcp__foster_session_mgmt__scan_accounts',
  'mcp__foster_session_mgmt__sweep_everything',
  'mcp__foster_session_mgmt__resume_headless',
];

describe('buildToolOptions — without --yes', () => {
  it('keeps the full Claude Code preset and the default (asking/auto-deny) permission mode', () => {
    const options = buildToolOptions(FOSTER_TOOLS, false);

    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(options.permissionMode).toBe('default');
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
  });

  it('still allowlists the foster tools plus the read-only trio, for the asking layer', () => {
    const options = buildToolOptions(FOSTER_TOOLS, false);
    expect(options.allowedTools).toEqual([...FOSTER_TOOLS, 'Read', 'Glob', 'Grep']);
  });
});

describe('buildToolOptions — with --yes', () => {
  it('trims the built-in toolset to the read-only trio — no Bash, Write, Edit, WebFetch, WebSearch', () => {
    const options = buildToolOptions(FOSTER_TOOLS, true);

    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    for (const dangerous of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
      expect(options.tools).not.toContain(dangerous);
    }
  });

  it('allowlists exactly the foster tools plus the read-only trio', () => {
    const options = buildToolOptions(FOSTER_TOOLS, true);
    expect(options.allowedTools).toEqual([...FOSTER_TOOLS, 'Read', 'Glob', 'Grep']);
  });

  it('switches to bypassPermissions, and installs a canUseTool as the second gate', () => {
    const options = buildToolOptions(FOSTER_TOOLS, true);

    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(typeof options.canUseTool).toBe('function');
  });
});

describe('denyOutsideAllowlist', () => {
  const canUseTool = denyOutsideAllowlist([...FOSTER_TOOLS, 'Read', 'Glob', 'Grep']);
  const fakeOptions = {
    signal: new AbortController().signal,
    toolUseID: 'tool-1',
    requestId: 'req-1',
  };

  it('allows a foster MCP tool', async () => {
    const result = await canUseTool(
      'mcp__foster_session_mgmt__sweep_everything',
      { apply: true },
      fakeOptions,
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: { apply: true } });
  });

  it('allows the read-only builtins', async () => {
    for (const name of ['Read', 'Glob', 'Grep']) {
      const result = await canUseTool(name, {}, fakeOptions);
      expect(result?.behavior).toBe('allow');
    }
  });

  it('denies Bash, Write, Edit, WebFetch and WebSearch — the tools --yes must never reach', async () => {
    for (const name of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
      const result = await canUseTool(name, {}, fakeOptions);
      expect(result?.behavior).toBe('deny');
    }
  });

  it('denies a name outside the allowlist even when it looks like a foster tool', async () => {
    const result = await canUseTool('mcp__foster_session_mgmt__purge', {}, fakeOptions);
    expect(result).toEqual({
      behavior: 'deny',
      message: expect.stringContaining('mcp__foster_session_mgmt__purge'),
    });
  });
});
