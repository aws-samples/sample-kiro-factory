/**
 * Find factories the registry has forgotten, by walking the home directory.
 *
 * The registry is the only memory of where factories live, and it used to be a
 * per-checkout file tracking absolute paths. Both of those have been fixed, but
 * neither fix helps a factory that is *already* lost - moved to a new folder, or
 * left behind by a clone whose registry nobody migrated. The folder is still on
 * disk, complete with its `.kirofactory/factory.json`, and the only way back to it
 * today is remembering where it is. This module is the alternative: look.
 *
 * Spotlight is not an option, and it is worth saying why so nobody tries it again.
 * `mdfind -name .kirofactory` would be instant and index-backed, and it returns
 * nothing: Spotlight deliberately excludes hidden files and dot-directories from
 * its index, so the one thing being searched for is the one thing it will never
 * know about. There is no flag for that. It has to be a real filesystem walk.
 *
 * Which makes the whole design question "how do you keep a walk of a developer's
 * home directory cheap", because the naive version is unusable: millions of entries
 * between `node_modules`, `.git` object stores and `Library/`, minutes of IO, and
 * cloud-synced folders that fault real files down from the network merely by being
 * listed. Two cuts make it seconds instead - a prune list and a depth cap - and
 * both are below.
 *
 * `fs.readdir` with `withFileTypes` rather than shelling out to `find`: one syscall
 * per directory either way, no dependency, no quoting, no platform differences in
 * how `-prune` is spelled, and the pruning stays readable as code.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DOC_NAME, INTERNAL } from './factory.ts';

/**
 * Directories never descended into, by name, at any depth.
 *
 * Dependency trees, object stores and caches: enormous, and a factory inside one is
 * not somewhere anybody put a factory on purpose. `Library` is the expensive one on
 * macOS - application support, caches, and every cloud provider's placeholder tree.
 *
 * `.kiro` is here for a different reason than its size: it holds skills and
 * steering, some of which are checkouts of other people's repositories, and a
 * factory found in one belongs to whoever wrote the skill.
 *
 * Hardcoded, and deliberately not configurable. A settings surface for this would
 * be a list of directory names to maintain in exchange for a walk that is already
 * fast enough, and the fallback for the one factory in an unusual place is the same
 * as it always was: walk to it in the picker. Revisit when somebody actually hits a
 * wall.
 */
const PRUNE = new Set([
  'node_modules',
  '.git',
  'Library',
  '.Trash',
  '.cache',
  '.npm',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.vscode',
  '.kiro',
]);

/**
 * How many path segments below the home directory the walk will go.
 *
 * Projects live shallow. Every factory in a registry seen so far sits two to five
 * segments down (`~/code/client/project` is a typical three), so eight is
 * generous rather than tight - it is there to stop
 * the walk falling into something pathological the prune list did not name, not to
 * express a belief about where factories are.
 */
const MAX_DEPTH = 8;

/** A factory found on disk: where it is, and what its document says it is. */
export interface FoundFactory {
  /** The base directory - the folder *containing* `.kirofactory`, not that folder. */
  dir: string;
  id: string;
  name: string;
}

/**
 * Read the document in `<dir>/.kirofactory/`, if there is one worth reading.
 *
 * Undefined for anything that is not a registrable factory: no document, a document
 * that will not parse, or one with no `id`. The id is the only field with no
 * fallback, because it is what the registry keys on and what tells a moved factory
 * apart from a new one - inventing one here would turn every unreadable folder into
 * a fresh phantom factory on every scan. A missing name falls back to the id, the
 * same way `Registry.read` does.
 */
async function readFound(dir: string): Promise<FoundFactory | undefined> {
  const doc = path.join(dir, INTERNAL, DOC_NAME);
  if (!existsSync(doc)) return undefined;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(doc, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const { id, name } = raw as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.length === 0) return undefined;
    return { dir, id, name: typeof name === 'string' && name.length > 0 ? name : id };
  } catch {
    return undefined;
  }
}

/**
 * Walk `root` and return every factory under it, shallowest first.
 *
 * Breadth-first over an explicit queue rather than recursion, which costs nothing
 * here and means the depth cap is a number compared against a number instead of a
 * property of the call stack. Shallowest-first is a free consequence and a useful
 * one: if a scan is ever cut short, what it has is the factories in the likeliest
 * places.
 *
 * Three things the walk will not do, each for its own reason:
 *
 * - **It does not descend into a `.kirofactory` it finds.** That folder is the
 *   factory's scratch space: queues, loop working directories, and - when a loop is
 *   given a checkout per session - whole clones of whatever repository the factory
 *   is building. Descending would find the sample factories committed inside those
 *   clones and register them as if the operator had put them there, one phantom per
 *   worktree per scan. Sibling factories under a shared parent are unaffected;
 *   only the dot-folder itself is opaque.
 * - **It does not follow symlinks.** `entry.isDirectory()` is false for a symlink,
 *   so this falls out of the check rather than needing one, but it is intended: a
 *   link is how a walk of a bounded directory ends up unbounded, and how one
 *   scoped to `$HOME` ends up reporting factories from outside it.
 * - **It ignores hidden directories generally**, not just the pruned ones. Dotted
 *   folders are tool state, and the tools that keep a lot of it are not all
 *   nameable in advance. `.kirofactory` is the deliberate exception, and it is
 *   handled before this rule applies - it is the thing being looked for.
 *
 * An unreadable directory is skipped in silence. Permission denied is the ordinary
 * case in a home directory, not a failure of the scan, and there is nothing useful
 * to tell the operator about a folder that was never theirs.
 */
export async function scanForFactories(root: string): Promise<FoundFactory[]> {
  const start = path.resolve(root);
  const found: FoundFactory[] = [];
  let queue: string[] = [start];

  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === INTERNAL) {
          // The folder holding it is the factory's base directory, and the walk
          // stops here either way: a `.kirofactory` with no document in it is not a
          // factory, and is still not something to look inside.
          const hit = await readFound(dir);
          if (hit) found.push(hit);
          continue;
        }
        if (PRUNE.has(entry.name) || entry.name.startsWith('.')) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    queue = next;
  }

  return found;
}
