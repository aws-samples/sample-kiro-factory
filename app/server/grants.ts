/**
 * What a new loop is allowed to use before anybody says otherwise.
 *
 * A loop's grant is two optional fields on the document - `tools` and `mcp` - and
 * absent means unrestricted on both. That is still what absent means; nothing here
 * changes how a grant is read. What this file decides is the narrower question of
 * where a *newly drawn* loop starts, which used to be "absent, so everything" by
 * default rather than by choice.
 *
 * The shipped answer is below and it is deliberately not everything: every built-in
 * tool except `subagent`, and no MCP server. A factory is several agents running
 * unattended, and handing each new one a second agent whose grant nobody reviewed,
 * plus every server on the machine, because that was the shortest thing to
 * implement is not a default anybody chose. Widening is one dropdown away, and the
 * panel says so the first time - see the hint in the canvas.
 *
 * Per operator, not per project: `~/.kirofactory/grants.json`, beside the registry.
 * The choice being made here is about how the person works rather than about one
 * repository, so it follows them across every factory they open, and a factory
 * exported to somebody else carries no opinion about what their loops may do. It
 * does mean a saved MCP list holds names from *this* machine's config, which is
 * fine for a per-machine file - the runner already drops granted servers the live
 * config no longer has.
 *
 * Each axis is remembered separately, because they are separate decisions and one
 * of them is far more likely to be revisited than the other: somebody who always
 * wants the same two MCP servers has said nothing about tools.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Bumped only if the shape changes in a way a reader has to know about. */
const FORMAT = 1;

/**
 * One grant, in the form the canvas seeds a loop from.
 *
 * `null` is "all of them" - the loop field left absent - and it has to be spellable
 * rather than implied by a missing key, or an operator who deliberately wants every
 * tool by default could not say so distinguishably from never having decided.
 */
export interface Grant {
  /** Built-in tool tags, or null for every category kiro-cli ships. */
  tools: string[] | null;
  /** MCP server names, or null for every server this machine enables. */
  mcp: string[] | null;
}

/** What the operator saved. A missing axis means the shipped default still holds. */
export type SavedGrant = Partial<Grant>;

/**
 * The grant a loop gets when nobody has chosen one.
 *
 * `read` and `write` because a loop that cannot write cannot deliver: an item goes
 * to `@output` as a file in a queue folder, and anything a loop wants to know next
 * iteration has to be written down. Without them this is not a cautious loop, it is
 * a loop that structurally cannot take part in a factory.
 *
 * `glob` and `grep` for the same reason one step out: a loop that can only open
 * files it was told the names of cannot survey anything, and "read the project" is
 * the first thing anybody asks a loop to do. `code` rides along with them as the
 * same capability at a higher level, and reads nothing they cannot already read.
 *
 * `shell` because the claim protocol is a move. A consumer takes an item off a queue
 * by renaming it out, and `write` is create, edit and delete with no rename in it -
 * so a consumer without `shell` cannot claim anything and improvises a copy plus a
 * tombstone instead, which is the read-then-delete race `queue.ts` exists to avoid.
 * An earlier default left `shell` out as the blast radius, and the cost was that the
 * shipped grant could not take part in the one mechanism the factory model rests on.
 * A default that breaks every consumer is not cautious, it is wrong, so `shell` is in
 * and the README says plainly what that means.
 *
 * `web_search` and `web_fetch` because fetching a page is most of what the other
 * first loop does, and `knowledge`, `todo_list` and `introspect` because they are
 * cheap to be wrong about - the last one is a lookup of Kiro's own documentation. The
 * pair of web names rather than the single `web`: the coarse name is not matched on
 * the surface this app runs against, so a default asking for `web` would quietly hand
 * out no web access at all.
 *
 * Not `subagent`. It is a way to get a second agent whose own grant nobody reviewed,
 * and it is the one row this default exists to make somebody tick on purpose.
 *
 * No MCP servers. A prompt that names one with `@` still gets it - the runner grants
 * on top of the list at turn time - so the narrow default costs nothing to a loop
 * that says what it needs, which is the shape the panel already encourages.
 */
export const SHIPPED: Grant = {
  tools: [
    'read',
    'write',
    'glob',
    'grep',
    'code',
    'shell',
    'web',
    'web_search',
    'web_fetch',
    'knowledge',
    'todo_list',
    'introspect',
  ],
  mcp: [],
};

/**
 * The effective default, plus which half of it the operator actually chose.
 *
 * `saved` is not bookkeeping the canvas could derive: a saved default that happens
 * to equal the shipped one is still a decision somebody made, and the panel's hint
 * turns on exactly that difference. It nudges an operator who has never thought
 * about the grant, and stays quiet for one who has.
 */
export interface GrantDefaults extends Grant {
  saved: { tools: boolean; mcp: boolean };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An axis as stored: absent, null for all, or a list of names. */
function axis(raw: Record<string, unknown>, key: 'tools' | 'mcp'): string[] | null | undefined {
  if (!Object.hasOwn(raw, key)) return undefined;
  const value = raw[key];
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * What the operator saved, or nothing at all.
 *
 * Tolerant the way every other read in this program is tolerant: a missing file is
 * no saved default, and so is a malformed one. The cost of getting that wrong is
 * one loop starting narrower than somebody wanted, which they can see and fix; the
 * cost of throwing would be a canvas that cannot add a loop.
 */
export async function readGrants(file: string): Promise<SavedGrant> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!isObject(raw) || !isObject(raw.grants)) return {};
    const saved: SavedGrant = {};
    const tools = axis(raw.grants, 'tools');
    const mcp = axis(raw.grants, 'mcp');
    if (tools !== undefined) saved.tools = tools;
    if (mcp !== undefined) saved.mcp = mcp;
    return saved;
  } catch {
    return {};
  }
}

export async function writeGrants(file: string, saved: SavedGrant): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({ kirofactory: FORMAT, grants: saved }, null, 2)}\n`, 'utf8');
}

/** The shipped default with whatever the operator saved laid over it. */
export function resolve(saved: SavedGrant): GrantDefaults {
  return {
    tools: saved.tools !== undefined ? saved.tools : SHIPPED.tools,
    mcp: saved.mcp !== undefined ? saved.mcp : SHIPPED.mcp,
    saved: { tools: saved.tools !== undefined, mcp: saved.mcp !== undefined },
  };
}

/** Save one axis, leaving the other as it was. Answers with the new default. */
export async function saveAxis(
  file: string,
  key: 'tools' | 'mcp',
  value: string[] | null,
): Promise<GrantDefaults> {
  const saved = await readGrants(file);
  const next: SavedGrant = { ...saved, [key]: value };
  await writeGrants(file, next);
  return resolve(next);
}
