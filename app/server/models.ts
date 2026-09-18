/**
 * Which models a loop can run on.
 *
 * kiro-cli knows; nobody else does. The catalogue depends on the subscription,
 * the region and the build, so a list kept here would be wrong within a month of
 * being written. Instead the server asks at startup: spawn `kiro-cli acp`, open a
 * session, and read the `models` block the protocol returns - the same answer the
 * model picker in any ACP editor is showing - then kill the process.
 *
 * Once, at startup, rather than per request. Models change when kiro-cli is
 * updated, which is also when this server gets restarted, and the question costs
 * a process spawn and a few seconds of session setup - not something to spend on
 * every page load. The result is a promise rather than a value so the one probe
 * is shared: a browser asking before discovery finishes waits for it instead of
 * triggering another.
 *
 * Discovery failing does not stop anything: loops run on the machine default, and
 * model selection is the only thing degraded. It is still worth saying so. A
 * failure and a genuinely empty catalogue are different facts, and flattening
 * both to an empty list makes a broken probe look like a subscription with no
 * models - indistinguishable from the feature not being there at all. So a
 * failure carries `failed` and a `reason`, which the caller uses to decide
 * whether to try again and the UI uses to say something honest.
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as readline from 'node:readline';

export interface ModelInfo {
  /** The id `kiro-cli acp --model` accepts. */
  id: string;
  name: string;
  description?: string;
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** What runs when a loop does not choose. Absent when discovery failed. */
  defaultId?: string;
  /**
   * The probe did not get an answer, so the empty list above means "unknown"
   * rather than "none". Absent on success, including a success that legitimately
   * offered no models.
   */
  failed?: true;
  /** Which failure, for the log and for the tooltip. Present with `failed`. */
  reason?: string;
}

/** How long the probe may take before it is written off. Session setup is slow. */
const DISCOVER_TIMEOUT_MS = 30_000;

export function discoverModels(command: string): Promise<ModelCatalog> {
  return new Promise((resolve) => {
    const failure = (reason: string): ModelCatalog => ({ models: [], failed: true, reason });
    let settled = false;
    const finish = (catalog: ModelCatalog): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGTERM');
      if (catalog.failed === true) {
        // Said once, where it can be found later. A failure that leaves no trace
        // is the reason a missing picker is a mystery rather than a bug report.
        console.error(`[models] discovery failed: ${catalog.reason}`);
      }
      resolve(catalog);
    };

    // In the temp directory, not any factory's baseDir: the probe wants the
    // catalogue, not whatever workspace agents and steering a project carries.
    const proc = spawn(command, ['acp'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: os.tmpdir() });
    proc.on('error', (err) => finish(failure(`${command} would not start: ${err.message}`)));
    proc.on('exit', (code) => finish(failure(`${command} exited (code ${code ?? '?'}) before answering`)));

    const timer = setTimeout(
      () => finish(failure(`no answer within ${DISCOVER_TIMEOUT_MS / 1000}s`)),
      DISCOVER_TIMEOUT_MS,
    );

    const rl = readline.createInterface({ input: proc.stdout! });
    const request = (id: number, method: string, params: unknown): void => {
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };

    /*
     * Only the two responses this probe asked for are of any interest.
     *
     * kiro-cli narrates a session opening: MCP servers coming up, the command list
     * being revised, a mode being set. Dozens of notifications, before the
     * `session/new` response and after it, and none of them addressed to us. An
     * earlier version of this checked every line for an `error` field and gave up
     * on finding one, which meant an MCP server failing to load could take the
     * model catalogue down with it - two unrelated things, one of them not even
     * asked for, because `mcpServers: []` below says this probe wants no servers.
     * So the id is checked first and everything unaddressed is dropped.
     */
    rl.on('line', (line) => {
      let msg: { id?: number; error?: { message?: unknown }; result?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      if (msg.id !== 1 && msg.id !== 2) return;
      if (msg.error !== undefined) {
        const detail =
          typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error);
        return finish(failure(`${msg.id === 1 ? 'initialize' : 'session/new'} failed: ${detail}`));
      }
      if (msg.id === 1) {
        request(2, 'session/new', { cwd: os.tmpdir(), mcpServers: [] });
      } else {
        finish(parseCatalog(msg.result));
      }
    });

    request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

/**
 * The `models` block of a `session/new` response, defensively.
 *
 * No block, or one that is not shaped like a catalogue, is a failure rather than an
 * empty catalogue: the session opened but did not say what it can run, so the answer
 * is unknown. An `availableModels` that is present and empty is not a failure - that
 * is a real answer, and it means this subscription offers nothing to choose between.
 */
function parseCatalog(result: unknown): ModelCatalog {
  const models = (result as { models?: unknown } | null)?.models as
    | { currentModelId?: unknown; availableModels?: unknown }
    | undefined;
  if (!models || !Array.isArray(models.availableModels)) {
    return { models: [], failed: true, reason: 'session/new returned no model catalogue' };
  }

  const list: ModelInfo[] = [];
  for (const m of models.availableModels) {
    const raw = m as { modelId?: unknown; name?: unknown; description?: unknown };
    if (typeof raw.modelId !== 'string' || raw.modelId.length === 0) continue;
    list.push({
      id: raw.modelId,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.modelId,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    });
  }
  return {
    models: list,
    ...(typeof models.currentModelId === 'string' ? { defaultId: models.currentModelId } : {}),
  };
}
