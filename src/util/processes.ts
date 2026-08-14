import { execFileSync } from 'node:child_process';

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
}

export type ProcessLister = () => ProcessRow[];

const POWERSHELL_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,' +
  'CommandLine,' +
  "@{n='Started';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | " +
  'ConvertTo-Csv -NoTypeInformation';

/**
 * The process table, with parent links.
 *
 * `tasklist` cannot report a parent pid, and the parent link is what separates
 * the app's main process from its dozen helpers — and what tells foster whether
 * it is itself running inside the app. Windows PowerShell 5.1 ships with every
 * supported Windows, so this needs nothing installed.
 */
export function readProcesses(): ProcessRow[] {
  if (process.platform !== 'win32') return [];
  let csv: string;
  try {
    csv = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_QUERY],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    );
  } catch {
    return [];
  }
  return parseProcessCsv(csv);
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
