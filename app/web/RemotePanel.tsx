/**
 * The parts of the panel that differ for a remote loop.
 *
 * A remote loop is a loop cluster on the canvas and most of the panel is the
 * same: the name, the prompt, the member strip, the files. What differs is here,
 * in four pieces, so `FactoryView` grows a few branches rather than a thousand
 * lines:
 *
 * - `RemoteBar`: the strip above the member tabs that says which flock, which
 *   cluster, what state, what it costs, and how the sync is doing - with the
 *   "Sign in to resume syncing" banner when the factory has lost its token.
 * - `RemoteSettings`: the node count (no local ceiling), the ring radius, the
 *   task size, the flock options and which connection, in place of the local
 *   cluster row.
 * - `RemoteOutput`: three views over the bottom half. ACP is the node's own
 *   transcript, fetched as markdown from the flock every ten seconds while
 *   visible; Console is its process log; Bridge is the factory's own system
 *   lines about moving items.
 * - `remoteProblems`: the client-side mirror of `server/flock/validate.ts`, so
 *   the Start button can be disabled with the reason before the server says it.
 */
import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Icon } from './Icon.tsx';
import { api, type FlockConnectionView, type RemoteSessions, type RemoteStream } from './api.ts';
import {
  REMOTE_ALGORITHMS,
  REMOTE_TASK_SIZES,
  remoteMinSize,
  type Factory,
  type Loop,
  type LoopStatus,
  type OutputLine,
  type RemoteAlgorithm,
  type RemoteLoop,
  type RemoteStatus,
  type RemoteTaskSize,
} from './types.ts';
import { useDismissOnOutside } from './useDismissOnOutside.ts';

/** One line per algorithm, for the select's tooltip and the option titles. */
const ALGORITHM_WORDS: Record<RemoteAlgorithm, string> = {
  amorphous: 'amorphous: a ring, each node reads its neighbours within the radius',
  mesh: 'mesh: every node reads every other node',
  swarm: 'swarm: each node reads the K most recently active nodes',
  single: 'single: no peers; each node works the direction alone, so N nodes are N independent runs',
};

/** How often the ACP and console views refresh while visible. The flock's own UI uses ten. */
const STREAM_MS = 10_000;

/* ---------------------------------------------------------------- problems */

const TOKEN_RE = /(?<![A-Za-z0-9_-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
/** Mirrors `REMOTE_RESERVED` in `server/mcp.ts`: the words a remote prompt may use. */
export const REMOTE_RESERVED = new Set(['input', 'output', 'loop', 'environment', 'browser', 'deploy']);

/**
 * What stops a remote loop from starting, as the panel can tell. Mirrors
 * `startProblems` on the server; the server's answer is authoritative and is
 * shown verbatim when they differ.
 */
export function remoteProblems(loop: Loop, factory: Factory, connections: FlockConnectionView[], models?: string[]): string[] {
  const out: string[] = [];
  if (loop.remote === undefined) return out;
  const connection = connections.find((c) => c.id === loop.remote!.connection);
  if (loop.remote.connection.length === 0 || connection === undefined) out.push('pick a flock connection');
  else if (!connection.signedIn) out.push(`sign in to ${connection.name}`);
  else if (connection.queueRoutes === false) out.push(`update your flock ${connection.name} to use remote loops`);
  const params = new Set((factory.parameters ?? []).map((p) => p.name.toLowerCase()));
  for (const name of params) {
    if (REMOTE_RESERVED.has(name)) out.push(`parameter ${name} shadows @${name}, a path on the flock`);
  }
  const seen = new Set<string>();
  for (const m of loop.prompt.matchAll(TOKEN_RE)) {
    const t = m[1].toLowerCase();
    if (seen.has(t)) continue;
    seen.add(t);
    if (t === 'project') out.push('@project: remote agents have no checkout; upload the project to the flock and name @environment');
    else if (!REMOTE_RESERVED.has(t) && !params.has(t)) out.push(`@${m[1]}: no MCP servers, skills or steering files on the flock`);
  }
  if (loop.model !== undefined && models !== undefined && !models.includes(loop.model)) out.push(`model ${loop.model} is not offered by this flock`);
  if (loop.prompt.trim().length === 0) out.push('the prompt is empty');
  return out;
}

/* --------------------------------------------------------------------- bar */

/**
 * The cluster id, as a button that copies it.
 *
 * It is on the bar from the moment the loop has a connection, before the first
 * Start, because the id is derived (connection, factory, loop) rather than
 * assigned by the flock - and the reason to copy it is to point the flock's own
 * tools at the cluster's folder (`env_upload` a project into it, `coder_attach`
 * to watch it), which an operator does *before* starting as often as after.
 */
function ClusterId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="remote-id"
      type="button"
      title={`The cluster id on the flock, derived from this factory, this loop and the connection. Click to copy.\n\nIts folder on the flock is environment/${id}/ - the prefix to give env_upload, env_download_all or coder_attach.`}
      aria-label={`Copy cluster id ${id}`}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }).catch(() => undefined);
      }}
    >
      {id}
      <Icon name={copied ? 'hero-check' : 'hero-clipboard'} />
    </button>
  );
}

const SYNC_WORDS: Record<RemoteStatus['sync'], string> = {
  live: '',
  'catching-up': 'collecting output produced while the factory was away',
  'signed-out': 'not syncing',
  unreachable: 'flock not reachable, retrying',
};

export function RemoteBar({
  remote,
  connection,
  onSignIn,
}: {
  remote: RemoteStatus | undefined;
  connection: FlockConnectionView | undefined;
  onSignIn: () => void;
}) {
  const state = remote?.clusterState ?? 'unknown';
  const seen = remote?.lastSeenAt ? new Date(remote.lastSeenAt) : null;
  return (
    <div className={`remote-bar sync-${remote?.sync ?? 'live'}`}>
      <div className="remote-bar-row">
        <Icon name="hero-cloud" />
        <span className="remote-conn" title={connection?.apiUrl ?? ''}>{connection?.name ?? remote?.connection ?? 'no connection'}</span>
        {remote !== undefined && (
          <>
            <ClusterId id={remote.clusterId} />
            <span className={`remote-state ${state}`} title={remote.stateReason ? `reason: ${remote.stateReason}` : ''}>
              {state}
              {remote.stateReason && state === 'paused' ? ` (${remote.stateReason})` : ''}
              {remote.sync === 'signed-out' && seen !== null ? ` (last seen ${seen.toLocaleTimeString()})` : ''}
            </span>
            {typeof remote.infraCostUsd === 'number' && (
              <span className="remote-cost" title="Estimated Fargate cost for this run, from the flock. Paused clusters still bill for the tasks.">
                ${remote.infraCostUsd.toFixed(2)} infra
              </span>
            )}
            <span className="remote-queues" title="Items waiting in the cluster's inbox / results waiting to be collected">
              in {remote.inboxPending ?? 0} · out {remote.outboxPending ?? 0}
            </span>
            <a className="remote-open" href={remote.uiUrl} target="_blank" rel="noopener noreferrer" title="Open this cluster in the flock's own dashboard, in a new tab. The dashboard needs its own sign-in.">
              Open Kiro Flock
            </a>
          </>
        )}
      </div>
      {remote?.sync === 'signed-out' && (
        <div className="remote-banner">
          <Icon name="hero-exclamation-triangle" />
          <span>
            <strong>Sign in to resume syncing.</strong> The cluster is still running; nothing is lost. Output accumulates on the flock until you sign in.
          </span>
          <button onClick={onSignIn}>Sign in</button>
        </div>
      )}
      {remote !== undefined && remote.sync !== 'signed-out' && SYNC_WORDS[remote.sync] && (
        <div className="remote-note">{SYNC_WORDS[remote.sync]}</div>
      )}
      {remote?.lastError && <div className="remote-note error">{remote.lastError}</div>}
      {remote?.problem && <div className="remote-note error">{remote.problem}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

export function RemoteSettings({
  loop,
  running,
  connections,
  cap,
  onChange,
  onPickConnection,
}: {
  loop: Loop;
  running: boolean;
  connections: FlockConnectionView[];
  /** The flock's node cap, as a hint only. The flock enforces it on Start. */
  cap: number | undefined;
  onChange: (patch: Partial<Loop>) => void;
  onPickConnection: () => void;
}) {
  const remote = loop.remote!;
  const algorithm: RemoteAlgorithm = remote.algorithm ?? 'amorphous';
  const min = remoteMinSize(algorithm);
  const size = loop.cluster?.size ?? min;
  const maxRadius = Math.max(1, Math.floor(size / 2));
  const maxK = Math.max(1, size - 1);
  const locked = running ? 'Stop this loop to change how its cluster is put together. Mode, size, radius, K and task size are fixed while it runs; a change made on the flock\'s dashboard shows up here.' : undefined;
  const connection = connections.find((c) => c.id === remote.connection);
  /** A size that respects the floor of the mode, with radius and K kept inside their ranges for it. */
  const resize = (n: number, algo: RemoteAlgorithm): Partial<Loop> => {
    const s = Math.max(remoteMinSize(algo), Math.round(n) || remoteMinSize(algo));
    const next: Loop['remote'] = { ...remote, neighbourRadius: Math.min(remote.neighbourRadius ?? 1, Math.max(1, Math.floor(s / 2))) };
    if (algo === 'amorphous') delete next.algorithm;
    else next.algorithm = algo;
    if (algo === 'swarm') next.swarmK = Math.min(Math.max(1, s - 1), Math.max(1, remote.swarmK ?? Math.min(4, s - 1)));
    else delete next.swarmK;
    return { cluster: { mode: 'fixed', comms: 'flock', size: s }, remote: next };
  };
  return (
    <div className="cluster-settings remote-settings">
      <div className="remote-num">
        <span className="unit">flock</span>
        <button
          className="remote-pick-conn"
          disabled={running}
          title={locked ?? 'Which flock this loop runs on'}
          onClick={onPickConnection}
        >
          <Icon name="hero-cloud" />
          {connection?.name ?? (remote.connection ? `${remote.connection} (missing)` : 'pick a flock…')}
        </button>
      </div>
      <label className="remote-num">
        <span className="unit">mode</span>
      <select
        className={`remote-algo algo-${algorithm}`}
        value={algorithm}
        disabled={running}
        title={locked ?? `How the nodes talk to each other - the flock's coordination algorithm.\n\n${REMOTE_ALGORITHMS.map((a) => ALGORITHM_WORDS[a]).join('\n')}`}
        aria-label="Communication mode"
        onChange={(e) => onChange(resize(size, e.target.value as RemoteAlgorithm))}
      >
        {REMOTE_ALGORITHMS.map((a) => (
          <option key={a} value={a} title={ALGORITHM_WORDS[a]}>
            {a}
          </option>
        ))}
      </select>
      </label>
      <label className="remote-num" title={locked ?? `How many nodes the cluster runs. Every node is a Fargate task on the flock. ${algorithm === 'single' ? 'In single mode each node works alone, so this is how many independent runs you get. ' : ''}No limit here${cap !== undefined ? `; this flock allows up to ${cap}` : ''} - the flock decides on Start.`}>
        <span className="unit">nodes</span>
        <input
          type="number"
          min={min}
          step={1}
          value={size}
          disabled={running}
          onChange={(e) => onChange(resize(Number(e.target.value), algorithm))}
        />
        {cap !== undefined && size > cap && <span className="hint">over this flock's cap of {cap}</span>}
      </label>
      {algorithm === 'amorphous' && (
        <label className="remote-num" title={locked ?? `Ring radius: how many neighbours each way a node reads. 1..${maxRadius} for ${size} nodes.`}>
          <span className="unit">radius</span>
          <input
            type="number"
            min={1}
            max={maxRadius}
            step={1}
            value={remote.neighbourRadius ?? 1}
            disabled={running}
            onChange={(e) => onChange({ remote: { ...remote, neighbourRadius: Math.min(maxRadius, Math.max(1, Math.round(Number(e.target.value) || 1))) } })}
          />
        </label>
      )}
      {algorithm === 'swarm' && (
        <label className="remote-num" title={locked ?? `K: how many of the most recently active nodes each node reads. 1..${maxK} for ${size} nodes.`}>
          <span className="unit">K</span>
          <input
            type="number"
            min={1}
            max={maxK}
            step={1}
            value={remote.swarmK ?? Math.min(4, maxK)}
            disabled={running}
            onChange={(e) => onChange({ remote: { ...remote, swarmK: Math.min(maxK, Math.max(1, Math.round(Number(e.target.value) || 1))) } })}
          />
        </label>
      )}
      <label className="remote-num">
        <span className="unit">size</span>
      <select
        value={remote.taskSize ?? 'medium'}
        disabled={running}
        title={locked ?? 'Fargate task size per node. small 2 vCPU / 4 GiB, medium 4 / 8, large 8 / 16, xlarge 16 / 32.'}
        aria-label="Task size"
        onChange={(e) => onChange({ remote: { ...remote, taskSize: e.target.value as RemoteTaskSize } })}
      >
        {REMOTE_TASK_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      </label>
      <RemoteOptions remote={remote} prompt={loop.prompt} disabled={running} onChange={(next) => onChange({ remote: next })} />
      <span className="hint remote-fixed" title="Remote agents run kiro-cli with its default built-in tools plus the flock's own s3 MCP server. MCP servers, skills and steering files from this machine are not available, and there is no checkout of the project.">
        Remote agents use the flock's fixed tool set
      </span>
    </div>
  );
}

/**
 * The flock's per-cluster toggles, mirroring the "options" field of its own UI
 * minus idle → pause, which the factory already owns as the run mode select
 * ("wait for work" is the flock's autopause). One dropdown in the Tools menu's
 * clothes rather than three loose checkboxes, so the row stays one line. No
 * "all" row: these are unrelated switches, not a set to narrow.
 *
 * Browser has a word, `@browser`, and naming it in the prompt turns the tool on -
 * the same rule as a `@`-named MCP server locally, and `remoteTools` on the
 * server. The row is then ticked and fixed. Trust deploy is the exception: it lets
 * the cluster create resources in the flock's account, so only the tick turns it
 * on; `@deploy` in the prompt is a request this tick has to answer, and Start
 * refuses the pair. Reflect is a behaviour rather than a tool and has no word.
 */
const REMOTE_OPTIONS: readonly { key: 'browser' | 'trustDeploy' | 'selfOptimizing'; word?: string; label: string; what: string }[] = [
  { key: 'browser', word: 'browser', label: 'browser auto', what: "Give the nodes a headless browser (the flock's puppeteer MCP server). Also on when the prompt names @browser." },
  {
    key: 'trustDeploy',
    label: 'trust deploy',
    what: "Let the nodes deploy CDK stacks into the flock's account, within the flock's deploy boundary. Only this tick turns it on; @deploy in the prompt does not. Without it deploy_request answers deploy_disabled.",
  },
  { key: 'selfOptimizing', label: 'iter → reflect', what: 'Nodes append what they learned to their own directive after each turn.' },
];
function RemoteOptions({
  remote,
  prompt,
  disabled,
  onChange,
}: {
  remote: RemoteLoop;
  prompt: string;
  disabled: boolean;
  onChange: (next: RemoteLoop) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useDismissOnOutside(open, () => setOpen(false));
  const named = useMemo(() => new Set([...prompt.matchAll(TOKEN_RE)].map((m) => m[1].toLowerCase())), [prompt]);
  const isNamed = (o: (typeof REMOTE_OPTIONS)[number]): boolean => o.word !== undefined && named.has(o.word);
  const has = (o: (typeof REMOTE_OPTIONS)[number]): boolean => remote[o.key] === true || isNamed(o);
  const on = REMOTE_OPTIONS.filter(has);
  return (
    <details className="mcp-pick remote-options" ref={root} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary title="The flock's cluster tools. All off by default; the flock applies a change on the next start.">
        Tools: {on.length} of {REMOTE_OPTIONS.length}
      </summary>
      <div className="mcp-menu">
        {REMOTE_OPTIONS.map((o) => {
          const fixed = isNamed(o);
          return (
            <label key={o.key} className={fixed ? 'fixed' : ''} title={fixed ? `The prompt names @${o.word}, so this is on regardless. Remove it from the prompt to turn it off.` : o.what}>
              <input
                type="checkbox"
                checked={has(o)}
                disabled={disabled || fixed}
                // Only `true` is stored, so an unticked option is the absence of the
                // field and a clean document stays clean.
                onChange={(e) => onChange({ ...remote, [o.key]: e.target.checked ? true : undefined })}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </details>
  );
}
/* ------------------------------------------------------------------ output */

type View = 'acp' | 'console' | 'bridge';

export function RemoteOutput({
  factoryId,
  loop,
  member,
  status,
  bridgeLines,
}: {
  factoryId: string;
  loop: Loop;
  member: number;
  status: LoopStatus | undefined;
  bridgeLines: OutputLine[];
}) {
  const [view, setView] = useState<View>('acp');
  const [session, setSession] = useState<string>('live');
  const [stream, setStream] = useState<RemoteStream | null>(null);
  const [sessions, setSessions] = useState<RemoteSessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const live = (status?.state ?? 'stopped') !== 'stopped';
  const signedOut = status?.remote?.sync === 'signed-out';
  const starting = status?.remote?.clusterState === 'starting';
  /*
   * What to show in place of a stream that could not be fetched.
   *
   * The flock reaches a node with ECS Exec, and a task that is still coming up
   * answers with a paragraph about the execute command agent not running. That
   * is the normal state of a cluster for its first minute or two, not a fault,
   * and while the status says `starting` the panel says so and nothing else.
   * The same paragraph on a running cluster is one node not reachable yet
   * (a task being replaced, say); it is named as that and the poll retries.
   * Anything else is shown as the flock said it.
   */
  const shownError = useMemo(() => {
    if (error === null) return null;
    if (starting) return null;
    if (/execute command/i.test(error)) return 'Node not reachable yet. The flock retries every ten seconds.';
    return error;
  }, [error, starting]);

  // Reset the session pick when the node changes: a session id belongs to one node.
  useEffect(() => {
    setSession('live');
    setStream(null);
    setSessions(null);
  }, [loop.id, member]);

  useEffect(() => {
    if (view === 'bridge' || !visible || signedOut) return;
    if (!live && stream !== null && session === 'live') return;
    let cancelled = false;
    const kind = view === 'console' ? 'console' : 'acp';
    const fetchOnce = () => {
      api
        .remoteStream(factoryId, loop.id, member, kind, session === 'live' ? undefined : session)
        .then((r) => {
          if (cancelled) return;
          setStream(r);
          setError(null);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });
    };
    fetchOnce();
    // A past session does not change; one fetch is enough.
    if (session !== 'live') return () => { cancelled = true; };
    const timer = setInterval(fetchOnce, STREAM_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [factoryId, loop.id, member, view, session, visible, live, signedOut]);

  useEffect(() => {
    if (view !== 'acp' || !visible || signedOut) return;
    api.remoteSessions(factoryId, loop.id, member).then(setSessions).catch(() => undefined);
  }, [factoryId, loop.id, member, view, visible, signedOut, stream?.sessionId]);

  const html = useMemo(() => {
    if (view !== 'acp' || !stream?.content) return '';
    return DOMPurify.sanitize(marked.parse(stream.content, { async: false }));
  }, [view, stream?.content]);

  return (
    <div className="remote-out">
      <div className="remote-out-bar">
        <div className="seg" role="tablist">
          {(['acp', 'console', 'bridge'] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'acp' ? 'ACP' : v === 'console' ? 'Console' : 'Bridge'}
            </button>
          ))}
        </div>
        {view === 'acp' && (
          <select
            className="remote-iter"
            value={session}
            onChange={(e) => setSession(e.target.value)}
            title="Which iteration's transcript to show. Live follows the current one."
          >
            <option value="live">Live</option>
            {(sessions?.sessions ?? [])
              .slice()
              .reverse()
              .map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  iteration {s.iteration + 1}
                  {s.active ? ' (active)' : ''} · {(s.sizeBytes / 1024).toFixed(0)} KB
                </option>
              ))}
          </select>
        )}
        {view !== 'bridge' && stream?.fetchedAt && (
          <span className="hint remote-fetched" title="The flock returns the last 22 KB of the transcript; older output is not in the live view. Each fetch is one command on the node, so this refreshes every 10 seconds while visible.">
            {new Date(stream.fetchedAt).toLocaleTimeString()}
            {signedOut ? ' · not updating' : ''}
          </span>
        )}
      </div>
      <div className="remote-out-body">
        {view === 'bridge' ? (
          <div className="output">
            {bridgeLines.length === 0 ? (
              <span className="empty">Nothing yet. The bridge logs here when it moves items to or from the cluster.</span>
            ) : (
              bridgeLines.map((line, i) => (
                <div key={i} className={`line ${line.kind}`}>
                  {line.text}
                </div>
              ))
            )}
          </div>
        ) : starting && (error !== null || stream === null || stream.content === null) ? (
          <span className="empty">Starting… the node's task is coming up on the flock, which takes a minute or two. Output appears here once it is reachable.</span>
        ) : shownError !== null ? (
          <span className="empty">{shownError}</span>
        ) : stream === null ? (
          <span className="empty">{live ? 'Fetching from the node…' : 'Start the loop to see its nodes.'}</span>
        ) : stream.content === null ? (
          <span className="empty">{stream.unavailable ?? 'nothing yet'}</span>
        ) : view === 'console' ? (
          <pre className="remote-console">{stream.content}</pre>
        ) : (
          <>
            <div className="kn-md" dangerouslySetInnerHTML={{ __html: html }} />
            {stream.turnError && <div className="remote-turn-error">{stream.turnError}</div>}
          </>
        )}
      </div>
    </div>
  );
}
