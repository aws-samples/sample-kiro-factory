/**
 * Which skills and steering files a loop can be told about.
 *
 * A sibling of mcp.ts, and deliberately the same shape: read on request, never
 * cached, never throwing, workspace shadowing user by name. The reason is the same
 * too - kiro-cli is what actually loads these, from its working directory and the
 * home directory, so this file does not decide what is available, it reports it.
 *
 * What it reports is used for one thing: describing, in the built prompt, the
 * skills and steering files the operator's prompt named. That is the whole of it.
 * Naming `@my-skill` gets the skill described with an instruction to load and
 * follow it; nothing is granted, generated, or blocked. This is reinforcement
 * rather than enforcement, which is the difference between this module and its
 * sibling: `McpServer` carries a verbatim `config` because a scoped loop's agent
 * file needs it, and there is no equivalent here because there is no scoping.
 *
 * That difference is why neither type below carries a path. Nothing downstream
 * needs one - the agent loads by its own rules and the prompt speaks in names -
 * and not carrying them is what keeps this module from growing back into an
 * enforcement layer by accident. A path is the first thing an enforcement layer
 * would want.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { tokensIn } from './mcp.ts';

/**
 * A skill a prompt can name.
 *
 * Skills are metadata until something activates them: kiro-cli reads the
 * frontmatter of every SKILL.md it can see and loads a body only when it judges
 * the skill relevant. That is the failure mode this feature exists for - an agent
 * that had the right skill and never opened it - so the description is carried
 * here to be repeated back in the prompt beside the instruction to load it.
 */
export interface Skill {
  /** The token an operator types after `@`: frontmatter `name`, else the folder name. */
  name: string;
  /** Where it was found. Workspace entries shadow user ones of the same name. */
  scope: 'user' | 'workspace';
  /** Frontmatter `description`, for the picker hint and the prompt bullet. */
  description: string;
}

/**
 * A steering file a prompt can name.
 *
 * No description, because steering has no equivalent of a skill's one-line summary
 * and needs none: the file is already in the agent's context in full, so a bullet
 * in the prompt emphasises rather than informs.
 *
 * "Steering" is an overloaded word in this codebase - `steerSection` in prompt.ts
 * and `pendingSteer` in runner.ts are operator messages typed at a running loop,
 * a different concept entirely. The type is `SteeringFile` and the lists are
 * `steeringFiles` everywhere on purpose, so the two cannot blur in code.
 */
export interface SteeringFile {
  /** The filename minus `.md`, which is the `@` token. */
  name: string;
  scope: 'user' | 'workspace';
}

/** Kiro's user-level skills, one directory each. */
function userSkills(): string {
  return path.join(os.homedir(), '.kiro', 'skills');
}

/** A factory's base directory is the agent's cwd, so its workspace skills are here. */
function workspaceSkills(baseDir: string): string {
  return path.join(baseDir, '.kiro', 'skills');
}

/** Kiro's user-level steering files. */
function userSteering(): string {
  return path.join(os.homedir(), '.kiro', 'steering');
}

/** The workspace half of the same. */
function workspaceSteering(baseDir: string): string {
  return path.join(baseDir, '.kiro', 'steering');
}

/**
 * `name` and `description` out of a SKILL.md's frontmatter fence.
 *
 * A line scan rather than a YAML library, and not for want of one: both keys are
 * one-line strings by the skill format's own rules, so the grammar this needs to
 * understand is `key: value`. Adding a parser - and a dependency - to read two
 * strings would be paying for generality nothing here can use.
 *
 * The scan stops at the closing fence, so a `description:` in the skill's prose is
 * not mistaken for the frontmatter's. Only unindented keys count, which is what
 * keeps a nested mapping's `name:` out of the answer.
 *
 * A value written as a block scalar (`description: >-` and the text below it) reads
 * as absent rather than as the literal `>-`. That is the format's rules being bent,
 * and the honest answer to a bent file is no answer: an empty description costs a
 * missing hint, where `>-` in the picker would be a wrong one.
 */
function frontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};

  const found: { name?: string; description?: string } = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;

    const match = /^(name|description):(.*)$/.exec(line);
    if (!match) continue;

    const value = match[2]!.trim().replace(/^['"]|['"]$/g, '').trim();
    // A block scalar indicator is all that is left on the line; the text is below
    // it, and reading that is the parser this deliberately is not.
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      continue;
    }
    found[match[1] as 'name' | 'description'] = value;
  }
  return found;
}

/**
 * The skills in one skills directory.
 *
 * Never throws. A missing directory is the normal case for the workspace scope,
 * and an unreadable SKILL.md is one skill's problem rather than the endpoint's:
 * either way the answer is that it contributes nothing.
 *
 * The folder name is the fallback for `name` because a skill without frontmatter
 * is still a skill kiro-cli will load, and a nameless row in the picker would be
 * this reader's failure showing as the machine's.
 */
async function readSkills(dir: string): Promise<Omit<Skill, 'scope'>[]> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const skills = await Promise.all(
    entries.map(async (folder) => {
      let text: string;
      try {
        text = await fsp.readFile(path.join(dir, folder, 'SKILL.md'), 'utf8');
      } catch {
        // No SKILL.md means it is not a skill, whatever else the folder holds.
        return undefined;
      }
      const { name, description } = frontmatter(text);
      return { name: name ?? folder, description: description ?? '' };
    }),
  );
  return skills.filter((s): s is Omit<Skill, 'scope'> => s !== undefined);
}

/**
 * The steering files in one steering directory.
 *
 * Every `.md` counts, whatever its `inclusion` frontmatter says. A
 * manual-inclusion steering file is precisely the kind a prompt would want to
 * name, so filtering on `inclusion` would hide the most useful half of the list -
 * and it would mean this reader deciding what kiro-cli loads, which is the one
 * thing neither this file nor its sibling does.
 */
async function readSteering(dir: string): Promise<Omit<SteeringFile, 'scope'>[]> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.map((file) => ({ name: file.slice(0, -'.md'.length) }));
}

/**
 * Every skill available to loops running in `baseDir`, sorted by name.
 *
 * Read on request rather than cached, for the reason `listMcpServers` gives: the
 * files are small, the operator edits them outside this app, and a picker offering
 * a skill that was deleted ten minutes ago is worse than a directory read.
 */
export async function listSkills(baseDir: string): Promise<Skill[]> {
  const [user, workspace] = await Promise.all([
    readSkills(userSkills()),
    readSkills(workspaceSkills(baseDir)),
  ]);
  return merge(user, workspace);
}

/** Every steering file available to loops running in `baseDir`, sorted by name. */
export async function listSteeringFiles(baseDir: string): Promise<SteeringFile[]> {
  const [user, workspace] = await Promise.all([
    readSteering(userSteering()),
    readSteering(workspaceSteering(baseDir)),
  ]);
  return merge(user, workspace);
}

/**
 * One list from the two scopes, workspace winning a shared name.
 *
 * The same rule mcp.ts applies to servers, and for the same reason: `@name` is one
 * reference, so two files answering to it have to resolve to one, and the
 * workspace copy is the one nearer the work.
 */
function merge<T extends { name: string }>(
  user: T[],
  workspace: T[],
): (T & { scope: 'user' | 'workspace' })[] {
  const byName = new Map<string, T & { scope: 'user' | 'workspace' }>();
  for (const item of user) byName.set(item.name, { ...item, scope: 'user' });
  for (const item of workspace) byName.set(item.name, { ...item, scope: 'workspace' });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The things a prompt actually names, out of the things there are.
 *
 * Generic over anything with a `name`, because skills and steering files differ in
 * what they carry and not at all in how they are referenced. `serversNamedIn` in
 * mcp.ts stays as it is: it predates this and its callers are typed on
 * `McpServer`.
 *
 * Only what the prompt names is described to the agent, for the reason
 * `serversNamedIn` documents - a catalogue of everything installed would bury the
 * instruction the operator wrote, and the agent has the skills and the steering
 * regardless of whether this prompt mentions them.
 *
 * `claimed` is how precedence in the one flat `@` namespace is applied, and the
 * caller decides it by what it passes. The order is reserved words, then
 * parameters, then MCP servers, then skills, then steering files: so a caller
 * looking up skills passes the parameter names and the server names, and one
 * looking up steering files passes those plus the skill names. Servers come before
 * skills because servers are the incumbent - a factory whose prompt says `@github`
 * today must keep meaning the server after a `github` skill appears on the machine.
 *
 * The stakes are lower here than they are for servers: a shadowed skill costs a
 * missing prompt section, not a missing capability. What it must not cost is
 * disagreement between the prompt and the panel that colours the same tokens, so
 * this is the one place the server side decides it.
 */
export function namedIn<T extends { name: string }>(
  prompt: string,
  available: T[],
  claimed: Iterable<string> = [],
): T[] {
  const wanted = new Set(tokensIn(prompt, claimed));
  return available.filter((item) => wanted.has(item.name.toLowerCase()));
}
