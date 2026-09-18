/**
 * One turn: spawn `kiro-cli acp`, open a session, send the prompt, stream the
 * output, tear down.
 *
 * Harvested from the previous engine and trimmed. A fresh session every pass is
 * the point, not an accident: context never accumulates, so a loop's memory is
 * whatever it left on disk rather than a conversation that grows until it falls
 * over. That also means a turn can die mid-flight and cost one iteration instead
 * of the run.
 *
 * Two things a turn can carry besides the prompt: a model id, which becomes a
 * spawn flag, and an MCP scope, which decides whether the agent loads the
 * machine's own server config or only what the request grants (see
 * SCOPED_AGENT). Tool *permission* gating is a separate axis and remains
 * allow-everything - see ALLOW_ALL_TOOLS below, which is worth reading before
 * you run this on a machine you care about.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { GrantedServer } from './mcp.ts';

export interface TurnRequest {
  /** Working directory of the session. */
  cwd: string;
  /** The instruction. The same text every pass, by design. */
  prompt: string;
  /**
   * MCP servers this turn runs with.
   *
   * Absent means trusted: the agent loads whatever its own machine config
   * enables, which is every loop's default. An array means scoped: the turn runs
   * under a generated agent that loads no machine config at all and declares
   * exactly these - possibly none - in its own `mcpServers`. See `ensureAgent`.
   */
  mcp?: GrantedServer[];
  /**
   * Built-in tool tags this turn runs with (`read`, `write`, `shell`, ...).
   *
   * Absent means all of them. An array means only these - the agent's `tools`
   * field carries exactly this list plus the MCP entries, so a loop narrowed to
   * `read` genuinely cannot write, not merely is asked not to.
   */
  tools?: string[];
  /** Model id to run on. Absent means kiro-cli's own default. */
  model?: string;
  /**
   * Abort this turn now.
   *
   * A graceful stop never uses this - it lets the turn drain. This is the force
   * stop: the subprocess is killed where it stands, and `runTurn` rejects rather
   * than inventing a result for a turn that never finished. The agent may have
   * been halfway through editing files; whoever aborts owns that trade.
   */
  signal?: AbortSignal;
  /**
   * A line kiro-cli wrote to stderr: a server that would not connect, an agent it
   * could not resolve, a tool it excluded for a name too long.
   *
   * Forwarded rather than discarded, and it should have been from the start. This
   * is the only place the agent gives its own account of its setup, and with the
   * stream thrown away a loop scoped to a server that never loaded looked exactly
   * like one working perfectly - the first clue was the agent remarking, four
   * paragraphs into a turn, that it could not find the tools it had been promised.
   */
  onNote?: (text: string) => void;
  /** Called with every text chunk the agent produces. */
  onText?: (text: string) => void;
  /**
   * Called when a tool call starts, and again only if it fails.
   *
   * Not once per status change: see the `tools` map in `KiroDriver.runTurn` for
   * why a call that is merely progressing has nothing new to say.
   */
  onTool?: (info: { title: string; kind?: string; status?: string }) => void;
}

export interface TurnResult {
  /** ACP stop reason, or a synthetic one. */
  stopReason: string;
  /** Everything the agent said, concatenated. */
  text: string;
}

export interface Driver {
  readonly name: string;
  runTurn(req: TurnRequest): Promise<TurnResult>;
}

/**
 * Every tool call is permitted.
 *
 * This is a deliberate trade and the honest place to state it. A permission gate
 * with no UI to configure it is not a safety feature, it is a silent blocker: the
 * old engine defaulted to read+edit only, so any loop that needed to run a build
 * had its tool calls refused with no way to say otherwise and no visible reason.
 *
 * These loops are autonomous by construction - nobody is sitting there approving
 * file writes - so the real containment is the working directory you point them
 * at and the prompt you give them. Treat a running loop as something with your
 * shell, and run it in a dedicated, version-controlled directory.
 *
 * If you want a gate back, narrow this array; it is matched against the ACP tool
 * kind on each permission request.
 */
const ALLOW_ALL_TOOLS = true;
const ALLOWED_KINDS: readonly string[] = [
  'read',
  'edit',
  'execute',
  'search',
  'fetch',
  'move',
  'delete',
  'think',
  'other',
];

/**
 * The agent a scoped or narrowed turn runs under.
 *
 * Scoping is entirely this file's job, and it is two fields. `includeMcpJson:
 * false` takes the machine's servers away; the agent's own `mcpServers` map puts
 * the granted ones back. That map is where kiro-cli expects a scoped agent's
 * servers to be declared, it takes the same entry shape mcp.json uses, and it
 * sits above both config files in the load order - so it works for a remote
 * server behind OAuth exactly as it does for a local binary.
 *
 * It used to be done through `session/new` instead, and that was the bug behind a
 * long afternoon: that channel carries stdio servers only. A loop scoped to a
 * remote server ran under an agent with mcp.json suppressed and nothing put back,
 * so it had no MCP tools whatsoever - while the panel reported a grant and the
 * prompt described the server as available.
 *
 * Built-in tools are the other axis. A custom agent gets only what its `tools`
 * field lists - omitting the field is what silently took `write` and `shell` away
 * from scoped loops - so the field is always written, as `@builtin` when the loop
 * is unrestricted and as the loop's exact tags when it is not.
 *
 * `@mcp` means "every server from mcp.json", so it is written only when mcp.json
 * is included. Under a scope it would resolve to nothing, which made it read like
 * a safety net that was never there. The granted servers are listed individually
 * as `@name`, and now those names refer to entries this same file declares.
 *
 * The file is named by a hash of its own content, because the content varies per
 * loop configuration: two loops with the same scope share one file, a changed
 * scope becomes a new file rather than an edit racing another loop's turn, and the
 * write is idempotent so it needs no locking. Regenerated before every turn that
 * needs it, so a hand-edited or deleted copy heals itself. Stale hashes linger in
 * `.kiro/agents/` - a few hundred bytes each, and deleting them here could pull an
 * agent out from under a concurrent turn, so they are left.
 *
 * The entries can carry `env` or `headers`, which is where people keep tokens, and
 * this writes them into a file inside the directory the loops work in. Values
 * written as `${VAR}` stay references and expand at runtime, so a config that
 * keeps its secrets in the environment keeps them out of here too. For the ones
 * that do not, `ignoreGeneratedAgents` keeps these files out of the operator's
 * commits - see it for why the pattern is narrow.
 */
async function ensureAgent(
  cwd: string,
  input: { mcp?: GrantedServer[]; tools?: string[] },
): Promise<string> {
  const scoped = input.mcp !== undefined;
  const servers = input.mcp ?? [];
  const config = {
    description:
      'Generated by kirofactory for loops with scoped MCP access or narrowed tools. ' +
      'Do not edit - the file is rewritten, and its name is a hash of its content.',
    includeMcpJson: !scoped,
    // Only under a scope: a trusted turn has no grants to declare, and an empty
    // map alongside `includeMcpJson: true` would be noise.
    ...(scoped ? { mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) } : {}),
    tools: [
      ...(input.tools ?? ['@builtin']),
      ...(scoped ? [] : ['@mcp']),
      ...servers.map((s) => `@${s.name}`),
    ],
  };
  // The name has to be in the file as well as being the file's name: kiro-cli
  // resolves `--agent` against the config's own `name` field, and an agent
  // without one is silently passed over in favour of the default. Hashing the
  // config before the name is added keeps the name out of its own input.
  const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 8);
  const name = `kirofactory-${hash}`;
  const body = JSON.stringify({ name, ...config }, null, 2);
  const dir = path.join(cwd, '.kiro', 'agents');
  await fsp.mkdir(dir, { recursive: true });
  await ignoreGeneratedAgents(dir);
  await fsp.writeFile(path.join(dir, `${name}.json`), `${body}\n`, 'utf8');
  return name;
}

/**
 * The two lines that keep generated agents out of the operator's commits.
 *
 * The second one ignores the ignore file itself, and it is what makes *Release*
 * work. `git worktree remove` refuses a checkout holding anything untracked, not
 * only anything modified, and a `.gitignore` this program wrote is untracked in
 * every checkout after its first turn - so the app's own bookkeeping was the file
 * standing between the operator and the button. Git honours a `.gitignore` that
 * lists `.gitignore`; an ignored file does not block the remove.
 */
const AGENT_IGNORES = ['kirofactory-*.json', '.gitignore'];

/**
 * Keep generated agent files out of git, without hiding anybody else's.
 *
 * `.kiro/agents/` belongs to the project, not to this program: a repository can
 * perfectly well commit its own agents there, so an ignore file saying `*` would
 * quietly stop git seeing files the operator wrote and meant to keep. The pattern
 * is the generated prefix alone, which cannot match anything but ours.
 *
 * Worth doing at all because these files can hold credentials - an `env` or
 * `headers` value written literally in mcp.json is copied in verbatim - and they
 * are written into a directory the operator is committing from. A generated file
 * nobody asked for should not be the thing that puts a token in a diff.
 *
 * Appends rather than overwrites, and only the lines that are absent, so an
 * existing ignore file keeps whatever else it says - and a file written by an
 * earlier version that knew only the first pattern gains the second. Never throws:
 * failing to write this is not a reason to fail the turn, and the alternative - no
 * agent, so no scope - is worse than an unignored file.
 */
async function ignoreGeneratedAgents(dir: string): Promise<void> {
  const file = path.join(dir, '.gitignore');
  try {
    const existing = await fsp.readFile(file, 'utf8').catch(() => '');
    const lines = new Set(existing.split('\n').map((line) => line.trim()));
    const missing = AGENT_IGNORES.filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const header = lines.size <= 1 ? '# Written by kirofactory for loops with a scoped MCP or tool set.\n' : '';
    await fsp.appendFile(file, `${prefix}${header}${missing.join('\n')}\n`, 'utf8');
  } catch {
    // See above: a turn is worth more than this line.
  }
}

/** Real driver: kiro-cli in ACP mode over stdio. */
export class KiroDriver implements Driver {
  readonly name = 'kiro';
  private readonly command: string;

  constructor(command = 'kiro-cli') {
    this.command = command;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    let text = '';
    let stopReason = 'unknown';

    const app = acp
      .client({ name: 'loop-canvas' })
      .onRequest('session/request_permission', ({ params }) => {
        const kind = params.toolCall.kind ?? 'other';
        const allowed = ALLOW_ALL_TOOLS || ALLOWED_KINDS.includes(kind);
        req.onTool?.({
          title: params.toolCall.title ?? 'tool',
          kind,
          status: allowed ? 'allowed' : 'denied',
        });
        const wanted = allowed ? 'allow_once' : 'reject_once';
        const option = params.options.find((o) => o.kind === wanted) ?? params.options[0];
        // No option offered at all: cancel rather than guess. An unattended loop
        // must never fall through a permission prompt.
        if (!option) return { outcome: { outcome: 'cancelled' as const } };
        return { outcome: { outcome: 'selected' as const, optionId: option.optionId } };
      });

    // The default agent serves the loop that changed nothing; any departure -
    // scoped servers, narrowed tools - runs under a generated one.
    const agent =
      req.mcp !== undefined || req.tools !== undefined
        ? await ensureAgent(req.cwd, { mcp: req.mcp, tools: req.tools })
        : undefined;

    const proc = spawn(
      this.command,
      [
        'acp',
        // The model is a spawn flag rather than a session/set_model call because
        // every turn is a fresh process anyway - there is no session to switch.
        ...(req.model !== undefined ? ['--model', req.model] : []),
        ...(agent !== undefined ? ['--agent', agent] : []),
      ],
      {
        // stderr is piped rather than ignored: see `onNote`. stdout is the ACP
        // stream and must not be read by anything else.
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: req.cwd,
      },
    );

    /*
     * kiro-cli's diagnostics, line by line, while the turn runs.
     *
     * Split on newlines and held over between chunks, because a pipe hands over
     * whatever has arrived rather than whole lines, and half a warning is worse
     * than none. Blank lines are dropped; everything else goes straight through
     * without interpretation, since guessing which warnings matter is how the
     * interesting ones get filtered out.
     */
    if (req.onNote !== undefined) {
      const note = req.onNote;
      let pending = '';
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        // The last piece has no newline yet, so it waits for the next chunk.
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trim();
          if (text.length > 0) note(text);
        }
      });
      proc.stderr?.on('end', () => {
        const text = pending.trim();
        if (text.length > 0) note(text);
      });
    }

    /*
     * The process failing to start, or dying before it has answered.
     *
     * `spawn` does not throw for a binary that is not there. It emits `error` on
     * the child, asynchronously, and an `error` with no listener is an uncaught
     * exception: the whole server exited, every loop with it, on a Start pressed
     * without kiro-cli on PATH - the first-run mistake the README warns about. The
     * `catch` in `Runner.run` that exists for a failed turn never saw it, because
     * nothing rejected. This turns both `error` and a non-zero exit into a
     * rejection of the turn, so the runner reports `turn failed: spawn kiro-cli
     * ENOENT` and takes its next turn, which is the failure class a per-turn
     * condition deserves. `models.ts` has had the same two listeners all along.
     *
     * A non-zero exit is only an answer when the stream has not already given one:
     * the SDK reports a closed stream too, as "ACP connection closed", which is
     * true and says nothing about why, so the exit code wins the race when it
     * arrives first. The `finally` below kills the process after every turn and
     * that exit is by signal, not code, so it does not reject here - and the
     * promise is marked handled up front because by then nobody is waiting on it.
     */
    const died = new Promise<never>((_, reject) => {
      proc.on('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            err.code === 'ENOENT'
              ? `${this.command} could not be started - is it on the PATH? (${err.message})`
              : `${this.command} could not be started: ${err.message}`,
          ),
        ),
      );
      proc.on('exit', (code, signal) => {
        if (code !== null && code !== 0) reject(new Error(`${this.command} exited with code ${code}`));
        else if (signal !== null && !proc.killed) reject(new Error(`${this.command} was killed by ${signal}`));
      });
    });
    void died.catch(() => undefined);

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
      );
      const turn = app.connectWith(stream, async (ctx) => {
        await ctx.request('initialize', {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        // Always empty, both ways round. A trusted turn takes the machine's own
        // config; a scoped turn takes the `mcpServers` written into its generated
        // agent, which is the channel that works for every transport rather than
        // stdio alone. Declaring the same servers here as well would be a second
        // source for one fact, and this is where that fact used to go wrong.
        await ctx.buildSession({ cwd: req.cwd, mcpServers: [] }).withSession(async (session) => {
          /**
           * What each tool call is, by its id, for the length of the turn.
           *
           * ACP describes one tool call with two different notifications, and they
           * do not carry the same fields. The opening `tool_call` must have a
           * `title`; a following `tool_call_update` need only have the
           * `toolCallId`, and every other field on it is optional and nullable -
           * kiro-cli's status updates are exactly that, an id and a new status.
           *
           * So the name has to be remembered from the opening frame, because the
           * frames that follow do not repeat it. Without this every update fell
           * back to printing the raw id, which for a Bedrock-served model is the
           * provider's own `toolu_…` tool_use id: unreadable, and identifying a
           * call nobody can look up.
           *
           * Per turn, which needs no cleanup: each turn is a fresh process and a
           * fresh session, so the map dies with the closure that holds it.
           */
          const tools = new Map<string, { title: string; kind?: string }>();

          session.prompt(req.prompt);
          for (;;) {
            const msg = await session.nextUpdate();
            if (msg.kind === 'stop') {
              stopReason = msg.stopReason;
              return;
            }
            const u = msg.update;
            if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
              text += u.content.text;
              req.onText?.(u.content.text);
            } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content.type === 'text') {
              req.onText?.(u.content.text);
            } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
              /*
               * `name` before the id in the fallback chain: it is the tool's actual
               * name (`fs_read`) where `title` is a description of this particular
               * call ("Reading notes.md"). The description is the better line when
               * it is there, and the name is a far better last resort than an id.
               */
              const known = tools.get(u.toolCallId);
              const title = u.title ?? u.name ?? known?.title;
              const kind = u.kind ?? known?.kind;
              if (title !== undefined) {
                tools.set(u.toolCallId, { title, ...(kind !== undefined ? { kind } : {}) });
              }
              /*
               * One line when the call starts, and one more only if it failed.
               *
               * A tool going pending, in_progress, completed is three
               * notifications about one action, and reporting each of them made
               * every call three lines in the log of which two said nothing. A
               * failure is the exception: that is a different outcome and worth
               * saying out loud.
               */
              const status = u.status ?? undefined;
              if (u.sessionUpdate === 'tool_call' || status === 'failed') {
                req.onTool?.({
                  title: title ?? u.toolCallId,
                  ...(kind !== undefined ? { kind } : {}),
                  ...(status !== undefined ? { status } : {}),
                });
              }
            }
          }
        });
      });
      /*
       * The abort is raced rather than merely listened for. Killing the process
       * ends the stdout stream, but whether the SDK then rejects, resolves, or
       * sits on a read that never comes is its business, not a contract - and a
       * force stop that sometimes hangs is worse than none. The race guarantees
       * the rejection; the `finally` guarantees the kill; the swallowed `turn`
       * failure keeps the superseded promise from surfacing as an unhandled
       * rejection after we have already thrown on its behalf.
       */
      const racers: Promise<unknown>[] = [turn, died];
      if (req.signal) {
        const signal = req.signal;
        racers.push(
          new Promise<never>((_, reject) => {
            const bail = () => reject(new Error('aborted'));
            if (signal.aborted) bail();
            else signal.addEventListener('abort', bail, { once: true });
          }),
        );
      }
      await Promise.race(racers).catch((err) => {
        void turn.catch(() => undefined);
        throw err;
      });
    } finally {
      // Always kill the subprocess so orphans never stack up.
      proc.kill('SIGTERM');
    }

    return { stopReason, text };
  }
}

/**
 * Offline driver. Makes no model call: it echoes the prompt back. Lets the loop
 * mechanics be exercised without kiro-cli on PATH.
 */
export class EchoDriver implements Driver {
  readonly name = 'echo';
  private readonly reply: (req: TurnRequest) => string;

  constructor(reply: (req: TurnRequest) => string = (r) => `echo: ${r.prompt.slice(0, 200)}`) {
    this.reply = reply;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const text = this.reply(req);
    req.onText?.(text);
    return { stopReason: 'end_turn', text };
  }
}

export function defaultDriver(): Driver {
  return process.env.LOOP_DRIVER === 'echo'
    ? new EchoDriver()
    : new KiroDriver(process.env.KIRO_CLI ?? 'kiro-cli');
}
