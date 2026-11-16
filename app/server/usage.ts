/**
 * Cost of a loop's iterations, read from the files kiro-cli itself writes.
 *
 * kiro-cli persists per-turn metering in the session sidecar
 * `~/.kiro/sessions/cli/<sessionId>.json`, under
 * `session_state.conversation_metadata.user_turn_metadatas[].metering_usage`, as
 * `{ value, unit: "credit" }` entries. Each iteration is one ACP session, so the
 * sum of those values is what the iteration cost. There is no token count and no
 * price table here: the sidecar already holds credits multiplied by the model's
 * rate, and the dollar figure is a single constant applied in the browser.
 *
 * Every finished iteration appends one line to a ledger under the factory's
 * `.kirofactory/usage/`, tagged with the id of the server run that wrote it. The
 * ledger is what the run history is built from. The live totals on the canvas
 * count only the current run, because a server restart starts the cost over.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { INTERNAL } from './factory.ts';

/** One finished iteration, as written to the ledger. */
export interface UsageEntry {
  ts: string;
  /** Which server run wrote it. See `newRunId`. */
  runId: string;
  /** The runner key: a loop id, or `<loopId>#<n>` for a cluster member. */
  key: string;
  loopId: string;
  loopName: string;
  iteration: number;
  sessionId?: string;
  /** Absent when the turn was not metered. */
  credits?: number;
  unmetered: boolean;
  startedAt: string;
  durationMs: number;
  stopReason: string;
  /** Running credit total of this runner within this run, carried forward. */
  totalCredits: number;
}

export interface UsageTotals {
  credits: number;
  /** How many finished iterations carried no metering. */
  unmetered: number;
}

/** One server run in the history popup. */
export interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  iterations: number;
  credits: number;
  unmetered: number;
  loops: Array<{
    key: string;
    loopName: string;
    iterations: number;
    credits: number;
    unmetered: number;
  }>;
}

/** An id for this server process: its start time plus a short random tail. */
export function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${rand}`;
}

/**
 * Where kiro-cli keeps its session files. `KIRO_SESSIONS_DIR` overrides it so a
 * test can point at a fixture.
 */
function sessionsDir(): string {
  return process.env.KIRO_SESSIONS_DIR ?? path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sum the credit metering recorded for a session: the kiro-cli sidecar first, then
 * the `--v3` layout.
 *
 * Null when the file is missing or unreadable or holds no metering entries, which
 * is also what a turn that was killed before it finished looks like.
 */
export async function readSessionCredits(sessionId: string): Promise<number | null> {
  return (await readSidecarCredits(sessionId)) ?? (await readV3Credits(sessionId));
}

/**
 * The `--v3` engine keeps a session at `~/.kiro/sessions/<workspace hash>/<id>/` and
 * has no sidecar in `cli/`. Its metering is a `usage_summary` record in
 * `messages.jsonl`, one per prompt turn, with credits under `promptTurnSummaries`.
 * The folder is keyed by a hash of the workspace, so it is found by looking for the
 * session id under each one.
 */
async function readV3Credits(sessionId: string): Promise<number | null> {
  try {
    const root = path.dirname(sessionsDir());
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'cli') continue;
      let text: string;
      try {
        text = await readFile(path.join(root, entry.name, sessionId, 'messages.jsonl'), 'utf8');
      } catch {
        continue;
      }
      let credits = 0;
      let seen = false;
      for (const line of text.split('\n')) {
        if (!line.includes('usage_summary')) continue;
        try {
          const payload = (JSON.parse(line) as { payload?: { type?: unknown; promptTurnSummaries?: unknown } }).payload;
          if (payload?.type !== 'usage_summary' || !Array.isArray(payload.promptTurnSummaries)) continue;
          for (const m of payload.promptTurnSummaries as Array<{ usage?: unknown; unit?: unknown }>) {
            const unit = typeof m.unit === 'string' ? m.unit.toLowerCase() : 'credit';
            if (typeof m.usage === 'number' && Number.isFinite(m.usage) && unit.startsWith('credit')) {
              credits += m.usage;
              seen = true;
            }
          }
        } catch {
          // A torn line is skipped; the rest of the file still counts.
        }
      }
      return seen ? credits : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function readSidecarCredits(sessionId: string): Promise<number | null> {
  try {
    const doc = JSON.parse(await readFile(path.join(sessionsDir(), `${sessionId}.json`), 'utf8')) as {
      session_state?: {
        conversation_metadata?: {
          user_turn_metadatas?: Array<{
            metering_usage?: Array<{ value?: unknown; unit?: unknown }>;
          }>;
        };
      };
    };
    const turns = doc.session_state?.conversation_metadata?.user_turn_metadatas;
    if (!Array.isArray(turns)) return null;
    let credits = 0;
    let seen = false;
    for (const turn of turns) {
      for (const m of turn.metering_usage ?? []) {
        const unit = typeof m.unit === 'string' ? m.unit.toLowerCase() : 'credit';
        if (typeof m.value === 'number' && Number.isFinite(m.value) && unit.startsWith('credit')) {
          credits += m.value;
          seen = true;
        }
      }
    }
    return seen ? credits : null;
  } catch {
    return null;
  }
}

/**
 * `readSessionCredits` with retries. kiro-cli flushes the sidecar asynchronously
 * around process exit, so one read straight after the turn races it: the file may
 * be missing or not yet hold the metering entries.
 */
export async function readSessionCreditsWithRetry(
  sessionId: string,
  attempts = 4,
  delayMs = 2500,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const credits = await readSessionCredits(sessionId);
    if (credits !== null) return credits;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

function usageDir(home: string): string {
  return path.join(home, INTERNAL, 'usage');
}

/** The ledger file for a runner key. `#` is not a safe filename character everywhere. */
function ledgerFile(home: string, key: string): string {
  return path.join(usageDir(home), `${key.replace(/#/g, '-m')}.ndjson`);
}

/**
 * Append one line to the ledger. Never throws: a ledger that cannot be written
 * costs a line of history, and must not cost the iteration. Returns whether the
 * line landed.
 */
export async function appendUsage(home: string, entry: UsageEntry): Promise<boolean> {
  try {
    const dir = usageDir(home);
    // The first write creates the folder and the ignore file with it, so the
    // ledger never shows up as churn in a project that commits `.kirofactory`.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.gitignore'), '*\n!.gitignore\n', { flag: 'wx' }).catch(
      () => undefined,
    );
    await appendFile(ledgerFile(home, entry.key), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    console.error(`usage ledger write failed for ${entry.key}:`, err);
    return false;
  }
}

function parseLines(text: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (typeof e.runId === 'string' && typeof e.key === 'string' && typeof e.iteration === 'number') {
        out.push(e);
      }
    } catch {
      // A torn or foreign line is skipped; the rest of the file still counts.
    }
  }
  return out;
}

/** Every ledger entry for one runner key, oldest first. Empty when there is none. */
export async function readUsage(home: string, key: string): Promise<UsageEntry[]> {
  try {
    return parseLines(await readFile(ledgerFile(home, key), 'utf8'));
  } catch {
    return [];
  }
}

/** Every ledger entry for the whole factory, oldest first. */
export async function readAllUsage(home: string): Promise<UsageEntry[]> {
  let names: string[];
  try {
    names = (await readdir(usageDir(home))).filter((n) => n.endsWith('.ndjson'));
  } catch {
    return [];
  }
  const all: UsageEntry[] = [];
  for (const name of names) {
    try {
      all.push(...parseLines(await readFile(path.join(usageDir(home), name), 'utf8')));
    } catch {
      // Unreadable file: skip it, the others still count.
    }
  }
  return all.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Credits and unmetered count over a list of entries. */
export function summarise(entries: UsageEntry[]): UsageTotals {
  let credits = 0;
  let unmetered = 0;
  for (const e of entries) {
    if (e.credits !== undefined) credits += e.credits;
    if (e.unmetered) unmetered += 1;
  }
  return { credits, unmetered };
}

/** Group a factory's ledger by server run, newest run first. */
export function groupRuns(entries: UsageEntry[]): RunSummary[] {
  const byRun = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const list = byRun.get(e.runId);
    if (list) list.push(e);
    else byRun.set(e.runId, [e]);
  }
  const runs: RunSummary[] = [];
  for (const [runId, list] of byRun) {
    const first = list.reduce((a, e) => (e.startedAt < a ? e.startedAt : a), list[0]!.startedAt);
    const last = list.reduce((a, e) => (e.ts > a ? e.ts : a), list[0]!.ts);
    const byKey = new Map<string, UsageEntry[]>();
    for (const e of list) {
      const k = byKey.get(e.key);
      if (k) k.push(e);
      else byKey.set(e.key, [e]);
    }
    const total = summarise(list);
    runs.push({
      runId,
      startedAt: first,
      endedAt: last,
      durationMs: Math.max(0, Date.parse(last) - Date.parse(first)),
      iterations: list.length,
      credits: total.credits,
      unmetered: total.unmetered,
      loops: [...byKey.entries()].map(([key, es]) => ({
        key,
        loopName: es[es.length - 1]!.loopName,
        iterations: es.length,
        ...summarise(es),
      })),
    });
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
