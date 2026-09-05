import { describe, expect, it } from 'vitest';
import {
  parseTasklistCsv,
  parseWmicList,
  processTableProvenance,
  readProcessesWith,
  regExePath,
  systemExePath,
  useProcessTable,
  type CommandOutcome,
  type CommandRunner,
  type ReaderMemory,
} from '../src/util/processes.js';

describe('parseWmicList', () => {
  // The real sample this module was written against, decoded from latin1 and
  // still carrying the doubled CR wmic prints, a leading blank line, and keys
  // in the alphabetical order wmic happens to use (not to be relied on).
  const SAMPLE =
    [
      '',
      '',
      'CommandLine=',
      'CreationDate=20260904141816.674287-180',
      'ExecutablePath=',
      'Name=System Idle Process',
      'ParentProcessId=0',
      'ProcessId=0',
      '',
      '',
      'CommandLine="C:\\Program Files\\WindowsApps\\Claude_1.46388.2.0_x64__abc\\app\\Claude.exe" ',
      'CreationDate=20260904142448.130765-180',
      'ExecutablePath=C:\\Program Files\\WindowsApps\\Claude_1.46388.2.0_x64__abc\\app\\Claude.exe',
      'Name=Claude.exe',
      'ParentProcessId=4460',
      'ProcessId=46024',
      '',
      '',
    ].join('\r\r\n') + '\r\r\n';

  it('skips pid 0 (System Idle Process) and keeps the real row', () => {
    const rows = parseWmicList(SAMPLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 46024,
      parentPid: 4460,
      name: 'Claude.exe',
      path: 'C:\\Program Files\\WindowsApps\\Claude_1.46388.2.0_x64__abc\\app\\Claude.exe',
    });
  });

  it('converts CreationDate from local DMTF time to the matching UTC instant', () => {
    const rows = parseWmicList(SAMPLE);
    // Verified against a live process: 20260904142448.130765-180 is the same
    // instant as PowerShell's own Started for that pid.
    expect(rows[0]?.startedAt).toBe(Date.parse('2026-09-04T17:24:48.131Z'));
  });

  it('leaves startedAt undefined for an empty CreationDate', () => {
    const text = [
      'CreationDate=',
      'ExecutablePath=',
      'Name=x.exe',
      'ParentProcessId=1',
      'ProcessId=7',
      '',
    ].join('\r\r\n');
    const [row] = parseWmicList(text);
    expect(row?.startedAt).toBeUndefined();
  });

  it('leaves startedAt undefined for a malformed CreationDate', () => {
    const text = [
      'CreationDate=not-a-date',
      'ExecutablePath=',
      'Name=x.exe',
      'ParentProcessId=1',
      'ProcessId=7',
      '',
    ].join('\r\r\n');
    const [row] = parseWmicList(text);
    expect(row?.startedAt).toBeUndefined();
  });

  it('keeps an empty ExecutablePath as an empty string, not absent', () => {
    const text = ['ExecutablePath=', 'Name=x.exe', 'ParentProcessId=1', 'ProcessId=7', ''].join(
      '\r\r\n',
    );
    const [row] = parseWmicList(text);
    expect(row?.path).toBe('');
  });

  it('keeps a CommandLine containing commas and further "=" signs whole', () => {
    const text = [
      'CommandLine=x.exe --flag=a,b --other=c=d',
      'Name=x.exe',
      'ParentProcessId=1',
      'ProcessId=7',
      '',
    ].join('\r\r\n');
    const [row] = parseWmicList(text);
    expect(row?.commandLine).toBe('x.exe --flag=a,b --other=c=d');
  });

  it('appends a continuation line — one with no recognised Key= prefix — to the previous value', () => {
    const text = [
      'CommandLine=x.exe --long-flag',
      'still going, no key here',
      'Name=x.exe',
      'ParentProcessId=1',
      'ProcessId=7',
      '',
    ].join('\r\r\n');
    const [row] = parseWmicList(text);
    expect(row?.commandLine).toBe('x.exe --long-flag\nstill going, no key here');
  });

  it('parses correctly however the six keys are ordered', () => {
    const text = [
      'ProcessId=7',
      'Name=x.exe',
      'ParentProcessId=1',
      'ExecutablePath=C:\\x.exe',
      'CommandLine=x.exe',
      'CreationDate=',
      '',
    ].join('\r\r\n');
    const [row] = parseWmicList(text);
    expect(row).toMatchObject({
      pid: 7,
      parentPid: 1,
      name: 'x.exe',
      path: 'C:\\x.exe',
      commandLine: 'x.exe',
    });
  });

  it('skips a record with no ProcessId at all', () => {
    const text = ['Name=x.exe', 'ParentProcessId=1', ''].join('\r\r\n');
    expect(parseWmicList(text)).toEqual([]);
  });

  it('never flags a wmic row as partial', () => {
    const rows = parseWmicList(SAMPLE);
    expect(rows.every((row) => row.partial === undefined)).toBe(true);
  });
});

describe('parseTasklistCsv', () => {
  it('reads pid and name, leaving every other field as the honest empty default', () => {
    const csv = '"Claude.exe","46024","Console","1","312.456 K"\r\n';
    expect(parseTasklistCsv(csv)).toEqual([
      { pid: 46024, parentPid: 0, name: 'Claude.exe', path: '', commandLine: '', partial: true },
    ]);
  });

  it('skips a localised header line — its pid column is not a number', () => {
    // Written in ASCII on purpose: the real header is pt-BR text, but the parser
    // must not depend on any particular language to recognise it as a header.
    const csv = [
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"Claude.exe","46024","Console","1","312.456 K"',
    ].join('\r\n');
    expect(parseTasklistCsv(csv)).toEqual([
      { pid: 46024, parentPid: 0, name: 'Claude.exe', path: '', commandLine: '', partial: true },
    ]);
  });

  it('skips an INFO: line printed instead of a table', () => {
    const csv = 'INFO: No tasks are running which match the specified criteria.';
    expect(parseTasklistCsv(csv)).toEqual([]);
  });

  it('keeps a name with a comma inside quotes', () => {
    const csv = '"a, b.exe","500","Console","1","1 K"';
    expect(parseTasklistCsv(csv)[0]?.name).toBe('a, b.exe');
  });

  it('flags every row partial, with no parent, path, command line or start time', () => {
    const csv = '"a.exe","1","Console","1","1 K"\r\n"b.exe","2","Console","1","1 K"';
    const rows = parseTasklistCsv(csv);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.partial).toBe(true);
      expect(row.parentPid).toBe(0);
      expect(row.path).toBe('');
      expect(row.commandLine).toBe('');
      expect(row.startedAt).toBeUndefined();
    }
  });
});

describe('readProcessesWith', () => {
  const ENV = { SystemRoot: 'C:\\W' };

  function runner(
    outcomes: Partial<Record<'powershell' | 'wmic' | 'tasklist', CommandOutcome>>,
    calls: string[] = [],
  ): CommandRunner {
    return (exe) => {
      calls.push(exe);
      if (exe.toLowerCase().includes('powershell')) {
        return outcomes.powershell ?? { ok: false, reason: 'failed' };
      }
      if (exe.toLowerCase().includes('wmic')) {
        return outcomes.wmic ?? { ok: false, reason: 'failed' };
      }
      return outcomes.tasklist ?? { ok: false, reason: 'failed' };
    };
  }

  const PS_CSV =
    '"ProcessId","ParentProcessId","Name","ExecutablePath","CommandLine","Started"\n' +
    '"7","1","x.exe","C:\\x.exe","x.exe",""';

  const WMIC_LIST = ['Name=x.exe', 'ParentProcessId=1', 'ProcessId=7', ''].join('\r\r\n');

  const TASKLIST_CSV = '"x.exe","7","Console","1","1 K"';

  it('answers from PowerShell when it works, and never calls the others', () => {
    const calls: string[] = [];
    const memory: ReaderMemory = {};
    const result = readProcessesWith(
      runner({ powershell: { ok: true, stdout: PS_CSV } }, calls),
      memory,
      ENV,
    );

    expect(result.provenance).toEqual({ source: 'powershell', passedOver: [] });
    expect(result.rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(memory.skipPowerShell).toBeUndefined();
  });

  it('falls back to wmic on a PowerShell timeout, and remembers not to retry it', () => {
    const calls: string[] = [];
    const memory: ReaderMemory = {};
    const run = runner(
      { powershell: { ok: false, reason: 'timeout' }, wmic: { ok: true, stdout: WMIC_LIST } },
      calls,
    );

    const first = readProcessesWith(run, memory, ENV);
    expect(first.provenance).toEqual({
      source: 'wmic',
      passedOver: ['PowerShell timed out after 20 s'],
    });
    expect(memory.skipPowerShell).toBe('PowerShell timed out after 20 s');

    const callsAfterFirst = calls.length;
    const second = readProcessesWith(run, memory, ENV);
    expect(second.provenance).toEqual({
      source: 'wmic',
      passedOver: ['PowerShell timed out after 20 s'],
    });
    // Only wmic ran the second time — no new call to the PowerShell exe.
    const secondCalls = calls.slice(callsAfterFirst);
    expect(secondCalls.some((exe) => exe.toLowerCase().includes('powershell'))).toBe(false);
  });

  it('falls back to tasklist when both PowerShell and wmic are missing', () => {
    const memory: ReaderMemory = {};
    const run = runner({
      powershell: { ok: false, reason: 'missing' },
      wmic: { ok: false, reason: 'missing' },
      tasklist: { ok: true, stdout: TASKLIST_CSV },
    });

    const result = readProcessesWith(run, memory, ENV);
    expect(result.provenance.source).toBe('tasklist');
    expect(result.rows.every((row) => row.partial)).toBe(true);
  });

  it('reports three reasons and an empty table when every reader fails', () => {
    const memory: ReaderMemory = {};
    const run = runner({
      powershell: { ok: false, reason: 'timeout' },
      wmic: { ok: false, reason: 'missing' },
      tasklist: { ok: false, reason: 'failed', detail: 'access denied' },
    });

    const result = readProcessesWith(run, memory, ENV);
    expect(result.rows).toEqual([]);
    expect(result.provenance.source).toBe('none');
    expect(result.provenance.passedOver).toEqual([
      'PowerShell timed out after 20 s',
      'wmic is not installed (a Feature on Demand on Windows 11 24H2 and later)',
      'tasklist failed: access denied',
    ]);
  });

  it('passes over a reader that answers ok with no rows', () => {
    const memory: ReaderMemory = {};
    const run = runner({
      powershell: {
        ok: true,
        stdout: '"ProcessId","ParentProcessId","Name","ExecutablePath","CommandLine","Started"',
      },
      wmic: { ok: true, stdout: WMIC_LIST },
    });

    const result = readProcessesWith(run, memory, ENV);
    expect(result.provenance.source).toBe('wmic');
    expect(memory.skipPowerShell).toBe('PowerShell returned no rows');
  });

  it('resolves every reader through the given SystemRoot, not PATH', () => {
    const calls: string[] = [];
    const memory: ReaderMemory = {};
    readProcessesWith(
      runner(
        {
          powershell: { ok: false, reason: 'missing' },
          wmic: { ok: false, reason: 'missing' },
          tasklist: { ok: true, stdout: TASKLIST_CSV },
        },
        calls,
      ),
      memory,
      ENV,
    );

    expect(calls).toEqual([
      'C:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\W\\System32\\wbem\\wmic.exe',
      'C:\\W\\System32\\tasklist.exe',
    ]);
  });
});

describe('processTableProvenance', () => {
  it('is "installed" after useProcessTable supplies rows, and "none" after it is cleared', () => {
    useProcessTable([{ pid: 1, parentPid: 0, name: 'x.exe', path: '', commandLine: '' }]);
    expect(processTableProvenance()).toEqual({ source: 'installed', passedOver: [] });

    useProcessTable(undefined);
    expect(processTableProvenance()).toEqual({ source: 'none', passedOver: [] });

    // Restore the suite-wide seam (tests/setup.ts) so later files see the same
    // "nothing installed" table they would have without this one running first.
    useProcessTable([]);
  });
});

describe('systemExePath and regExePath', () => {
  it('agree on where reg.exe is', () => {
    const env = { SystemRoot: 'C:\\W' };
    expect(regExePath(env)).toBe(systemExePath('reg.exe', env));
  });

  it('falls back to C:\\Windows when SystemRoot is unset', () => {
    expect(systemExePath('tasklist.exe', {})).toBe('C:\\Windows\\System32\\tasklist.exe');
  });
});
