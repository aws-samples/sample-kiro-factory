/**
 * Every factory this installation has seen, and which of them are open.
 *
 * A factory's document lives inside its own base directory, so this file is not
 * the factory - it is the record of them. Losing it loses no design work: every
 * document is still on disk under its `.kirofactory/`, and opening that directory
 * again puts the tab back. That is what `POST /api/factories/open` is for, and it
 * is why closing a tab can afford to be as cheap as clearing a flag in here.
 *
 * The list used to be exactly the open tabs, which made closing one the same thing
 * as forgetting it: the only way back was to remember the folder and walk to it.
 * Now an entry survives its tab and carries `open` to say whether it is a tab at
 * the moment, so a closed factory can still be offered back by name.
 *
 * Array order is "most recently a tab first". An entry moves to the front when it
 * is created or reopened and stays put otherwise, which keeps `list()` usable as
 * the tab strip's order - a rename is not a reason for a tab to jump.
 *
 * That split is the reason the registry holds only `id`, `name`, `baseDir` and
 * that flag. Anything else here would be a second copy of something the document
 * already says, and the two would drift.
 *
 * The file lives at `~/.kirofactory/factories.json`: per user, not per checkout.
 * It used to sit next to the app as `app/factories.json`, which made every clone
 * of this repo start with an empty list and every factory look lost even though
 * nothing on disk had moved. One list per machine is what the operator means by
 * "my factories", so that is where it is kept. `REGISTRY` still overrides the
 * path outright, and `mergeInto` brings a checkout-local file forward once.
 *
 * Note the name collision, because a scan of the home directory will meet it:
 * `~/.kirofactory/` is this file's directory *and* what a factory's own internal
 * folder is called. It stays unambiguous because it holds no `factory.json`, and
 * because a factory is refused `$HOME` as its base directory - see `isFree` in
 * index.ts.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DOC_NAME, INTERNAL, newFactoryId, type Factory, type FactoryRef } from './factory.ts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class Registry {
  private readonly file: string;
  private refs: FactoryRef[] = [];

  constructor(file: string) {
    this.file = path.resolve(file);
  }

  /** Read the list. A missing or malformed file is an empty list, not an error. */
  async read(): Promise<FactoryRef[]> {
    if (!existsSync(this.file)) {
      this.refs = [];
      return this.refs;
    }
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.factories) ? raw.factories : [];
      this.refs = list.filter(isObject).flatMap((r) => {
        if (typeof r.id !== 'string' || typeof r.baseDir !== 'string') return [];
        return [{
          id: r.id,
          name: typeof r.name === 'string' ? r.name : r.id,
          baseDir: path.resolve(r.baseDir),
          // No `open` means the file was written before closed entries existed, and
          // everything in it then was a tab. So an absent flag is `true`, and no
          // migration step is needed: the first read of an old file says what that
          // file already meant.
          open: typeof r.open === 'boolean' ? r.open : true,
        }];
      });
    } catch {
      this.refs = [];
    }
    return this.refs;
  }

  /** The open tabs, in the order the strip shows them. */
  list(): FactoryRef[] {
    return this.refs.filter((r) => r.open);
  }

  /** Everything known, closed entries included, most recently a tab first. */
  listAll(): FactoryRef[] {
    return this.refs;
  }

  /** Any known factory, open or closed: reopening one has to be able to find it. */
  get(id: string): FactoryRef | undefined {
    return this.refs.find((r) => r.id === id);
  }

  /**
   * Add a factory, or update the name and location of one already known.
   *
   * Omitting `open` means open, since every caller of this is the app opening,
   * creating, importing or editing a tab. A new or reopened entry goes to the
   * front, because that is the app touching a factory as a tab. One that is
   * already open keeps its slot: `list()` is the tab order, and renaming a tab or
   * moving its directory should not shuffle the strip.
   */
  async put(ref: Omit<FactoryRef, 'open'> & { open?: boolean }): Promise<FactoryRef> {
    const next: FactoryRef = {
      id: ref.id,
      name: ref.name,
      baseDir: path.resolve(ref.baseDir),
      open: ref.open ?? true,
    };
    const at = this.refs.findIndex((r) => r.id === next.id);
    const was = at === -1 ? undefined : this.refs[at];
    const inPlace = was !== undefined && was.open && next.open;
    if (was !== undefined) this.refs.splice(at, 1);
    if (inPlace) this.refs.splice(at, 0, next);
    else this.refs.unshift(next);
    await this.write();
    return next;
  }

  /**
   * Add a factory the operator did not ask for, without disturbing anything.
   *
   * This is what the scan registers with, and it is a separate method from `put`
   * because every one of `put`'s defaults is wrong here. `put` is the app touching
   * a tab: it opens what it adds and moves it to the front, both of which are
   * correct when a person pressed Open and neither of which is correct when a walk
   * of the home directory turned up twelve folders. A loop over `put` would open
   * twelve tabs and reorder the strip on the way.
   *
   * So: `open: false`, and appended at the end rather than unshifted. The array's
   * front is "most recently a tab", and a factory nobody has opened yet has no
   * claim on it. The tail is also where closed entries already collect, so found
   * factories land among their own kind.
   *
   * An id already present is left completely alone and returned as it stands. The
   * scan decides what a repeat id means - moved, or copied - before it gets here,
   * and this refusing to overwrite is the backstop that keeps a bug in that
   * decision from quietly rewriting the operator's list.
   */
  async adopt(ref: Omit<FactoryRef, 'open'>): Promise<FactoryRef> {
    const existing = this.refs.find((r) => r.id === ref.id);
    if (existing !== undefined) return existing;
    const next: FactoryRef = {
      id: ref.id,
      name: ref.name,
      baseDir: path.resolve(ref.baseDir),
      open: false,
    };
    this.refs.push(next);
    await this.write();
    return next;
  }

  /**
   * The factory did not change, its folder moved.
   *
   * Point an existing entry at a new directory and change nothing else - not the
   * name, not the open flag, not its place in the order. The scan calls this when
   * it finds a known id at an unknown path whose old path holds no document any
   * more, which is what a renamed or relocated folder looks like from outside.
   *
   * Distinct from `put` for the same reason `adopt` is: `put` would work, and would
   * also move the entry to the front, announcing a move nobody made as a tab
   * somebody touched. Distinct from `adopt` because this is the one case where
   * overwriting an existing entry is exactly the point.
   *
   * The name deliberately does not follow the document. A factory renamed in the
   * registry and never saved is a case that exists, and the registry's name is the
   * operator's - see the `skipped` rule in the scan.
   */
  async relocate(id: string, baseDir: string): Promise<FactoryRef | undefined> {
    const ref = this.refs.find((r) => r.id === id);
    if (ref === undefined) return undefined;
    const next = path.resolve(baseDir);
    if (ref.baseDir === next) return ref;
    ref.baseDir = next;
    await this.write();
    return ref;
  }

  /**
   * Take in an older registry from somewhere else, once.
   *
   * The move to `~/.kirofactory/factories.json` left a file behind in every
   * checkout, and this is how those entries arrive. Union by `id`, with what is
   * already here winning: the per-user file is the live one, and a checkout that
   * has been sitting untouched for a month must not be able to reinstate the name,
   * location or open flag its stale copy remembers.
   *
   * Entries the union keeps are appended, so an inherited factory does not push
   * itself to the front of the tab strip - same reasoning as `adopt`. They keep
   * their own `open` flag, though, because this is not a discovery: those really
   * were the operator's tabs, and losing them on the way to a better location
   * would make the migration itself the fourth way to lose a factory.
   *
   * Reads the file directly rather than through a second `Registry`, so a missing
   * or malformed one is nothing to merge rather than an error, and takes care not
   * to write when there is nothing to add - the common case, every startup after
   * the first.
   *
   * Returns how many entries came across, for the startup line.
   */
  async mergeInto(other: string): Promise<number> {
    const from = path.resolve(other);
    if (from === this.file || !existsSync(from)) return 0;

    let incoming: FactoryRef[];
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(from, 'utf8'));
      const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.factories) ? raw.factories : [];
      incoming = list.filter(isObject).flatMap((r) => {
        if (typeof r.id !== 'string' || typeof r.baseDir !== 'string') return [];
        return [{
          id: r.id,
          name: typeof r.name === 'string' ? r.name : r.id,
          baseDir: path.resolve(r.baseDir),
          open: typeof r.open === 'boolean' ? r.open : true,
        }];
      });
    } catch {
      return 0;
    }

    const have = new Set(this.refs.map((r) => r.id));
    const added = incoming.filter((r) => !have.has(r.id));
    if (added.length === 0) return 0;
    this.refs = [...this.refs, ...added];
    await this.write();
    return added.length;
  }

  /**
   * Close the tab and keep the factory.
   *
   * Nothing on disk is touched and the entry stays where it is, so the factory can
   * still be listed and offered back later. Hard delete is `remove`.
   */
  async close(id: string): Promise<void> {
    const ref = this.refs.find((r) => r.id === id);
    if (ref === undefined || !ref.open) return;
    ref.open = false;
    await this.write();
  }

  /** Forget a factory entirely. For deletion; closing a tab is `close`. */
  async remove(id: string): Promise<void> {
    this.refs = this.refs.filter((r) => r.id !== id);
    await this.write();
  }

  /** Tab order, as the strip shows it. */
  async reorder(ids: string[]): Promise<FactoryRef[]> {
    const byId = new Map(this.refs.map((r) => [r.id, r]));
    const ordered = ids.flatMap((id) => {
      const ref = byId.get(id);
      if (!ref) return [];
      byId.delete(id);
      return [ref];
    });
    // Anything the client did not mention keeps its place at the end rather than
    // being dropped, so a stale list cannot delete a factory. The strip only knows
    // the open ones, so that tail is where the closed entries end up: they lose
    // their recency order when the operator reorders tabs, which is a position they
    // are never shown in anyway.
    this.refs = [...ordered, ...byId.values()];
    await this.write();
    return this.refs;
  }

  private async write(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, `${JSON.stringify(this.refs, null, 2)}\n`, 'utf8');
  }
}

/**
 * Bring a pre-tabs installation forward.
 *
 * Before this, there was one document at `app/factory.json` and one workspace at
 * `app/workspace/` with `wires/` and `loops/` directly inside it. That is now one
 * factory whose base directory is that same workspace, with both folders moved
 * under `.kirofactory/` where every other factory keeps them.
 *
 * Done once, guarded on the registry not existing yet, and logged: it moves
 * folders holding real queue items, so it should be visible that it happened.
 *
 * Returns the factory to register, or undefined when there is nothing to bring
 * forward.
 */
export async function migrateLegacy(opts: {
  legacyDoc: string;
  legacyWorkspace: string;
}): Promise<Factory | undefined> {
  const { legacyDoc, legacyWorkspace } = opts;
  if (!existsSync(legacyDoc) && !existsSync(legacyWorkspace)) return undefined;

  const baseDir = path.resolve(legacyWorkspace);
  const internal = path.join(baseDir, INTERNAL);
  await fsp.mkdir(internal, { recursive: true });

  for (const folder of ['wires', 'loops']) {
    const from = path.join(baseDir, folder);
    const to = path.join(internal, folder);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      await fsp.rename(from, to);
      process.stdout.write(`  moved ${folder}/ into ${INTERNAL}/\n`);
    } catch {
      // A failed move leaves the old folder in place. The factory still opens;
      // it just starts with empty queues, which is better than not starting.
    }
  }

  // A document already at the destination means this ran before and the registry
  // was lost or cleared since. Reading that one rather than the legacy file keeps
  // the factory's id and name, so the same factory comes back instead of a copy of
  // it with a new identity.
  const target = path.join(internal, DOC_NAME);
  const source = existsSync(target) ? target : legacyDoc;

  let doc: Record<string, unknown> = {};
  if (existsSync(source)) {
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(source, 'utf8'));
      if (isObject(raw)) doc = raw;
    } catch {
      // An unreadable document migrates as an empty factory rather than blocking
      // startup.
    }
  }

  const migrated = {
    ...doc,
    id: typeof doc.id === 'string' ? doc.id : newFactoryId(),
    name: typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : 'Factory',
    baseDir,
  };
  await fsp.writeFile(target, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
  process.stdout.write(`  wrote ${path.relative(baseDir, target)}\n`);
  return migrated as unknown as Factory;
}
