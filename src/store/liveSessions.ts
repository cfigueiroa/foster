import { readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  cachedProcesses,
  isCodeCliProcess,
  processTableReadable,
  readProcesses,
  type ProcessLister,
  type ProcessRow,
} from '../util/processes.js';
import { isDirectory, safeReaddir } from '../util/fs.js';
import { configDirCandidates } from './configDirs.js';
import { accountDir, layoutFor, listAccountDirs } from '../domain/paths.js';
import { isSessionFileName } from '../domain/naming.js';
import { readCliSessionId } from './sessionFile.js';

/**
 * The CLI's registry of running sessions.
 *
 * Every live `claude` process registers itself as a JSON file under
 * `<configDir>/sessions/` — pid, session id, working directory — and removes it
 * on exit. A crash leaves the file behind, so an entry only counts when its pid
 * still answers.
 *
 * Answering is not enough on its own. Windows hands pids back out quickly, and
 * after a reboot much of a day-old registry points at whatever took the number
 * next — a database worker, a git process, the desktop app. Asking only whether
 * *a* process holds the pid says yes to all of them, so the record's own account
 * of its writer is checked against what the pid names now:
 *
 *  - the CLI records the writer's creation time in the registry file
 *    (`procStart`, a Windows FILETIME). Two processes can share a pid; they
 *    cannot share a pid *and* a creation instant, so a match is proof and a
 *    difference is proof of the opposite;
 *  - failing that — an older CLI, a record written by something else — a process
 *    younger than the record that supposedly describes it cannot be its writer,
 *    and neither can one that is plainly not a Code CLI at all.
 *
 * This is the gate in front of anything that would write to a conversation from
 * outside: a transcript with a live writer must not get a second one, and the
 * registry is the only place that says whether one exists right now. It is also
 * the gate in front of a kill, which is why the verdict is kept rather than
 * flattened to a boolean — `foster live --stop` may end a process it has
 * identified, and nothing else.
 */

/** A process holding a conversation open, as a warning needs to describe it. */
export interface LiveWriter {
  pid: number;
  cwd?: string;
  /** True for the session foster itself is running inside. */
  isSelf?: boolean;
}

/** What a registry file claims about the process that wrote it. */
export interface WriterIdentity {
  pid: number;
  /** The writer's creation time, as the record copied it from Windows. Epoch ms. */
  procStartedAt?: number;
  /** When the record was written; its writer cannot have started after it. Epoch ms. */
  recordedAt?: number;
}

export interface LiveCliSession {
  /** The registry file the entry came from. */
  registryFile: string;
  pid: number;
  /** The conversation the process is holding open. */
  sessionId: string;
  cwd?: string;
  /**
   * Who started this CLI process, when the record says. `'claude-desktop'` is
   * the app spawning a Code session inside itself; anything else, terminal.
   * Records too old to carry one are treated as terminal — the safe default,
   * since a terminal session is never mistaken for one the app can be asked
   * about.
   */
  entrypoint?: string;
  /** What the file says about its writer, for anything that has to verify it. */
  identity: WriterIdentity;
}

/**
 * Whether a pid still belongs to the process a record named.
 *
 * The check takes the identity as well as the pid so it can be replaced whole in
 * tests — injecting it is how a fixture decides what is running, and a test that
 * only cares about liveness can go on ignoring the second argument.
 */
export type WriterCheck = (pid: number, identity?: WriterIdentity) => boolean;

/**
 * Every directory that might register live sessions — one per Claude config
 * directory, from the same enumeration transcripts are discovered by:
 * `CLAUDE_CONFIG_DIR`, the default `~/.claude`, and any `~/.claude*` sibling a
 * second subscription uses.
 */
export function sessionRegistryRoots(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): string[] {
  return configDirCandidates(env, extra)
    .map((dir) => path.join(dir, 'sessions'))
    .filter(isDirectory);
}

/** Whether a pid names a process that exists. EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * How far apart the two clocks may be before a creation time stops being the
 * same creation time. The record keeps 100-nanosecond ticks and the process
 * table is read to the millisecond, so this is rounding slack, not doubt: a pid
 * is only reissued once its holder has exited, which puts a recycled process's
 * start well after the one the record wrote down.
 */
const START_MATCH_MS = 1_000;

/**
 * How much later than its own record a process may have started before it is a
 * stranger. The CLI writes the file moments after starting, so a real writer is
 * always older than its record; the minute is for clock adjustments and for the
 * rewrites the CLI does when a session is renamed.
 */
const RECORD_SLACK_MS = 60_000;

type WriterVerdict =
  /** The pid is the process the record named — the creation times match. */
  | 'confirmed'
  /** Nothing contradicts the record, but there is no proof either. */
  | 'plausible'
  /** The pid belongs to something else now. */
  | 'mismatch'
  /** The process table could not be read, or does not list the pid. */
  | 'unknown';

interface WriterInspection {
  verdict: WriterVerdict;
  /** What the pid names now, when the table could be read. */
  row?: ProcessRow;
  /** Why, in the words a refusal has to be explained in. */
  note?: string;
}

/**
 * What the pid behind a registry entry actually is.
 *
 * The order matters: proof first, and only then the weaker evidence that has to
 * carry records written before the CLI recorded a creation time.
 */
function inspectWriter(identity: WriterIdentity, rows: ProcessRow[]): WriterInspection {
  if (rows.length === 0) {
    return { verdict: 'unknown', note: 'the process table could not be read' };
  }

  const row = rows.find((candidate) => candidate.pid === identity.pid);
  if (!row) {
    // The pid gate, not this, decides whether a process exists; a table read a
    // moment earlier is entitled to have missed one.
    return { verdict: 'unknown', note: `pid ${identity.pid} is not in the process table` };
  }

  // tasklist rows never carry a creation time, so without this check every
  // partial row would fall straight through to the 'plausible' return at the
  // bottom — the two checks in between (creation time, then recordedAt) both
  // require fields a partial row never has. That is exactly backwards: a
  // partial row is the case with the LEAST evidence, and 'plausible' is what
  // lets `endableWriter` hand a pid to `taskkill /F /T`. With parent links gone
  // too, `isSelfHostedBy` cannot see that the pid is foster's own ancestor
  // either, so a partial row must never come out as anything but 'mismatch' (a
  // name alone still proves a stranger) or 'unknown' — never 'confirmed', never
  // 'plausible'.
  if (row.partial) {
    if (!couldBeWriter(row)) {
      return {
        verdict: 'mismatch',
        row,
        note: `pid ${identity.pid} is ${row.name || 'a process'}, which is not a claude session`,
      };
    }
    return {
      verdict: 'unknown',
      row,
      note:
        `pid ${identity.pid} is ${row.name || 'a process'}, but the process table was read ` +
        'through tasklist, which reports no creation time or path to check the record against',
    };
  }

  if (identity.procStartedAt !== undefined && row.startedAt !== undefined) {
    if (Math.abs(row.startedAt - identity.procStartedAt) <= START_MATCH_MS) {
      return { verdict: 'confirmed', row };
    }
    return {
      verdict: 'mismatch',
      row,
      note:
        `pid ${identity.pid} is now ${row.name || 'another process'}, started ` +
        `${iso(row.startedAt)} — the record was written for a process started ` +
        `${iso(identity.procStartedAt)}`,
    };
  }

  if (!couldBeWriter(row)) {
    return {
      verdict: 'mismatch',
      row,
      note: `pid ${identity.pid} is ${row.name || 'a process'}, which is not a claude session`,
    };
  }

  if (
    row.startedAt !== undefined &&
    identity.recordedAt !== undefined &&
    row.startedAt > identity.recordedAt + RECORD_SLACK_MS
  ) {
    return {
      verdict: 'mismatch',
      row,
      note:
        `pid ${identity.pid} started ${iso(row.startedAt)}, after the record describing it ` +
        `was written ${iso(identity.recordedAt)}`,
    };
  }

  return { verdict: 'plausible', row };
}

/**
 * Whether a process could be a Code CLI at all.
 *
 * Only reached for records with no creation time to check. The desktop app is
 * excluded by the rule that separates it everywhere else — it is claude.exe too,
 * and a recycled pid landing on it is exactly the case a name alone would wave
 * through. A path that could not be read says nothing either way, and nothing is
 * concluded from silence.
 */
function couldBeWriter(row: ProcessRow): boolean {
  const name = row.name.toLowerCase();
  // The CLI run from source, or from an npm install, is a node process.
  if (name === 'node.exe') return true;
  if (name !== 'claude.exe') return false;
  return row.path === '' || isCodeCliProcess(row);
}

/**
 * The default liveness check: the pid answers, and it still belongs to the
 * process the record named.
 *
 * A verdict of `unknown` counts as alive. The registry is what says a
 * conversation has a writer, and disbelieving it because the process table was
 * unreadable would drop the fork protection at the moment it cannot be
 * corroborated — the wrong way round for a check whose failure mode is a second
 * writer on one transcript.
 */
export const writerAlive: WriterCheck = writerAliveWith(cachedProcesses);

/** The same check against a given process table — the seam tests build fixtures on. */
export function writerAliveWith(
  list: ProcessLister,
  alive: (pid: number) => boolean = pidAlive,
): WriterCheck {
  return (pid, identity) => {
    if (!alive(pid)) return false;
    if (!identity) return true;
    return inspectWriter(identity, list()).verdict !== 'mismatch';
  };
}

/**
 * Whether a writer may be ended.
 *
 * Stricter than counting one as live, and deliberately so: the cost of believing
 * a stale entry is a stray warning, and the cost of acting on one is `taskkill
 * /F /T` against whatever holds the pid now — a database worker, an editor, a
 * process tree with children of its own. Only an identified process may be
 * killed, so anything short of evidence refuses.
 */
export function endableWriter(
  identity: WriterIdentity,
  rows: ProcessRow[],
  readable: boolean = processTableReadable(),
): { ok: true } | { ok: false; reason: string } {
  const { verdict, note } = inspectWriter(identity, rows);
  if (verdict === 'confirmed' || verdict === 'plausible') return { ok: true };
  if (verdict === 'mismatch') {
    return {
      ok: false,
      reason:
        `${note ?? 'the pid belongs to another process now'}.\n` +
        'Windows reuses pids, so this registry entry is stale: ending it would kill\n' +
        'something unrelated. Run "foster live --prune" to clear entries like it.',
    };
  }
  // Separated because the two read completely differently to whoever is holding
  // the terminal. On Windows an empty table is a failure worth retrying; on any
  // other machine it is the platform, and sending someone to debug PowerShell
  // for it would waste an afternoon.
  if (!readable) {
    return {
      ok: false,
      reason:
        'foster only reads the process table on Windows, so it cannot tell whether this pid\n' +
        'is still this session. It does not kill what it cannot name; end the session from\n' +
        'its own window instead.',
    };
  }
  return {
    ok: false,
    reason:
      `${note ?? 'the process behind this entry could not be identified'}, so foster cannot\n` +
      'tell whether the pid is still this session. It does not kill what it cannot name;\n' +
      'end the session from its own window instead.',
  };
}

/**
 * Whether foster is running inside this conversation, from the session's own
 * marking of its children.
 *
 * The ancestry walk answers the same question and is wrong more often than it
 * looks: it follows parent links, and a link dies with the process holding it.
 * Launch foster through a wrapper whose shell has since exited and the chain
 * breaks at the gap — measured here, a four-deep shell chain lost its third
 * link, and `--stop` offered to end the session the command was running in.
 *
 * The CLI marks every process it starts, however deep, with both the
 * conversation and the pid holding it. Either match is enough and both are
 * asked: a session id is a uuid, so unlike a pid it cannot come back as somebody
 * else, and a pid that matches means the kill takes this command with it whatever
 * the record calls itself. An id inherited from a session that has since ended
 * names a conversation with no registry entry left to match, and a stale pid
 * costs a refusal — the direction everything here errs in anyway.
 */
export function isSelfSession(
  session: { sessionId: string; pid: number },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (id && id.toLowerCase() === session.sessionId.toLowerCase()) return true;
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid === session.pid;
}

/**
 * The sessions whose processes are still running.
 *
 * The liveness check is injectable so tests can decide which fixture pids are
 * "alive" without depending on the machine's process table.
 */
export function liveSessions(roots: string[], alive: WriterCheck = writerAlive): LiveCliSession[] {
  return registryEntries(roots).filter((entry) => alive(entry.pid, entry.identity));
}

/** Every parsed entry in the registry, live or not — what pruning starts from. */
function registryEntries(roots: string[]): LiveCliSession[] {
  const out: LiveCliSession[] = [];

  for (const root of roots) {
    for (const entry of safeReaddir(root)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(root, entry);
      const record = readRegistryFile(file);
      if (!record) continue;
      out.push({ ...record, registryFile: file });
    }
  }

  return out;
}

/** A registry file that provably describes nothing, and the reason it is over. */
export interface StaleEntry {
  /** The file to remove. */
  file: string;
  pid: number;
  /** The conversation the file named, for the files that name one. */
  sessionId?: string;
  cwd?: string;
  why: string;
}

/**
 * The files that can be removed without guessing.
 *
 * Only two cases qualify: the pid answers to nobody, or it answers to a process
 * that is demonstrably not the one the file was written for. A file foster
 * merely cannot identify stays — a registry entry belongs to the session that
 * wrote it, and deleting one on suspicion would strip the fork protection from a
 * conversation that still has a writer.
 *
 * Both halves of an entry are considered. A session leaves a record and a peer
 * key beside it, the CLI clears records it finds stale but not the keys, and a
 * machine that has been up for a while carries far more of the second than the
 * first. Removing only what is easy to name would leave the directory as full as
 * it was found and the command's own count would say otherwise.
 */
export function staleRegistryEntries(
  roots: string[],
  alive: (pid: number) => boolean = pidAlive,
  list: ProcessLister = cachedProcesses,
): StaleEntry[] {
  const found: { described: Omit<StaleEntry, 'why'>; identity: WriterIdentity }[] = [
    ...registryEntries(roots).map((entry) => ({
      described: {
        file: entry.registryFile,
        pid: entry.pid,
        sessionId: entry.sessionId,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      },
      identity: entry.identity,
    })),
    ...peerKeys(roots).map((key) => ({
      described: { file: key.file, pid: key.identity.pid },
      identity: key.identity,
    })),
  ];
  if (found.length === 0) return [];

  const rows = list();
  const stale: StaleEntry[] = [];
  for (const { described, identity } of found) {
    if (!alive(identity.pid)) {
      stale.push({ ...described, why: `pid ${identity.pid} is gone` });
      continue;
    }
    const { verdict, note } = inspectWriter(identity, rows);
    if (verdict === 'mismatch') {
      stale.push({ ...described, why: note ?? `pid ${identity.pid} was reused` });
    }
  }
  return stale;
}

/** Removes registry files, reporting the ones that would not go. */
export function pruneRegistry(stale: StaleEntry[]): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const { file } of stale) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch {
      // Another client's directory foster cannot write to, or a file that went on
      // its own between the scan and now. Neither is worth failing over.
      failed.push(file);
    }
  }
  return { removed, failed };
}

/**
 * The companion files a session leaves beside its record.
 *
 * `<pid>.<hash>.key` holds the token another process is expected to present, and
 * the creation time of the process it was minted for — the same identity the
 * record keeps, in the same format, which is what makes it answerable here at
 * all. Nothing else is read from one and nothing is inferred about what it is
 * for; the only claim ever made is that the process it names is not running.
 */
function peerKeys(roots: string[]): { file: string; identity: WriterIdentity }[] {
  const out: { file: string; identity: WriterIdentity }[] = [];
  for (const root of roots) {
    for (const name of safeReaddir(root)) {
      if (!name.endsWith('.key')) continue;
      const file = path.join(root, name);
      const identity = readPeerKey(file, name);
      if (identity) out.push({ file, identity });
    }
  }
  return out;
}

function readPeerKey(file: string, name: string): WriterIdentity | undefined {
  const pid = Number(name.slice(0, name.indexOf('.')));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const procStartedAt =
      typeof parsed.procStartFt === 'string' ? filetimeToEpochMs(parsed.procStartFt) : undefined;
    const recordedAt = mtimeOf(file);
    return {
      pid,
      ...(procStartedAt !== undefined ? { procStartedAt } : {}),
      ...(recordedAt !== undefined ? { recordedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether foster is running inside this session.
 *
 * The registry gives a pid; the question is whether that process is an ancestor
 * of this one. It matters wherever ending a writer is offered: the session foster
 * was started from is the one it must never end, for the same reason it refuses
 * to close the app it runs inside — the kill would take the command with it,
 * part-way through, and the user would be left guessing what ran.
 */
export function isSelfHostedBy(
  pid: number,
  list: ProcessLister = readProcesses,
  selfPid: number = process.pid,
): boolean {
  const rows = list();
  if (rows.length === 0) return false;

  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let current = byPid.get(selfPid);
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.pid === pid) return true;
    const parent = byPid.get(current.parentPid);
    // A recycled pid can point at a process younger than its supposed child.
    if (parent && current.startedAt !== undefined && parent.startedAt !== undefined) {
      if (parent.startedAt > current.startedAt) return false;
    }
    current = parent;
  }
  return false;
}

/**
 * The writers behind a set of conversations, described for a warning.
 *
 * Shared by the command and the menu so the same fostering is reported the same
 * way in both, and so "which of these is me" is answered once — the process table
 * is read a single time however many writers there are, and that one read settles
 * both whether an entry is still its own writer and which one is this session.
 */
export function describeWriters(
  cliSessionIds: string[],
  roots: string[],
  list: ProcessLister = readProcesses,
  alive?: WriterCheck,
): LiveWriter[] {
  const wanted = new Set(cliSessionIds.map((id) => id.toLowerCase()));
  let rows: ProcessRow[] | undefined;
  const table = () => (rows ??= list());

  const sessions = liveSessions(roots, alive ?? writerAliveWith(table)).filter((session) =>
    wanted.has(session.sessionId.toLowerCase()),
  );
  if (sessions.length === 0) return [];

  const seen = table();
  return sessions.map((session) => ({
    pid: session.pid,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(isSelfHostedBy(session.pid, () => seen) ? { isSelf: true as const } : {}),
  }));
}

/** The live process holding this conversation open, if any. */
export function liveSessionFor(
  cliSessionId: string,
  roots: string[],
  alive: WriterCheck = writerAlive,
): LiveCliSession | undefined {
  const wanted = cliSessionId.toLowerCase();
  return liveSessions(roots, alive).find((session) => session.sessionId.toLowerCase() === wanted);
}

/**
 * The subset of a known installation this needs — deliberately narrower than
 * `KnownStore` (`src/engine/stores.ts`), so this module never has to import the
 * engine layer just to describe the shape it reads.
 */
export interface HostCandidate {
  root: string;
  /** The name it was registered under, when it has one. */
  name?: string;
  /** The account this installation last recorded — `readConfig(store).lastKnownAccountUuid`. */
  accountUuid?: string;
  /** Whether the directory is still there; a gone store cannot hold a live card. */
  exists: boolean;
}

/**
 * An index from a CLI session id to the store whose card names it.
 *
 * The registry's `sessionId` is the CLI's own id for the conversation
 * (`93dd914b-…`). The card the app writes is named after a *different* id — the
 * app's own session id (`local_360c2711-….json`) — and carries the CLI id
 * inside itself, as the `cliSessionId` field. So the link between a registry
 * entry and the store hosting it cannot be found by filename at all; it only
 * exists by reading cards and comparing that field. (`storeHoldsSession` in
 * `paths.ts` checks the opposite pairing — a card's *own* id against
 * `CLAUDE_CODE_HOST_SESSION_ID` — and stays right for that.)
 *
 * Built once per set of candidate stores rather than once per registry entry:
 * `foster live` and `app status` ask this question of every live session, and
 * the card tree does not get any smaller for asking about them one at a time.
 * Only existing stores are scanned — a store whose directory is gone cannot
 * hold a card — and an unreadable or malformed card is skipped rather than
 * read as evidence of anything. The first store (in the order given) whose
 * card claims an id wins, matching the linear scan this replaces.
 */
export function buildHostedIndex(stores: HostCandidate[]): Map<string, HostCandidate> {
  const index = new Map<string, HostCandidate>();
  for (const store of stores) {
    if (!store.exists) continue;
    const layout = layoutFor(store.root);
    for (const account of listAccountDirs(layout)) {
      const dir = accountDir(layout, account);
      for (const entry of safeReaddir(dir)) {
        if (!isSessionFileName(entry)) continue;
        const cliSessionId = readCliSessionId(path.join(dir, entry));
        if (!cliSessionId) continue;
        const key = cliSessionId.toLowerCase();
        if (!index.has(key)) index.set(key, store);
      }
    }
  }
  return index;
}

/**
 * Which known installation is hosting a registry entry, if any.
 *
 * Looks the entry's CLI session id up in an index built by `buildHostedIndex` —
 * see there for why a card has to be read to answer this at all.
 *
 * A terminal session (any entrypoint but `'claude-desktop'`) is never looked
 * up: it did not come from an installation at all, so a card that happens to
 * carry its id as `cliSessionId` would be a coincidence, not an answer. A
 * hosted entry whose card cannot be found — deleted since, or in a store
 * foster does not know about — comes back `undefined` rather than a guess at
 * the likeliest one.
 */
export function hostedStoreFor(
  session: { sessionId: string; entrypoint?: string },
  index: Map<string, HostCandidate>,
): HostCandidate | undefined {
  if (session.entrypoint !== 'claude-desktop') return undefined;
  return index.get(session.sessionId.toLowerCase());
}

function readRegistryFile(file: string): Omit<LiveCliSession, 'registryFile'> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pid = parsed.pid;
    const sessionId = parsed.sessionId;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const procStartedAt =
      typeof parsed.procStart === 'string' ? filetimeToEpochMs(parsed.procStart) : undefined;
    // The record's own `startedAt` is when the session began; the file's mtime is
    // the fallback, and both answer the only question asked of them — whether a
    // process that started later can possibly be the one described here.
    const recordedAt =
      typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
        ? parsed.startedAt
        : mtimeOf(file);
    return {
      pid,
      sessionId,
      ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.entrypoint === 'string' ? { entrypoint: parsed.entrypoint } : {}),
      identity: {
        pid,
        ...(procStartedAt !== undefined ? { procStartedAt } : {}),
        ...(recordedAt !== undefined ? { recordedAt } : {}),
      },
    };
  } catch {
    // A torn or foreign file is not a live session.
    return undefined;
  }
}

/**
 * A Windows FILETIME as epoch milliseconds.
 *
 * The CLI writes the writer's creation time the way Windows reports it: ticks of
 * 100 nanoseconds since 1601. The process table is read to the millisecond, so
 * the tick count is truncated the same way rather than rounded, and the two land
 * on the same number for the same process.
 */
function filetimeToEpochMs(value: string): number | undefined {
  if (!/^\d{1,20}$/.test(value)) return undefined;
  const ticks = BigInt(value);
  if (ticks <= 0n) return undefined;
  const ms = Number(ticks / 10_000n) - 11_644_473_600_000;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** When the file was last written — the fallback for a record with no time of its own. */
function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
