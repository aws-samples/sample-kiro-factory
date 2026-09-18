/**
 * Two texts, turned into the rows a diff is drawn from.
 *
 * Pure functions over strings, in the same spirit as filetree.ts and for the same
 * reason: the server sends two whole files and the browser decides what to draw, so
 * everything about *how* a diff is laid out belongs on this side and none of it
 * needs React to be tested or read.
 *
 * Inline rather than side by side. The file panel is the short edge of the window -
 * the note at the top of LoopFiles.tsx makes the same argument for showing a tree or
 * a file rather than both - and two columns halve a width that is already the
 * constraint. One column of rows, each marked as unchanged, added or removed, reads
 * at any width and is what a narrow panel can actually show.
 */

/** One row of the rendered diff. */
export interface DiffRow {
  /**
   * What the row is.
   *
   * `skip` is not a line at all: it stands for a run of unchanged lines that were
   * collapsed, and carries how many in `count`. See `collapse`.
   */
  kind: 'same' | 'add' | 'del' | 'skip';
  /** Line number in the before text, 1-based. Absent on an added line. */
  before?: number;
  /** Line number in the after text, 1-based. Absent on a removed line. */
  after?: number;
  text: string;
  /** How many unchanged lines a `skip` row stands for. */
  count?: number;
}

/**
 * Unchanged lines kept either side of a change.
 *
 * Three is the conventional amount and it is the right amount here for the same
 * reason it is elsewhere: enough to see which function you are looking at, not
 * enough to push the next change off the screen.
 */
export const CONTEXT = 3;

/**
 * The largest LCS table worth building, in cells.
 *
 * The table is the exact algorithm and it is quadratic, so it needs a ceiling. Four
 * million cells is a 2000-line change against a 2000-line change, which is far past
 * anything a person is going to read row by row, and it costs 16MB as a Uint32Array
 * for the moment it takes to walk. Past that, `blocks` gives an honest coarse
 * answer instead of locking the tab up producing a precise one nobody wanted.
 *
 * Worth knowing that this is the size of the *differing middle*, not of the files:
 * common prefixes and suffixes are trimmed first, so a one-line edit to a
 * ten-thousand-line file never comes near it.
 */
const MAX_CELLS = 4_000_000;

/**
 * Split a text into lines the way a diff needs them.
 *
 * A trailing newline is dropped rather than producing a final empty line, because
 * almost every text file ends with one and showing it as an extra blank row at the
 * bottom of every diff would be noise on every file. `\r\n` is normalised, so a file
 * whose line endings changed does not read as every line having been rewritten.
 */
function lines(text: string): string[] {
  if (text.length === 0) return [];
  const body = text.replace(/\r\n/g, '\n');
  const out = body.split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Diff two texts, line by line.
 *
 * Three stages, and the first two are what make the third affordable. Common lines
 * at the start and end are matched off directly, which is most of the work for a
 * typical edit. What is left is the part that actually differs, and only that is fed
 * to the exact algorithm - and only if it is small enough to be worth it.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = lines(before);
  const b = lines(after);

  // Matching lines at the top, taken in one pass. `head` ends up as the count of
  // rows that are identical on both sides before anything interesting happens.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  // The same from the bottom, stopping before it can overlap the head - otherwise a
  // file of identical lines gets counted twice and the middle goes negative.
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i += 1) {
    rows.push({ kind: 'same', before: i + 1, after: i + 1, text: a[i]! });
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  rows.push(...middle(midA, midB, head));

  for (let i = 0; i < tail; i += 1) {
    const ai = a.length - tail + i;
    rows.push({ kind: 'same', before: ai + 1, after: b.length - tail + i + 1, text: a[ai]! });
  }

  return rows;
}

/**
 * The differing part, once the matching ends have been taken off.
 *
 * `offset` is how many lines were already matched at the top, so line numbers come
 * out right rather than restarting at one in the middle of a file.
 */
function middle(a: string[], b: string[], offset: number): DiffRow[] {
  if (a.length === 0 && b.length === 0) return [];
  // One side empty is a pure addition or a pure deletion, and no algorithm is
  // needed to say so. Worth checking because a new file is exactly this case.
  if (a.length === 0 || b.length === 0) return blocks(a, b, offset);
  if (a.length * b.length > MAX_CELLS) return blocks(a, b, offset);
  return exact(a, b, offset);
}

/**
 * Everything removed, then everything added.
 *
 * The answer when one side is empty, where it happens to also be the exact answer,
 * and the fallback when the two sides are too large to compare properly. Coarse but
 * never wrong: every line of the old text is gone and every line of the new one is
 * there, which is true, and the alternative was not answering.
 */
function blocks(a: string[], b: string[], offset: number): DiffRow[] {
  return [
    ...a.map((text, i) => ({ kind: 'del' as const, before: offset + i + 1, text })),
    ...b.map((text, i) => ({ kind: 'add' as const, after: offset + i + 1, text })),
  ];
}

/**
 * The longest common subsequence, and the rows that follow from it.
 *
 * The textbook table, filled bottom-up so the walk that reads it out runs forwards
 * and produces rows already in order. `Uint32Array` rather than nested arrays
 * because the table is the whole memory cost of this function and a flat typed array
 * is one allocation of exactly the size needed.
 *
 * A removed line and the line that replaced it come out as a `del` immediately
 * followed by an `add`, which is what an inline diff wants: the two rows sit
 * together and read as the change they are.
 */
function exact(a: string[], b: string[], offset: number): DiffRow[] {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + (j + 1)]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', before: offset + i + 1, after: offset + j + 1, text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j]! >= table[i * w + (j + 1)]!) {
      rows.push({ kind: 'del', before: offset + i + 1, text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: 'add', after: offset + j + 1, text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ kind: 'del', before: offset + i + 1, text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ kind: 'add', after: offset + j + 1, text: b[j]! });
    j += 1;
  }

  return rows;
}

/**
 * Replace long runs of unchanged lines with a marker.
 *
 * Without this, a one-line change to a large file is one interesting row and two
 * thousand boring ones, and the interesting one is somewhere in the middle of a
 * scroll. With it, the diff is the changes and the few lines around each.
 *
 * A run is only collapsed when there is enough of it to be worth collapsing: two
 * lines hidden behind a "2 unchanged lines" row is more to read, not less, so the
 * run has to exceed the context it would keep on both sides by a clear margin.
 */
export function collapse(rows: DiffRow[], context = CONTEXT): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;

  while (i < rows.length) {
    if (rows[i]!.kind !== 'same') {
      out.push(rows[i]!);
      i += 1;
      continue;
    }

    // The whole run of unchanged rows, so the decision is made once for the run
    // rather than row by row.
    let end = i;
    while (end < rows.length && rows[end]!.kind === 'same') end += 1;
    const run = rows.slice(i, end);

    // Context is only owed to a side that has a change on it. A run at the very top
    // or the very bottom of the file keeps nothing, which is why an unchanged
    // preamble collapses away entirely instead of leaving three lines of nothing.
    const lead = i === 0 ? 0 : context;
    const trail = end === rows.length ? 0 : context;

    if (run.length <= lead + trail + 2) {
      out.push(...run);
    } else {
      const hidden = run.length - lead - trail;
      out.push(...run.slice(0, lead));
      out.push({
        kind: 'skip',
        count: hidden,
        text: `${hidden} unchanged line${hidden === 1 ? '' : 's'}`,
      });
      out.push(...run.slice(run.length - trail));
    }
    i = end;
  }

  return out;
}

/** How many lines were added and removed, for the header to report. */
export function stats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    if (row.kind === 'del') removed += 1;
  }
  return { added, removed };
}
