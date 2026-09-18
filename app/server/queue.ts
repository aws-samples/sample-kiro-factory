/**
 * A queue is a folder. A wire is a queue. An item is a file in it.
 *
 * That is the whole design now. There used to be three subfolders - `pending/`,
 * `claimed/`, `done/` - and a protocol for moving an item between them. It is
 * gone: an item sits in the queue folder until a loop takes it, and taking it
 * removes it.
 *
 * Taking is a MOVE, not a read-then-delete, and that distinction is the only
 * subtle thing left here. A rename is atomic within a filesystem, so it either
 * succeeds or fails, which means two loops racing for the same item cannot both
 * get it: the loser's rename reports that the file is gone and it picks another.
 * A read followed by a delete has a window between the two where both loops think
 * they own the work.
 *
 * What this costs, stated plainly: there is no longer a record on the wire of what
 * crossed it. `done/` was that record. The trade is that a queue now shows exactly
 * what is outstanding and nothing else, and the history of what a loop did lives
 * in the loop's own output rather than in a folder that grows forever.
 *
 * This module provides the mechanism and none of the policy. It does not assign
 * work, does not know what an item means, and does not schedule. The agent decides
 * what to take and in what order, because that needs judgement about the content
 * and a filesystem has none.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** One unit of work sitting on a wire. */
export interface QueueItem {
  id: string;
  /** ISO timestamp of when the item was produced. */
  ts: string;
  /** Loop that produced the item. */
  producer: string;
  /** Inline payload, for items small enough to carry their own content. */
  payload?: unknown;
  /** Relative pointer to a larger artifact, instead of a payload. */
  artifact?: string;
}

/** The three-stage subfolders this layout replaced. */
const LEGACY_STAGES = ['pending', 'claimed', 'done'] as const;

let seq = 0;
function newItemId(): string {
  seq = (seq + 1) % 10_000;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Queue {
  /** Absolute path of the queue folder. Items live directly in it. */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Create the folder, and migrate a queue left over from the staged layout. */
  async create(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await this.migrateLegacy();
  }

  /**
   * Lift items out of an old `pending/` folder and drop the stage folders.
   *
   * Without this, a workspace created before the layout changed would look empty
   * while its items sat one level down, which reads as "my work disappeared".
   * Items in `claimed/` come back too: a loop that was holding one when the layout
   * changed never finished it, so it is outstanding work. `done/` is discarded -
   * that is the record the new layout deliberately does not keep, and restoring it
   * to the queue would re-run work that was already finished.
   */
  private async migrateLegacy(): Promise<void> {
    for (const stage of LEGACY_STAGES) {
      const stageDir = path.join(this.dir, stage);
      if (!existsSync(stageDir)) continue;
      if (stage !== 'done') {
        for (const from of await this.findJson(stageDir)) {
          const to = path.join(this.dir, path.basename(from));
          // An existing file of the same name is the newer one; leave it alone.
          if (!existsSync(to)) await fsp.rename(from, to).catch(() => undefined);
        }
      }
      await fsp.rm(stageDir, { recursive: true, force: true });
    }
  }

  /** Produce an item into the queue. */
  async put(input: { producer: string; payload?: unknown; artifact?: string }): Promise<QueueItem> {
    const item: QueueItem = {
      id: newItemId(),
      ts: new Date().toISOString(),
      producer: input.producer,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.artifact !== undefined ? { artifact: input.artifact } : {}),
    };
    await fsp.mkdir(this.dir, { recursive: true });
    // Write to a temp name and rename, so a consumer never sees a half-written item.
    const tmp = path.join(this.dir, `.${item.id}.json.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(item, null, 2), 'utf8');
    await fsp.rename(tmp, path.join(this.dir, `${item.id}.json`));
    return item;
  }

  /** How many items are outstanding. */
  async count(): Promise<number> {
    return (await this.itemNames()).length;
  }

  /** The items in the queue, oldest first. A read, not a take. */
  async list(): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    for (const name of await this.itemNames()) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8')) as QueueItem;
        if (typeof raw.id === 'string') items.push(raw);
      } catch {
        // A take can race a read; a vanished or half-visible file is not an error.
      }
    }
    items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return items;
  }

  /**
   * Throw away every outstanding item. Returns how many went.
   *
   * The folder stays. An empty folder is a queue with nothing in it; a missing one is
   * a path an agent finds absent halfway through a turn, which is the state `create`
   * exists to prevent. So this empties rather than removes - removing is what happens
   * when the last wire delivering here is deleted, and that is a different event.
   *
   * Only item files go, by the same filter `count` and `list` use, so a `.tmp` from a
   * `put` still in flight is left to land. Each unlink is allowed to fail: a consumer
   * can take an item between the listing and the delete, and that is the item leaving
   * by the front door rather than an error.
   */
  async clear(): Promise<number> {
    let gone = 0;
    for (const name of await this.itemNames()) {
      try {
        await fsp.rm(path.join(this.dir, name));
        gone += 1;
      } catch {
        // Taken by a loop first, or already gone. Either way it is not here now.
      }
    }
    return gone;
  }

  private async itemNames(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    return (await fsp.readdir(this.dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  }

  private async findJson(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // `claimed/` nests one level deeper, a folder per claimant.
      if (entry.isDirectory()) out.push(...(await this.findJson(full)));
      else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) out.push(full);
    }
    return out;
  }
}
