/**
 * A tree you can open files from: either the selected loop's folder, or the project.
 *
 * A loop is given a folder of its own and told to keep its work there. Until now
 * the only way to see what came out was to leave the app and open the directory in
 * something else, which is a strange gap in a tool whose entire output is files.
 *
 * The project is the second source, and the more important one now that the loops
 * are told the base directory is a codebase to build rather than a place their own
 * folder happens to sit in. Same panel, same tree, same viewer - only the root
 * differs, so `source` selects it and everything below is written once.
 *
 * Changes is the third, and the one that answers the question the other two only
 * gesture at: not what is in the project, but what the loops have *done* to it.
 * Same tree, same rows, filled from git rather than from a folder walk, and opening
 * a row gives a diff instead of a file. It is only available when the directory is
 * a repository, because there is otherwise nothing to compare against - see
 * `GitState`.
 *
 * The three sources are not symmetric, and the asymmetry is deliberate. A loop's
 * folder is scratch an agent was handed, so it can be cleared and its files
 * deleted from here. The project is the operator's real source, so it is read-only:
 * see `listProjectFiles` on the server, which has no delete to call. Changes is a
 * reading of git and owns no files at all.
 *
 * Two views in one panel rather than a split: the tree, or one file filling the
 * space. A tree beside a viewer would give both of them half a panel that is
 * already the short edge of the window, and a file is the thing you came to read.
 *
 * Ported from the flock dashboard's environment panel, which solves the same
 * problem against S3. The tree maths came across in filetree.ts; this is the
 * rendering, and the two places it deliberately differs from the original:
 *
 *   - Markdown is sanitised before it is injected. Flock pipes `marked` straight
 *     into `innerHTML`, which is survivable there and is not here: this server
 *     answers `DELETE /api/factories/:f` on the same origin, and loops write files
 *     out of web pages they have read. An `<img onerror>` in a loop's notes should
 *     not be able to close a factory.
 *   - Polling stops. The original sets an interval and never clears it, which is
 *     invisible in a page that never unmounts and a leak in a component that does.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import { Confirm, type ConfirmAsk } from './Confirm.tsx';
import { Icon } from './Icon.tsx';
import {
  api,
  type ChangeEntry,
  type DiffRange,
  type FileDiff,
  type GitState,
  type LoopFileEntry,
  type WorktreeEntry,
} from './api.ts';
import { nodeLabel } from './types.ts';
import { collapse, lineDiff, stats, type DiffRow } from './diff.ts';
import {
  buildTree,
  fmtBytes,
  fmtWhen,
  isMarkdown,
  languageOf,
  sortNodes,
  type FolderNode,
  type Node,
  type SortMode,
} from './filetree.ts';
import 'highlight.js/styles/github-dark.css';

/**
 * How often the tree re-reads the folder, while it is open.
 *
 * A running loop writes whenever it likes and tells nobody, so this is the same
 * bargain the wire labels make: no push exists, so it is a timer. Only while open,
 * because a folder walk for a panel that is folded shut is work for nobody.
 */
const POLL_MS = 2000;

/**
 * How often the changes view asks git, while it is open.
 *
 * Slower than the folder walk above, because it is not one. Answering it runs
 * `status` and `diff` in a subprocess, and `status` on a large repository is the
 * expensive call in this whole app - every two seconds it would be a background
 * process doing real work for a panel nobody is necessarily reading. Five seconds is
 * still well inside the time it takes to notice a file appear.
 */
const CHANGES_POLL_MS = 5000;

/** Rows are indented by hand, since the tree is flat `<li>`s rather than nested. */
const INDENT = 14;

/** Sort order outlives a reload. It is a preference, not a property of a loop. */
const STORE_SORT = 'files-sort';

/** So does the diff range. Also a preference: which comparison you think in. */
const STORE_RANGE = 'files-range';

function storedSort(): SortMode {
  const raw = window.localStorage.getItem(STORE_SORT);
  return raw === 'modified' || raw === 'size' ? raw : 'name';
}

function storedRange(): DiffRange {
  return window.localStorage.getItem(STORE_RANGE) === 'branch' ? 'branch' : 'uncommitted';
}

/** What a status letter means, spelled out for the row's tooltip. */
const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
};

/**
 * Markdown to HTML, safely.
 *
 * Frontmatter is pulled off and shown as a small table rather than left to
 * `marked`, which renders a leading `---` block as a heading and a rule and makes
 * a mess of the top of the file. Loops write frontmatter often enough - it is the
 * obvious place to put an item's id - that it is worth the ten lines.
 *
 * `DOMPurify` is the last thing to touch the string. It strips scripts, event
 * handlers and `javascript:` URLs, which is the whole of what an untrusted
 * markdown file can attack this page with.
 */
function renderMarkdown(text: string): string {
  let front = '';
  let body = text;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match) {
    const rows = match[1]!
      .split('\n')
      .map((line) => {
        const colon = line.indexOf(':');
        if (colon < 0) return null;
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')];
      })
      .filter((pair): pair is string[] => pair !== null);
    if (rows.length > 0) {
      // Escaped by hand because this text never reaches `marked`, so this is the
      // one path into the viewer that nothing else would have escaped.
      const cells = rows
        .map(([k, v]) => `<tr><td>${escapeHtml(k!)}</td><td>${escapeHtml(v!)}</td></tr>`)
        .join('');
      front = `<table class="files-front">${cells}</table>`;
      body = match[2] ?? '';
    }
  }

  // `async: false` is what makes this return a string rather than a promise; the
  // default is a union and there is nothing here worth awaiting.
  return DOMPurify.sanitize(front + marked.parse(body, { async: false }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A source file as highlighted HTML, or null to show it as plain text.
 *
 * Null for anything with no language, and also for anything highlight.js refuses:
 * the `common` bundle is a subset, and a language that is in the extension map but
 * not in the bundle throws rather than returning unhighlighted. Plain text is a
 * fine answer either way and is what the caller does with null.
 */
function highlight(name: string, content: string): string | null {
  const language = languageOf(name);
  if (language === null) return null;
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * Is this a page a browser could render?
 *
 * Case-insensitive and by name, for the reason `isMarkdown` gives: the loop chose
 * the name deliberately and it is better evidence than the bytes. `.htm` as well as
 * `.html`, because a loop copying a page off the web inherits whatever that site
 * called it.
 *
 * Local rather than in filetree.ts, where `isMarkdown` lives, because nothing but
 * this viewer asks the question. The tree does not care: an HTML file is a row like
 * any other and gets its language from `languageOf`.
 */
function isHtmlFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

/** The last path segment, which is the only part any of the name checks read. */
function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

interface OpenFile {
  path: string;
  content: string;
  /** Why there is no content: too large, or the read failed. */
  note?: string;
}

/**
 * Which of the two presentations an HTML file is being shown in.
 *
 * Only HTML has two. Everything else the viewer opens has one right answer, so this
 * is not a general "view mode" and is deliberately not named like one.
 */
type HtmlMode = 'source' | 'rendered';

/**
 * Which of the three the panel is showing.
 *
 * Held by the parent rather than here, because selecting a loop on the canvas moves
 * it and the canvas is up there. The switch in this panel's own bar changes it
 * through `onTarget`, so there is one value and two things that can set it.
 */
export type FilesTarget = 'loop' | 'project' | 'changes';

export function LoopFiles({
  factoryId,
  target,
  loop,
  git,
  checkout,
  open,
  onTarget,
  onFiles,
}: {
  factoryId: string;
  /** Which source to show. `loop` with nothing selected is the empty state. */
  target: FilesTarget;
  /**
   * The selected loop, when there is one.
   *
   * The name as well as the id, because the switch labels itself with it and the
   * confirm dialogs say it, and the panel has no other way to look one up.
   */
  loop: { id: string; name: string } | null;
  /**
   * What git makes of the factory's directory, or null before the first answer.
   *
   * Passed in rather than fetched here, so the directory bar and this panel say the
   * same thing from one request - and so the changes segment can be unavailable
   * rather than merely failing when there is no repository.
   */
  git: GitState | null;
  /**
   * The session checkout the changes view should read, when the selected loop
   * works in worktrees of its own - the runner key the panel is reading, and
   * the branch for the wording. Null reads the factory's directory, which is
   * every loop before per-session checkouts existed.
   *
   * This deliberately makes the changes view follow the selection: a loop whose
   * sessions commit on their own branches shows nothing in the factory's
   * directory, so pointing the comparison at its checkout is the only version
   * of "what has this loop done" that is not an empty list.
   */
  checkout?: { key: string; branch: string } | null;
  /** Whether the panel is unfolded. Polling and fetching follow it. */
  open: boolean;
  /** Change which source is shown, from the switch in the bar. */
  onTarget: (target: FilesTarget) => void;
  /**
   * How many files a loop turned out to have, reported once per loop.
   *
   * Once, not per poll: the panel opening itself because a loop has files is
   * helpful the first time you select that loop and rude every two seconds after
   * you have folded it shut again.
   *
   * Loops only. Neither of the other two is a reason to open the panel by itself -
   * you get there by asking, and the asking already opens it.
   */
  onFiles: (loopId: string, count: number) => void;
}) {
  const [dir, setDir] = useState('');
  const [files, setFiles] = useState<LoopFileEntry[]>([]);
  /**
   * The listing stopped at the server's cap. Kept beside `files` because they
   * arrive together and mean nothing apart: the tag this drives is a caption on
   * exactly this list. Changes never sets it - git's list is never capped.
   */
  const [truncated, setTruncated] = useState(false);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortMode>(storedSort);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DiffRange>(storedRange);
  /**
   * Status letters by path, for the changes view's rows.
   *
   * Beside the file list rather than on it, which is what lets `buildTree` and
   * `sortNodes` take a changes list without knowing anything about git: they see the
   * `LoopFileEntry` fields they already understand, and a row looks its own letter up
   * by path when it draws itself.
   */
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  /** Why the changes list is empty, and what it compared against. From the server. */
  const [changesNote, setChangesNote] = useState<string | null>(null);
  const [changesBase, setChangesBase] = useState<string | null>(null);
  /** The open file's two sides, in the changes view. Null in the other two. */
  const [diff, setDiff] = useState<FileDiff | null>(null);
  /**
   * Every checkout the factory's sessions have, for the project view's picker.
   * Refreshed on the same poll as the listing, so a checkout made by a start
   * appears in the dropdown while you watch.
   */
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  /**
   * Which root the project view reads: `auto` follows the canvas selection - a
   * worktree loop's session shows its checkout, anything else the main
   * directory - and a hand-pick from the dropdown overrides it until the
   * selection moves again. Reset rather than persisted on selection change,
   * because "the loop I just clicked" is the answer the panel should default
   * to, which is the whole point of `auto` existing.
   */
  const [projectPick, setProjectPick] = useState<'auto' | 'main' | string>('auto');
  /**
   * The open question, if there is one.
   *
   * Held here and rendered here rather than raised to FactoryView, which is what
   * the wire panel does with its own delete: a component that asks a question owns
   * the asking, and there is then no callback to keep in step.
   */
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);

  /** Loops already announced to the parent, so the open is offered only once. */
  const announced = useRef(new Set<string>());

  /** A file from outside is over the panel, and whether it would be taken. */
  const [dropping, setDropping] = useState(false);

  /**
   * Which presentation an HTML file gets: its markup, or the page.
   *
   * Source by default, because the panel's audience is reading what a loop wrote and
   * markup is what it wrote. One value for the panel rather than one per file, so
   * opening three HTML files in a row leaves the third the way the first was left -
   * sticky while the panel lives, and gone when it unmounts.
   *
   * Not persisted. Which presentation you want is a property of what you are doing
   * this minute, unlike the sort order and the diff range above, which are opinions
   * you hold. Flock made the same call.
   */
  const [htmlMode, setHtmlMode] = useState<HtmlMode>('source');

  /*
   * The target, taken apart into the primitives the rest of this component wants.
   *
   * Primitives rather than objects, because these are effect and callback
   * dependencies and the parent has no reason to keep an object stable: an identity
   * that changed every render would re-run a folder walk on every keystroke
   * elsewhere in the view. `loopId` is also the null that guards every loop-only
   * operation, so having it as one value keeps those guards to one comparison.
   */
  const isProject = target === 'project';
  const isChanges = target === 'changes';
  /** The session checkout the changes view reads, as a primitive for the deps. */
  const checkoutKey = isChanges && checkout != null ? checkout.key : null;
  // '' means "worktree loop whose checkout is not made yet" - key still set, so
  // the fetch takes the per-session path and reports why it is empty.
  const checkoutBranch = checkout != null && checkout.branch.length > 0 ? checkout.branch : null;
  const loopId = target === 'loop' && loop !== null ? loop.id : null;
  const loopName = loop?.name ?? '';
  /**
   * The checkout the project view is reading, or null for the main directory.
   *
   * `auto` resolves through the selection, and only to a checkout that is
   * actually in the list: a worktree loop that has never been started has
   * intent but no directory, and silently showing the main project beats a
   * picker claiming a place that is not there. An explicit pick whose checkout
   * has since been released falls back the same way.
   */
  const projectCheckout = !isProject
    ? null
    : projectPick === 'main'
      ? null
      : projectPick === 'auto'
        ? (checkout != null && worktrees.some((w) => w.key === checkout.key) ? checkout.key : null)
        : worktrees.some((w) => w.key === projectPick)
          ? projectPick
          : null;
  /** Only a loop's own folder has deletes. The other two read something real. */
  const readOnly = !isProject && !isChanges ? loopId === null : true;
  /** Nothing to show yet, and no request to make either. */
  const idle = !isProject && !isChanges && loopId === null;
  /** Changes needs a repository to compare against. See `GitState`. */
  const noRepo = git !== null && git.kind === 'none';

  useEffect(() => {
    window.localStorage.setItem(STORE_SORT, sort);
    window.localStorage.setItem(STORE_RANGE, range);
  }, [sort, range]);

  const load = useCallback((): void => {
    if (!isProject && !isChanges && loopId === null) return;

    if (isChanges) {
      void (checkoutKey !== null ? api.loopChanges(factoryId, checkoutKey, range) : api.changes(factoryId, range))
        .then((res) => {
          setDir(res.dir);
          setFiles(res.files);
          setTruncated(false);
          // Rebuilt from the answer rather than merged into, so a file that stopped
          // being changed loses its letter instead of keeping a stale one.
          setStatuses(Object.fromEntries(res.files.map((f: ChangeEntry) => [f.path, f.status])));
          setChangesNote(res.note ?? null);
          setChangesBase(res.base ?? null);
          setError(null);
        })
        .catch((e: Error) => {
          // A session whose checkout has not been made yet - the loop was ticked
          // but never started - answers 404, and that is an empty list with a
          // reason, not a broken panel.
          if (checkoutKey !== null) {
            setFiles([]);
            setStatuses({});
            setChangesNote('This session has no checkout yet. It is created when the loop starts.');
            setError(null);
          } else {
            setError(e.message);
          }
        });
      return;
    }

    if (isProject) {
      // The picker's options ride the same poll as the listing: cheap, and a
      // checkout provisioned by a start appears while you watch.
      void api
        .worktrees(factoryId)
        .then((r) => setWorktrees(r.sessions))
        .catch(() => undefined);
    }

    void (isProject
      ? api.projectFiles(factoryId, projectCheckout ?? undefined)
      : api.loopFiles(factoryId, loopId!)
    )
      .then((res) => {
        setDir(res.dir);
        setFiles(res.files);
        setTruncated(res.truncated ?? false);
        setError(null);
        // Loops only, and once each. Neither other source opens the panel by itself.
        if (loopId !== null && !announced.current.has(loopId)) {
          announced.current.add(loopId);
          onFiles(loopId, res.files.length);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [factoryId, isProject, isChanges, checkoutKey, projectCheckout, loopId, range, onFiles]);

  // Back to following the selection whenever it moves. A hand-picked worktree
  // is an answer to "while I am here, show me that one", not a standing setting.
  const selectedKey = checkout?.key ?? null;
  useEffect(() => {
    setProjectPick('auto');
  }, [selectedKey, loop?.id]);

  /*
   * A different source is a different folder: everything about the old one goes,
   * including which file was open. Keeping the open file across a change would
   * leave the panel showing a file that is no longer anywhere in its tree - and
   * between the two sources it would be a path resolved against the wrong root.
   */
  useEffect(() => {
    setFile(null);
    setDiff(null);
    setOpenFolders(new Set());
    setFiles([]);
    setTruncated(false);
    setStatuses({});
    setChangesNote(null);
    setChangesBase(null);
    setDir('');
    setError(null);
    // The two checkout keys are in the list because a different session's
    // checkout is a different directory in exactly the way a different source is.
  }, [isProject, isChanges, loopId, checkoutKey, projectCheckout]);

  /*
   * Changing the range is a different comparison of the same directory, so the list
   * and any open diff both go - but which folders are open does not. The tree is the
   * same shape either way and reopening it by hand after every switch would make the
   * two ranges feel like two places.
   */
  useEffect(() => {
    setDiff(null);
    setFile(null);
  }, [range]);

  /*
   * Fetch once whatever the panel's state, then poll only while it is open.
   *
   * The first fetch has to happen even folded shut, because it is what answers the
   * question the fold depends on - whether this loop has anything worth showing.
   * The project is polled on the same terms: the loops are writing into it while
   * you watch, which is the thing you opened it to see.
   */
  useEffect(() => {
    load();
    if (!open) return;
    const timer = window.setInterval(load, isChanges ? CHANGES_POLL_MS : POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, load, isChanges]);

  /**
   * Open a row: a file's text, or in the changes view a file's two sides.
   *
   * `file` is set either way and holds the path, because the header is the same row
   * for both - a back button where the title was, and the path beside it. What
   * differs is what fills the body, and `diff` being set is what says which.
   */
  function show(path: string): void {
    if (!isProject && !isChanges && loopId === null) return;
    setLoading(true);
    setFile({ path, content: '' });
    setDiff(null);

    if (isChanges) {
      void (checkoutKey !== null
        ? api.loopDiff(factoryId, checkoutKey, path, range)
        : api.diff(factoryId, path, range)
      )
        .then((body) => {
          setDiff(body);
          setFile({
            path,
            // The text of the file as it stands, so Save still saves something.
            content: body.after,
            ...(body.note === undefined ? {} : { note: body.note }),
          });
        })
        .catch((e: Error) => setFile({ path, content: '', note: e.message }))
        .finally(() => setLoading(false));
      return;
    }

    void (isProject
      ? api.projectFile(factoryId, path, projectCheckout ?? undefined)
      : api.loopFile(factoryId, loopId!, path)
    )
      .then((body) =>
        setFile({
          path,
          content: body.content,
          ...(body.note === undefined ? {} : { note: body.note }),
        }),
      )
      .catch((e: Error) => setFile({ path, content: '', note: e.message }))
      .finally(() => setLoading(false));
  }

  /**
   * Delete one file, after asking.
   *
   * The server answers with the folder as it now stands, so the tree redraws from
   * the truth rather than from an assumption about what the delete did.
   */
  function removeFile(target: string): void {
    // Guarded as well as hidden. The buttons that call this are not rendered for
    // the project, and a delete reaching a source file because a future render
    // forgot that is not a bug worth leaving one branch away.
    if (loopId === null) return;
    setConfirm({
      title: `Delete ${target.split('/').pop() ?? target}?`,
      body: `It is removed from ${dir}. Nothing here keeps a copy, and a loop that expected to read it will not find it.`,
      action: 'Delete file',
      onConfirm: () => {
        void api
          .deleteLoopFile(factoryId, loopId, target)
          .then((res) => {
            setDir(res.dir);
            setFiles(res.files);
            setTruncated(res.truncated ?? false);
            // The file on screen is the one that just went, so stop showing it.
            setFile((shown) => (shown?.path === target ? null : shown));
          })
          .catch((e: Error) => setError(e.message));
      },
    });
  }

  /**
   * Empty the whole folder, after asking.
   *
   * The server refuses this while the loop is going, and says so - a running loop's
   * folder holds the item its turn claimed off a queue, which exists nowhere else.
   * That refusal arrives as the error message rather than being second-guessed here,
   * because the loop can start between the render and the click.
   */
  function clearAll(): void {
    if (loopId === null) return;
    const n = files.length;
    setConfirm({
      title: `Delete everything ${loopName} has written?`,
      body: `${n} file${n === 1 ? '' : 's'} under ${dir}, gone for good. The folder comes back empty the next time the loop takes a turn.`,
      action: 'Clear folder',
      onConfirm: () => {
        void api
          .clearLoopFiles(factoryId, loopId)
          .then((res) => {
            setDir(res.dir);
            setFiles(res.files);
            setTruncated(res.truncated ?? false);
            setFile(null);
          })
          .catch((e: Error) => setError(e.message));
      },
    });
  }

  /** Save the open file. Its text is already here, so nothing is fetched again. */
  function download(): void {
    if (file === null) return;
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.path.split('/').pop() ?? 'file';
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggle(path: string): void {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  const tree = useMemo(() => buildTree(files), [files]);

  /*
   * The diff, laid out, and how big it is.
   *
   * Computed here rather than inside `DiffBody` because the bar reports the counts
   * and the body draws the rows, and both want the same walk. Memoised on the payload,
   * so scrolling and the five-second poll do not re-diff a file that has not changed.
   */
  const diffRows = useMemo(
    () => (diff === null || diff.binary === true ? null : collapse(lineDiff(diff.before, diff.after))),
    [diff],
  );
  const diffStats = useMemo(() => (diffRows === null ? null : stats(diffRows)), [diffRows]);

  /**
   * One row, and its children when it is a folder that is open.
   *
   * A flat list of `<li>` with computed padding rather than nested `<ul>`s: the
   * indent is then one number per row instead of a stack of margins, and a deep
   * tree cannot walk itself off the right edge of a panel this narrow.
   */
  function rows(nodes: Node[], depth: number): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    for (const node of sortNodes(nodes, sort)) {
      const pad = { paddingLeft: 8 + depth * INDENT };
      if (node.kind === 'folder') {
        const isOpen = openFolders.has(node.path);
        out.push(
          <li key={node.path}>
            <div
              className="files-row files-row-folder"
              style={pad}
              onClick={() => toggle(node.path)}
              title={node.path}
            >
              <span className="files-twist">{isOpen ? '\u2212' : '+'}</span>
              <Icon name={isOpen ? 'hero-folder-open' : 'hero-folder'} />
              <span className="files-name">{node.name}</span>
              <span className="files-meta">
                {fmtBytes(node.size)}
                {node.time > 0 && ` \u00b7 ${fmtWhen(node.time)}`}
              </span>
            </div>
          </li>,
        );
        if (isOpen) out.push(...rows(node.children, depth + 1));
      } else {
        out.push(
          <li key={node.path}>
            <div
              className={`files-row files-row-file${file?.path === node.path ? ' active' : ''}`}
              style={pad}
              onClick={() => show(node.path)}
              title={node.path}
            >
              <span className="files-twist" />
              <span className="files-name">{node.name}</span>
              {/*
                What happened to this file, in the changes view only.

                One letter, coloured, sitting where the row's own name ends. A letter
                rather than an icon because git's letters are the vocabulary anyone
                reading a diff already has, and because at this size a green `A` and a
                red `D` are told apart from across the room while two 12px glyphs are
                not. The colour is doing most of the work and the letter is what makes
                it unambiguous for anyone who cannot see the difference.
              */}
              {isChanges && statuses[node.path] !== undefined && (
                <span
                  className={`files-status st-${letterClass(statuses[node.path]!)}`}
                  title={STATUS_WORDS[statuses[node.path]!] ?? statuses[node.path]!}
                >
                  {statuses[node.path]}
                </span>
              )}
              <span className="files-meta">
                {fmtBytes(node.size)}
                {node.time > 0 && ` \u00b7 ${fmtWhen(node.time)}`}
              </span>
              {/*
                The row opens the file, so this has to stop the click reaching it -
                otherwise deleting a file shows it first, and cancelling the question
                leaves you looking at something you were trying to get rid of.

                Absent for the project: these are real source files and there is no
                endpoint behind the button anyway.
              */}
              {!readOnly && (
                <button
                  className="files-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(node.path);
                  }}
                  title="Delete this file"
                  aria-label={`Delete ${node.name}`}
                >
                  <Icon name="hero-trash" />
                </button>
              )}
            </div>
          </li>,
        );
      }
    }
    return out;
  }

  /*
   * Where a dropped file may land: the root of the source being shown. Project
   * view is the project root, a loop's view is that loop's folder. Changes is a
   * comparison rather than a folder - there is no "into" - so it takes nothing,
   * and neither does the loop view with no loop selected.
   */
  const dropTarget = !isChanges && (isProject || loopId !== null);

  /**
   * Copy dropped files in, one PUT each, and redraw from the last answer.
   *
   * Sequential rather than parallel, so two files cannot interleave their listing
   * responses and leave the panel showing the earlier of the two. The name is the
   * file's own, which is what "copy it here" means, and an existing file of that
   * name is overwritten - the same bargain as `cp`.
   */
  function uploadDropped(list: FileList): void {
    const todo = [...list];
    if (todo.length === 0) return;
    setError(null);
    void (async () => {
      for (const f of todo) {
        const res = isProject
          ? await api.uploadProjectFile(factoryId, f.name, f, projectCheckout ?? undefined)
          : await api.uploadLoopFile(factoryId, loopId!, f.name, f);
        setDir(res.dir);
        setFiles(res.files);
        setTruncated(res.truncated ?? false);
      }
    })().catch((e: Error) => setError(e.message));
  }

  return (
    <section
      className={`files-panel${dropping ? (dropTarget ? ' dropping' : ' drop-refused') : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        // 'none' keeps the browser's cursor honest over the changes view: the
        // forbidden badge is the refusal, said where the pointer already is.
        e.dataTransfer.dropEffect = dropTarget ? 'copy' : 'none';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // `globalThis.Node`: this file's own `Node` is the tree's node type.
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) {
          setDropping(false);
        }
      }}
      onDrop={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDropping(false);
        if (!dropTarget) {
          setError(
            isChanges
              ? 'The changes view is a comparison, not a folder. Switch to Project or a loop to drop files into it.'
              : 'Select a loop first, or switch to Project.',
          );
          return;
        }
        uploadDropped(e.dataTransfer.files);
      }}
    >
      <header className="files-bar">
        {file ? (
          <>
            <button className="with-icon" onClick={() => setFile(null)}>
              <Icon name="hero-chevron-left" />
              Files
            </button>
            <span className="files-path" title={file.path}>
              {file.path}
            </span>
            {/*
              How big the change is, on the bar rather than over the diff.
              
              The counts belong beside the path for the same reason the size does in
              the tree: they are what the row is, and putting them in a strip of their
              own above the body would cost a line of a panel that has few to spare.
            */}
            {diffStats !== null && (
              <span className="files-tally">
                <span className="st-add">+{diffStats.added}</span>
                <span className="st-del">&minus;{diffStats.removed}</span>
              </span>
            )}
            <span className="spacer" />
            {/*
              Markup, or the page it describes.
              
              Only for an HTML file, and only outside the changes view: a diff of HTML
              is a diff, and the file itself is one segment away. The label names the
              mode it would switch *to*, so it reads as the action it is rather than as
              a badge saying which mode you are already in.
              
              The one button on this bar with a word and no icon. The two that could
              have stood for it are taken or wrong: the magnifying-glass document is
              this panel's own "Project" segment three lines up, and the queue list
              means a queue everywhere else in the app. A word that changes is clearer
              than a glyph borrowed from something else, and the mode it switches to is
              the whole of what there is to say.
            */}
            {!isChanges && isHtmlFile(baseName(file.path)) && (
              <button
                onClick={() => setHtmlMode(htmlMode === 'rendered' ? 'source' : 'rendered')}
                title={
                  htmlMode === 'rendered'
                    ? 'Show the markup instead'
                    : 'Render this page, without scripts'
                }
              >
                {htmlMode === 'rendered' ? 'source' : 'rendered'}
              </button>
            )}
            <button className="with-icon" onClick={() => show(file.path)} title="Read it again">
              <Icon name="hero-arrow-path" />
            </button>
            <button className="with-icon" onClick={download} title="Save this file">
              <Icon name="hero-arrow-down-tray" />
            </button>
            {!readOnly && (
              <button
                className="with-icon danger"
                onClick={() => removeFile(file.path)}
                title="Delete this file"
                aria-label="Delete this file"
              >
                <Icon name="hero-trash" />
              </button>
            )}
          </>
        ) : (
          <>
            {/*
              The switch, standing where the title used to.
              
              Replacing it rather than sitting beside it, which is what makes room on
              a strip that was already a title, a path, a sort and a delete. The title
              only ever said which of the sources you were looking at; a switch says
              the same thing by which segment is lit, and lets you change it. So this
              is one control where there were two half-controls - a label here and a
              button up on the directory bar that pointed the panel at the project.
              
              Each segment keeps the icon that was already standing for it, so the
              button on the directory bar and the segment it activates are visibly the
              same thing.
            */}
            <div className="files-switch" role="group" aria-label="What to show">
              {/*
                Project leads, because it is the default view and the one that is
                always available: the order of the segments is the order of how
                often they answer with nothing - the project always has files, a
                loop needs selecting, and changes need a repository.
              */}
              <button
                className={`files-seg${target === 'project' ? ' active' : ''}`}
                onClick={() => onTarget('project')}
                title="Every file in the directory this factory runs in"
              >
                <Icon name="hero-document-magnifying-glass" />
                <span className="files-seg-label">Project</span>
              </button>
              <button
                className={`files-seg${target === 'loop' ? ' active' : ''}`}
                onClick={() => onTarget('loop')}
                disabled={loop === null}
                title={
                  loop === null
                    ? 'Select a loop on the factory floor to see what it has written'
                    : `What ${loopName} has written`
                }
              >
                <Icon name="hero-folder" />
                <span className="files-seg-label">{loop === null ? 'Loop' : loopName}</span>
              </button>
              {/*
                Unavailable rather than hidden when there is no repository.
                
                Hidden, the view would be a feature that exists in some directories
                and not others with nothing to say why. Disabled with the reason in its
                tooltip, it is a thing you cannot use yet and an explanation of what
                would make it work - which for a directory that is not a repository is
                `git init`, and the directory bar is already saying so.
              */}
              <button
                className={`files-seg${target === 'changes' ? ' active' : ''}`}
                onClick={() => onTarget('changes')}
                disabled={noRepo}
                title={
                  noRepo
                    ? `${git?.reason ?? 'not a git repository'}, so there is nothing to compare against`
                    : 'What the loops have changed in the project'
                }
              >
                <Icon name="branch" />
                <span className="files-seg-label">Changes</span>
              </button>
            </div>
            {dir.length > 0 && (
              <span className="files-path" title={dir}>
                {dir}
              </span>
            )}
            <span className="spacer" />
            {/*
              Which comparison, in the changes view.
              
              The same `<select>` the sort uses, because it is the same kind of choice
              - a small named option on a panel bar - and a second widget style for it
              would be a second thing to learn. Offered whether or not the list has
              anything in it, unlike the sort: an empty list is exactly when you want
              to try the other range.
            */}
            {/*
              Which root the project view reads, when there is more than one.

              Only rendered when a checkout exists, so a factory that never
              turned worktrees on never sees it - the main directory is then the
              only answer and a dropdown of one option is a label in disguise.
              The value shown is the *resolved* choice, not the raw pick, so
              `auto` reads as whatever it currently resolves to and the control
              always names the directory the tree beside it is showing.
            */}
            {isProject && worktrees.length > 0 && (
              <select
                className="files-sort files-worktree"
                value={projectCheckout ?? 'main'}
                onChange={(e) => setProjectPick(e.target.value)}
                aria-label="Which checkout to browse"
                title={
                  projectCheckout === null
                    ? 'The main project directory - the factory\'s own checkout. Worktree loops do their work elsewhere: pick a session to see its copy.'
                    : `${worktrees.find((w) => w.key === projectCheckout)?.dir ?? ''} on ${worktrees.find((w) => w.key === projectCheckout)?.branch ?? ''}`
                }
              >
                <option value="main">main project</option>
                {worktrees.map((w) => (
                  <option key={w.key} value={w.key} title={`${w.dir} on ${w.branch}`}>
                    {w.member !== undefined ? `${w.loopName} ${nodeLabel(w.member)}` : w.loopName} - worktree
                  </option>
                ))}
              </select>
            )}
            {isChanges && !noRepo && (
              <select
                className="files-sort"
                value={range}
                onChange={(e) => setRange(e.target.value as DiffRange)}
                title={
                  range === 'uncommitted'
                    ? 'Everything not committed: staged, unstaged and untracked'
                    : `Everything since this branch left ${changesBase ?? 'the trunk'}, commits included`
                }
              >
                <option value="uncommitted">uncommitted</option>
                <option value="branch">since branch point</option>
              </select>
            )}
            {files.length > 0 && (
              <>
                {/*
                  Only when the listing is incomplete. A cap that is not being hit
                  is an implementation detail; one that is, is a fact about the
                  tree on screen - some files exist that this panel is not showing -
                  and that is worth a quiet caption where the eye already goes to
                  change how the list is shown.
                */}
                {truncated && (
                  <span
                    className="files-cap"
                    title="The project has more files than the panel lists. The walk stops here so the listing stays cheap; everything is still on disk."
                  >
                    first {files.length.toLocaleString()} files
                  </span>
                )}
                <select
                  className="files-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  title="Sort"
                >
                  <option value="name">name</option>
                  <option value="modified">modified</option>
                  <option value="size">size</option>
                </select>
                {!readOnly && (
                  <button
                    className="with-icon danger"
                    onClick={clearAll}
                    title="Delete everything in this loop's folder"
                  >
                    <Icon name="hero-trash" />
                    Clear
                  </button>
                )}
              </>
            )}
          </>
        )}
        {error !== null && (
          <span className="error" title={error} onClick={() => setError(null)}>
            {error}
          </span>
        )}
      </header>

      <div className="files-body">
        {file && isChanges ? (
          <DiffBody diff={diff} rows={diffRows} loading={loading} />
        ) : file ? (
          <FileBody file={file} loading={loading} htmlMode={htmlMode} />
        ) : idle ? (
          <p className="empty">
            Select a loop to see what it has written, or switch to the project or its changes.
          </p>
        ) : isChanges && noRepo ? (
          <p className="empty">
            {git?.reason ?? 'Not a git repository'}. There is nothing to compare the loops' work
            against, so nothing to show here. Run <code>git init</code> in the directory, or branch off
            into a worktree from the bar above.
          </p>
        ) : files.length === 0 ? (
          <p className="empty">
            {isChanges
              ? (changesNote ??
                (checkoutKey !== null
                  ? `Nothing changed in this session's checkout${checkoutBranch !== null ? ` on ${checkoutBranch}` : ''} yet.`
                  : range === 'uncommitted'
                    ? 'Nothing changed. Every file in the project is as git last saw it.'
                    : `Nothing since this branch left ${changesBase ?? 'the trunk'}.`))
              : isProject
                ? 'Nothing to show. Either the directory is empty, or everything in it is a folder this panel skips - dependencies, build output and version control.'
                : "Nothing here yet. A loop's folder appears the first time it takes a turn, and holds whatever it writes."}
          </p>
        ) : (
          <>
            {/*
              What the list is a comparison against, under the tree's own header.
              
              Only when there is something to qualify: a note beside an empty list is
              the empty state above, and this is the other case - rows on screen, and a
              sentence saying which comparison produced them. Worth having because
              "12 changed files" means two different things in the two ranges.
            */}
            {isChanges && changesNote !== null && <p className="files-note">{changesNote}</p>}
            <ul className="files-tree">{rows((tree as FolderNode).children, 0)}</ul>
          </>
        )}
      </div>

      <Confirm ask={confirm} onClose={() => setConfirm(null)} />
    </section>
  );
}

/**
 * One file's contents: markdown, highlighted source, plain text, or a rendered page.
 *
 * Four cases, all decided by the file name. Nothing sniffs content - a name is
 * better evidence for a short file than its bytes are, and it is what the loop chose
 * deliberately.
 *
 * HTML is the one with two presentations rather than one, behind the toggle on the
 * viewer bar: the highlighted markup, which is what every other case gets, or the
 * page itself in a sandboxed iframe. It earns the second because a loop writing a
 * report, a chart or a board as HTML made an artefact meant to be looked at, and
 * markup is the description rather than the thing.
 *
 * Markdown gets no such toggle, and the asymmetry is the point. Markdown's rendered
 * form is safe to inline because DOMPurify strips it to inert markup first, so there
 * is one presentation and it is already the good one. An HTML file is arbitrary and
 * wants the opposite treatment: full fidelity behind a wall, rather than a sanitized
 * approximation inline. Running an agent's HTML report through DOMPurify would
 * silently delete the parts that make it a report - the styles that lay it out, the
 * structure it was built around - and hand back something that looks like a failure
 * of the report rather than of the viewer. So it is `sandbox=""` instead: no scripts,
 * no forms, no same-origin access, a null origin. Nothing has to be guessed about
 * what is dangerous, because everything active is off.
 *
 * An image or an archive falls to the plain-text branch and looks like the binary
 * it is. That is the same as flock and is honest enough: the file is listed, its
 * size is right, and it can be downloaded.
 */
function FileBody({
  file,
  loading,
  htmlMode,
}: {
  file: OpenFile;
  loading: boolean;
  /** Which presentation HTML gets. Ignored for every other kind of file. */
  htmlMode: HtmlMode;
}): React.ReactElement {
  const name = baseName(file.path);

  const html = useMemo(() => {
    if (file.content.length === 0) return null;
    if (isMarkdown(name)) return { markdown: true, value: renderMarkdown(file.content) };
    const code = highlight(name, file.content);
    return code === null ? null : { markdown: false, value: code };
  }, [file.content, name]);

  if (loading && file.content.length === 0) return <p className="empty">Reading…</p>;
  if (file.note !== undefined) return <p className="empty">{file.note}</p>;
  if (file.content.length === 0) return <p className="empty">This file is empty.</p>;

  /*
   * The page, before the markup branches, because for an HTML file in rendered mode
   * the highlighting above is beside the point - it was computed and is not used, and
   * that costs one pass over a file already in memory.
   *
   * `srcdoc` rather than a URL, because the content is already here: the viewer holds
   * the string and there is nothing to fetch, no endpoint to add, and no origin to
   * serve it from. The cost is that relative `<img>` and `<link>` references do not
   * resolve - an empty sandbox has a null origin and nothing to be relative to - so a
   * multi-file page previews without its assets. Accepted: the markup and inline CSS
   * are what a loop's report is made of, and serving loop folders as browsable
   * origins is a server feature this deliberately is not.
   */
  if (htmlMode === 'rendered' && isHtmlFile(name)) {
    return (
      <iframe className="files-frame" sandbox="" srcDoc={file.content} title={`${name}, rendered`} />
    );
  }

  if (html === null) return <pre className="files-text">{file.content}</pre>;
  if (html.markdown) {
    return <div className="files-md" dangerouslySetInnerHTML={{ __html: html.value }} />;
  }
  return (
    <pre className="files-code">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html.value }} />
    </pre>
  );
}

/**
 * One file's change, inline: two line-number gutters, a sign, and the line.
 *
 * Inline rather than side by side, for the reason `diff.ts` gives: this panel is the
 * short edge of the window and two columns halve a width that is already the
 * constraint. Two gutters instead, before and after, so a row says where it sits in
 * both texts and a removed line still has a number.
 *
 * Deliberately not syntax highlighted, which is the one place this view is less than
 * the file viewer above it and is a considered trade rather than a gap.
 * highlight.js emits spans that straddle newlines - a block comment, a template
 * literal - so splitting its output into rows means tracking which spans are open at
 * every line boundary and reopening them, and getting that wrong produces markup
 * that leaks its colour down the rest of the file. The colour that carries meaning in
 * a diff is the add/remove tint, and that is a property of the row rather than of
 * anything inside it. Reading the file itself, highlighted, is one segment away.
 */
function DiffBody({
  diff,
  rows,
  loading,
}: {
  diff: FileDiff | null;
  rows: DiffRow[] | null;
  loading: boolean;
}): React.ReactElement {
  if (diff === null) return <p className="empty">{loading ? 'Comparing…' : 'Nothing to compare.'}</p>;
  if (diff.note !== undefined && rows === null) return <p className="empty">{diff.note}</p>;
  if (rows === null || rows.length === 0) {
    return <p className="empty">No change in this file against that revision.</p>;
  }

  return (
    <div className="diff">
      {rows.map((row, i) =>
        row.kind === 'skip' ? (
          /*
           * A run of unchanged lines, standing in for itself.
           *
           * Not expandable, and that is on purpose for now: the file is one segment
           * away in full, so a control here that grew the context would be a second,
           * worse file viewer. What this row has to do is say that something was left
           * out, so the diff cannot be mistaken for the whole file.
           */
          <div className="diff-row diff-skip" key={`s${i}`}>
            <span className="diff-gutter" />
            <span className="diff-gutter" />
            <span className="diff-sign" />
            <span className="diff-text">{row.text}</span>
          </div>
        ) : (
          <div className={`diff-row diff-${row.kind}`} key={`${row.kind}${i}`}>
            <span className="diff-gutter">{row.before ?? ''}</span>
            <span className="diff-gutter">{row.after ?? ''}</span>
            {/*
              The sign, as well as the tint. Colour alone would put the whole meaning
              of this view behind being able to tell green from red, and roughly one
              man in twelve cannot.
            */}
            <span className="diff-sign">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '\u2212' : ' '}
            </span>
            {/*
              An empty line still needs height, and a `<span>` with nothing in it has
              none, so a run of blank lines would silently close up and throw the
              gutters out of step with the file.
            */}
            <span className="diff-text">{row.text.length === 0 ? '\u00a0' : row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A status letter as a class suffix.
 *
 * Letters are what git says and what the row shows, but they are not class names -
 * `?` is not one at all, and `st-M` beside `st-m` would be two rules for one thing.
 * Renames and copies share the modified colour, which is what they are: the file is
 * still there and its content is what changed.
 */
function letterClass(letter: string): string {
  switch (letter.toUpperCase()) {
    case 'A':
      return 'add';
    case 'D':
      return 'del';
    case '?':
      return 'new';
    case 'U':
      return 'clash';
    default:
      return 'mod';
  }
}
