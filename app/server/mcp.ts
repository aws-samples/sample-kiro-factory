/**
 * Which MCP servers a loop can be told about.
 *
 * A loop's prompt can name a tool the same way it names a queue or the project
 * directory: `@input` is a
 * folder this loop reads, `@aws-docs` is an MCP server it can call. Both are
 * references the operator writes and the prompt resolves, and neither is a path or
 * a tool name the operator should have to remember.
 *
 * The list is read from kiro-cli's own configuration rather than kept here,
 * because kiro-cli is what actually loads the servers. So this file does not decide
 * what is available, it reports it - which is why disabled servers are dropped
 * rather than listed as unavailable.
 *
 * A trusted loop gets whatever that config enables, and this file's answer is only
 * used to describe those servers in the prompt. A scoped loop is different: its
 * grants are written into the generated agent's own `mcpServers` field, which sits
 * above both mcp.json files in kiro-cli's load order, and the agent is told not to
 * include mcp.json at all. That is why `config` is carried verbatim - the agent
 * file needs the entry in the same shape the config file wrote it, `oauth` blocks
 * and all. See `ensureAgent` in acp.ts.
 *
 * An earlier version translated entries into ACP's `session/new` shape instead.
 * That channel carries stdio servers only, so a loop scoped to a remote server got
 * an agent with mcp.json suppressed, nothing put back, and no tools at all.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface McpServer {
  /** The server's key in the config, and the token an operator types after `@'. */
  name: string;
  /** Where it was found. Workspace entries shadow user ones of the same name. */
  scope: 'user' | 'workspace';
  /**
   * The entry exactly as mcp.json wrote it, for a generated agent's own
   * `mcpServers` field.
   *
   * Carried verbatim rather than translated, and that is the point. kiro-cli owns
   * this schema - `command`/`args`/`env` for a local server, `url`/`headers` for a
   * remote one, plus `oauth`, `oauthScopes`, `timeout`, `requestTimeout` - and an
   * agent config takes the same shape a config file does. Anything this reader does
   * not recognise still reaches the agent, which is what a remote server behind
   * OAuth needs: its `oauth` block matters and nothing here understands it.
   *
   * See `ensureAgent` in acp.ts for where it lands. Agent config sits above both
   * mcp.json files in kiro-cli's load order, so a scoped loop's servers win.
   */
  config: AgentServerConfig;
}

/**
 * One server as an agent config spells it: mcp.json's own entry shape.
 *
 * Deliberately opaque. Naming the fields here would mean this file deciding what
 * kiro-cli supports, and it would silently drop whatever it had not been taught -
 * which is the bug this replaced. See `McpServer.config`.
 */
export type AgentServerConfig = Record<string, unknown>;

/** A granted server, as a turn hands it to the agent it will run under. */
export interface GrantedServer {
  name: string;
  config: AgentServerConfig;
}

/** Kiro's user-level MCP configuration. */
function userConfig(): string {
  return path.join(os.homedir(), '.kiro', 'settings', 'mcp.json');
}

/** A factory's base directory is the agent's cwd, so its workspace config is this. */
function workspaceConfig(baseDir: string): string {
  return path.join(baseDir, '.kiro', 'settings', 'mcp.json');
}

/**
 * The entry an agent config should carry for this server.
 *
 * A copy, minus `disabled`. The copy is so a later edit to the parsed config
 * cannot reach into a generated agent file; dropping `disabled` is because only
 * enabled servers get this far, and writing `disabled: false` into an agent would
 * be restating a fact by way of the one key that could turn the server off.
 *
 * Everything else survives untouched, including keys this file has never heard
 * of. An `env` value written as `${TOKEN}` stays a reference rather than being
 * expanded, which is what keeps secrets out of the agent file - see the security
 * note in the Kiro MCP configuration docs.
 */
function agentConfigOf(def: Record<string, unknown>): AgentServerConfig {
  const { disabled: _disabled, ...rest } = def;
  return rest;
}

/**
 * Servers from one config file, disabled ones included and flagged.
 *
 * Never throws. A missing file is the normal case for the workspace scope, and a
 * malformed one is not worth taking an endpoint down for: either way the answer is
 * that this file contributes nothing.
 *
 * Disabled entries are kept here and dropped by the caller *after* the two files
 * are merged, because kiro-cli's rule is that the winning definition decides: a
 * workspace file saying `{ "fetch": { "disabled": true } }` switches off the user
 * file's `fetch` for this project, which is the documented way to keep a global
 * server and turn it off for one repository. Filtering per file threw the
 * workspace entry away before the merge, so the user-level one survived, the
 * picker offered it, the prompt described it, and a scoped loop granted it had
 * the overridden definition written into its agent - this app starting a server
 * the operator had turned off, from the config they had turned it off with.
 */
async function readConfig(
  file: string,
): Promise<{ name: string; config: AgentServerConfig; disabled: boolean }[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null) return [];
  const servers = (raw as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null) return [];

  return Object.entries(servers as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const def = entry[1];
      return typeof def === 'object' && def !== null;
    })
    .map(([name, def]) => ({
      name,
      config: agentConfigOf(def),
      disabled: (def as { disabled?: unknown }).disabled === true,
    }));
}

/**
 * Every MCP server available to loops running in `baseDir`, sorted by name.
 *
 * Read on request rather than cached. The files are small, the operator edits them
 * outside this app, and a picker offering a server that was removed ten minutes ago
 * is worse than a file read.
 */
export async function listMcpServers(baseDir: string): Promise<McpServer[]> {
  const [user, workspace] = await Promise.all([
    readConfig(userConfig()),
    readConfig(workspaceConfig(baseDir)),
  ]);

  // Workspace last: same name in both is one server, and the workspace definition
  // is the one kiro-cli uses - including a workspace definition whose only content
  // is `disabled: true`, which wins the name and then removes it. Hence the filter
  // runs on the merged map, not on either file; see `readConfig`.
  const byName = new Map<string, McpServer & { disabled: boolean }>();
  for (const s of user) byName.set(s.name, { ...s, scope: 'user' });
  for (const s of workspace) byName.set(s.name, { ...s, scope: 'workspace' });

  return [...byName.values()]
    .filter((s) => !s.disabled)
    .map(({ disabled: _dropped, ...s }) => s)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What may follow an `@`.
 *
 * Deliberately narrow, and the same shape the panel highlights with. A dot is not
 * part of a name so `@aws-docs.` at the end of a sentence resolves and the full
 * stop stays prose - which is why the two sides have to agree on this: a token the
 * panel colours and this does not find is a promise the prompt breaks.
 *
 * A string rather than a literal because three things are built from it and they
 * must not drift: the scanner below, the anchored test beside it, and the same
 * pattern in the panel. `factory.ts` validates a parameter's name with `NAME_ONLY`
 * for exactly that reason - a parameter that cannot be written as a reference is a
 * parameter no prompt can ever reach.
 */
const NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';

/**
 * Every reference in a prompt.
 *
 * The lookbehind stops an `@` in the middle of a word from being a reference, so an
 * email address in a prompt is left alone.
 */
export const TOKEN = new RegExp(`(?<![A-Za-z0-9_-])@(${NAME})`, 'g');

/** Whether a bare string could be written after an `@` and be found again. */
export const NAME_ONLY = new RegExp(`^${NAME}$`);

/**
 * Names the prompt defines itself, so they are never looked up as servers.
 *
 * The queue vocabulary and the two directories. `prompt.ts` explains each of them
 * above the operator's text, so a match here is already accounted for; matching one
 * against the server list would mean a loop scoped to no tools could be handed one
 * by writing `@loop`.
 *
 * Exported because the web UI keeps the same list for its own token colouring, and
 * the two have to agree or the scope UI claims a grant the runner does not make.
 */
export const RESERVED = new Set(['input', 'output', 'project', 'loop']);

/**
 * The `@tokens` a prompt uses, lowercased.
 *
 * Reserved names are excluded, see above. Everything else is a candidate to be
 * matched against the server list, and anything that does not match is left alone -
 * a prompt is prose, and an `@` in it does not have to be a reference.
 *
 * `claimed` is for names that are already something else - the factory's
 * parameters, which share this one flat namespace with the servers. A parameter
 * wins its name, and it has to win here rather than only in `prompt.ts`: this
 * function is what `runner.ts` asks whether a scoped loop's prompt named a server,
 * so a parameter left in would hand that loop a tool it was never granted. The
 * operator wrote a value and would have got a tool with it.
 *
 * Parameters winning is the deterministic half of a genuine trade-off. A server
 * added later under a name a parameter already has is shadowed by it - quietly,
 * because nothing here can know the collision appeared. The other direction is
 * worse: the prompt would stop substituting and start granting, and the text that
 * changed meaning is text nobody edited. The panel refuses a parameter named after
 * a reserved word and warns about one named after a server it can see, which is as
 * early as this can be caught.
 */
export function tokensIn(prompt: string, claimed: Iterable<string> = []): string[] {
  const taken = new Set([...claimed].map((c) => c.toLowerCase()));
  const seen = new Set<string>();
  for (const match of prompt.matchAll(TOKEN)) {
    const name = match[1]!.toLowerCase();
    if (RESERVED.has(name) || taken.has(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

/**
 * The servers a prompt actually names.
 *
 * Only these are described to the agent. Listing all fifteen enabled servers in
 * every prompt would bury the instruction the operator wrote in a catalogue they
 * did not ask for, and the agent already has the tools regardless.
 *
 * `claimed` carries the parameter names straight through to `tokensIn`; see there
 * for why a parameter has to be excluded before a server is looked up.
 */
export function serversNamedIn(
  prompt: string,
  available: McpServer[],
  claimed: Iterable<string> = [],
): McpServer[] {
  const wanted = new Set(tokensIn(prompt, claimed));
  return available.filter((s) => wanted.has(s.name.toLowerCase()));
}
