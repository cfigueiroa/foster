import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

/**
 * The process table, reduced to what foster needs: parent links, the image
 * path, and the command line (where a profile's `--user-data-dir` shows up).
 *
 * Lives below engine so the store can ask "is this pid still here?" without
 * importing desktop control.
 */

export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  /** Empty when the path could not be read, which is normal for other users' processes. */
  path: string;
  /** The full command line, which is where a profile's --user-data-dir shows up. */
  commandLine: string;
  /** Epoch milliseconds, or undefined when the creation time was unavailable. */
  startedAt?: number;
  /**
   * True when the reader could not report a parent link, a path, a command line
   * or a creation time for ANY row (tasklist, the last reader in the fallback
   * chain below). The empty fields on such a row are not evidence about the
   * process: `path === ''` no longer means "this process's path could not be
   * read", it means "nothing here could read paths". Every consumer that
   * reasons from those fields — `isDesktopProcess`, `runningStores`,
   * `inspectWriter` — has to treat a partial row as "cannot tell" rather than
   * as the negative answer an empty field would otherwise imply.
   */
  partial?: true;
}

/** Whether a table came from a reader that reports no paths, parents, command lines or start times. */
export function partialTable(rows: ProcessRow[]): boolean {
  return rows.some((row) => row.partial);
}

export type ProcessLister = () => ProcessRow[];

/**
 * The absolute path to a `System32` executable, resolved through `SystemRoot`
 * rather than PATH.
 *
 * `execFileSync('reg', ...)` (or `'wmic'`, or `'tasklist'`) resolves the
 * executable through the calling process's PATH, and PATH is not the same in
 * every shell: an elevated PowerShell (or a `runas`, or a shell launched by a
 * scheduled task) can carry a trimmed one that never includes `System32`, so
 * the spawn throws ENOENT — while the same command typed into an ordinary
 * window succeeds against the exact same binary. Windows always ships these
 * executables here, and `SystemRoot` is set by the OS for every process
 * regardless of PATH, so resolving through it sidesteps the whole problem.
 * `env` is a parameter only so a test could point it elsewhere; production
 * always calls this with no argument.
 */
export function systemExePath(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  // The Windows flavour of join, whatever the host: this is a Windows path by
  // definition, and the platform-native join on the Linux CI runner would spell
  // it `C:\Windows/System32/…` — which every caller here only ever sees on
  // Windows, where it never runs, but which the tests see everywhere.
  return win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', relative);
}

/** `reg.exe`, by the rule above. Kept as its own name: `desktop.ts` and `protocolHandler.ts` import it. */
export function regExePath(env: NodeJS.ProcessEnv = process.env): string {
  return systemExePath('reg.exe', env);
}

const POWERSHELL_RELATIVE = 'WindowsPowerShell\\v1.0\\powershell.exe';
const WMIC_RELATIVE = 'wbem\\wmic.exe';
const TASKLIST_RELATIVE = 'tasklist.exe';

const POWERSHELL_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,' +
  'CommandLine,' +
  "@{n='Started';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | " +
  'ConvertTo-Csv -NoTypeInformation';

const WMIC_ARGS = [
  'process',
  'get',
  'ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate',
  '/format:list',
];

const TASKLIST_ARGS = ['/fo', 'csv', '/nh'];

/**
 * How long any one reader may run before it counts as stuck. Unchanged from
 * the value this module has always used for PowerShell — nobody asked for the
 * hang itself to resolve faster, only for foster to stop trusting the empty
 * answer it produces — and reused for `wmic` and `tasklist` so a machine that
 * is simply slow (a laptop waking up, a heavily loaded box) gets the same
 * patience from every reader rather than a shorter fuse on the ones added later.
 */
const TIMEOUT_MS = 20_000;

/**
 * The process table, with parent links.
 *
 * PowerShell answers first, because `Get-CimInstance Win32_Process` is the only
 * reader here that reports a parent pid — and the parent link is what separates
 * the app's main process from its dozen helpers, and what tells foster whether
 * it is itself running inside the app. Windows PowerShell 5.1 ships with every
 * supported Windows, so this needs nothing installed.
 *
 * But PowerShell can also hang at start-up rather than fail quickly. Measured
 * on 05/09/2026: a machine whose PowerShell was blocked in
 * `InitializeDefaultDrives` of the FileSystem provider, waiting on a
 * WinFsp/Cryptomator drive that had stopped answering — every invocation, from
 * any script, waited the full 20 s and then errored, and this function
 * returning `[]` on that failure told every caller the machine had nothing
 * running at all. `foster app status`, `foster live`, `foster stores` and
 * `foster doctor` each paid the 20 s once per read and then reported a
 * confidently wrong answer — dangerous for `live --stop`, which decides what to
 * kill from exactly this table.
 *
 * So this now falls back, in `readProcessesWith`: when PowerShell fails or
 * returns nothing, `wmic process get ... /format:list` reports the same six
 * fields (see `parseWmicList` for its considerable list of quirks); when wmic
 * also fails or is not installed (it is a Feature on Demand on Windows 11 24H2
 * and later, and can be absent), `tasklist /fo csv /nh` reports pid and name
 * only, flagged `partial: true` (`parseTasklistCsv`) — a name is proof of
 * absence but never of identity, so every consumer that reasons from a path, a
 * parent link or a command line has to answer "cannot tell" rather than "no"
 * when it sees one. A PowerShell that fails once is not retried for the rest of
 * the process (`ReaderMemory.skipPowerShell`, sticky by design): a single CLI
 * run reads this table several times, `cachedProcesses` below only covers five
 * seconds of them, and paying the 20 s hang once per run instead of once per
 * read is most of the fix. `processTableProvenance()` reports which reader
 * actually answered the most recent read and why the ones before it were
 * passed over; `foster doctor` prints it.
 */
export function readProcesses(): ProcessRow[] {
  if (installedTable) return installedTable;
  if (process.platform !== 'win32') return [];
  const result = readProcessesWith(execFileSyncRunner, readerMemory);
  provenance = result.provenance;
  return result.rows;
}

/** Exported for tests: the parser is the part with edge cases, not the spawn. */
export function parseProcessCsv(csv: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  // The first line is the header; ConvertTo-Csv quotes every field.
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields.length < 4) continue;
    // Number('') is 0, not NaN, so an empty field would otherwise become a
    // process with pid 0 — and pid 0 is a plausible-looking parent link.
    const pid = fields[0]?.trim() ? Number(fields[0]) : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const started = fields[5] ? Date.parse(fields[5]) : Number.NaN;
    rows.push({
      pid,
      parentPid: Number(fields[1]) || 0,
      name: fields[2] ?? '',
      path: fields[3] ?? '',
      commandLine: fields[4] ?? '',
      ...(Number.isFinite(started) ? { startedAt: started } : {}),
    });
  }
  return rows;
}

const WMIC_KEYS = [
  'CommandLine',
  'CreationDate',
  'ExecutablePath',
  'Name',
  'ParentProcessId',
  'ProcessId',
] as const;
type WmicKey = (typeof WMIC_KEYS)[number];
const WMIC_KEY_NAMES: readonly string[] = WMIC_KEYS;

/**
 * Parses `wmic process get ... /format:list` output into rows.
 *
 * `/format:list` prints one `Key=Value` line per field, records separated by
 * blank lines, keys always in the same alphabetical order but not to be relied
 * on as such. Measured quirks this has to survive:
 *
 *  - the console's OEM code page, not UTF-16, and it ignores `chcp` — callers
 *    must read this with `encoding: 'latin1'` (byte-preserving) rather than a
 *    Unicode decoder, which has no cp850 table at all. ASCII bytes are exact
 *    either way; only non-ASCII characters in a path or command line come out
 *    wrong. That limit only affects comparing a path against a store root that
 *    contains non-ASCII characters — the ASCII markers foster actually greps
 *    for (`\claude-code\`, `\Packages\Claude`, `--user-data-dir=`, `--type=`)
 *    still match.
 *  - line endings are `\r\r\n`, the doubled CR wmic is known for; stripped
 *    below rather than split on, so a stray lone `\r` cannot swallow a line.
 *  - a `CommandLine` can itself contain `=` and commas (`--flag=a,b`), and
 *    `/format:list` does not escape or quote anything — so a line is only a new
 *    field when the text before its first `=` is one of the six keys asked
 *    for; anything else is the previous field's value continuing onto another
 *    line, and is appended to it rather than parsed as a key of its own.
 *  - a value can be empty (`ExecutablePath=` for a process whose path could not
 *    be read, `CommandLine=` likewise) — kept as `''`, not treated as absent.
 *
 * `CreationDate` is WMI's DMTF format, local time plus a UTC offset in minutes
 * (`yyyyMMddHHmmss.ffffff±ooo`); converted below by treating the local fields as
 * if they were UTC and then subtracting the offset. Verified against a live
 * process on the machine this was written for:
 * `20260904142448.130765-180` → `2026-09-04T17:24:48.131Z`, which matched
 * PowerShell's own `Started` for the same pid. A missing or malformed value
 * leaves `startedAt` undefined, same as every other reader here.
 *
 * Pid 0 (System Idle Process) is skipped, as every reader in this file does.
 */
export function parseWmicList(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  let record: Partial<Record<WmicKey, string>> = {};
  let currentKey: WmicKey | undefined;

  const finishRecord = () => {
    const rawPid = record.ProcessId;
    if (rawPid !== undefined) {
      const pid = Number(rawPid);
      if (Number.isInteger(pid) && pid > 0) {
        const rawParentPid = record.ParentProcessId;
        const parentPid = rawParentPid !== undefined ? Number(rawParentPid) : 0;
        const startedAt = record.CreationDate
          ? parseWmicCreationDate(record.CreationDate)
          : undefined;
        rows.push({
          pid,
          parentPid: Number.isFinite(parentPid) ? parentPid : 0,
          name: record.Name ?? '',
          path: record.ExecutablePath ?? '',
          commandLine: record.CommandLine ?? '',
          ...(startedAt !== undefined ? { startedAt } : {}),
        });
      }
    }
    record = {};
    currentKey = undefined;
  };

  for (const rawLine of text.split('\n')) {
    // The doubled CR (`\r\r\n`) and the ordinary one both end up here; either
    // way the line's content has no trailing carriage return left in it.
    const line = rawLine.replace(/\r+$/, '');
    if (line.trim() === '') {
      finishRecord();
      continue;
    }
    const eq = line.indexOf('=');
    const key = eq === -1 ? undefined : line.slice(0, eq);
    if (key !== undefined && WMIC_KEY_NAMES.includes(key)) {
      currentKey = key as WmicKey;
      record[currentKey] = line.slice(eq + 1);
    } else if (currentKey) {
      record[currentKey] = `${record[currentKey] ?? ''}\n${line}`;
    }
  }
  // /format:list does not guarantee a trailing blank line after the last record.
  finishRecord();

  return rows;
}

/** `yyyyMMddHHmmss.ffffff±ooo`, WMI's DMTF datetime — see parseWmicList's docblock. */
function parseWmicCreationDate(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, frac, offset] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const ms = Math.round(Number(frac) / 1000);
  // Treat the local-time fields as if they were UTC, then subtract the offset
  // (in minutes) to land on the real UTC instant — matches PowerShell's own
  // `ToUniversalTime()` for the same process, verified above.
  const asIfUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    ms,
  );
  const epoch = asIfUtc - Number(offset) * 60_000;
  return Number.isFinite(epoch) ? epoch : undefined;
}

/**
 * Parses `tasklist /fo csv /nh` output into rows.
 *
 * Every field is quoted (`"Claude.exe","46024","Console","1","312.456 K"`),
 * `\r\n`-terminated, columns fixed by position: image name, pid, session name,
 * session number, memory. Only the first two are anything foster uses; the
 * rest are read by nobody and dropped.
 *
 * `/nh` suppresses the header, but a caller cannot always guarantee that flag
 * survives — and the header, when present, is localised (`"Nome da
 * imagem","Identificação pessoal",…` on a pt-BR machine), so it cannot be
 * recognised by name. It is recognised by shape instead: a header's "pid"
 * column is not a number, and the same test happens to reject
 * `INFO: No tasks are running…`, which tasklist prints instead of a table for
 * some filters.
 *
 * Every row here is missing everything but a name and a pid — tasklist reports
 * neither a parent, a path, a command line nor a creation time — so every row
 * is flagged `partial: true`. See `ProcessRow.partial` for what that changes
 * for the code reading these rows.
 */
export function parseTasklistCsv(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('INFO:')) continue;
    const fields = splitCsvLine(line);
    const pid = fields[1]?.trim() ? Number(fields[1]) : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      parentPid: 0,
      name: fields[0] ?? '',
      path: '',
      commandLine: '',
      partial: true,
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      // A doubled quote inside a quoted field is a literal quote.
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

/**
 * How a reader's command is actually run.
 *
 * Injected so the fallback chain (`readProcessesWith`) can be exercised by
 * feeding it canned outcomes instead of spawning PowerShell, wmic and tasklist
 * for every test case — which would make the suite as slow and as flaky as the
 * bug it exists to catch.
 */
export type CommandOutcome =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'timeout' | 'missing' | 'failed'; detail?: string };

export type CommandRunner = (
  exe: string,
  args: string[],
  options: { timeoutMs: number; encoding: 'utf8' | 'latin1' },
) => CommandOutcome;

/**
 * What one process remembers across reads: a PowerShell that hung once is not
 * tried again for the rest of it. Kept as a value the caller owns (rather than
 * baked into `readProcessesWith` as module state) so a test can start each
 * case with a clean memory, and so production can hold one across calls.
 */
export interface ReaderMemory {
  skipPowerShell?: string;
}

export type ProcessSource = 'powershell' | 'wmic' | 'tasklist' | 'none' | 'installed';

export interface ProcessTableProvenance {
  /** Which reader answered the most recent read in this process. */
  source: ProcessSource;
  /**
   * Why each reader before the one that answered was passed over, one line per
   * reader, in the order they were tried. E.g. "PowerShell timed out after 20 s".
   */
  passedOver: string[];
}

/** Why a reader was passed over, phrased for `passedOver` and for the sticky skip reason alike. */
function readerFailureReason(
  name: 'PowerShell' | 'wmic' | 'tasklist',
  outcome: { reason: 'timeout' | 'missing' | 'failed'; detail?: string },
  exe: string,
): string {
  switch (outcome.reason) {
    case 'timeout':
      return `${name} timed out after ${TIMEOUT_MS / 1000} s`;
    case 'missing':
      // wmic is a Feature on Demand as of Windows 11 24H2 and may genuinely not
      // be there; PowerShell and tasklist ship with every supported Windows, so
      // "missing" for either of those means it is not where SystemRoot says.
      return name === 'wmic'
        ? 'wmic is not installed (a Feature on Demand on Windows 11 24H2 and later)'
        : `${name} is not at ${exe}`;
    case 'failed':
      return `${name} failed${outcome.detail ? `: ${outcome.detail}` : ''}`;
  }
}

/**
 * The fallback chain itself, over an injected runner and memory.
 *
 * Tries PowerShell, then wmic, then tasklist, in that order, and stops at the
 * first one that returns at least one row. A reader that runs cleanly but
 * reports nothing is treated the same as one that failed outright — a process
 * table with zero entries is never the true answer on a running Windows
 * machine, only evidence that this reader could not produce one — so it too is
 * passed over rather than accepted as "nothing is running".
 *
 * PowerShell alone is sticky: once it has failed in this process, `memory`
 * remembers why and every later call skips straight past it, still recording
 * the same reason in `passedOver`. wmic and tasklist are cheap enough, and
 * fail independently enough of one another, that retrying them each call is
 * not worth the extra state.
 */
export function readProcessesWith(
  run: CommandRunner,
  memory: ReaderMemory,
  env: NodeJS.ProcessEnv = process.env,
): { rows: ProcessRow[]; provenance: ProcessTableProvenance } {
  const passedOver: string[] = [];

  if (memory.skipPowerShell === undefined) {
    const exe = systemExePath(POWERSHELL_RELATIVE, env);
    const outcome = run(exe, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_QUERY], {
      timeoutMs: TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (outcome.ok) {
      const rows = parseProcessCsv(outcome.stdout);
      if (rows.length > 0) return { rows, provenance: { source: 'powershell', passedOver } };
      memory.skipPowerShell = 'PowerShell returned no rows';
    } else {
      memory.skipPowerShell = readerFailureReason('PowerShell', outcome, exe);
    }
  }
  passedOver.push(memory.skipPowerShell);

  const wmicExe = systemExePath(WMIC_RELATIVE, env);
  const wmicOutcome = run(wmicExe, WMIC_ARGS, { timeoutMs: TIMEOUT_MS, encoding: 'latin1' });
  if (wmicOutcome.ok) {
    const rows = parseWmicList(wmicOutcome.stdout);
    if (rows.length > 0) return { rows, provenance: { source: 'wmic', passedOver } };
    passedOver.push('wmic returned no rows');
  } else {
    passedOver.push(readerFailureReason('wmic', wmicOutcome, wmicExe));
  }

  const tasklistExe = systemExePath(TASKLIST_RELATIVE, env);
  const tasklistOutcome = run(tasklistExe, TASKLIST_ARGS, {
    timeoutMs: TIMEOUT_MS,
    encoding: 'latin1',
  });
  if (tasklistOutcome.ok) {
    const rows = parseTasklistCsv(tasklistOutcome.stdout);
    if (rows.length > 0) return { rows, provenance: { source: 'tasklist', passedOver } };
    passedOver.push('tasklist returned no rows');
  } else {
    passedOver.push(readerFailureReason('tasklist', tasklistOutcome, tasklistExe));
  }

  return { rows: [], provenance: { source: 'none', passedOver } };
}

/** The production `CommandRunner`: a real spawn, errors mapped to the three reasons the chain understands. */
export const execFileSyncRunner: CommandRunner = (exe, args, options) => {
  try {
    const stdout = execFileSync(exe, args, {
      encoding: options.encoding,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    if (failure.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (failure.code === 'ENOENT') return { ok: false, reason: 'missing' };
    const text = String(failure.stderr ?? '').trim() || String(failure.message ?? '');
    const detail = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '');
    return { ok: false, reason: 'failed', ...(detail ? { detail } : {}) };
  }
};

/**
 * Both the desktop app and the Code CLI are called claude.exe. Only the path
 * tells them apart, and only the CLI lives under a claude-code directory.
 *
 * Kept here rather than in engine/desktop so the session registry can ask what a
 * pid is now without importing desktop control — the same reason this module
 * exists at all.
 */
export function isCodeCliProcess(row: ProcessRow): boolean {
  return (
    row.name.toLowerCase() === 'claude.exe' && row.path.toLowerCase().includes('\\claude-code\\')
  );
}

/** Long enough that one command reads the table once; short enough to stay a snapshot. */
const PROCESS_CACHE_MS = 5_000;

let cached: { rows: ProcessRow[]; at: number } | undefined;

/**
 * The process table, read at most once every few seconds.
 *
 * Reading it spawns PowerShell, which costs the better part of a second. Asking
 * whether a pid is still the process a registry file named happens once per
 * entry, and a machine carrying ninety stale entries would otherwise pay that
 * ninety times over. Nothing is lost by reusing the answer briefly: a process
 * table is already the past by the time it is parsed, so every caller here
 * treats it as evidence about a moment, not as the present.
 */
export function cachedProcesses(): ProcessRow[] {
  const now = Date.now();
  if (cached && now - cached.at < PROCESS_CACHE_MS) return cached.rows;
  const rows = readProcesses();
  cached = { rows, at: now };
  return rows;
}

/**
 * Whether this machine can report a process table at all.
 *
 * `readProcesses` answers an unreadable table and an unsupported platform the
 * same way, with nothing, because every caller has to cope with nothing either
 * way. The difference is only in what a refusal should say about it: "the read
 * failed" is worth retrying, and "not on this platform" is not.
 */
export function processTableReadable(): boolean {
  return installedTable !== undefined || process.platform === 'win32';
}

/** Drops the memoised table, so the next ask reaches the machine again. */
function clearProcessCache(): void {
  cached = undefined;
}

/** What one process remembers about its readers between reads — see readProcesses' docblock. */
let readerMemory: ReaderMemory = {};

/** Backing state for processTableProvenance(), below. */
let provenance: ProcessTableProvenance = { source: 'none', passedOver: [] };

/** The provenance of the last readProcesses() call — see readProcesses' docblock. */
export function processTableProvenance(): ProcessTableProvenance {
  return provenance;
}

/**
 * Test seam: a fixed table so unit tests never spawn PowerShell against the real
 * machine. Production never calls this. It stands in front of the read itself
 * rather than the memoised one, so no route reaches the machine. An empty list
 * is the honest answer for a test that is not asking about processes — it reads
 * as "the table could not be read", which every caller here already has to cope
 * with. A test that *is* asking about them passes its own rows, here or through
 * the lister its subject takes.
 */
let installedTable: ProcessRow[] | undefined;

export function useProcessTable(rows: ProcessRow[] | undefined): void {
  installedTable = rows;
  clearProcessCache();
  // A fresh table also means a fresh reader history: nothing about a previous
  // test's PowerShell failure should stick to the next one, and provenance
  // should describe what this call actually installed rather than whatever the
  // real chain last answered before the seam took over.
  readerMemory = {};
  provenance =
    rows !== undefined
      ? { source: 'installed', passedOver: [] }
      : { source: 'none', passedOver: [] };
}
