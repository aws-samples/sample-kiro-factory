/**
 * The library: things that worked, kept in the repository.
 *
 * A loop is a name and a prompt, so a loop worth keeping is a small JSON file and
 * nothing more. One file per entry, under `library/` at the root of this repository,
 * committed - which is the point. The library is not per-machine state and not part
 * of any factory; it is a shared collection that arrives with a clone and grows by
 * pull request.
 *
 * This is the one thing this program writes outside a factory's
 * `<baseDir>/.kirofactory/`. `factory.ts` says that folder is the only place it
 * writes, and that stays true of factories: saving to the library writes into your
 * checkout, on purpose, so a saved entry shows up in `git status` as the file you
 * would send. Keeping it in its own module with its own root is what keeps the
 * factory boundary honest rather than quietly widening it.
 *
 * ## Three kinds, three folders
 *
 * `library/loops/`, `library/clusters/` and `library/factories/`. The split is for
 * whoever is reading the repository rather than for this file - the audience of a
 * committed folder of JSON is people, and a flat directory of forty files mixing a
 * one-prompt loop with a whole wired-up factory is a directory nobody browses twice.
 *
 * The folders organise; they do not decide. Whether an entry is a loop or a cluster
 * is still read off its `cluster` field, exactly as it was when both lived in one
 * directory, so a misfiled entry works and simply sits in the wrong folder for a
 * reviewer to move. Only factories are genuinely a different shape, and they are the
 * one kind that could not have shared a parse: an entry with loops and wires and no
 * prompt at all.
 *
 * Files directly in `library/` are still read, as loops and clusters. The entries
 * that shipped here before the split were moved into their folders in the same commit
 * that added them, so this is not for them - it is for the checkout with an
 * uncommitted entry in the old place, which should not silently vanish out of the
 * picker because the layout moved underneath it.
 *
 * ## What an entry carries, and what it does not
 *
 * A loop entry carries no `id`, `x` or `y`: those describe a loop's placement on one
 * canvas, which is not something a shared loop can know. A cluster is one component,
 * so it is one of these files, and it keeps its shape - see `LoopEntry.cluster`.
 *
 * A factory entry is the exception that proves the rule. It *does* keep positions,
 * because a factory is a graph and the relative layout is the design rather than
 * where somebody's card happened to sit. What it drops is `id` and `baseDir`: a
 * shared factory cannot know which directory you will run it in, and that is the one
 * thing you have to supply when you take one out. See `FactoryEntry`.
 */
import * as fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_COMMS,
  CLUSTER_MAX,
  CLUSTER_MIN,
  CLUSTER_MODES,
  parse as parseFactory,
  type Cluster,
  type ClusterComms,
  type ClusterMode,
  type Loop,
  type Parameter,
  type Wire,
} from './factory.ts';

/** Bumped only if the loop entry shape changes in a way a reader has to know about. */
export const LOOP_FORMAT = 1;

/** The same, for a factory entry. Separate number: separate shape, separate history. */
export const FACTORY_FORMAT = 1;

/**
 * Where the library lives: `library/` beside `app/`, at the root of the repository.
 *
 * At the root rather than under `app/` because its audience is people reading the
 * repository, not the server that happens to serve it. Overridable so a fork can
 * point somewhere else without editing this.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const LIBRARY_DIR = path.resolve(
  process.env.LIBRARY_DIR ?? path.join(here, '..', '..', 'library'),
);

/** Which of the three an entry is. Derived on read, never stored - like `slug`. */
export type EntryKind = 'loop' | 'cluster' | 'factory';

/** The folder each kind is written into. Reading is more forgiving; see `list`. */
const FOLDER: Record<EntryKind, string> = {
  loop: 'loops',
  cluster: 'clusters',
  factory: 'factories',
};

/** What every entry has, whichever kind it is. */
interface Common {
  /** Filename without `.json`. Identifies the entry; also what a PR is named after. */
  slug: string;
  name: string;
  /** One line on what it does, shown beside the name in the picker. */
  description: string;
  /** Whoever contributed it. Free text, blank when unclaimed. */
  author: string;
  tags: string[];
}

/**
 * One loop, or one cluster, in the library.
 *
 * No `id`, `x` or `y`. Those describe a loop's placement on one canvas, which is not
 * something a shared loop can know or should carry: they are assigned when the entry
 * is dropped into a factory.
 */
export interface LoopEntry extends Common {
  kirofactoryLoop: number;
  /** `cluster` when it carries a cluster shape, `loop` when it does not. */
  kind: 'loop' | 'cluster';
  prompt: string;
  /**
   * The shape of the cluster this entry is, when it is one. Absent means a plain
   * loop, which is what every file written before this field existed means by not
   * having it.
   *
   * Kept because it is part of the loop rather than part of the canvas. The size,
   * the mode and whether the members see each other are decisions about how the
   * prompt works - a prompt written for a ring of five reading each other's lines
   * is not the same prompt as one written for a single session - so an entry that
   * dropped them would be sharing something that no longer does what it did. It is
   * the same reasoning that keeps `x` and `y` out: those describe a canvas, this
   * describes the loop.
   */
  cluster?: Cluster;
}

/**
 * A whole factory in the library: its loops, how they are wired, and its parameters.
 *
 * The one entry that keeps geometry. A loop's position is where somebody else's card
 * sat and means nothing here, but a factory's positions *are* the diagram - which
 * loop feeds which, read left to right - and an entry that dropped them would arrive
 * as a heap of boxes at the origin with the design lost.
 *
 * What it drops is identity and location. `id` goes because taking one out makes a
 * new factory rather than a copy of somebody's, and `baseDir` goes because it is a
 * path on the machine that shared it; the directory to run in is the one thing the
 * person taking it out has to supply. Loop ids are kept, because the wires are
 * matched by them and the entry has to stay internally consistent - they are
 * regenerated together with the wires on the way in.
 *
 * Parameters come too, names and values both. A parameterised factory whose
 * parameters were stripped would arrive with every prompt full of `@topic` tokens
 * standing for nothing, which is not a shareable factory; the values that came with
 * it are also the worked example of what it expects. Whoever takes it out changes
 * them on the bar, which is one click and the point of parameters.
 */
export interface FactoryEntry extends Common {
  kirofactoryLibrary: number;
  kind: 'factory';
  /** Named values its prompts write as `@name`. Absent when it has none. */
  parameters?: Parameter[];
  loops: Loop[];
  wires: Wire[];
}

export type Entry = LoopEntry | FactoryEntry;

/**
 * The whole library, grouped the way the picker shows it.
 *
 * Grouped here rather than in the client because the grouping is the disk layout and
 * the rule for loop-versus-cluster lives in this file. A client partitioning a flat
 * list would be a second copy of that rule, and the two would disagree the first time
 * one of them changed.
 */
export interface LibraryIndex {
  loops: LoopEntry[];
  clusters: LoopEntry[];
  factories: FactoryEntry[];
}

/** What a caller has to supply to save a loop. Everything else is derived or optional. */
export interface NewLoopEntry {
  name: string;
  prompt: string;
  description?: string;
  author?: string;
  tags?: string[];
  /**
   * The cluster shape, unvalidated. `unknown` on purpose: it arrives from an HTTP
   * body, and normalising it here keeps the one copy of that logic beside the one
   * that reads these files back.
   */
  cluster?: unknown;
}

/** The same for a factory: its graph, unvalidated, plus what a person adds. */
export interface NewFactoryEntry {
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
  loops?: unknown;
  wires?: unknown;
  parameters?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function tagsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * A filename from a name: lowercase, words joined by hyphens, nothing else.
 *
 * The slug is a path segment, so this is a containment boundary as much as a
 * tidiness one - anything that is not a letter, a digit or a hyphen cannot survive
 * it, which is what stops a name from reaching outside the library directory.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'loop';
}

/**
 * The cluster shape off a file or a request body, or nothing at all.
 *
 * Clamped and defaulted rather than rejected, exactly as `factory.ts` does for the
 * same field in a document: these files are hand-written and arrive by pull
 * request, so a size of 500, a mode nobody recognises, or a bare `{}` has to
 * resolve to something runnable rather than drop the entry out of the picker with
 * no explanation of why.
 *
 * Anything that is not an object - absent, `null`, `false` - is the plain loop.
 */
function parseCluster(input: unknown): Cluster | undefined {
  if (!isObject(input)) return undefined;
  const size = Number(input.size);
  return {
    mode: CLUSTER_MODES.includes(input.mode as ClusterMode) ? (input.mode as ClusterMode) : 'fixed',
    size: Math.min(
      CLUSTER_MAX,
      Math.max(CLUSTER_MIN, Number.isFinite(size) ? Math.round(size) : CLUSTER_MIN),
    ),
    comms: CLUSTER_COMMS.includes(input.comms as ClusterComms)
      ? (input.comms as ClusterComms)
      : 'isolated',
  };
}

/**
 * Read one loop entry. Never throws: a malformed or half-written file is skipped
 * rather than taking the whole library down with it, the way a bad document opens as
 * an empty canvas rather than killing the server.
 */
function parseLoopEntry(input: unknown, slug: string): LoopEntry | null {
  if (!isObject(input)) return null;
  const prompt = str(input.prompt, '');
  if (prompt.trim().length === 0) return null;
  const cluster = parseCluster(input.cluster);
  return {
    kirofactoryLoop: LOOP_FORMAT,
    slug,
    // The `cluster` field decides, not the folder the file was found in. See the
    // header: the folders organise the repository, they do not overrule the contents.
    kind: cluster !== undefined ? 'cluster' : 'loop',
    name: str(input.name, slug),
    description: str(input.description, ''),
    prompt,
    author: str(input.author, ''),
    tags: tagsOf(input.tags),
    ...(cluster !== undefined ? { cluster } : {}),
  };
}

/**
 * Read one factory entry, loops and wires and all.
 *
 * The graph goes through `factory.ts`'s own `parse` rather than being re-read here,
 * which is what keeps one copy of every rule about loops and wires: run modes
 * resolved by precedence, cluster sizes clamped, wires pointing at absent loops
 * dropped, a producer's wire modes made to agree. A hand-written entry gets exactly
 * the treatment a hand-written document gets.
 *
 * The identity handed to that parse is thrown away with its result. `parse` needs
 * defaults because a document may not carry its own id, name or directory; an entry
 * carries none of the three by design, so they are supplied as blanks and only
 * `loops`, `wires` and `parameters` are kept.
 *
 * An entry with no loops is skipped. A factory with nothing in it is not a design.
 */
function parseFactoryEntry(input: unknown, slug: string): FactoryEntry | null {
  if (!isObject(input)) return null;
  const doc = parseFactory(
    { loops: input.loops, wires: input.wires, parameters: input.parameters },
    { id: '', name: '', baseDir: '' },
  );
  if (doc.loops.length === 0) return null;
  return {
    kirofactoryLibrary: FACTORY_FORMAT,
    slug,
    kind: 'factory',
    name: str(input.name, slug),
    description: str(input.description, ''),
    author: str(input.author, ''),
    tags: tagsOf(input.tags),
    ...(doc.parameters !== undefined ? { parameters: doc.parameters } : {}),
    loops: doc.loops,
    wires: doc.wires,
  };
}

/**
 * Every `.json` file in one folder, parsed. A missing folder is simply empty.
 *
 * `read` is given rather than chosen here so the two shapes share the walking and
 * the swallowing of bad files, which is the part worth having once.
 */
async function readFolder<T>(
  dir: string,
  read: (raw: unknown, slug: string) => T | null,
): Promise<T[]> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const out: T[] = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')) as unknown;
      const entry = read(raw, file.slice(0, -'.json'.length));
      if (entry !== null) out.push(entry);
    } catch {
      // Not an entry. Skipped, so one bad file does not empty the library.
    }
  }
  return out;
}

/** By name. The picker is a list you read, and the only order that helps is the alphabet. */
function byName<T extends { name: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The whole library, in its three groups.
 *
 * Loops and clusters are read from both folders and from the library root, then
 * separated by what they are rather than by where they were found - see the header.
 * The root read is the one concession to the layout having changed underneath a
 * working checkout.
 */
export async function list(): Promise<LibraryIndex> {
  const [inLoops, inClusters, loose, factories] = await Promise.all([
    readFolder(path.join(LIBRARY_DIR, FOLDER.loop), parseLoopEntry),
    readFolder(path.join(LIBRARY_DIR, FOLDER.cluster), parseLoopEntry),
    readFolder(LIBRARY_DIR, parseLoopEntry),
    readFolder(path.join(LIBRARY_DIR, FOLDER.factory), parseFactoryEntry),
  ]);

  const components = [...inLoops, ...inClusters, ...loose];
  return {
    loops: byName(components.filter((e) => e.kind === 'loop')),
    clusters: byName(components.filter((e) => e.kind === 'cluster')),
    factories: byName(factories),
  };
}

/**
 * A free filename in a folder, from a name.
 *
 * A name already in use gets `-2`, `-3` and so on rather than being refused.
 * Stopping a save to argue about a name interrupts the moment someone decided
 * something was worth keeping, and two entries can reasonably be called the same
 * thing; the filename only has to be unique, and whoever reviews the pull request
 * can rename it.
 */
function freeSlug(dir: string, name: string): string {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; existsSync(path.join(dir, `${slug}.json`)); n += 1) slug = `${base}-${n}`;
  return slug;
}

/** Write one entry, minus the fields that are not the file's to hold. */
async function write(dir: string, slug: string, entry: Entry): Promise<void> {
  // `slug` is the filename and `kind` is the folder, so neither is stored: a copy
  // inside the file that could disagree with its location is one that will.
  const { slug: _slug, kind: _kind, ...stored } = entry;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify(stored, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Save a loop or a cluster to the library.
 *
 * Which of the two it is decides the folder, and it is decided by the cluster shape
 * being there - the same rule the read uses, so a saved entry comes back out of the
 * picker in the group it was saved from.
 */
export async function addLoop(input: NewLoopEntry): Promise<LoopEntry> {
  const cluster = parseCluster(input.cluster);
  // An unnamed entry is called after what it is, so a cluster saved without a name
  // does not arrive in the library as a file called `loop.json`.
  const fallback = cluster !== undefined ? 'Cluster' : 'Loop';
  const name = input.name.trim().length > 0 ? input.name.trim() : fallback;
  const dir = path.join(LIBRARY_DIR, cluster !== undefined ? FOLDER.cluster : FOLDER.loop);
  await fsp.mkdir(dir, { recursive: true });
  const slug = freeSlug(dir, name);

  // Written field by field rather than spreading the input, so nothing a caller
  // sends that is not part of the format ends up committed in the file.
  const entry: LoopEntry = {
    kirofactoryLoop: LOOP_FORMAT,
    slug,
    kind: cluster !== undefined ? 'cluster' : 'loop',
    name,
    description: (input.description ?? '').trim(),
    prompt: input.prompt,
    author: (input.author ?? '').trim(),
    tags: input.tags ?? [],
    // Only when there is one, so a plain loop's file is byte for byte what it was
    // before clusters could be saved: no `"cluster": null` in the repository.
    ...(cluster !== undefined ? { cluster } : {}),
  };
  await write(dir, slug, entry);
  return entry;
}

/**
 * Save a whole factory to the library: its loops, its wires, its parameters.
 *
 * The graph is normalised on the way in through the same parse the read uses, so what
 * lands in the repository is a document a reader will get back unchanged rather than
 * whatever the client happened to post. `baseDir` and `id` are not written at all -
 * they are not asked for and would be a path and an identity from one machine.
 *
 * ## A name already taken is a question, not a suffix
 *
 * Loops get `-2`, `-3` and keep going, because two people can reasonably call two
 * different prompts "Reviewer". A factory save is different in practice: the common
 * case of a name collision is the same factory being kept again after editing, and
 * silently filing that as `kirofactoryfactory-2.json` leaves the library holding
 * every draft under names nobody chose. So a taken slug comes back as
 * `{ conflict: slug }` for the caller to put to the person - replace it, or rename
 * and save again - and only an explicit `overwrite` writes over the file.
 *
 * Overwriting replaces the graph and the parameters, which is what changed on the
 * canvas. The entry's description, author and tags are read off the existing file
 * and kept unless the caller supplies its own, because the save button asks for
 * none of them and "replace" should not mean "blank out what a reviewer wrote".
 */
export async function addFactory(
  input: NewFactoryEntry,
  overwrite = false,
): Promise<FactoryEntry | { conflict: string }> {
  const name = input.name.trim().length > 0 ? input.name.trim() : 'Factory';
  const dir = path.join(LIBRARY_DIR, FOLDER.factory);
  await fsp.mkdir(dir, { recursive: true });
  const slug = slugify(name);
  const taken = existsSync(path.join(dir, `${slug}.json`));
  if (taken && !overwrite) return { conflict: slug };

  // What the file being replaced said about itself, for the fields the canvas does
  // not carry. Read through the same parse as everything else; a file too broken to
  // parse has nothing worth preserving and the fallbacks stand in.
  const existing = taken ? await factoryBySlug(slug) : null;

  const doc = parseFactory(
    { loops: input.loops, wires: input.wires, parameters: input.parameters },
    { id: '', name: '', baseDir: '' },
  );

  const keep = (own: string | undefined, was: string | undefined): string =>
    (own ?? '').trim().length > 0 ? (own ?? '').trim() : (was ?? '');

  const entry: FactoryEntry = {
    kirofactoryLibrary: FACTORY_FORMAT,
    slug,
    kind: 'factory',
    name,
    description: keep(input.description, existing?.description),
    author: keep(input.author, existing?.author),
    tags: input.tags !== undefined && input.tags.length > 0 ? input.tags : (existing?.tags ?? []),
    ...(doc.parameters !== undefined ? { parameters: doc.parameters } : {}),
    loops: doc.loops,
    wires: doc.wires,
  };
  await write(dir, slug, entry);
  return entry;
}

/**
 * One factory entry by slug, for taking it out of the library.
 *
 * By slug rather than by handing the client the graph and letting it post it back:
 * the entry is a file in the repository and this is the server that reads it, so a
 * round trip through the browser would be one more place for it to change.
 */
export async function factoryBySlug(slug: string): Promise<FactoryEntry | null> {
  // Slugged before use: the value arrives from a URL and is about to be a path
  // segment, and `slugify` is the boundary that keeps it inside the library.
  const safe = slugify(slug);
  const file = path.join(LIBRARY_DIR, FOLDER.factory, `${safe}.json`);
  if (!existsSync(file)) return null;
  try {
    return parseFactoryEntry(JSON.parse(await fsp.readFile(file, 'utf8')) as unknown, safe);
  } catch {
    return null;
  }
}
