/**
 * One factory: a toolbar, the directory it runs in, a canvas, and a panel showing
 * the selected loop's prompt and its output.
 *
 * This is everything that used to be the whole app. It is a component taking a
 * factory id so several can exist, and it is mounted with `key={factoryId}` by the
 * shell, which means switching tabs remounts rather than reconciles - no state from
 * one factory can leak into another's canvas.
 *
 * The prompt is still the only setting a loop has, so the panel is a name field, a
 * textarea and the output stream.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Canvas } from './Canvas.tsx';
import { Confirm, type ConfirmAsk } from './Confirm.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import { Icon } from './Icon.tsx';
import { LoopFiles, type FilesTarget } from './LoopFiles.tsx';
import { api, subscribe, type GitState, type Outbox, type SessionCheckout } from './api.ts';
import { DEFAULT_VIEW, type View } from './geometry.ts';
import {
  CLUSTER_MAX,
  CLUSTER_MIN,
  INTERVAL_SECONDS,
  aggregate,
  intervalLabel,
  memberCount,
  memberId,
  memberKeys,
  nodeLabel,
  parseDuration,
  type Cluster,
  type ClusterComms,
  type ClusterMode,
  type Factory,
  NO_LIBRARY,
  type FactoryEntry,
  type FactoryResources,
  type GrantDefaults,
  type LibraryIndex,
  type Loop,
  type LoopEntry,
  type LoopStatus,
  type McpServer,
  type ModelCatalog,
  type OutputLine,
  type Parameter,
  type QueueItem,
  type Selection,
  type Skill,
  type SteeringFile,
  type Wire,
  type WireMode,
} from './types.ts';

/** How many output blocks are held in the browser, per loop. */
const OUTPUT_LIMIT = 400;

/**
 * What a cluster is when nobody has said anything else about it.
 *
 * The conservative reading of "several": fixed rather than scaled, because a count
 * you set is easier to reason about than one the backlog sets; the minimum size,
 * because two is the smallest thing worth calling a cluster and growing it is one
 * stepper click; isolated, because members that cannot see each other are the cheap
 * predictable case and the ring is the thing you should have to ask for.
 *
 * One constant because two things reach for it - the toolbar's `Loop cluster` and
 * the panel's convert button - and two copies of a default is two places for it to
 * drift. Spread at each use so the document never holds a reference to it.
 */
const NEW_CLUSTER: Cluster = { mode: 'fixed', size: CLUSTER_MIN, comms: 'isolated' };

/** How often the wire labels re-read the queue folders. */
const QUEUE_POLL_MS = 1500;

/** Panel width limits. The lower bound is where the prompt stops being writable. */
const PANEL_MIN = 320;
const PANEL_DEFAULT = 480;

/**
 * Panel width and open state persist across reloads.
 *
 * Small thing, but a panel that forgets it was collapsed is a panel you collapse
 * every time you open the app. Shared across factories on purpose: it is a property
 * of how you like the window, not of the design you are looking at.
 */
const STORE_WIDTH = 'panel-width';
const STORE_OPEN = 'panel-open';

/**
 * The file panel's height limits. The lower bound is about four rows of tree,
 * below which the thing is a strip rather than a view of anything.
 */
const FILES_MIN = 140;
const FILES_DEFAULT = 260;

/**
 * The file panel remembers its height, and whether it was open.
 *
 * Unlike the right-hand panel it defaults to *shut*: it answers a question you ask
 * occasionally - what did this loop actually produce - rather than the one the
 * canvas is for, and a factory whose loops have never run has nothing to put in
 * it. It opens itself when a loop turns out to have files, which is the moment the
 * question becomes askable.
 */
const STORE_FILES_HEIGHT = 'files-height';
const STORE_FILES_OPEN = 'files-open';

/**
 * The loop panel's horizontal split: how much of it the output log and the chat
 * box get, in pixels from the bottom. Bounded on both sides for the same reason
 * the widths above are - below the minimum either half is a strip. The default
 * is decided at first use, as half the window, which is the request the split
 * exists to serve: prompt written, attention moves to the loop.
 */
const SPLIT_MIN = 180;
/**
 * The top half's floor, if the stylesheet cannot be asked for it.
 *
 * It is `.panel-top`'s `min-height` - one line of the loop's name - and the real
 * value is read off the element so the two cannot drift. This is only the answer
 * when the element is not mounted yet.
 */
const PANEL_TOP_FLOOR = 48;
const STORE_SPLIT = 'panel-split';

function storedNumber(key: string, fallback: number): number {
  const raw = Number(window.localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Join consecutive text chunks into one block.
 *
 * The agent streams its reply token by token, and each chunk arrives as its own
 * event so the UI can show it appearing. Rendered one-per-block that reads as
 * "I / 'm / going / to grab" down the page, because a block element is a line
 * break. Only `system` and `tool` entries are genuinely separate events, so they
 * stay separate; text is one message and is shown as one.
 *
 * The agent's own newlines survive: the block is `white-space: pre-wrap`, so the
 * paragraph breaks it actually wrote are the only ones displayed.
 */
function joinText(lines: OutputLine[]): OutputLine[] {
  const out: OutputLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (line.kind === 'text' && last?.kind === 'text') {
      out[out.length - 1] = { ...last, text: last.text + line.text };
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * The loop on the clipboard, and how many times it has been pasted.
 *
 * Module scope rather than component state because switching factory tabs remounts
 * the view - the shell mounts it with `key={factoryId}` - and a clipboard that
 * emptied itself when you looked at another tab could not carry a loop from one
 * factory into another, which is most of the reason to have one.
 *
 * The paste count is what makes repeated pastes cascade instead of stacking.
 */
let clipboard: { loop: Loop; pastes: number } | null = null;

/**
 * What a pasted loop is called: the original's name with `copy` after it, numbered
 * if a name like that is already on the canvas.
 *
 * Numbered rather than left to collide because the name is how a loop is referred
 * to everywhere outside its card - wire labels, the file panel, the log - so two
 * cards reading `Loop 3 copy` is an ambiguity rather than an untidiness.
 */
function copyName(name: string, loops: Loop[]): string {
  const taken = new Set(loops.map((l) => l.name));
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function FactoryView({
  factoryId,
  onImportFile,
  onOpenFactory,
  onOpenLibraryFactory,
  librarySaved,
  models,
  onRetryModels,
  grants,
  onGrantsChange,
}: {
  factoryId: string;
  /** A factory file dropped on the canvas: imported by the shell, which owns tabs. */
  onImportFile: (file: File) => void;
  /**
   * A directory holding another factory: opened as its own tab by the shell, for
   * the same reason importing is. Both end with a different factory in front of
   * you, and which tab is in front of you is not this view's to decide.
   */
  onOpenFactory: (dir: string) => void;
  /**
   * A factory taken out of the library: opened as its own tab, like the two above.
   *
   * The picker that offers it sits on this view's toolbar because that is where the
   * library is, but a factory entry is the one kind that cannot land on this canvas -
   * dropping a whole factory into an open one would be merging two designs. So it
   * leaves here as a slug and comes back as somebody else's tab.
   */
  onOpenLibraryFactory: (slug: string) => void;
  /**
   * Bumped by the shell whenever it has written to the library, so the picker refetches.
   *
   * The shell's `To library` button keeps the whole factory, and it sits on the tab row
   * where this view's picker cannot see it - so without this the entry you just kept is
   * missing from the picker until something remounts, which means a reload. The
   * bookmark button in this view's own panel needs no such thing: it already refreshes
   * what it owns.
   */
  librarySaved: number;
  /**
   * Which models a loop can run on, owned by the shell.
   *
   * A prop rather than this view's own fetch because the view is keyed by the active
   * factory: switching tabs remounts it, and state fetched on mount would be refetched
   * every switch to arrive at the same machine-wide answer. Held above the key, it
   * survives the remount.
   */
  models: ModelCatalog;
  /** Ask the shell to probe again, for the picker's retry after a failure. */
  onRetryModels: () => void;
  /**
   * What a new loop starts out allowed to use, owned by the shell for the same
   * reason the catalogue is: it is per operator, so it is the same answer in every
   * tab and must survive this view's remount.
   */
  grants: GrantDefaults;
  /** A `Save as default` here changed it, so the shell holds the new answer. */
  onGrantsChange: (next: GrantDefaults) => void;
}) {
  const [factory, setFactory] = useState<Factory>({
    kirofactory: 1,
    id: factoryId,
    name: '',
    baseDir: '',
    loops: [],
    wires: [],
  });
  const [status, setStatus] = useState<Map<string, LoopStatus>>(new Map());
  const [queues, setQueues] = useState<Record<string, number>>({});
  /** MCP servers a prompt here can name. Empty until fetched, and after a failure. */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  /**
   * Skills and steering files a prompt here can name. Same lifecycle as the servers
   * above - empty until fetched, empty again after a failure - because they are the
   * same kind of fact: names the machine and the base directory happen to carry.
   */
  const [resources, setResources] = useState<FactoryResources>({
    skills: [],
    steeringFiles: [],
  });
  /** The library. Shared by every factory, so not scoped to this one. */
  const [library, setLibrary] = useState<LibraryIndex>(NO_LIBRARY);
  /**
   * Bumped when a document arrives carrying loops, asking the canvas to frame them.
   *
   * A counter rather than a boolean so the request cannot be missed or go stale: the
   * canvas acts on the change and there is nothing to reset afterwards.
   */
  const [fitOnLoad, setFitOnLoad] = useState(0);
  const [output, setOutput] = useState<Map<string, OutputLine[]>>(new Map());
  const [selected, setSelected] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Questions this view asks: so far, deleting a wire that has work on it. */
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => storedNumber(STORE_WIDTH, PANEL_DEFAULT));
  const [panelOpen, setPanelOpen] = useState(() => window.localStorage.getItem(STORE_OPEN) !== 'no');
  /** True while the divider is being dragged, which suspends the fold animation. */
  const [resizing, setResizing] = useState(false);
  const [splitHeight, setSplitHeight] = useState(() =>
    storedNumber(STORE_SPLIT, Math.round(window.innerHeight / 2)),
  );
  const [resizingSplit, setResizingSplit] = useState(false);
  /**
   * How tall the bottom half may get: measured, not calculated.
   *
   * The reserve above it is not a number this file can know. The settings row wraps
   * with the window's width, a cluster adds a row of its own, the panel starts
   * wherever the tab strip and toolbar leave off, and there are paddings and gaps
   * between all of it. An earlier version reserved a constant from
   * `window.innerHeight` and was wrong twice over: wrong by the height of the chrome
   * above the panel, and wrong again by however that row had wrapped.
   *
   * So it is measured, and the measurement is exact by construction: whatever the top
   * half can give up is what the bottom half can take. Everything else in the column
   * holds its size, so `bottom + (top - top's floor)` is the ceiling, with no need to
   * account for a single gap or padding.
   *
   * The floor comes off `.panel-top`'s own computed `min-height`, so the stylesheet
   * stays the one place it is decided.
   */
  const [splitMax, setSplitMax] = useState(() => Math.max(SPLIT_MIN, window.innerHeight));
  const panelTopRef = useRef<HTMLDivElement>(null);
  const panelBottomRef = useRef<HTMLDivElement>(null);
  /**
   * Which way the split's arrow is sweeping.
   *
   * The divider has three stops now - prompt maximised, the even split, log
   * maximised - and one button cannot name three destinations. So it sweeps: it
   * keeps moving the way it was going, one stop per click, and turns around at
   * the ends. The glyph always points where the next click will send the
   * divider, which is the whole contract.
   */
  const [splitDir, setSplitDir] = useState<'down' | 'up'>('down');
  /**
   * Where the arrow goes next: the nearest stop in the sweep's direction, or
   * the nearest one behind when the sweep has hit an end. A few pixels of slack
   * because the height comes from a drag, and a divider parked one pixel off a
   * stop is at that stop in every sense the arrow cares about.
   */
  const splitJump = ((): { target: number; up: boolean } => {
    /*
     * The three stops, each pulled inside what the panel can actually do, and
     * de-duplicated when that pulls two of them together.
     *
     * The even split is half the window, which on a short one is more than the
     * ceiling - so the arrow would aim at a height the clamp immediately takes back,
     * and the sweep would appear to skip a stop or stall on one. Clamping first means
     * a window too short for three positions honestly has two.
     */
    const stops = [
      ...new Set(
        [SPLIT_MIN, Math.round(window.innerHeight / 2), splitMax].map((s) =>
          Math.min(splitMax, Math.max(SPLIT_MIN, s)),
        ),
      ),
    ].sort((a, b) => a - b);
    const slack = 8;
    const above = stops.filter((s) => s > splitHeight + slack);
    const below = stops.filter((s) => s < splitHeight - slack);
    if (splitDir === 'up') {
      if (above.length > 0) return { target: above[0]!, up: true };
      return { target: below[below.length - 1] ?? splitHeight, up: false };
    }
    if (below.length > 0) return { target: below[below.length - 1]!, up: false };
    return { target: above[0] ?? splitHeight, up: true };
  })();
  /** What the next stop gives the room to, for the tooltip. */
  const splitJumpLabel =
    splitJump.target <= SPLIT_MIN + 4
      ? 'Give the prompt the room'
      : splitJump.target >= splitMax - 4
        ? 'Give the log the room'
        : 'Back to the even split';
  const [filesHeight, setFilesHeight] = useState(() => storedNumber(STORE_FILES_HEIGHT, FILES_DEFAULT));
  // Shut unless it was left open: the opposite default to the panel above, and see
  // STORE_FILES_OPEN for why.
  const [filesOpen, setFilesOpen] = useState(() => window.localStorage.getItem(STORE_FILES_OPEN) === 'yes');
  const [resizingFiles, setResizingFiles] = useState(false);
  /**
   * Whether the file panel is showing the project or the selected loop's folder.
   *
   * Not persisted. The project is the resting state: it is what the panel shows
   * before anything is clicked and what it returns to when a loop is deselected,
   * because it is the one view that always has something to say. Selecting a
   * loop points the panel at that loop's folder - see `onSelect` - which is the
   * thing selecting a loop is supposed to do.
   */
  const [filesTarget, setFilesTarget] = useState<FilesTarget>('project');
  /**
   * What git makes of the base directory, or null until the first answer.
   *
   * Owned here rather than in either of the two places that show it, because both do
   * and they must not disagree: the directory bar names the branch, and the file panel
   * decides from the same fact whether its changes view is available at all. One
   * request, one value, passed down twice.
   *
   * Null is "not yet", not "no repository" - that is `kind: 'none'` - so the bar shows
   * nothing rather than flashing "not versioned" for the length of a round trip.
   */
  const [git, setGit] = useState<GitState | null>(null);
  /**
   * The selected loop's own checkouts, from the sidecar, keyed by runner key.
   * Empty for a loop without `worktree` on, and for one that has never been
   * started since ticking it - the checkouts are made at Start, not at the
   * checkbox. Refetched when the selection moves and when the component's
   * running state flips, which is when provisioning has just happened.
   */
  const [checkouts, setCheckouts] = useState<Record<string, SessionCheckout>>({});
  /**
   * Which grant list is open, at most one.
   *
   * The two menus are absolutely positioned and the same size, so both open at
   * once is one menu covering the other. Held here rather than left to each
   * `<details>` because exclusivity is a fact about the pair, not about either of
   * them - the browser's own `name` grouping would do it, but React 18's types do
   * not carry the attribute and this is three lines.
   */
  const [openPick, setOpenPick] = useState<'mcp' | 'tools' | 'skills' | 'steering' | null>(null);

  /**
   * The prompt's textarea, held here rather than inside `PromptBox`, because the
   * skills and steering dropdowns in the settings row insert `@name` at its caret
   * - and the caret is a property of the element, not of any state this component
   * keeps. Selection survives blur, so the position read after a dropdown click is
   * the one the operator last left the caret at.
   */
  const promptArea = useRef<HTMLTextAreaElement>(null);
  /**
   * Which member of a cluster the log is showing, by index.
   *
   * The panel shows one member at a time and the strip above the log switches
   * between them. One at a time rather than merged, because five agents narrating
   * into one scroll is not a log: their `text` blocks would interleave mid-sentence
   * and the result is unreadable in a way no amount of tagging fixes.
   *
   * Not persisted and not per loop. Member 0 is the right place to land on a
   * cluster you have just selected - it is the one member a scaled cluster is
   * guaranteed to have running - and remembering that you were looking at member 4
   * of some other cluster is a fact with no value the next time you click.
   */
  const [memberPick, setMemberPick] = useState(0);

  useEffect(() => {
    window.localStorage.setItem(STORE_WIDTH, String(panelWidth));
    window.localStorage.setItem(STORE_OPEN, panelOpen ? 'yes' : 'no');
  }, [panelWidth, panelOpen]);

  useEffect(() => {
    window.localStorage.setItem(STORE_FILES_HEIGHT, String(filesHeight));
    window.localStorage.setItem(STORE_FILES_OPEN, filesOpen ? 'yes' : 'no');
  }, [filesHeight, filesOpen]);

  useEffect(() => {
    window.localStorage.setItem(STORE_SPLIT, String(splitHeight));
  }, [splitHeight]);

  /*
   * Ask git about the directory, and ask again when the directory changes.
   *
   * Not polled. The answer changes when the factory is pointed somewhere else, which
   * is this effect, or when someone switches branches in a terminal, which is rare and
   * costs a reload to notice - and the alternative is three subprocesses on a timer
   * for a badge that is usually saying the same thing it said last time. The changes
   * view refreshes it as a side effect of its own polling, so a panel that is open
   * keeps the bar current for free.
   *
   * `cancelled` because a factory pointed at two directories in quick succession has
   * two of these in flight, and the slower one must not be allowed to answer last.
   */
  useEffect(() => {
    let cancelled = false;
    setGit(null);
    void api
      .git(factoryId)
      .then((state) => {
        if (!cancelled) setGit(state);
      })
      .catch(() => {
        if (!cancelled) setGit({ kind: 'none', reason: 'could not ask git about this directory' });
      });
    return () => {
      cancelled = true;
    };
  }, [factoryId, factory.baseDir]);

  /*
   * A directory with no repository cannot show changes, so a panel left on that view
   * comes back to the project rather than sitting on an empty one it cannot fill.
   * Happens when the factory is pointed somewhere that is not a repository while the
   * changes view is open, which is a move the directory bar allows.
   */
  useEffect(() => {
    if (filesTarget === 'changes' && git?.kind === 'none') setFilesTarget('project');
  }, [filesTarget, git]);

  /**
   * Show the file panel when the loop you just selected has something in it.
   *
   * Reported once per loop by the panel itself, which is the only thing that knows
   * - it has to list the folder to find out, and it does that whether it is folded
   * or not for exactly this reason. Once per loop rather than per poll, so folding
   * it shut stays shut while you keep working on the same loop.
   */
  const onLoopFiles = useMemo(
    () => (_loopId: string, count: number): void => {
      if (count > 0) setFilesOpen(true);
    },
    [],
  );

  /**
   * Drag the divider. Width is measured from the right edge of the window, so the
   * panel follows the pointer directly however the window is sized.
   *
   * The pointer is captured on the divider, so a fast drag that outruns the
   * element keeps resizing instead of dropping the gesture the moment the cursor
   * crosses onto the canvas or the panel.
   */
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    if (!panelOpen) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // The panel animates its width when it folds, and that animation has to be off
    // while you are dragging or the width lags a frame or two behind the cursor.
    // The class is what the stylesheet keys the suspension off.
    setResizing(true);
    const max = Math.max(PANEL_MIN, window.innerWidth - 240);
    const move = (ev: PointerEvent): void => {
      setPanelWidth(Math.min(max, Math.max(PANEL_MIN, window.innerWidth - ev.clientX)));
    };
    const done = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  }

  /**
   * The same gesture on the other axis: drag the file panel's top edge.
   *
   * Height measured from the bottom of the window, for the same reason width is
   * measured from its right - the edge being dragged is the one the pointer is on,
   * so it tracks the cursor exactly rather than through whatever is above it. The
   * upper bound leaves the canvas a usable strip; without it the panel can be
   * dragged over the whole factory.
   */
  function onFilesResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    if (!filesOpen) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizingFiles(true);
    const max = Math.max(FILES_MIN, window.innerHeight - 260);
    const move = (ev: PointerEvent): void => {
      setFilesHeight(Math.min(max, Math.max(FILES_MIN, window.innerHeight - ev.clientY)));
    };
    const done = (): void => {
      setResizingFiles(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  }

  /**
   * And once more inside the loop panel: drag the line between the prompt half
   * and the output half. Measured from the bottom of the window like the file
   * panel is, because the bottom half is the one whose edge is being dragged.
   *
   * The upper bound is `splitMax`, which leaves one line of the loop's name and the
   * rows that cannot fold - see `SPLIT_TOP_MIN`. It is the same number the arrow's
   * top stop uses, so dragging to the end and clicking the arrow up arrive in the
   * same place. Previously this reserved a flat 220px, enough for the prompt to keep
   * a third of the panel, so the drag stopped well short of the floor the stylesheet
   * had been given.
   */
  function onSplitResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizingSplit(true);
    const move = (ev: PointerEvent): void => {
      setSplitHeight(Math.min(splitMax, Math.max(SPLIT_MIN, window.innerHeight - ev.clientY)));
    };
    const done = (): void => {
      setResizingSplit(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  }

  // The canvas edits at pointer speed; the server is told after things settle, so
  // dragging a loop does not become one PUT per mouse move.
  const saveTimer = useRef<number | undefined>(undefined);

  /**
   * Which part of the canvas is on screen.
   *
   * A ref, not state: the only thing here that needs it is `addLoop`, which reads
   * it on a click, and holding it as state would re-render this whole component -
   * output log included - on every frame of a pan.
   */
  const viewRef = useRef<View>(DEFAULT_VIEW);

  /**
   * Loops whose buffered output has already been asked for.
   *
   * A set rather than checking the output map, so a loop whose history turned
   * out to be empty is not asked for it again on every re-selection.
   */
  const seeded = useRef(new Set<string>());

  /**
   * Runners whose history has *arrived*, as opposed to been asked for.
   *
   * Until it has, live lines for that runner are held raw in `pending` instead of
   * going into `output`. The old rule was "if live output is already there, drop
   * the history as older", and it was wrong in the common case: open a factory
   * whose loops are running, one token arrives before the history request
   * returns, and everything the loop said before the view mounted is thrown away
   * for that one token. Holding the live lines aside and merging them once the
   * history is here keeps both. Lines carry a timestamp, so the merge is history
   * followed by whatever pending line is newer than its last entry - no sequence
   * numbers needed. A history request that fails counts as landed with nothing,
   * so a server that cannot answer does not make the log go dark.
   */
  const landed = useRef(new Set<string>());
  const pending = useRef(new Map<string, OutputLine[]>());

  useEffect(() => {
    void api
      .getFactory(factoryId)
      .then((doc) => {
        setFactory(doc);
        /*
         * A document that arrives with loops already in it is a design you have not
         * looked at on this machine - taken out of the library, imported, or opened
         * from its folder - so ask the canvas to frame it.
         *
         * Signalled from here rather than decided here, because framing needs the
         * measured size of the surface and only the canvas has that. The canvas also
         * gets the last word: it ignores this when it has a remembered window for
         * this factory, since a corner you had panned to is where you left off and
         * should not be overruled by a reload.
         *
         * Keyed on a document *load* rather than on loops appearing, so drawing the
         * first loop of an empty factory by hand does not yank the view: that loop
         * was placed relative to where you were looking, which is already right.
         */
        if (doc.loops.length > 0) setFitOnLoad((n) => n + 1);
      })
      .catch((e: Error) => setError(e.message));
    void api
      .status(factoryId)
      .then((all) => setStatus(new Map(all.map((s) => [s.id, s]))))
      .catch(() => undefined);

    // One stream carries every factory, so each frame is checked against this one.
    // A factory running in another tab is still producing output; it is buffered on
    // the server and fetched when you come back to it, rather than accumulating in
    // a view nobody is looking at.
    const unsubscribe = subscribe({
      onStatusAll: ({ factory: id, status: all }) => {
        if (id === factoryId) setStatus(new Map(all.map((s) => [s.id, s])));
      },
      onStatus: (s) => {
        if (s.factory === factoryId) setStatus((prev) => new Map(prev).set(s.id, s));
      },
      onFactory: (doc) => {
        // The server rewrote the document - a rename, or a move to another
        // directory. Loops and wires are left alone: they are what this view is
        // editing, and adopting a server copy mid-edit would undo keystrokes.
        if (doc.id === factoryId) {
          setFactory((prev) => ({ ...prev, name: doc.name, baseDir: doc.baseDir }));
        }
      },
      onOutput: (line) => {
        if (line.factory !== factoryId) return;
        // Not yet seeded from the server's buffer: held raw until that arrives,
        // see `landed`. Capped like the log itself so an unwatched member cannot
        // grow without bound.
        if (!landed.current.has(line.loop)) {
          const held = pending.current.get(line.loop) ?? [];
          pending.current.set(line.loop, [...held, line].slice(-OUTPUT_LIMIT));
          return;
        }
        setOutput((prev) => {
          const next = new Map(prev);
          // Joined on arrival as well as on render, so the browser holds 400
          // messages rather than 400 tokens of one reply.
          const lines = joinText([...(next.get(line.loop) ?? []), line]);
          next.set(line.loop, lines.slice(-OUTPUT_LIMIT));
          return next;
        });
      },
    });

    // Queue depth is a property of a folder that agents write to directly, so it
    // is read on a timer rather than pushed: nothing in this process is told when
    // a file lands.
    const poll = window.setInterval(() => {
      void api
        .queues(factoryId)
        .then(setQueues)
        .catch(() => undefined);
    }, QUEUE_POLL_MS);
    void api.queues(factoryId).then(setQueues).catch(() => undefined);

    return () => {
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [factoryId]);

  /*
   * The tools a prompt can name.
   *
   * Re-read when the factory moves, because half the answer comes from the base
   * directory's own `.kiro/settings/mcp.json` and a factory pointed at another
   * project can offer other tools. Not polled: the operator edits that file in an
   * editor, not here, and the runner re-reads it every turn regardless - so a
   * stale picker costs a page refresh, not a wrong prompt.
   */
  useEffect(() => {
    if (factory.baseDir.length === 0) return;
    void api
      .mcp(factoryId)
      .then(setMcpServers)
      .catch(() => setMcpServers([]));
    // Skills and steering ride the same effect for the same reasons: half of each
    // list comes from the base directory's own `.kiro/`, the runner re-reads both
    // every turn, and a stale picker costs a page refresh rather than a wrong
    // prompt. Failure empties rather than erroring - a factory with no skills and
    // one whose listing failed both simply have nothing to offer.
    void api
      .resources(factoryId)
      .then(setResources)
      .catch(() => setResources({ skills: [], steeringFiles: [] }));
  }, [factoryId, factory.baseDir]);

  /*
   * The library.
   *
   * Read on mount, and again whenever something has written to it. It changes when
   * someone saves an entry or pulls the repository, the first of which we can be told
   * about and the second of which is not something to poll a folder for.
   *
   * `refreshLibrary` is what this view's own save calls, so the entry it just wrote is
   * in the picker without a reload. `librarySaved` is the same news arriving from the
   * shell, whose `To library` button keeps the whole factory from a row this view does
   * not own.
   */
  const refreshLibrary = useMemo(
    () => (): void => {
      void api
        .library()
        .then(setLibrary)
        .catch(() => setLibrary(NO_LIBRARY));
    },
    [],
  );
  // `librarySaved` in the list is the shell saying it wrote to the library from the tab
  // row, where this view's picker cannot see it happen. See the prop.
  useEffect(refreshLibrary, [refreshLibrary, librarySaved]);

  /*
   * Starting clears nothing, here or on the server: the log and the iteration
   * count carry across a stop and start, because a restart is a pause in the
   * loop's life rather than a new loop - and the conversation the operator had
   * with it belongs to the loop, not to the run. The server writes a `started
   * again` line as the seam between runs.
   */
  function startLoop(id: string): void {
    void api.startLoop(factoryId, id).catch((e: Error) => setError(e.message));
  }

  function startAll(): void {
    void api.startAll(factoryId).catch((e: Error) => setError(e.message));
  }

  function setPrompt(loopId: string, prompt: string): void {
    change({
      ...factory,
      loops: factory.loops.map((l) => (l.id === loopId ? { ...l, prompt } : l)),
    });
  }

  /**
   * Change one loop's settings - waiting, MCP scope, model.
   *
   * Saved through the ordinary document path like every other edit, so there is no
   * endpoint for them: the server hands the new document to the running runners,
   * and a loop mid-run picks the change up on its next iteration without a
   * restart. A field set to `undefined` reads as absent - trusted, default model -
   * and JSON drops it on the way to the server, so the document stays clean.
   */
  function patchLoop(loopId: string, patch: Partial<Loop>): void {
    change({
      ...factory,
      loops: factory.loops.map((l) => (l.id === loopId ? { ...l, ...patch } : l)),
    });
  }

  function change(next: Factory): void {
    setFactory(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.putFactory(factoryId, next).catch((e: Error) => {
        setError(e.message);
        // A refused save (a mode switch under a running loop, an id the server
        // will not accept) leaves the canvas showing a document the server does
        // not hold. Reading it back puts the two in step again, so the control
        // that was refused visibly snaps back rather than lying.
        void api.getFactory(factoryId).then(setFactory).catch(() => undefined);
      });
    }, 400);
  }

  /**
   * Put a loop on the canvas, blank or from the library.
   *
   * One function for both, because a library entry is a name and a prompt and a
   * blank loop is the absence of them - the placement is identical either way, and
   * the id and position are ours to assign in both cases since neither is anything
   * a shared loop could carry.
   */
  function addLoop(seed?: Partial<Pick<Loop, 'name' | 'prompt' | 'cluster'>>): void {
    const n = factory.loops.length + 1;
    const id = `loop-${Date.now().toString(36)}`;
    // The canvas is unbounded, so the same four-column cascade is laid out from the
    // corner of what is currently on screen rather than from world origin. A loop
    // added after panning across a large factory lands where you are looking; the
    // old fixed 60,60 would have put it somewhere off screen.
    //
    // The row pitch grew with clusters: a stack reaches down and right past its own
    // box, so the old 160 put the boxes behind one card through the title of the
    // card below it. 190 clears a full five-deep stack, and costs a plain loop
    // nothing but air.
    const view = viewRef.current;
    change({
      ...factory,
      loops: [
        ...factory.loops,
        {
          id,
          name: seed?.name ?? (seed?.cluster ? `Cluster ${n}` : `Loop ${n}`),
          prompt: seed?.prompt ?? '',
          // Not carried by a library entry: the right mode depends on what this
          // loop ends up wired to, which the person sharing it could not know.
          // Auto stop is the default for a new loop - the mode that cannot burn
          // money forever unattended - and changing it is one dropdown away.
          autoPause: false,
          autoStop: true,
          disabled: false,
          /*
           * What this loop may use, from the operator's default rather than from
           * the absence of a decision.
           *
           * Written onto the loop as real fields, so the document says what the
           * loop is allowed to do instead of leaving it to whatever "absent"
           * happens to mean. `null` on an axis is the one case that writes nothing:
           * an operator whose default is everything wants the unrestricted form,
           * which is the absent field and the `@builtin` wildcard behind it - and
           * that wildcard is the point, since it keeps picking up categories
           * kiro-cli adds later.
           *
           * A library entry does not override this. Its name, prompt and cluster
           * shape are what somebody chose to share; what an agent on this machine
           * may reach is not theirs to decide.
           */
          ...(grants.tools !== null ? { tools: canonicalTools(grants.tools) } : {}),
          ...(grants.mcp !== null ? { mcp: grants.mcp } : {}),
          ...(seed?.cluster ? { cluster: seed.cluster } : {}),
          x: Math.round(view.x + 60 + ((n - 1) % 4) * 260),
          y: Math.round(view.y + 60 + Math.floor((n - 1) / 4) * 190),
        },
      ],
    });
    setSelected({ kind: 'loop', id });
  }

  /**
   * Put a cluster on the canvas: the same component, running several sessions.
   *
   * `addLoop` with a cluster on it rather than a function of its own, because a
   * cluster *is* a loop with one more field - same id, same placement, same
   * selection afterwards - and two functions would be two places for the cascade
   * to drift.
   *
   * The defaults are `NEW_CLUSTER`, shared with the panel's convert button so both
   * ways of getting a cluster agree on what one starts out as.
   */
  function addCluster(): void {
    addLoop({ cluster: { ...NEW_CLUSTER } });
  }

  /**
   * Delete whichever thing is selected. A loop takes its wires with it.
   *
   * For a wire this is the whole fan-out, not the one branch: selecting a wire
   * selects its producer's wires together, and a button acting on the selection has
   * to mean what the selection says. One branch goes by the × at its arriving end,
   * which is the only place that can point at a single wire unambiguously.
   *
   * Called from the two panels, one per kind, and no longer from the toolbar. The
   * toolbar acts on the factory - run it, stop it, add a loop - so a delete there had
   * to read the selection to know what it meant, which made one button that was
   * three different actions depending on where you had last clicked. Each panel
   * owning the removal of the thing it describes says it once and says it plainly.
   */
  function deleteSelected(): void {
    if (!selected) return;
    let remove: () => void;
    let doomed: Wire[];
    if (selected.kind === 'loop') {
      const id = selected.id;
      remove = () =>
        change({
          ...factory,
          loops: factory.loops.filter((l) => l.id !== id),
          wires: factory.wires.filter((w) => w.from !== id && w.to !== id),
        });
      /*
       * Which folders go with it. Everything it produces into: with the producer
       * gone no wire reaches those folders. What it consumes: a topic copy is its
       * alone and goes; a shared queue stays for the other readers unless this was
       * the last of them. The same rule `deleteWire` applies to one wire, applied
       * to every wire the loop touches.
       */
      doomed = factory.wires.filter(
        (w) =>
          w.from === id ||
          (w.to === id &&
            (w.mode === 'topic' || !factory.wires.some((o) => o.from === w.from && o.to !== id))),
      );
    } else {
      const from = factory.wires.find((w) => w.id === selected.id)?.from;
      if (from === undefined) return;
      remove = () => change({ ...factory, wires: factory.wires.filter((w) => w.from !== from) });
      // The whole fan-out goes, so every folder under it does too.
      doomed = factory.wires.filter((w) => w.from === from);
    }
    // A shared queue is counted once, however many wires read it: `queues` reports
    // the folder's count against each wire on it.
    const folders = new Map<string, number>();
    for (const w of doomed) folders.set(w.mode === 'queue' ? w.from : w.id, queues[w.id] ?? 0);
    const waiting = [...folders.values()].reduce((sum, n) => sum + n, 0);

    const finish = (): void => {
      remove();
      setSelected(null);
    };
    // Same rule as deleting one wire: no question when there is nothing to lose.
    // Deleting a loop with a backlog behind it used to ask nothing, while deleting
    // one of its wires did - the larger removal had the smaller guard.
    if (waiting === 0) return finish();
    const what =
      selected.kind === 'loop'
        ? `${factory.loops.find((l) => l.id === selected.id)?.name ?? 'this loop'} and its wires`
        : 'these wires';
    setConfirm({
      title: `Delete ${what}, and the ${waiting} item${waiting === 1 ? '' : 's'} waiting on them?`,
      body: 'No other loop will be reading those folders, so the work on them is lost.',
      action: selected.kind === 'loop' ? 'Delete loop' : 'Delete wires',
      onConfirm: finish,
    });
  }

  /**
   * Put the copied loop on the canvas: everything about it except its identity.
   *
   * Its wires do not come with it. A wire is a fact about two loops rather than a
   * property of one, so the copy arrives connected to nothing until somebody says
   * otherwise. Everything else does come across - prompt, stop conditions, MCP and
   * tool scoping, model, the cluster shape - because avoiding setting all of that
   * again is the reason to copy a configured loop rather than add a blank one.
   *
   * Pastes cascade: each lands a little further down and right than the last, so
   * pasting four times gives four cards you can see rather than one with three
   * hidden underneath it.
   */
  function pasteLoop(): void {
    if (!clipboard) return;
    const { loop, pastes } = clipboard;
    clipboard = { loop, pastes: pastes + 1 };
    const step = 30 * (pastes + 1);
    const id = `loop-${Date.now().toString(36)}`;
    change({
      ...factory,
      loops: [
        ...factory.loops,
        {
          ...loop,
          id,
          name: copyName(loop.name, factory.loops),
          x: loop.x + step,
          y: loop.y + step,
        },
      ],
    });
    setSelected({ kind: 'loop', id });
  }

  /*
   * Copy, paste and delete the selection from the keyboard.
   *
   * Loops only, clusters included - a cluster is a loop with one more field, so the
   * one check covers both. A selected wire is deliberately left alone: the selection
   * there is a whole fan-out, there is nothing coherent for paste to mean, and the
   * `×` at a wire's arriving end is how one branch goes.
   *
   * Listening on the document because the selection is not a DOM focus: you click a
   * card and the keys then act on it wherever the caret happens to be. Which is
   * exactly why the guards below matter - backspace inside the prompt box means
   * backspace, and a shortcut that deleted the loop whose prompt you were writing
   * would be the worst bug in the program.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A question on screen owns the keyboard until it has been answered.
      if (confirm !== null) return;
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable === true) return;
      if (el !== null && /^(input|textarea|select)$/i.test(el.tagName)) return;

      const command = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

      // Paste needs a clipboard, not a selection. Copy and delete act on the
      // selected loop, but a tab switch remounts this view with nothing selected,
      // and a paste that waited for a click on some unrelated card first would
      // make carrying a loop between factories - the reason the clipboard lives at
      // module scope - a thing nobody discovers.
      if (command && e.key === 'v') {
        if (!clipboard) return;
        e.preventDefault();
        pasteLoop();
        return;
      }

      if (selected?.kind !== 'loop') return;

      if (command && e.key === 'c') {
        // Text the operator has selected - a line of log, a path - is what they
        // meant, so that copy is the browser's and this one stands aside.
        if ((window.getSelection()?.toString().length ?? 0) > 0) return;
        const loop = factory.loops.find((l) => l.id === selected.id);
        if (!loop) return;
        e.preventDefault();
        clipboard = { loop, pastes: 0 };
        return;
      }

      // Same path as the trash button on the panel, wires and all, and the same
      // question when there is queued work to lose - see `deleteSelected`.
      if (e.key === 'Backspace' && !command) {
        e.preventDefault();
        deleteSelected();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [factory, selected, confirm]);

  /**
   * Remove one wire.
   *
   * Asks first when there is work on it to lose, which is the same rule the panel
   * used to apply: items on a folder nobody else is reading are gone with the
   * folder, and items on a shared queue are not this wire's to take away. The count
   * comes from `queues`, which the canvas is already polling for the badges.
   */
  function deleteWire(wireId: string): void {
    const wire = factory.wires.find((w) => w.id === wireId);
    if (!wire) return;
    const remove = (): void => {
      change({ ...factory, wires: factory.wires.filter((w) => w.id !== wireId) });
      // Selecting the fan-out and then deleting its last branch would leave the
      // panel describing a producer with no wires.
      if (factory.wires.filter((w) => w.from === wire.from).length === 1) setSelected(null);
    };
    const waiting = queues[wireId] ?? 0;
    const shared =
      wire.mode === 'queue' && factory.wires.some((w) => w.id !== wireId && w.from === wire.from);
    const toName = factory.loops.find((l) => l.id === wire.to)?.name ?? wire.to;
    if (shared || waiting === 0) return remove();
    setConfirm({
      title: `Delete the wire to ${toName} and the ${waiting} item${waiting === 1 ? '' : 's'} waiting on it?`,
      body: 'No other loop is reading that folder, so the work on it is lost.',
      action: 'Delete wire',
      onConfirm: remove,
    });
  }

  /**
   * Switch a producer between one shared queue and a copy per consumer.
   *
   * Every wire out of the same loop, not just the one selected. The mode is a
   * property of the fan-out - see `WireMode` - so setting it on one wire would leave
   * the document in a state that has no meaning and looks, on the canvas, exactly
   * like a mode change that did not work.
   *
   * Saved through the ordinary document path, so the server does the rest: it sees
   * the producer's mode has flipped and carries the backlog across, fanning one
   * queue out to every subscriber or gathering every subscriber's copies back into
   * one queue.
   */
  function setWireMode(wireId: string, mode: WireMode): void {
    const from = factory.wires.find((w) => w.id === wireId)?.from;
    if (from === undefined) return;
    change({
      ...factory,
      wires: factory.wires.map((w) => (w.from === from ? { ...w, mode } : w)),
    });
  }

  /**
   * The factory's parameters, or an empty list when it has none.
   *
   * Memoised because `PromptBox` keys its suggestion list and its name set off this,
   * and `factory.parameters ?? []` is a fresh array every render - which would
   * rebuild both on every keystroke in the prompt.
   */
  const parameters = useMemo(() => factory.parameters ?? [], [factory.parameters]);

  /**
   * Change the factory's parameters.
   *
   * The ordinary document path, like a loop's settings and unlike `baseDir`. A
   * parameter is content rather than identity: the canvas is allowed to write it,
   * the debounced save carries it, and the host hands the new document to whatever
   * is running - so a value edited mid-run reaches the loops on their next
   * iteration, which is the whole reason the substitution happens per turn.
   *
   * An empty list is stored as no list at all, matching the server's parse: a
   * factory whose last parameter was deleted writes the document it had before any
   * existed, rather than leaving `"parameters": []` behind in the file.
   */
  function setParameters(next: Parameter[]): void {
    const { parameters: _old, ...rest } = factory;
    change(next.length > 0 ? { ...rest, parameters: next } : rest);
  }

  /**
   * Point the factory at another directory.
   *
   * Sent on blur or Enter rather than per keystroke: a half-typed path is a
   * different directory, and the server creates the one it is given.
   */
  function setBaseDir(dir: string): void {
    const next = dir.trim();
    if (next.length === 0 || next === factory.baseDir) return;
    setError(null);
    void api
      .patchFactory(factoryId, { baseDir: next })
      .then((doc) => setFactory((prev) => ({ ...prev, baseDir: doc.baseDir })))
      .catch((e: Error) => setError(e.message));
  }

  /**
   * Give this factory a checkout and a branch of its own, after asking.
   *
   * Asked rather than done, and it is the one thing on this bar that warrants a
   * question. Everything else here points the factory at a directory that already
   * exists; this creates one, outside the factory's own folder, and adds a branch to
   * the operator's repository. That is this program writing somewhere it otherwise
   * never writes, and it should be a decision rather than a click.
   *
   * The question is also the only place the trade is stated: a worktree is a clean
   * checkout, so nothing untracked comes across and a project that needs installing
   * needs installing again.
   *
   * A gitignored directory gets the highlighted warning: the factory follows its
   * subpath into the worktree, so it stays ignored there, and a changes view that
   * can never show anything is the likeliest reason to regret having pressed this.
   */
  function branchOff(): void {
    setError(null);
    setConfirm({
      title: 'Give this factory its own worktree?',
      body:
        'A new branch, checked out beside the repository, and the factory moves into it. ' +
        'The loops then work and commit there instead of in your checkout. ' +
        'Nothing untracked comes across, and removing it later is git worktree remove.',
      ...(git?.ignored === true
        ? {
            warning:
              'This directory is gitignored, and stays so in the worktree: git will not see ' +
              'anything the loops write, and the changes view will stay empty. ' +
              'Point the factory at a real project directory first.',
          }
        : {}),
      action: 'Branch off',
      onConfirm: () => {
        void api
          .branchOff(factoryId)
          .then((res) => {
            setFactory((prev) => ({ ...prev, baseDir: res.factory.baseDir }));
            // Pointing the panel at the changes view: branching off is something you
            // do because you are about to let the loops loose, and what they do to
            // that branch is the thing you will want to watch.
            setFilesTarget('changes');
            setFilesOpen(true);
          })
          .catch((e: Error) => setError(e.message));
      },
    });
  }

  const selectedLoop = useMemo(
    () => (selected?.kind === 'loop' ? factory.loops.find((l) => l.id === selected.id) ?? null : null),
    [factory.loops, selected],
  );

  /*
   * ------------------------------------------------------- the grant, and its hint
   *
   * Two related things live here: whether the operator has been told where the grant
   * controls are, and whether what this loop holds is worth offering to keep.
   *
   * The hint shows for a loop still carrying the *shipped* default on an axis the
   * operator has never saved. Deliberately not "a loop was just added": a factory
   * taken out of the library arrives as a whole document without going through
   * `addLoop`, and its loops are exactly the ones whose grant the operator has not
   * looked at - a library factory holds `shell` and can run commands in the
   * directory they just pointed it at. Keyed on the loop and on what it holds
   * rather than on an event, so both ways of getting a loop are covered by one rule.
   *
   * Seen once per loop, not once per session. Clicking back to a loop should not be
   * nagged at, and a second loop is a second thing to decide about.
   */
  const [hintSeen, setHintSeen] = useState<ReadonlySet<string>>(new Set());

  const grantHint = useMemo(() => {
    if (selectedLoop === null || hintSeen.has(selectedLoop.id)) return null;
    const tools = !grants.saved.tools && sameGrant(selectedLoop.tools, grants.tools);
    const mcp = !grants.saved.mcp && sameGrant(selectedLoop.mcp, grants.mcp);
    if (!tools && !mcp) return null;
    /*
     * Silent as soon as either axis has been moved off the default, and that is
     * also what keeps this out of the `Save as default` button's way: both hang in
     * the strip above the row, and a loop that has diverged on one axis is offering
     * to keep it there. Somebody in that position has plainly found the controls, so
     * there is nothing left for a hint to say.
     */
    if (!sameGrant(selectedLoop.tools, grants.tools) || !sameGrant(selectedLoop.mcp, grants.mcp)) {
      return null;
    }
    // Named for what is actually unset, because a hint that mentions MCP servers to
    // somebody who has already chosen their servers reads as a malfunction.
    const what = tools && mcp ? 'tools and MCP servers' : tools ? 'tools' : 'MCP servers';
    return `Set which ${what} this loop may use`;
  }, [selectedLoop, hintSeen, grants]);

  /** Any move on either control answers the hint, so it goes. */
  function dismissHint(): void {
    const id = selectedLoop?.id;
    if (id === undefined || hintSeen.has(id)) return;
    setHintSeen((prev) => new Set(prev).add(id));
  }

  /**
   * Keep this loop's grant as the default for new ones. One axis at a time.
   *
   * `?? null` is the whole translation between the two shapes: an unrestricted loop
   * says so by having no field, and a default says so with an explicit `null` - which
   * is a decision, and has to be storable as one so it can silence the hint.
   */
  function saveGrantDefault(axis: 'tools' | 'mcp'): void {
    if (selectedLoop === null) return;
    const value = (axis === 'tools' ? selectedLoop.tools : selectedLoop.mcp) ?? null;
    dismissHint();
    setError(null);
    void api
      .putGrant(axis, value)
      .then(onGrantsChange)
      .catch((e: Error) => setError(e.message));
  }

  /**
   * The hint's own answer: keep the shipped grant, and stop asking.
   *
   * Clicking the hint away lasts a session and a loop; this lasts. It writes the
   * grant the loop already holds as the default for every axis nobody has decided
   * yet, which is exactly the set the hint is naming, and `saved` flips for each -
   * so the hint has nothing left to say on any loop on this machine. Somebody who
   * reads "the default is fine" and wants to say so once needs a way that is not
   * "open a list, change nothing, and hope"; `Save as default` cannot be that way,
   * because it is offered only where the loop differs from the default.
   *
   * One axis after the other rather than two requests in flight: the server reads
   * the file back before each write, and two concurrent writes could each lose the
   * other's key. The last answer carries both.
   */
  function keepGrantDefault(): void {
    if (selectedLoop === null) return;
    const axes: ('tools' | 'mcp')[] = [];
    if (!grants.saved.tools) axes.push('tools');
    if (!grants.saved.mcp) axes.push('mcp');
    if (axes.length === 0) return;
    dismissHint();
    setError(null);
    void (async () => {
      let next: GrantDefaults | null = null;
      for (const axis of axes) {
        next = await api.putGrant(axis, (axis === 'tools' ? selectedLoop.tools : selectedLoop.mcp) ?? null);
      }
      if (next !== null) onGrantsChange(next);
    })().catch((e: Error) => setError(e.message));
  }

  /**
   * Whether the selected component has anything live in it.
   *
   * The card's own aggregate, so `paused` and `stopping` both count: a loop waiting
   * for an item is up and will take a turn by itself, and a draining turn is still a
   * turn holding an item it claimed.
   *
   * Two controls read it, and they are the two that cannot be changed under a running
   * session - what the component *is*, and how many of it there are. See `ConvertKind`
   * and `ClusterSettings`.
   */
  const selectedRunning =
    selectedLoop !== null && aggregate(selectedLoop, status).state !== 'stopped';

  /**
   * Write `@name ` into the selected loop's prompt, where the caret last was.
   *
   * What a row in the skills or steering dropdown does when clicked. The caret is
   * read off the textarea itself - selection survives blur, so this is wherever
   * the operator left it, or the start of an untouched prompt, which for the empty
   * prompt this most often is amounts to the same place.
   */
  function insertReference(name: string): void {
    if (selectedLoop === null) return;
    const el = promptArea.current;
    const at = el?.selectionStart ?? selectedLoop.prompt.length;
    spliceReference(el, selectedLoop.prompt, at, at, `@${name}`, (next) =>
      setPrompt(selectedLoop.id, next),
    );
  }

  /*
   * The selected loop's checkouts, fetched from the sidecar. `selectedRunning`
   * is a dependency on purpose: a start is when provisioning happens, so the
   * flip to running is exactly the moment the answer changes and a badge that
   * did not refetch then would show "no checkouts" for the whole run.
   */
  const selectedWorktree = selectedLoop?.worktree === true;
  const selectedLoopId = selectedLoop?.id;
  useEffect(() => {
    if (selectedLoopId === undefined || !selectedWorktree) {
      setCheckouts({});
      return;
    }
    let cancelled = false;
    void api
      .loopWorktrees(factoryId, selectedLoopId)
      .then((r) => {
        if (!cancelled) setCheckouts(r.sessions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [factoryId, selectedLoopId, selectedWorktree, selectedRunning]);

  /**
   * Turn per-session checkouts on or off for the selected loop.
   *
   * On is a decision with a cost, so a cluster is asked first, with the count in
   * the question: provisioning happens at the next Start, one `git worktree add`
   * per session, sequentially. Off removes nothing - the next start simply runs
   * in the base directory again, and the checkouts stay in the sidecar until
   * released. The checkbox itself is disabled while the component runs (see
   * `WorktreePick`), so no guard is needed here.
   */
  function toggleWorktree(on: boolean): void {
    if (!selectedLoop) return;
    if (!on) {
      patchLoop(selectedLoop.id, { worktree: undefined });
      return;
    }
    const n = memberCount(selectedLoop);
    if (n === 1) {
      patchLoop(selectedLoop.id, { worktree: true });
      return;
    }
    const id = selectedLoop.id;
    setConfirm({
      title: `Check the project out ${n} times?`,
      body:
        `Each of the ${n} sessions gets a worktree of its own, on its own branch, so they stop ` +
        'overwriting each other in one directory. The checkouts are created at the next Start, one ' +
        'after another - a first start on a large repository will take a while, and says so in the ' +
        `log as it goes. That is ${n} extra checkouts of this repository on disk.`,
      action: 'Turn it on',
      onConfirm: () => patchLoop(id, { worktree: true }),
    });
  }

  /** Remove the selected loop's checkouts, after asking. Branches always stay. */
  function releaseCheckouts(): void {
    if (!selectedLoop) return;
    const id = selectedLoop.id;
    const n = Object.keys(checkouts).length;
    setError(null);
    setConfirm({
      title: `Release ${n === 1 ? 'this loop\'s checkout' : `all ${n} checkouts`}?`,
      body:
        'git worktree remove, never forced: a checkout with uncommitted or untracked files refuses and stays, ' +
        'so nothing unsaved is lost. The branches are never deleted - committed work survives a ' +
        'release and can be merged or revisited later.',
      action: 'Release',
      onConfirm: () => {
        void api
          .releaseWorktrees(factoryId, id)
          .then((r) => {
            setCheckouts(r.sessions);
            if (r.failures.length > 0) {
              setError(`${r.failures.length} refused: ${r.failures[0]!.error}`);
            }
          })
          .catch((e: Error) => setError(e.message));
      },
    });
  }

  /*
   * Keep `splitMax` in step with the layout.
   *
   * Re-measured on anything that changes how much room the column has or how the
   * rows inside it wrap: the selection, whether the panel and the file tree are
   * open, their sizes, and the window. `splitHeight` is in the list too, which looks
   * circular and is not - moving the divider trades height between the two halves
   * without changing their sum, so the answer is the same before and after, and
   * measuring again simply keeps it honest through a drag.
   *
   * A layout effect rather than an ordinary one: it reads geometry, and doing that
   * after paint would show one frame clamped to the previous answer.
   */
  useLayoutEffect(() => {
    const measure = (): void => {
      const top = panelTopRef.current;
      const bottom = panelBottomRef.current;
      const column = top?.parentElement;
      if (!top || !bottom || !column) return;

      /*
       * Measured off the column, not off the two halves.
       *
       * An earlier version took the top half's current slack and added it to the
       * bottom half's current height, which is exact only while the split already
       * fits. Once it does not, the top half is already pinned at its floor, the
       * slack reads zero, and the answer becomes whatever the bad value was - the
       * measurement agreeing with the thing it was supposed to correct.
       *
       * Reading the column instead makes it independent of the current split: the
       * space is what the column has, less everything in it that never folds, less
       * the floor the top half keeps.
       */
      const style = window.getComputedStyle(column);
      const gap = Number.parseFloat(style.rowGap) || 0;
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      const kids = [...column.children];
      // Everything that is neither half: the settings row, a cluster's row, the
      // divider. Each holds its size, so each comes straight off the top.
      const fixed = kids
        .filter((el) => el !== top && el !== bottom)
        .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
      /*
       * And the margins, which a bounding rect does not include.
       *
       * Both settings rows carry `margin-top: 2px`. Four pixels, and leaving them out
       * put the ceiling four too high - enough for the bottom half to hang past the
       * column and carry the chat box down with it. Summed rather than collapsed
       * because margins between flex items do not collapse.
       */
      const margins = kids.reduce((sum, el) => {
        const s = window.getComputedStyle(el);
        return sum + (Number.parseFloat(s.marginTop) || 0) + (Number.parseFloat(s.marginBottom) || 0);
      }, 0);
      const declared = Number.parseFloat(window.getComputedStyle(top).minHeight);
      const floor = Number.isFinite(declared) ? declared : PANEL_TOP_FLOOR;

      const room =
        column.clientHeight - padding - gap * Math.max(0, kids.length - 1) - margins - fixed - floor;
      const max = Math.max(SPLIT_MIN, Math.round(room));
      setSplitMax(max);
      // A remembered split from a taller window, or from before a cluster's row
      // appeared, is corrected here rather than left to over-constrain the column.
      setSplitHeight((h) => Math.min(h, max));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [selectedLoop?.id, selectedLoop?.cluster !== undefined, splitHeight, panelOpen, filesOpen, filesHeight]);

  /*
   * The runner key the panel's log and chat are pointed at.
   *
   * A plain loop is its own key, so the log and the message box behave exactly as
   * they did. A cluster resolves to the member the strip has selected - one session
   * of several - which is what makes the chat box work at all on a cluster: a
   * message is a reply to something you just read in one member's log, and sending
   * it to all five would put five agents onto a remark meant for one.
   *
   * Clamped rather than trusted, because the size can be turned down while a member
   * further along is being read. A stale index would point the log at a member that
   * no longer exists and show nothing, with no way to tell that from a member that
   * has not spoken.
   */
  const memberIndex = selectedLoop?.cluster
    ? Math.min(memberPick, selectedLoop.cluster.size - 1)
    : 0;
  const readingKey =
    selectedLoop === null
      ? null
      : selectedLoop.cluster
        ? memberId(selectedLoop.id, memberIndex)
        : selectedLoop.id;

  // Back to the first member whenever the selection moves. See `memberPick`.
  useEffect(() => {
    setMemberPick(0);
  }, [selectedLoop?.id]);

  /*
   * A session looked at for the first time shows what it has already said, which
   * the server buffered while nothing was watching.
   *
   * Keyed on the runner rather than on the loop, so each member of a cluster is
   * seeded the first time its own tab is opened rather than all of them the moment
   * the cluster is selected. A sixteen-member cluster would otherwise fire sixteen
   * requests for fifteen logs nobody is looking at, and `seeded` would mark them
   * all fetched - so the one you did open would be showing the buffer as of
   * somebody else's click.
   *
   * That is also why it depends on the reading key rather than the selection:
   * switching member is a fresh subject in exactly the way selecting a different
   * loop is.
   *
   * Below `readingKey` rather than up with the other effects, because it needs it.
   */
  useEffect(() => {
    if (readingKey === null) return;
    if (seeded.current.has(readingKey)) return;
    seeded.current.add(readingKey);
    /*
     * History first, then every live line held back that the history cannot
     * contain. See `landed` for why the lines were held.
     *
     * The cut is the moment the request was made, not the history's last
     * timestamp: the server joins text chunks in its buffer and a joined block
     * keeps its *first* chunk's time, so the last entry's `ts` can predate tokens
     * it already holds, and cutting there would append those tokens twice. Server
     * and browser share a clock - this is loopback - so a line stamped after the
     * request went out is one the buffer, complete as of when it answered, could
     * only hold if it was emitted during the round trip. That sliver is closed
     * for the discrete kinds by an exact match; text chunks in it are joined
     * server-side and cannot be matched, and a millisecond of doubled token is
     * the cost of not losing the log.
     */
    const asked = new Date().toISOString();
    const land = (history: OutputLine[]): void => {
      const had = new Set(history.filter((l) => l.kind !== 'text').map((l) => `${l.ts}\n${l.kind}\n${l.text}`));
      const held = (pending.current.get(readingKey) ?? []).filter(
        (l) => l.ts > asked && !had.has(`${l.ts}\n${l.kind}\n${l.text}`),
      );
      pending.current.delete(readingKey);
      landed.current.add(readingKey);
      setOutput((prev) => new Map(prev).set(readingKey, joinText([...history, ...held]).slice(-OUTPUT_LIMIT)));
    };
    void api
      .output(factoryId, readingKey)
      .then(land)
      .catch(() => land([]));
  }, [readingKey, factoryId]);
  const selectedWire = useMemo(
    () => (selected?.kind === 'wire' ? factory.wires.find((w) => w.id === selected.id) ?? null : null),
    [factory.wires, selected],
  );
  /**
   * Every wire the selected one belongs to.
   *
   * Selecting a wire selects its producer's fan-out, so this is what the wire panel
   * describes and what its delete acts on. In document order, which is the order
   * they were drawn.
   */
  const selectedFanOut = useMemo(
    () => (selectedWire === null ? [] : factory.wires.filter((w) => w.from === selectedWire.from)),
    [factory.wires, selectedWire],
  );

  // Paused counts as running here: a waiting loop still has the base directory as
  // its agents' cwd and will take a turn on its own, so the bar must stay locked
  // and the badge must stay lit.
  const anyRunning = [...status.values()].some((s) => s.state !== 'stopped');

  return (
    <>
      <header className="bar">
        <button className="with-icon" onClick={startAll}>
          <Icon name="hero-play" />
          Run all
        </button>
        <button
          className="with-icon"
          title="Finish the turn in flight, then stop. Nothing is interrupted."
          onClick={() => void api.stopAll(factoryId).catch(() => undefined)}
        >
          <Icon name="hero-stop" />
          Stop all
        </button>
        {/*
          The impatient sibling. Stop all lets each loop finish its final turn -
          which is minutes when an agent is deep in an edit - and this one kills
          the turn where it stands. Tinted like the danger it is: a killed agent
          can leave files in a state nobody chose.
        */}
        <button
          className="icon-only force-stop"
          title="Force stop"
          aria-label="Force stop"
          onClick={() => void api.forceStopAll(factoryId).catch(() => undefined)}
        >
          <Icon name="hero-bolt" />
        </button>
        <span className="sep" />
        <button className="with-icon add-loop" onClick={() => addLoop()}>
          <Icon name="hero-arrow-path" />
          Add loop
        </button>
        {/*
          Beside Add loop, because it is the same act with a different component:
          both put a box on the canvas and neither has any other effect. A cluster
          is not a variant of a loop reached through a setting - it is a thing you
          decide to place, the way you decide to place a loop - so it gets its own
          button rather than a checkbox in the panel that would turn one into the
          other after the fact.
        */}
        <button className="with-icon add-loop" onClick={addCluster}>
          <Icon name="cluster" />
          Loop cluster
        </button>
        <LibraryPicker
          library={library}
          onPick={(entry) => addLoop(entry)}
          onPickFactory={onOpenLibraryFactory}
        />
        <span className="spacer" />
        {anyRunning && <span className="live">running</span>}
        {error && (
          <span className="error" title={error} onClick={() => setError(null)}>
            {error}
          </span>
        )}
      </header>

      <BaseDirBar
        baseDir={factory.baseDir}
        running={anyRunning}
        git={git}
        parameters={parameters}
        servers={mcpServers}
        resources={resources}
        onChange={setBaseDir}
        onParameters={setParameters}
        onOpenFactory={onOpenFactory}
        onBranchOff={branchOff}
      />

      <div className="body">
        {/*
          The canvas and the file panel, stacked.
          
          A column inside the row, rather than a fourth thing below `.body`, which
          is what puts the file panel under the canvas *and* left of the settings
          panel instead of running the full width of the window beneath both. The
          right-hand panel keeps its full height that way, which is what it wants:
          it is a prompt editor and an output log, and both are tall things.
        */}
        <div className="stack">
          <Canvas
            factory={factory}
            status={status}
            queues={queues}
            defaultModel={models.defaultId}
            fitOnLoad={fitOnLoad}
            selected={selected}
            onSelect={(next) => {
              setSelected(next);
              // Selecting something is only ever a request to look at it, so a
              // collapsed panel opens rather than swallowing the click.
              if (next) setPanelOpen(true);
              // Selecting a loop is asking about that loop, so the file panel
              // follows it; deselecting takes the loop view's subject away, so
              // the panel falls back to the project rather than sitting on an
              // empty "select a loop" placeholder. The changes view is neither
              // loop-bound nor empty without a selection, so it stays where the
              // operator put it.
              setFilesTarget((prev) =>
                next?.kind === 'loop' ? 'loop' : prev === 'loop' ? 'project' : prev,
              );
            }}
            onChange={change}
            onDeleteWire={deleteWire}
            onStart={startLoop}
            onStop={(id) => void api.stopLoop(factoryId, id).catch(() => undefined)}
            onForceStop={(id) => void api.forceStopLoop(factoryId, id).catch(() => undefined)}
            // An ordinary document edit, like every other loop setting: the
            // server hands the new document to the runners and its start guard
            // reads `disabled` from it. No endpoint of its own.
            onDisable={(id, disabled) => patchLoop(id, { disabled })}
            onView={(next) => {
              viewRef.current = next;
            }}
            onImportFile={onImportFile}
          />

          {/*
            The file panel's divider, built exactly like the one beside the settings
            panel: a 7px grab area with a 1px line drawn in it, and the fold control
            sitting on the line it moves.
            
            The chevron is the same glyph rotated a quarter turn, so it points down
            to push the panel away and up to pull it back. There is no
            `hero-chevron-down` and there does not need to be - one path rotated
            cannot disagree with itself.
          */}
          <div
            className={`resizer-h${filesOpen ? '' : ' collapsed'}${resizingFiles ? ' dragging' : ''}`}
            onPointerDown={onFilesResizeStart}
            onDoubleClick={filesOpen ? () => setFilesHeight(FILES_DEFAULT) : undefined}
            title={filesOpen ? 'Drag to resize, double-click to reset' : undefined}
          >
            <button
              className={`files-arrow${filesOpen ? '' : ' closed'}`}
              // Without this the press starts a resize drag as well as toggling.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setFilesOpen((open) => !open)}
              title={filesOpen ? "Hide the loop's files" : "Show the loop's files"}
              aria-label={filesOpen ? "Hide the loop's files" : "Show the loop's files"}
              aria-expanded={filesOpen}
            >
              <Icon name="hero-chevron-right" />
            </button>
          </div>

          {/*
            Folded by animating its height to zero, and kept mounted while shut for
            the same reasons the panel beside it is: nothing can animate if it is
            not there, and an open file and a scroll position are worth keeping
            across a fold.
          */}
          <div
            className={`files${filesOpen ? '' : ' collapsed'}`}
            style={{ height: filesHeight }}
            aria-hidden={!filesOpen}
          >
            <LoopFiles
              factoryId={factoryId}
              target={filesTarget}
              loop={
                selectedLoop ? { id: selectedLoop.id, name: selectedLoop.name } : null
              }
              git={git}
              /*
                A worktree loop's changes live in the selected session's checkout,
                not in the factory's directory - which for such a loop would show
                nothing at all. The key follows the member strip; an empty branch
                means "ticked but never started", which the panel says out loud.
              */
              checkout={
                selectedLoop?.worktree === true && readingKey !== null
                  ? { key: readingKey, branch: checkouts[readingKey]?.branch ?? '' }
                  : null
              }
              open={filesOpen}
              onTarget={(next) => {
                setFilesTarget(next);
                // Asking for a view is asking to see it, so the panel unfolds. The
                // switch is inside the panel, so this only matters for the keyboard -
                // but a segment that focused without showing anything would be odd.
                setFilesOpen(true);
              }}
              onFiles={onLoopFiles}
            />
          </div>
        </div>

        {/*
          The divider, and the arrow that folds the panel.
          
          The arrow sits on the divider rather than in the toolbar, straddling the
          border line the way the advanced-settings chevron does in the flock
          dashboard: the control is on the edge it moves. It stays put when the
          panel folds, which is what makes it the way back - a toggle that lived in
          the toolbar was a button you had to remember was related.
        */}
        <div
          className={`resizer${panelOpen ? '' : ' collapsed'}${resizing ? ' dragging' : ''}`}
          onPointerDown={onResizeStart}
          onDoubleClick={panelOpen ? () => setPanelWidth(PANEL_DEFAULT) : undefined}
          title={panelOpen ? 'Drag to resize, double-click to reset' : undefined}
        >
          <button
            className={`panel-arrow${panelOpen ? '' : ' closed'}`}
            // Without this the press starts a resize drag as well as toggling.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setPanelOpen((open) => !open)}
            title={panelOpen ? 'Collapse the panel' : 'Show the panel'}
            aria-label={panelOpen ? 'Collapse the panel' : 'Show the panel'}
            aria-expanded={panelOpen}
          >
            <Icon name="hero-chevron-right" />
          </button>
        </div>

        {/*
          Always rendered, and folded by animating its width to zero.
          
          It used to be unmounted when collapsed, which cannot animate: there is
          nothing on screen to transition. Kept mounted, the panel slides shut, and
          its contents are still there when it slides back - no refetch, no
          scroll position lost. `width: 0 !important` in the stylesheet beats the
          inline width, which is the same trick the flock dashboard uses to fold its
          environment column over an operator-set width.
        */}
        <aside
          className={`panel${panelOpen ? '' : ' collapsed'}`}
          style={{ width: panelWidth }}
          aria-hidden={!panelOpen}
        >
            {selectedWire ? (
              <WirePanel
                factoryId={factoryId}
                wire={selectedWire}
                fromName={factory.loops.find((l) => l.id === selectedWire.from)?.name ?? selectedWire.from}
                /*
                 * Locked while any loop at either end of the fan-out is going, and
                 * `paused` counts as going.
                 *
                 * Switching mode rewrites the folders those loops are using, and an
                 * agent mid-turn was handed the old paths in its prompt: the producer
                 * would write into a folder that has just been deleted, and a
                 * consumer claiming an item could race the copy that fans it out to
                 * three subscribers. The next turn reads the new document and is
                 * fine; the one in flight cannot be told.
                 */
                /*
                  Through `aggregate` rather than `status.get(id)`: the status map
                  is keyed by session, and a cluster's sessions are `<id>#<n>`, so
                  a bare lookup found nothing for a running cluster and read it as
                  stopped - which left the one control this guard exists for
                  enabled in exactly the case where switching costs the most. The
                  server refuses the switch too now, with a 409, so a tab that
                  gets this wrong is told rather than obeyed.
                */
                busy={[selectedWire.from, ...selectedFanOut.map((w) => w.to)].some((id) => {
                  const loop = factory.loops.find((l) => l.id === id);
                  return loop !== undefined && aggregate(loop, status).state !== 'stopped';
                })}
                // Every consumer of this producer, this wire's included: the panel
                // shows the whole fan-out, and the mode control edits all of it.
                consumers={selectedFanOut.map((w) => ({
                  id: w.to,
                  name: factory.loops.find((l) => l.id === w.to)?.name ?? w.to,
                }))}
                onMode={(mode) => setWireMode(selectedWire.id, mode)}
                onDelete={deleteSelected}
              />
            ) : !selectedLoop ? (
              <p className="empty">
                Select a loop to write its prompt, or a wire to see its queue. Drag from the dot on a
                loop's right edge to another loop to wire them.
              </p>
            ) : (
              <>
                {/*
                  The panel's top half: the loop's name and its prompt. The
                  settings row lives *below* this, outside the half that gives
                  way - dragging the split up must not cost the operator the
                  wait-for-work box or the model picker, which are controls, not
                  reference. What folds as the top shrinks is the prompt, down to
                  its floor and then away entirely, leaving the name row.
                */}
                <div className="panel-top" ref={panelTopRef}>
                <div className="loop-head">
                  <input
                    className="name"
                    value={selectedLoop.name}
                    onChange={(e) =>
                      change({
                        ...factory,
                        loops: factory.loops.map((l) =>
                          l.id === selectedLoop.id ? { ...l, name: e.target.value } : l,
                        ),
                      })
                    }
                  />
                  <SaveToLibrary loop={selectedLoop} onSaved={refreshLibrary} onError={setError} />
                  {/*
                    One button, both directions: a loop becomes a cluster, a cluster
                    becomes a loop again.

                    One rather than two because there is one question here - how many
                    sessions is this - and the answer is a toggle. The glyph names the
                    destination rather than the state, so it reads as the thing the
                    click will do: the three joined nodes on a loop, the circular
                    arrows on a cluster.

                    Between saving and deleting on purpose. Everything in this row
                    acts on this component, and the order is how far each goes: keep
                    it, change what it is, remove it.
                  */}
                  <ConvertKind
                    loop={selectedLoop}
                    running={selectedRunning}
                    onConvert={(cluster) => patchLoop(selectedLoop.id, { cluster })}
                  />
                  {/*
                    Deleting the loop lives here, next to saving it, because both are
                    things you do to *this* loop rather than to the factory. The
                    toolbar used to carry it and should not have: everything else in
                    that row acts on the whole factory - run it, stop it, add to it -
                    and a delete there was the odd one out that changed meaning
                    depending on what happened to be selected.

                    Icon-only, matching the wire panel's delete exactly: same glyph,
                    same tint, and the tooltip is the label it replaced rather than a
                    sentence about it. The two are the sibling case - each panel owning
                    the removal of the thing it describes - so a text button here beside
                    an icon there would be the inconsistency, not the fix for one. The
                    name input next to it is what should have the row's width.
                  */}
                  <button
                    className="danger icon-only"
                    title="Delete loop and its wires"
                    aria-label="Delete loop and its wires"
                    onClick={deleteSelected}
                  >
                    <Icon name="hero-trash" />
                  </button>
                </div>
                <PromptBox
                  value={selectedLoop.prompt}
                  onChange={(next) => setPrompt(selectedLoop.id, next)}
                  area={promptArea}
                  servers={mcpServers}
                  reads={factory.wires.filter((w) => w.to === selectedLoop.id).length}
                  writes={factory.wires.filter((w) => w.from === selectedLoop.id).length}
                  baseDir={factory.baseDir}
                  loopId={selectedLoop.id}
                  parameters={parameters}
                  skills={resources.skills}
                  steeringFiles={resources.steeringFiles}
                />
                {/*
                  The loop's settings, in one row: when it runs (wait for work),
                  what it may call (the MCP scope), and what it runs on (the
                  model). They sit below the prompt and above the log - between
                  the design and the behaviour, which is what they are. One row
                  because each is a checkbox or a select wide; the explanations
                  live on tooltips rather than paragraphs, so three settings cost
                  the height one used to.
                */}
                </div>
                {/*
                  The cluster's own settings, on a row above the rest.
                  
                  Above rather than in the row below, and only present on a cluster.
                  Everything in `loop-settings` answers a question about one session
                  - when it stops, what it may call, which model it runs - and these
                  answer a prior one: how many sessions there are, and whether they
                  can see each other. Mixed into that row they would read as two more
                  dials of the same kind, and the size dial would sit beside the
                  iteration-cap dial looking like a sibling of it.
                */}
                {selectedLoop.cluster && (
                  <ClusterSettings
                    cluster={selectedLoop.cluster}
                    reads={factory.wires.filter((w) => w.to === selectedLoop.id).length}
                    running={selectedRunning}
                    worktree={selectedLoop.worktree === true}
                    onChange={(next) =>
                      patchLoop(selectedLoop.id, { cluster: { ...selectedLoop.cluster!, ...next } })
                    }
                  />
                )}
                <div className="loop-settings">
                  <RunMode
                    loop={selectedLoop}
                    reads={factory.wires.filter((w) => w.to === selectedLoop.id).length}
                    onChange={(next) => patchLoop(selectedLoop.id, next)}
                  />
                  {/*
                    Directly after the run mode, because the two are the same
                    thought split in half: that one says whether another turn
                    starts, this one says when. Before the grant and model picks,
                    which are about what a turn *is* rather than about its cadence.
                  */}
                  <IntervalPick
                    seconds={selectedLoop.intervalSeconds}
                    onChange={(next) => patchLoop(selectedLoop.id, { intervalSeconds: next })}
                  />
                  <McpScope
                    mcp={selectedLoop.mcp}
                    servers={mcpServers}
                    prompt={selectedLoop.prompt}
                    parameters={parameters}
                    open={openPick === 'mcp'}
                    // Closing only clears the state when this menu is the one
                    // recorded as open. React closing the *other* menu fires its
                    // toggle too, and without the guard that close would undo the
                    // open that caused it - leaving both shut.
                    onOpen={(open) => {
                      if (open) dismissHint();
                      setOpenPick((prev) => (open ? 'mcp' : prev === 'mcp' ? null : prev));
                    }}
                    onChange={(next) => {
                      dismissHint();
                      patchLoop(selectedLoop.id, { mcp: next });
                    }}
                    /*
                      The hint rides on this one because it is first in the row and
                      already a positioning context, so a bubble anchored here sits
                      above both grants without anybody measuring anything.
                    */
                    hint={grantHint}
                    onDismissHint={dismissHint}
                    onKeepHint={keepGrantDefault}
                    onSaveDefault={
                      sameGrant(selectedLoop.mcp, grants.mcp)
                        ? undefined
                        : () => saveGrantDefault('mcp')
                    }
                  />
                  <ToolsPick
                    tools={selectedLoop.tools}
                    open={openPick === 'tools'}
                    onOpen={(open) => {
                      if (open) dismissHint();
                      setOpenPick((prev) => (open ? 'tools' : prev === 'tools' ? null : prev));
                    }}
                    onChange={(next) => {
                      dismissHint();
                      patchLoop(selectedLoop.id, { tools: next });
                    }}
                    onSaveDefault={
                      sameGrant(selectedLoop.tools, grants.tools)
                        ? undefined
                        : () => saveGrantDefault('tools')
                    }
                  />
                  {/*
                    After the grants because they look like grants and are not:
                    these two change the prompt, not the loop. Kept in the same
                    row and the same chrome anyway, because "what does this loop
                    get to work with" is one question wherever the answer is
                    stored.
                  */}
                  <SkillsPick
                    skills={resources.skills}
                    prompt={selectedLoop.prompt}
                    parameters={parameters}
                    servers={mcpServers}
                    open={openPick === 'skills'}
                    onOpen={(open) =>
                      setOpenPick((prev) => (open ? 'skills' : prev === 'skills' ? null : prev))
                    }
                    onInsert={insertReference}
                  />
                  <SteeringPick
                    steeringFiles={resources.steeringFiles}
                    skills={resources.skills}
                    prompt={selectedLoop.prompt}
                    parameters={parameters}
                    servers={mcpServers}
                    open={openPick === 'steering'}
                    onOpen={(open) =>
                      setOpenPick((prev) => (open ? 'steering' : prev === 'steering' ? null : prev))
                    }
                    onInsert={insertReference}
                  />
                  <ModelPicker
                    model={selectedLoop.model}
                    catalog={models}
                    onRetry={onRetryModels}
                    onChange={(next) => patchLoop(selectedLoop.id, { model: next })}
                  />
                  {/*
                    Last in the row because it is the only setting here about
                    *where* a session works rather than how. Only offered when the
                    directory is a repository: the checkouts are worktrees, and
                    without a repository there is nothing to check out.
                  */}
                  {git !== null && git.kind !== 'none' && (
                    <WorktreePick
                      loop={selectedLoop}
                      running={selectedRunning}
                      checkouts={checkouts}
                      readingKey={readingKey}
                      onToggle={toggleWorktree}
                      onRelease={releaseCheckouts}
                    />
                  )}
                </div>
                {/*
                  The split's divider carries the same fold control as the other
                  two, with one difference of meaning: nothing here closes. The
                  arrow sweeps the divider through its three stops - prompt
                  maximised, the even split, log maximised - one per click,
                  turning around at the ends, and points the way it will move,
                  with the same glyph and quarter-turn the file panel's arrow
                  uses.
                */}
                <div
                  className={`panel-split${resizingSplit ? ' dragging' : ''}`}
                  onPointerDown={onSplitResizeStart}
                  onDoubleClick={() => setSplitHeight(Math.round(window.innerHeight / 2))}
                  title="Drag to resize, double-click to reset"
                >
                  <button
                    className={`split-arrow${splitJump.up ? ' closed' : ''}`}
                    // Without this the press starts a resize drag as well as toggling.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      setSplitHeight(splitJump.target);
                      setSplitDir(splitJump.up ? 'up' : 'down');
                    }}
                    title={splitJumpLabel}
                    aria-label={splitJumpLabel}
                  >
                    <Icon name="hero-chevron-right" />
                  </button>
                </div>
                {/*
                  The bottom half: what the loop is doing, and the way to talk to
                  it. Sized by the split rather than by flex, so it holds its
                  height while the top half gives way.
                */}
                <div className="panel-bottom" ref={panelBottomRef} style={{ height: splitHeight }}>
                  {/*
                    Which member's log you are reading, on a strip above it.
                    
                    Only on a cluster - a plain loop has one session and a strip of
                    one tab is a label pretending to be a control. The alternative
                    was one merged log with a member tag per line, and it does not
                    work: `say` merges consecutive text into one block, so five
                    agents streaming at once produce blocks that are literally five
                    sentences spliced together. Switching is the only version of this
                    that yields something readable.
                  */}
                  {selectedLoop.cluster && (
                    <MemberStrip
                      loop={selectedLoop}
                      status={status}
                      current={memberIndex}
                      onPick={setMemberPick}
                    />
                  )}
                  <Output lines={output.get(readingKey ?? selectedLoop.id) ?? []} />
                  <SteerBox
                    running={(status.get(readingKey ?? selectedLoop.id)?.state ?? 'stopped') !== 'stopped'}
                    onSend={(text) =>
                      void api
                        .steerLoop(factoryId, readingKey ?? selectedLoop.id, text)
                        .catch((e: Error) => setError(e.message))
                    }
                  />
                </div>
              </>
            )}
        </aside>
      </div>

      {/* Asked by the canvas: removing a wire that still has work waiting on it. */}
      <Confirm ask={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

/* --------------------------------------------------------------- the cluster */

/**
 * How many sessions a cluster runs, and whether they can see each other.
 *
 * Three controls on one row, in the order the questions come: what kind of cluster,
 * how big, and how the members relate. The size sits between the other two because
 * it means different things either side of the mode switch - a count when fixed, a
 * ceiling when scaled - and reading it next to the mode is what makes that legible.
 */
function ClusterSettings({
  cluster,
  reads,
  running,
  worktree,
  onChange,
}: {
  cluster: Cluster;
  /** How many wires feed this component, which is what scaling has to scale on. */
  reads: number;
  /** Anything live in the cluster, which locks all three of these. See below. */
  running: boolean;
  /** Sessions work in checkouts of their own, which changes what a broadcast means. */
  worktree: boolean;
  onChange: (patch: Partial<Cluster>) => void;
}) {
  /*
   * Locked while the cluster is running, all three of them.
   *
   * None of these is a setting a session picks up on its next turn, which is what
   * everything in the row below this one is. They are the shape of the component.
   *
   * The size decides how many sessions there are, and sessions are keyed by member,
   * so turning it down retires the members past the new size - a graceful stop, but
   * still a stop the operator did not ask for from a control that says nothing about
   * stopping, and a retiring member has claimed an item off a queue it has not yet
   * written back. Turning it up is the mirror problem and worse for being quiet: the
   * new members enter the document and nothing starts them, so the control looks like
   * it worked and half did.
   *
   * The mode has the same gap in the other direction. A cluster that becomes scaled
   * while running gets no supervisor until the next Start - deliberately, since
   * supervising it would start members on a component nobody has run - so switching
   * live changes the label and not the behaviour.
   *
   * Comms is the one that is technically safe: the ring's files are created lazily by
   * the first flock turn and a neighbour with no file yet reads as silence, so a live
   * switch works. It is locked anyway, because what it changes is not a degree of
   * anything - it decides whether these agents are working alone or reading each
   * other, which is a different job description arriving between turns. A row where
   * two controls are locked and the third is not would also be a row that has to be
   * learned rather than read.
   *
   * Stop, change, start. The card's own button, next to the thing being changed.
   */
  const locked = running
    ? 'Stop this cluster to change how it is put together. Its type, its size and how the nodes communicate are all fixed while it runs.'
    : undefined;

  const modeTips: Record<ClusterMode, string> = {
    fixed: `Exactly ${cluster.size} nodes, started together. The same as having drawn ${cluster.size} identical loops.`,
    scaled:
      'One node per item waiting on the incoming queues, up to the ceiling. Nodes start as the backlog grows and stop again as it drains.',
  };
  const commsTips: Record<ClusterComms, string> = {
    isolated:
      'Nodes never see each other. Each takes an item and works on it alone, like a subagent - the queue is the only thing they share.',
    flock:
      'Kiro Flock, locally: the nodes form a ring and each one reads its two neighbours before deciding what to do. Append-only, one log per node.',
  };

  return (
    <div className="cluster-settings">
      <select
        className="cluster-mode"
        value={cluster.mode}
        disabled={running}
        title={locked ?? modeTips[cluster.mode]}
        aria-label="Cluster type"
        onChange={(e) => onChange({ mode: e.target.value as ClusterMode })}
      >
        <option value="fixed" title={modeTips.fixed}>
          Fixed size
        </option>
        <option value="scaled" title={modeTips.scaled}>
          Auto scaled
        </option>
      </select>
      <Stepper
        value={cluster.size}
        min={CLUSTER_MIN}
        max={CLUSTER_MAX}
        /*
         * The unit carries the mode, because the number means two different things.
         * Fixed: this many members. Scaled: at most this many, and the live count is
         * whatever the queue says - which the card's chip reports as `3 of 8 max`.
         * Labelling both "members" would make a scaled cluster showing three of
         * eight look like five members had failed to start.
         */
        unit={cluster.mode === 'scaled' ? 'max' : 'nodes'}
        disabled={running}
        title={
          locked ??
          (cluster.mode === 'scaled'
            ? 'The most nodes this cluster will ever run at once. Every node is an agent session on this machine.'
            : 'How many nodes this cluster runs. Every node is an agent session on this machine.')
        }
        onChange={(n) => onChange({ size: n })}
      />
      <select
        className="cluster-comms"
        value={cluster.comms}
        disabled={running}
        title={locked ?? commsTips[cluster.comms]}
        aria-label="How members communicate"
        onChange={(e) => onChange({ comms: e.target.value as ClusterComms })}
      >
        <option value="isolated" title={commsTips.isolated}>
          Fire and forget
        </option>
        <option value="flock" title={commsTips.flock}>
          Kiro Flock
        </option>
      </select>
      {/*
        Auto scaling has nothing to scale on without a queue to read.
        
        Said here rather than left to be discovered, and not by disabling the option:
        the wiring is what is wrong, not the choice, and a greyed-out dropdown entry
        cannot say which. The cluster still runs - one member, which is the floor -
        so this is a note about a setting that is doing nothing, not an error.
      */}
      {cluster.mode === 'scaled' && reads === 0 && (
        <span className="hint" title="Auto scaling counts the items waiting on the folders this component reads. With nothing wired in there is nothing to count, so the cluster runs one node.">
          nothing wired in - runs one node
        </span>
      )}
      {/*
        Flock comms with per-session checkouts: allowed, warned about, not
        blocked. The mechanics are fine - the ring lives in the machinery, which
        never forks - but a broadcast naming a file points at the sender's
        checkout, not the reader's, and the reader should hear that from us
        rather than discover it. It also makes the local ring behave more like
        the thing it is named after: the broadcast becomes the only channel, and
        a neighbour's work is reached through its branch.
      */}
      {cluster.comms === 'flock' && worktree && (
        <span
          className="hint"
          title="Each node works in its own checkout, so a file a neighbour's broadcast mentions changed in that node's checkout - not in this one's. Their branches are how their work is reached. The prompt tells every node this."
        >
          separate checkouts - broadcasts cross them
        </span>
      )}
    </div>
  );
}

/**
 * Per-session checkouts: the checkbox, the badge, and the way out.
 *
 * The checkbox is intent - `worktree` on the document - and nothing more:
 * checking it spends no time and touches no repository, because provisioning
 * happens at the next Start, where a slow `git worktree add` per session can
 * say so on the loop's own log. It is disabled while the component runs, and
 * that lock is not the usual courtesy: the field is read once, at start, when
 * each session's runner is built around its checkout, so a mid-run edit would
 * change nothing until the next start while letting the panel claim otherwise.
 * The one thing worse than a locked control is a live one that lies.
 *
 * The badge is the per-loop sibling of the directory bar's `GitBadge`: the
 * branch the session you are reading works on, with its directory in the
 * tooltip. It follows the member strip's selection, because "which branch is
 * this log's work on" is a question about the log you have open.
 *
 * Release is per component, never per member - see the server's route note -
 * and only offered when there is something to release and nothing running.
 */
function WorktreePick({
  loop,
  running,
  checkouts,
  readingKey,
  onToggle,
  onRelease,
}: {
  loop: Loop;
  running: boolean;
  checkouts: Record<string, SessionCheckout>;
  /** The runner key whose log the panel is reading, for the badge. */
  readingKey: string | null;
  onToggle: (on: boolean) => void;
  onRelease: () => void;
}) {
  const on = loop.worktree === true;
  const provisioned = Object.keys(checkouts).length;
  const current = readingKey !== null ? checkouts[readingKey] : undefined;
  const sessions = memberCount(loop);
  return (
    <>
      <label
        className="setting"
        title={
          running
            ? 'Stop the loop to change this. Each session\'s checkout is fixed when it starts, so flipping it now would not take effect until the next start anyway.'
            : on
              ? 'Each session works in its own git worktree, on its own branch. Untick to run in the factory\'s directory again - existing checkouts stay until released.'
              : sessions > 1
                ? `Give each of the ${sessions} sessions its own git worktree, so they stop editing one directory over each other. Created at the next Start.`
                : 'Give this loop its own git worktree of the project, on its own branch. Created at the next Start.'
        }
      >
        <input
          type="checkbox"
          checked={on}
          disabled={running}
          onChange={(e) => onToggle(e.target.checked)}
        />
        own checkout
      </label>
      {on && current !== undefined && (
        <span
          className="dirbar-git worktree"
          title={`This session works in ${current.dir}, a worktree on its own branch. Other sessions have checkouts of their own.`}
        >
          <Icon name="branch" />
          {current.branch}
        </span>
      )}
      {on && provisioned > 0 && !running && (
        <button
          className="with-icon"
          title={`Remove ${provisioned === 1 ? 'the checkout' : `all ${provisioned} checkouts`}. Never forced - uncommitted or untracked files refuse - and branches always stay.`}
          onClick={onRelease}
        >
          <Icon name="hero-trash" />
          Release
        </button>
      )}
    </>
  );
}

/**
 * Which member of a cluster the log below is showing.
 *
 * One tab per member, and the running ones carry a dot. A cluster's members are
 * separate sessions with separate logs - see `OutputLine.loop` - so the panel has
 * to pick one, and picking is more useful than merging: the question you have while
 * watching a cluster is "what is member 3 doing", and an interleaved scroll answers
 * it worse than a switch does.
 *
 * Every member gets a tab whether or not it has ever run, including the ones a
 * scaled cluster has not needed yet. A strip that grew as members started would
 * move the tab you were aiming at, and a member with an empty log is a fact worth
 * being able to look at.
 */
function MemberStrip({
  loop,
  status,
  current,
  onPick,
}: {
  loop: Loop;
  status: Map<string, LoopStatus>;
  current: number;
  onPick: (member: number) => void;
}) {
  return (
    <div className="member-strip" role="tablist" aria-label="Cluster nodes">
      {memberKeys(loop).map((key, n) => {
        const state = status.get(key)?.state ?? 'stopped';
        const iteration = status.get(key)?.iteration ?? 0;
        // `n1` for the first node, not `n0`. The index is zero-based because it is
        // an array position and a ring modulo; what a person points at is the first
        // node. `nodeLabel` is the single place those two meet, and it names the
        // node's folder as well, so this tab and the file panel agree.
        const label = nodeLabel(n);
        return (
          <button
            key={key}
            role="tab"
            aria-selected={n === current}
            className={`member-tab${n === current ? ' on' : ''}${state !== 'stopped' ? ' live' : ''}${state === 'running' ? ' working' : ''}`}
            title={
              state === 'stopped'
                ? `Node ${label} - stopped${iteration > 0 ? `, ${iteration} turns taken` : ', never run'}`
                : `Node ${label} - ${state}, ${iteration} ${iteration === 1 ? 'turn' : 'turns'}`
            }
            onClick={() => onPick(n)}
          >
            {label}
            {/* The dot is the whole point of the bar being more than a switch: it
                says which nodes are up without opening each one's log. */}
            {state !== 'stopped' && <span className="member-dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ the loop */

/** The five ways a run can end, in the order the dropdown lists them. */
type RunModeKey = 'stop' | 'iterations' | 'hours' | 'wait' | 'forever';

/** What a new pick of each mode writes. The absent keys clear the others. */
const RUN_MODE_PATCH: Record<RunModeKey, Partial<Loop>> = {
  stop: { autoStop: true, autoPause: false, stopAfterIterations: undefined, stopAfterHours: undefined },
  iterations: { autoStop: false, autoPause: false, stopAfterIterations: 10, stopAfterHours: undefined },
  hours: { autoStop: false, autoPause: false, stopAfterIterations: undefined, stopAfterHours: 1 },
  wait: { autoStop: false, autoPause: true, stopAfterIterations: undefined, stopAfterHours: undefined },
  forever: { autoStop: false, autoPause: false, stopAfterIterations: undefined, stopAfterHours: undefined },
};

/**
 * How the loop's run ends - or does not.
 *
 * One choice of five, and exactly one, which is why it is a select and not the
 * checkboxes it used to be. The combinations did not mean anything a person had
 * chosen: waiting is a claim that more work is coming, the stop modes are claims
 * that the run can finish, and a loop cannot hold both beliefs at once. The
 * dropdown makes the states say what they are:
 *
 * - **Auto stop** - the agent may end the run: it declares there is no further
 *   work, then confirms on one more turn having contributed nothing. Only the
 *   confirmation stops the loop. The default for a new loop, because it is the
 *   one mode that ends when the *work* ends rather than when a number does.
 * - **Wait for work** - turns only when an item is waiting; pauses on an empty
 *   queue and resumes by itself. Needs a wire in: a loop with no input has
 *   nothing to wait for.
 * - **Run forever** - turns until Stop is pressed. Right for a loop whose input
 *   is a file or whose job has no end.
 * - **After N iterations** - a cap on turns taken this run.
 * - **After N hours** - a deadline from the moment Start was pressed.
 *
 * The three modes that need no number come first, and the two counted ones sit
 * below them: they are the answer when the budget is the constraint rather than
 * the work, which is the less common thing to be choosing. A document with no
 * flags still reads as run-forever - absent means what it always meant - the
 * default here is what a *new* loop gets.
 *
 * The counted modes reveal a stepper beside the select rather than opening a
 * dialog or growing a second row: the number is part of the same sentence as the
 * mode ("after 10 iterations"), and reads as one setting because it is one.
 *
 * The read-back above resolves the fields in the parse's own precedence, not in
 * this list's order, so a hand-written document showing several modes shows the
 * one that will actually run.
 */
function RunMode({
  loop,
  reads,
  onChange,
}: {
  loop: Loop;
  reads: number;
  onChange: (next: Partial<Loop>) => void;
}) {
  // Reading the fields back as one value, in the parse's own precedence, so the
  // select shows what will actually run even for a hand-written document.
  const mode: RunModeKey = loop.autoStop
    ? 'stop'
    : loop.stopAfterIterations !== undefined
      ? 'iterations'
      : loop.stopAfterHours !== undefined
        ? 'hours'
        : loop.autoPause
          ? 'wait'
          : 'forever';
  const tips: Record<RunModeKey, string> = {
    forever: 'The loop takes turn after turn until Stop is pressed, even with nothing to read.',
    wait:
      reads === 0
        ? 'Nothing is wired into this loop, so there is nothing to wait for and it will keep taking turns. Draw a wire into it for this to apply.'
        : 'Turns are only spent when an item is waiting. The loop pauses on an empty queue and resumes by itself.',
    stop: 'The agent may end the run itself: it declares there is no further work, then confirms it on one more turn. Only the confirmation stops the loop.',
    iterations:
      'The run ends after this many turns. Counted from Start, so a restart gives the loop the full count again.',
    hours:
      'The run ends once this long has passed since Start. A turn already going is allowed to finish.',
  };
  return (
    <>
      <select
        className="model-pick"
        value={mode}
        title={tips[mode]}
        aria-label="Run mode"
        onChange={(e) => onChange(RUN_MODE_PATCH[e.target.value as RunModeKey])}
      >
        <option value="stop" title={tips.stop}>
          Auto stop
        </option>
        <option value="wait" title={tips.wait}>
          Wait for work
        </option>
        <option value="forever" title={tips.forever}>
          Run forever
        </option>
        <option value="iterations" title={tips.iterations}>
          After iterations
        </option>
        <option value="hours" title={tips.hours}>
          After hours
        </option>
      </select>
      {mode === 'iterations' && (
        <Stepper
          value={loop.stopAfterIterations ?? 10}
          min={1}
          max={999}
          unit="turns"
          title={tips.iterations}
          onChange={(n) => onChange({ stopAfterIterations: n })}
        />
      )}
      {mode === 'hours' && (
        <Stepper
          value={loop.stopAfterHours ?? 1}
          min={HOUR_STEPS[0]}
          max={HOUR_STEPS[HOUR_STEPS.length - 1]}
          steps={HOUR_STEPS}
          unit="hours"
          title={tips.hours}
          onChange={(n) => onChange({ stopAfterHours: n })}
        />
      )}
    </>
  );
}

/**
 * The rungs the hours stepper walks.
 *
 * A ladder rather than a step size, because hours are not used evenly: the
 * interesting values are a few minutes for a smoke test, the quarters of an
 * hour, then whole hours thinning out to a day. Walking that by ±1 would take
 * twenty-four presses to cross a range whose useful entries number eleven, and
 * an even step small enough to reach 0.05 would make the top of the range
 * unreachable by hand.
 *
 * Typing is still free between the ends: the document takes any fraction, and
 * snapping a typed value to the nearest rung would quietly overwrite a
 * deliberate 1.5. The arrows move to the next rung past wherever the value is,
 * so an off-ladder number is a place to be, not an error.
 */
const HOUR_STEPS = [0.05, 0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 12, 24] as const;

/**
 * A number and two tiny arrows, for the counted run modes.
 *
 * Deliberately small: it sits in a row of controls that are each one or two
 * words wide, and a full-size number input with the platform's own spinners
 * would be the loudest thing in the panel for the least important reason. The
 * native spinners are hidden in CSS and replaced with a stacked pair on the
 * field's edge - the shape kiro-flock's cluster controls use for the same job.
 *
 * The typed value is clamped on the way out, not while typing: clamping each
 * keystroke makes clearing the field to type a new number impossible, since the
 * empty string clamps to the minimum and the caret jumps. An unparseable or
 * out-of-range entry is simply not sent, so the field can be mid-edit without
 * the document following every intermediate state.
 *
 * A second mode, opt-in through `format` and `parse`, holds the same numeric value
 * as text. For a value that reads better with a unit inside it than as a bare
 * count: the interval's 86400 is a day, and `24h` says so. It is an addition rather
 * than a conversion because the counted run modes beside it are genuinely numbers,
 * and a number field is the right control for a number.
 */
function Stepper({
  value,
  min,
  max,
  steps,
  unit,
  disabled,
  title,
  format,
  parse,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  /**
   * Values the arrows walk, ascending. Absent means whole numbers, ±1 a press.
   * Present and the arrows move to the next rung beyond the current value,
   * which lands an off-ladder number on the ladder without snapping it there
   * behind the operator's back.
   */
  steps?: readonly number[];
  /**
   * The label above the number, so it reads as a quantity rather than a bare
   * count.
   *
   * Above rather than beside, which it used to be. These steppers appear next to a
   * dropdown in a row that already wraps to two lines on a narrow panel, and a
   * word to the right of each one was the widest part of the row for the least
   * information - the label is read once when you learn the control and the number
   * is read every time. Stacked, the control is as wide as its field and the row
   * fits on one line.
   */
  unit: string;
  /**
   * Greyed and inert. The field as well as the arrows: a number you can still type
   * into is a number you expect to keep, and a control that took an edit and dropped
   * it would be worse than one that refused the edit.
   */
  disabled?: boolean;
  title: string;
  /**
   * Write the value as text, and read it back. Together they turn the field from a
   * number input into a text one holding `format(value)`; absent, the field is the
   * number input it has always been.
   *
   * Both or neither. One without the other would be a field that displays a
   * duration and takes a count, or takes a duration and displays nothing, so the
   * pair is checked together and a lone half is ignored.
   *
   * `parse` returning `undefined` is the ordinary outcome for a half-typed or
   * meaningless entry, not an error: nothing is sent and the value stays where it
   * was. Nothing here reports it, the same way the numeric path says nothing about
   * a number outside its range.
   */
  format?: (n: number) => string;
  parse?: (s: string) => number | undefined;
  onChange: (next: number) => void;
}) {
  /**
   * The text being typed, or absent when the field is simply showing the value.
   *
   * Text mode needs it because a duration is unparseable for most of the time it
   * takes to type one: `1h30m` passes through `1`, `1h`, `1h3`, and a field that
   * only ever rendered `format(value)` would fight every keystroke that did not
   * yet mean anything. The draft is what the operator typed, kept until the edit
   * ends, and then dropped so the field goes back to agreeing with the document.
   */
  const [draft, setDraft] = useState<string>();
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));
  /**
   * The pair, once, so the two modes are one decision rather than two independent
   * checks that could disagree halfway down the component.
   */
  const text = format !== undefined && parse !== undefined ? { format, parse } : undefined;
  const stepUp = (from: number = value): number => {
    if (!steps) return clamp(from + 1);
    return steps.find((s) => s > from) ?? max;
  };
  const stepDown = (from: number = value): number => {
    if (!steps) return clamp(from - 1);
    // Ascending list, so the last rung below the value is the one to land on.
    return [...steps].reverse().find((s) => s < from) ?? min;
  };
  /**
   * Where the arrows start from in text mode: what is in the field if it means
   * anything, otherwise the value behind it. Typing `7m` and pressing up should
   * climb from seven minutes, not from wherever the value was before the edit.
   */
  const base = (): number => {
    if (draft === undefined || text === undefined) return value;
    return text.parse(draft) ?? value;
  };
  /**
   * End the edit: send what was typed if it means a number, and drop the draft
   * either way so the field shows the value rather than sitting on text that was
   * refused. Clamped like the numeric path's blur, for the same reason: a blur is
   * where an edit settles.
   */
  const commit = (): void => {
    if (draft !== undefined && text !== undefined) {
      const n = text.parse(draft);
      if (n !== undefined) onChange(clamp(n));
    }
    setDraft(undefined);
  };
  return (
    <span
      className={`stepper${disabled === true ? ' disabled' : ''}`}
      title={title}
    >
      {/*
        The label, and it is out of flow - see the stylesheet. It sits above the
        field without being part of the row, so the field itself lines up with the
        selects beside it instead of the whole two-line control centring against
        them and dropping the field half a line.
      */}
      <span className="stepper-unit">{unit}</span>
      {text !== undefined ? (
        <input
          type="text"
          inputMode="text"
          value={draft ?? text.format(value)}
          disabled={disabled === true}
          aria-label={unit}
          // Every keystroke, straight into the draft. Nothing is parsed here: a
          // duration is meaningless for most of the time it takes to type one.
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            /*
             * `type="number"` gave the arrow keys away for free, following `step`.
             * Text has no such thing, and what replaces it is better than what it
             * replaces: the keyboard walks the same uneven ladder as the buttons
             * beside it instead of moving by the smallest rung, so up from 30s is
             * a minute rather than ten more seconds.
             *
             * The draft is dropped on the way, because the value is about to
             * change and text left over from before it would hide the result.
             */
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setDraft(undefined);
              onChange(stepUp(base()));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setDraft(undefined);
              onChange(stepDown(base()));
            } else if (e.key === 'Enter') {
              // Enter is the other end of an edit, for a field nobody tabs out of
              // because it is the last thing they touched.
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          disabled={disabled === true}
          /*
           * A ladder's rungs are uneven, so the keyboard's own stepping follows the
           * smallest non-zero one rather than a whole unit - otherwise arrow-up
           * from 0.05 hours would jump past four rungs at once. Non-zero because a
           * ladder may start at zero, as the interval's does, and a step of nothing
           * is not a step. It lands on 10 there, which is the same reasoning read
           * the other way: a second at a time is too fine for a range that ends in
           * a day.
           */
          step={steps ? steps.find((s) => s > 0) ?? 1 : 1}
          aria-label={unit}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
          }}
          // A blur is the end of an edit, so this is where a half-typed or
          // out-of-range value is settled rather than left disagreeing with the
          // document behind it.
          onBlur={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? clamp(n) : value);
          }}
        />
      )}
      <span className="stepper-arrows">
        <button
          type="button"
          disabled={disabled === true}
          aria-label={`More ${unit}`}
          onClick={() => onChange(stepUp())}
        >
          <Icon name="hero-chevron-right" />
        </button>
        <button
          type="button"
          disabled={disabled === true}
          aria-label={`Fewer ${unit}`}
          onClick={() => onChange(stepDown())}
        >
          <Icon name="hero-chevron-right" />
        </button>
      </span>
    </span>
  );
}

/**
 * How long the loop idles between one turn and the next.
 *
 * In the per-turn settings row rather than in the cluster's, and it is the same
 * control for a plain loop and for a cluster: a cluster's members are sessions
 * running this same loop, so one interval is every member's interval and each
 * one waits it out on its own clock. The cluster row above is locked while it
 * runs because it decides how many sessions there are; this is read fresh at the
 * end of every turn, so it can be changed on a loop mid-run - including on one
 * that is sitting out a wait right now, which shortens or ends that wait.
 *
 * Not part of the run mode next to it, though they read as one thought. The mode
 * decides whether another turn starts; this decides when. Every pairing of the
 * two is meaningful, which is exactly why they are two controls: folding the
 * intervals into that dropdown would have made "wait for work, then throttle"
 * unsayable.
 *
 * A stepper on a ladder rather than a dropdown, matching the two counted run modes
 * beside it - they are the same kind of setting, a duration on an uneven scale, and
 * they should be the same control. Zero is a rung like any other and is the
 * default: a loop that leaves no gap between turns leaves a gap of zero, which is
 * the plain reading and the one that lets the arrows walk down to it. The document
 * still stores that as no field at all - see `onChange`.
 *
 * Written the way a duration is read: `30s`, `5m`, `24h`, through the same
 * `intervalLabel` the card's beacon and the countdown already use, so the three
 * agree character for character. The field held raw seconds until it learned to say
 * units, on the argument that a bare number under a unit *label* is ambiguous,
 * because the label moves as the value grows and the same digits then mean different
 * things. That argument does not reach a value carrying its own unit: `5m` and `5s`
 * are different strings, so there is nothing left for the control to guess. A bare
 * number is still seconds, for anyone in the habit of typing one.
 *
 * The document is untouched by any of that. `intervalSeconds` is seconds and is
 * absent at zero, so a factory written before the field spoke units and one written
 * after it are the same file.
 */
function IntervalPick({
  seconds,
  onChange,
}: {
  seconds: number | undefined;
  /** `undefined` at zero, so the field leaves the document rather than sitting at 0. */
  onChange: (next?: number) => void;
}) {
  const value = seconds ?? 0;
  return (
    <Stepper
      value={value}
      min={0}
      max={INTERVAL_SECONDS[INTERVAL_SECONDS.length - 1]!}
      steps={INTERVAL_SECONDS}
      unit="interval"
      // The field says the duration the way everything else says it: `intervalLabel`
      // itself, not a second formatter that would drift from it. `parseDuration`
      // reads that back, and a bare number is still seconds.
      format={intervalLabel}
      parse={parseDuration}
      title={
        value === 0
          ? 'How long the loop waits between turns. Zero is no wait: the next turn opens as soon as the last one ends.'
          : `The loop idles ${intervalLabel(value)} between turns. Taken after a turn, so Start still runs one immediately, and Stop or a message to the loop cuts the wait short.`
      }
      // Zero leaves rather than being written: the two mean the same thing, and a
      // document carrying `intervalSeconds: 0` would be carrying a field to say
      // nothing. The parse reads it back the same way, so this round-trips.
      onChange={(n) => onChange(n > 0 ? n : undefined)}
    />
  );
}

/**
 * Shut a menu when the pointer goes down outside it, or on Escape.
 *
 * Returns the ref to put on the menu's root. Both picks below use it, which is why
 * it is a hook rather than the same effect written twice: they are the same control
 * with different contents, and a dismissal rule that drifted between them would be
 * the kind of difference nobody notices until one of them feels broken.
 *
 * `pointerdown` rather than `click`, so the menu is gone before whatever was clicked
 * behind it reacts. It fires ahead of the native `<summary>` toggle too, which is
 * what makes clicking the *other* menu's summary work: this one shuts on the press,
 * that one opens on the click, and the exclusivity guard in `openPick` sorts out the
 * two toggle events that arrive from it.
 *
 * A press inside the menu is left alone - ticking a checkbox is not leaving, and the
 * whole point of this dropdown is ticking several things before you go.
 *
 * Escape comes along because it is the same gesture by another means, and the folder
 * picker already answers it. Listening only while open keeps both handlers off the
 * document the rest of the time.
 */
function useDismissOnOutside<T extends HTMLElement = HTMLDetailsElement>(
  open: boolean,
  onClose: () => void,
) {
  const root = useRef<T>(null);
  // The latest callback, read at event time. In the dependency list it would
  // re-register both listeners on every render, since every caller passes a fresh
  // arrow - this keeps the effect keyed on the one thing that matters.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return root;
}

/**
 * Whether a loop's grant on one axis is the same answer as the default's.
 *
 * The two shapes differ by one value and this is the whole of the translation: a
 * loop says "everything" by having no field, a default says it with an explicit
 * `null`. Compared as sets, not as arrays, because the two are written by different
 * hands - `ToolsPick` rebuilds in the table's order, a saved default arrives in
 * whatever order it was stored - and a re-ordered list is the same grant.
 *
 * Names are folded for case the way the runner folds them, so a default holding
 * `GitHub` and a loop holding `github` are not offered as a difference to save.
 */
function sameGrant(loop: string[] | undefined, fallback: string[] | null): boolean {
  if (loop === undefined || fallback === null) return loop === undefined && fallback === null;
  if (loop.length !== fallback.length) return false;
  const have = new Set(loop.map((n) => n.toLowerCase()));
  return fallback.every((n) => have.has(n.toLowerCase()));
}

/**
 * A default's tool list resolved to whole rows, in the table's own order.
 *
 * Resolving through the rows rather than filtering the names does three jobs at
 * once. It orders, so a seeded loop reads down the menu the way a hand-narrowed
 * one does. It drops names no checkbox can take off again, which is what a default
 * saved against an older table would otherwise leave stuck on every new loop. And
 * it completes a row from any one of its names, so a default holding `web_fetch`
 * alone arrives as the whole web row - the row is the unit somebody chose, and half
 * of one is not a state the menu can show.
 */
function canonicalTools(tags: string[]): string[] {
  const want = new Set(tags.map((t) => t.toLowerCase()));
  return tagsOf(BUILTIN_TOOLS.filter((r) => r.tags.some((t) => want.has(t.toLowerCase()))));
}

/**
 * The nudge above a loop still carrying the grant it was born with.
 *
 * In the strip above the settings row rather than below it, for the reason the
 * steppers' labels are: `.loop-settings` centres its items, so anything that made
 * one control two rows tall would centre that control's whole self against its
 * neighbours and drop every chip beside it half a line. Out of flow, the row stays
 * one line of aligned chips and the hint hangs over it.
 *
 * Dismissed by a click, and by any move on either grant - see `dismissHint`. No
 * timer: a bubble that removes itself mid-sentence is worse than one that waits.
 *
 * Two buttons, not one. The text is the old answer - "I have read it", good for
 * this loop and this session. `Keep` is the other answer the hint kept asking for
 * and had no button for: "the default is fine, stop telling me". That one is a
 * saved decision and outlives the session; see `keepGrantDefault`. It has to be
 * here because the only other way to make a decision permanent, `Save as default`,
 * is offered only where the loop differs from the default - and a loop that
 * agrees with the default is precisely the loop this hint hangs over.
 */
function GrantHint({
  text,
  onDismiss,
  onKeep,
}: {
  text: string;
  onDismiss: () => void;
  onKeep: () => void;
}) {
  return (
    <span className="grant-strip grant-hint" role="group" aria-label="Grant hint">
      <button
        type="button"
        className="grant-hint-text"
        title="A new loop starts with every tool but subagent, and no MCP servers. Open either list to change it for this loop; click here to dismiss the note for now."
        onClick={onDismiss}
      >
        {text}
      </button>
      <button
        type="button"
        className="grant-hint-keep"
        title="Keep this grant as the default for every new loop and stop showing this note. Saved for you in ~/.kirofactory/grants.json, not for this factory."
        onClick={onKeep}
      >
        Keep
      </button>
    </span>
  );
}

/**
 * Keep this loop's grant as the one new loops start with.
 *
 * Offered only when there is a difference to keep, so the button is absent for the
 * loop that already matches - which makes its presence the answer to "is this
 * different from my default", with nothing to read.
 *
 * Above the chip, in the same out-of-flow strip as the hint, and mutually exclusive
 * with it: see `grantHint`.
 */
function SaveDefault({ what, onSave }: { what: 'tools' | 'servers'; onSave: () => void }) {
  return (
    <button
      type="button"
      className="grant-strip save-default"
      title={`Start every new loop with these ${what}. Kept for you, not for this factory - it applies in every factory you open on this machine.`}
      onClick={onSave}
    >
      Save as default
    </button>
  );
}

/**
 * A grant chip with room above it for the one note that belongs to it.
 *
 * A wrapper exists for a layout reason worth writing down, because the obvious
 * shorter version does not work: the note cannot live inside the `<details>` it is
 * about. Chrome puts every non-`summary` child of a `<details>` inside an implicit
 * `::details-content` box, which has no layout at all while the element is closed -
 * so an absolutely positioned note in there resolves `bottom: 100%` against a height
 * of zero and lands *over* the chip rather than above it, exactly when the menu is
 * shut and the note is the only thing to see. `.mcp-menu` gets away with living in
 * there because it is only ever looked at while the menu is open.
 *
 * So the note is a sibling of the `<details>`, and this box is what both are
 * positioned against. It takes the chip's place as the flex item in the settings row
 * and is the chip's own size, so the row stays one line of aligned chips - the note
 * hangs into the strip `.loop-settings:has(.grant-strip)` reserves above them.
 */
function GrantSlot({ strip, children }: { strip: ReactNode; children: ReactNode }) {
  return (
    <div className="grant-slot">
      {children}
      {strip}
    </div>
  );
}

/**
 * Which MCP servers the loop's agent may load.
 *
 * One dropdown, shaped like the tools one beside it: everything unless you say
 * otherwise. `All servers` is the top entry and the way back to trusting the
 * machine's config; unticking it grants nothing, because the prompt has already
 * said what this loop needs - every server it names with `@` stays ticked - and
 * starting from that is a shorter walk than unticking twenty servers one by one.
 *
 * Which is also why a `@`-named server is ticked and immovable. Naming a tool is
 * asking for it, and a prompt that says `@aws-docs` against an agent that does
 * not have it is a promise broken, so the grant follows the prompt and the
 * checkbox only reports it. Removing the name from the prompt is how you revoke
 * it. Unticking a single server while `All servers` is on pins the rest, which is
 * the one-move way to take away exactly one thing.
 */
function McpScope({
  mcp,
  servers,
  prompt,
  parameters,
  open,
  onOpen,
  onChange,
  hint,
  onDismissHint,
  onKeepHint,
  onSaveDefault,
}: {
  mcp: string[] | undefined;
  servers: McpServer[];
  prompt: string;
  /** The factory's parameters, which claim their names out of the server namespace. */
  parameters: Parameter[];
  /** Open state is owned above, so this menu and the tools one exclude each other. */
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (next?: string[]) => void;
  /**
   * The one-line nudge for a loop still on the shipped grant, or null for nothing.
   *
   * Shown here and covering both grants - see the call site for why this control
   * carries it - so the text names whichever of the two is still unset rather than
   * describing this menu alone.
   */
  hint: string | null;
  onDismissHint: () => void;
  /** The hint's `Keep` - accept the shipped grant as the default, for good. */
  onKeepHint: () => void;
  /**
   * Keep this loop's servers as the default for new ones, or undefined when they
   * already are the default and there is nothing to offer.
   */
  onSaveDefault?: () => void;
}) {
  const all = mcp === undefined;
  const named = namedInPrompt(
    prompt,
    parameters.map((p) => p.name),
  );
  const isNamed = (s: McpServer): boolean => named.has(s.name.toLowerCase());
  const has = (s: McpServer): boolean =>
    all || isNamed(s) || mcp.some((n) => n.toLowerCase() === s.name.toLowerCase());
  const granted = servers.filter(has);
  const set = (server: McpServer, on: boolean): void => {
    const next = servers.filter((s) => (s.name === server.name ? on : has(s)));
    // Everything ticked is the default, and the default is the absence of the
    // field - so re-completing the set returns the loop to trusting the machine.
    onChange(next.length === servers.length ? undefined : next.map((s) => s.name));
  };

  const root = useDismissOnOutside(open, () => onOpen(false));

  return (
    <GrantSlot
      strip={
        hint !== null ? (
          <GrantHint text={hint} onDismiss={onDismissHint} onKeep={onKeepHint} />
        ) : onSaveDefault !== undefined ? (
          <SaveDefault what="servers" onSave={onSaveDefault} />
        ) : null
      }
    >
      <details
        className="mcp-pick"
        ref={root}
        open={open}
        onToggle={(e) => onOpen(e.currentTarget.open)}
      >
        <summary
          title={
            all
              ? "Which MCP servers this loop's agent gets. Every server this machine has enabled, unless narrowed here."
              : "Which MCP servers this loop's agent gets. Only the ticked ones, plus any the prompt names with @."
          }
        >
          MCPs: {all ? 'all' : `${granted.length} of ${servers.length}`}
        </summary>
        <div className="mcp-menu">
          {servers.length === 0 ? (
            <p>No MCP servers are enabled on this machine, so there is nothing to grant.</p>
          ) : (
            <>
              <label
                className="all"
                title={
                  all
                    ? 'Untick to grant nothing but the servers this loop\'s prompt names with @, then add any others it needs.'
                    : 'Tick to go back to loading every server this machine has enabled, including ones added later.'
                }
              >
                <input
                  type="checkbox"
                  checked={all}
                  // Unticking grants nothing: the prompt's `@` names are already
                  // ticked and are the sensible place to start from.
                  onChange={(e) => onChange(e.target.checked ? undefined : [])}
                />
                All servers
              </label>
              {servers.map((s) => {
                const named = isNamed(s);
                // Ticked and fixed for two different reasons, shown the same way:
                // `All servers` grants everything, and a `@`-named server is granted
                // whatever the list says. Either way the row is reporting a grant
                // rather than offering a choice, so it is not the operator's to
                // click - the way to choose individually is to untick All first.
                const fixed = all || named;
                return (
                  <label
                    key={s.name}
                    className={fixed ? 'fixed' : ''}
                    title={
                      named
                        ? 'The prompt names this server with @, so it is granted regardless. Remove it from the prompt to revoke it.'
                        : all
                          ? 'Granted because All servers is ticked. Untick it to choose servers one by one.'
                          : undefined
                    }
                  >
                    <input type="checkbox" checked={has(s)} disabled={fixed} onChange={(e) => set(s, e.target.checked)} />
                    {s.name}
                  </label>
                );
              })}
            </>
          )}
        </div>
      </details>
    </GrantSlot>
  );
}

/**
 * What a loop's agent can be granted, one row per capability, from the built-in
 * tools Kiro documents at kiro.dev/docs/tools.
 *
 * A row is not always one name, and that is the point of the indirection. The
 * `tools` field of an agent config is matched by name, and the names come in two
 * granularities: coarse ones covering a category (`read`, `web`), and the
 * individual tools inside them (`web_search`, `web_fetch`, `glob`, `grep`). Which
 * granularity a given build understands is not something this app can ask it, so
 * a row carries every name that means the capability and lets the agent take the
 * ones it recognises. An unrecognised name is dropped rather than refused - the
 * rest of the list still applies - which is what makes listing both safe.
 *
 * The `web` row is the case that forced this. On the ACP surface the app runs
 * against, `web` alone grants *nothing*: the tools are reached as `web_search`
 * and `web_fetch`, and a loop asking for `web` silently ends up with no web
 * access at all. Listing all three is the only spelling that works either way.
 *
 * The table is capabilities an operator grants a loop, so it stops there. Tools
 * that reach a cloud account belong in a config file rather than behind a tickbox,
 * and the ones an agent uses to run its own turn are not a choice to offer.
 *
 * A hardcoded list, because nothing exposes it at runtime - and the drift risk is
 * contained by how the default works: an unrestricted loop stores nothing and
 * runs on the `@builtin` wildcard, so tools added by a later Kiro arrive without
 * this table knowing about them. Only a narrowed loop pins to these names, and a
 * narrowed loop *should* stay narrow as Kiro grows. If a category is added, the
 * cost is one missing checkbox until this table is updated.
 */
const BUILTIN_TOOLS: readonly { id: string; tags: readonly string[]; what: string }[] = [
  { id: 'read', tags: ['read'], what: 'Reading files and listing directories' },
  { id: 'write', tags: ['write'], what: 'Creating, editing and deleting files' },
  { id: 'search', tags: ['glob', 'grep'], what: 'Finding files by name, and searching inside them' },
  { id: 'code', tags: ['code'], what: 'Code intelligence: symbols, references, AST search and rewrite' },
  { id: 'shell', tags: ['shell'], what: 'Running commands' },
  { id: 'web', tags: ['web', 'web_search', 'web_fetch'], what: 'Searching the web and fetching pages' },
  { id: 'subagent', tags: ['subagent'], what: 'Delegating work to sub-agents' },
  { id: 'knowledge', tags: ['knowledge'], what: 'Searching indexed knowledge bases' },
  { id: 'todo_list', tags: ['todo_list'], what: 'Tracking a task list within a turn' },
  { id: 'introspect', tags: ['introspect'], what: "Looking up Kiro's own documentation" },
];

/** Every name the ticked rows grant, in the table's order. */
function tagsOf(rows: readonly { tags: readonly string[] }[]): string[] {
  return rows.flatMap((r) => [...r.tags]);
}

/**
 * Which built-in tools the loop's agent gets.
 *
 * A dropdown with no gate checkbox, unlike the MCP scope beside it, because the
 * two want opposite shapes: scoping MCP starts from nothing - the blast radius is
 * external - while tools start nearly full (nine of ten rows), so the usual move
 * is one tick either way rather than curating from zero. The dropdown itself
 * is the control: everything ticked stores nothing and the loop runs on
 * whatever kiro-cli ships, so "Tools: all" is genuinely the absence of a
 * setting, not a list that happens to be complete.
 */
function ToolsPick({
  tools,
  open,
  onOpen,
  onChange,
  onSaveDefault,
}: {
  tools: string[] | undefined;
  /** Open state is owned above, so this menu and the MCP one exclude each other. */
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (next?: string[]) => void;
  /**
   * Keep this loop's tools as the default for new ones, or undefined when they
   * already are the default.
   */
  onSaveDefault?: () => void;
}) {
  const all = tools === undefined;
  // Any of a row's names counts as the row being on, so a hand-edited document
  // that named only `web_fetch` reads as the web row rather than as nothing.
  const has = (row: (typeof BUILTIN_TOOLS)[number]): boolean =>
    all || row.tags.some((t) => tools.includes(t));
  const on = BUILTIN_TOOLS.filter(has);
  const set = (row: (typeof BUILTIN_TOOLS)[number], want: boolean): void => {
    const next = BUILTIN_TOOLS.filter((r) => (r.id === row.id ? want : has(r)));
    // Everything ticked is the default, and the default is the absence of the
    // field - so re-completing the set returns the document to clean.
    onChange(next.length === BUILTIN_TOOLS.length ? undefined : tagsOf(next));
  };

  const root = useDismissOnOutside(open, () => onOpen(false));

  return (
    <GrantSlot
      strip={
        onSaveDefault !== undefined ? <SaveDefault what="tools" onSave={onSaveDefault} /> : null
      }
    >
      <details
        className="mcp-pick"
        ref={root}
        open={open}
        onToggle={(e) => onOpen(e.currentTarget.open)}
      >
        <summary title="Which built-in tools this loop's agent gets. All of them unless narrowed here.">
          Tools: {all ? 'all' : `${on.length} of ${BUILTIN_TOOLS.length}`}
        </summary>
        <div className="mcp-menu">
          {BUILTIN_TOOLS.map((t) => (
            <label key={t.id} title={t.what}>
              <input type="checkbox" checked={has(t)} onChange={(e) => set(t, e.target.checked)} />
              {t.id}
            </label>
          ))}
        </div>
      </details>
    </GrantSlot>
  );
}

/**
 * A browse list of skills or steering files, where clicking a row writes the
 * `@name` into the prompt.
 *
 * In the grant lists' clothes - the same `details.mcp-pick` chrome as the MCP and
 * tools menus beside it, so the settings row reads as one family - but with no
 * checkboxes and no gate, because there is nothing to grant: kiro-cli already
 * loads every skill and steering file it finds, and naming one only tells this
 * loop to actually use it. A row is a fact about the machine plus an action on
 * the prompt, so it is a button, not a checkbox.
 *
 * One component worn twice. `SkillsPick` and `SteeringPick` below differ only in
 * their words, their token colour and which names outrank theirs in the `@`
 * namespace - a `kind` switch inside would have been the same information stated
 * less directly.
 */
function ResourcePick({
  label,
  tooltip,
  empty,
  cls,
  rows,
  named,
  open,
  onOpen,
  onInsert,
}: {
  /** The summary's first word: `Skills` or `Steering`. */
  label: string;
  /** The one-line model of what these are, on the summary. */
  tooltip: string;
  /** What the menu says when nothing is installed. */
  empty: string;
  cls: 'tok-skill' | 'tok-steer';
  rows: { name: string; hint: string }[];
  /** Lowercased names the prompt already references, shadowing applied above. */
  named: Set<string>;
  /** Open state is owned above, so the four settings menus exclude each other. */
  open: boolean;
  onOpen: (open: boolean) => void;
  onInsert: (name: string) => void;
}) {
  const root = useDismissOnOutside(open, () => onOpen(false));
  const count = rows.filter((r) => named.has(r.name.toLowerCase())).length;
  // Three shapes, not a template with zeroes in it: `none` reads as an answer
  // where `0 named of 0` reads as a malfunction.
  const summary =
    rows.length === 0
      ? `${label}: none`
      : count === 0
        ? `${label}: none of ${rows.length}`
        : `${label}: ${count} named of ${rows.length}`;

  return (
    <details
      className="mcp-pick"
      ref={root}
      open={open}
      onToggle={(e) => onOpen(e.currentTarget.open)}
    >
      <summary title={tooltip}>{summary}</summary>
      <div className="mcp-menu">
        {rows.length === 0 ? (
          <p>{empty}</p>
        ) : (
          rows.map((r) => {
            const referable = NAME_ONLY.test(r.name);
            const isNamed = named.has(r.name.toLowerCase());
            return (
              <button
                key={r.name}
                type="button"
                /*
                 * Dimmed rather than hidden when the name cannot be written after
                 * `@`, and named rows keep their look but lose their action:
                 * removing a reference is editing the prompt, where the reference
                 * lives, so the row has nothing to offer but the fact.
                 */
                className={`res-row${referable ? '' : ' unref'}`}
                aria-disabled={!referable || isNamed}
                title={
                  !referable
                    ? `"${r.name}" cannot be referenced as written: a name has to start with a letter or digit and hold only letters, digits, - and _.`
                    : isNamed
                      ? `The prompt already names @${r.name}. Remove the reference there to unname it.`
                      : `Insert @${r.name} into the prompt, at the caret.`
                }
                onClick={() => {
                  if (referable && !isNamed) onInsert(r.name);
                }}
              >
                <code className={cls}>@{r.name}</code>
                {r.hint.length > 0 && <span className="res-hint">{r.hint}</span>}
                {isNamed && (
                  <span className="res-tick" aria-label="Named in the prompt">
                    &#10003;
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </details>
  );
}

/**
 * The skills this machine and the factory's directory carry.
 *
 * The claimed set is what keeps the tick honest: a skill whose name a parameter
 * or an MCP server owns is not "named" however often its token appears, because
 * the token means the parameter or the server - the same precedence `classOf`
 * colours by and `namedIn` matches by server-side.
 */
function SkillsPick({
  skills,
  prompt,
  parameters,
  servers,
  open,
  onOpen,
  onInsert,
}: {
  skills: Skill[];
  prompt: string;
  parameters: Parameter[];
  servers: McpServer[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onInsert: (name: string) => void;
}) {
  return (
    <ResourcePick
      label="Skills"
      tooltip="Skills this machine and project carry. kiro-cli loads them for every loop; naming one with @ tells this loop to actually use it."
      empty="No skills are installed on this machine or in this factory's directory, so there is nothing to name."
      cls="tok-skill"
      rows={skills.map((s) => ({ name: s.name, hint: shortValue(s.description) }))}
      named={namedInPrompt(prompt, [
        ...parameters.map((p) => p.name),
        ...servers.map((s) => s.name),
      ])}
      open={open}
      onOpen={onOpen}
      onInsert={onInsert}
    />
  );
}

/**
 * The steering files this machine and the factory's directory carry.
 *
 * Skills join the claimed set here - a steering file loses its name to a skill,
 * per the namespace's fixed order - which is the one line that distinguishes this
 * from `SkillsPick` beyond the words.
 */
function SteeringPick({
  steeringFiles,
  skills,
  prompt,
  parameters,
  servers,
  open,
  onOpen,
  onInsert,
}: {
  steeringFiles: SteeringFile[];
  skills: Skill[];
  prompt: string;
  parameters: Parameter[];
  servers: McpServer[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onInsert: (name: string) => void;
}) {
  return (
    <ResourcePick
      label="Steering"
      tooltip="Steering rules this machine and project carry. kiro-cli already keeps them in every loop's context; naming one with @ tells this loop to hold them front of mind."
      empty="No steering files exist on this machine or in this factory's directory, so there is nothing to name."
      cls="tok-steer"
      rows={steeringFiles.map((s) => ({
        name: s.name,
        // The servers' convention: only the workspace ones are labelled, being
        // the ones that change when the factory moves.
        hint: s.scope === 'workspace' ? 'workspace' : '',
      }))}
      named={namedInPrompt(prompt, [
        ...parameters.map((p) => p.name),
        ...servers.map((s) => s.name),
        ...skills.map((s) => s.name),
      ])}
      open={open}
      onOpen={onOpen}
      onInsert={onInsert}
    />
  );
}

/**
 * What the loop runs on.
 *
 * Real models only: a loop that has not chosen shows the machine's default
 * *selected*, rather than a synthetic "default" entry above the list. The two
 * would say the same thing, and one of them is a model you can point at - the
 * picker then always answers "which model", never "none chosen", which is also
 * what the card says beside the loop's name.
 *
 * So the document keeps its distinction - no field means follow the default,
 * which is what a shared or exported loop wants - and the UI stops showing it.
 * Picking the default explicitly writes it, which is harmless: the loop runs on
 * the same model, and it stops following if the machine default ever changes,
 * which is a fair reading of having picked it by name.
 *
 * Hidden when the catalogue is genuinely empty and no model is pinned: there is
 * nothing to choose between, and loops run fine without the control.
 *
 * Shown, disabled, with a retry when discovery *failed*. The two used to look the
 * same, and that was the bug: a probe that timed out or hit an expired login left no
 * picker at all, which reads as the feature having been removed rather than as
 * something to fix. Vagueness was the objection to showing a failed picker, so this
 * one is not vague - it names the failure in its tooltip and offers the retry.
 *
 * A pinned model the catalogue does not list is kept as an extra option rather than
 * silently dropped - the document may have come from a machine with a wider
 * subscription, and the honest thing is to show what is set.
 */
function ModelPicker({
  model,
  catalog,
  onRetry,
  onChange,
}: {
  model: string | undefined;
  catalog: ModelCatalog;
  onRetry: () => void;
  onChange: (next?: string) => void;
}) {
  if (catalog.failed === true && model === undefined) {
    return (
      <button
        className="model-pick failed"
        onClick={onRetry}
        title={`Could not read the model list: ${catalog.reason ?? 'unknown'}. Loops run on this machine's default. Click to try again.`}
        aria-label="Model list unavailable, click to retry"
      >
        Models unavailable
      </button>
    );
  }
  if (catalog.models.length === 0 && model === undefined) return null;
  const showing = model ?? catalog.defaultId ?? '';
  const unknown = showing.length > 0 && !catalog.models.some((m) => m.id === showing);
  return (
    <select
      className={`model-pick${model === undefined ? ' inherited' : ''}`}
      value={showing}
      title={
        model === undefined
          ? 'Which model this loop runs on. Following this machine\'s default until you pick one.'
          : 'Which model this loop runs on'
      }
      aria-label="Model"
      onChange={(e) => onChange(e.target.value)}
    >
      {catalog.models.map((m) => (
        <option key={m.id} value={m.id} title={m.description}>
          {m.name}
        </option>
      ))}
      {unknown && <option value={showing}>{showing} (not on this machine)</option>}
    </select>
  );
}

/* --------------------------------------------------------------- the library */

/**
 * How wide the popover is, for clamping it inside the window.
 *
 * The stylesheet fixes `.libpick-pop` to exactly this, and that is the point: the
 * clamp has to know the width, and measuring the element means placing it, seeing how
 * wide it came out and placing it again.
 */
const LIB_WIDTH = 660;

/** Margin kept between the popover and the edge of the window. */
const LIB_MARGIN = 16;

/**
 * Take something out of the library: a loop, a cluster, or a whole factory.
 *
 * This was a native `<select>` with two `<optgroup>`s, and the third category is what
 * ended that. A select is as wide as its widest option, so it could only ever show
 * names - no descriptions, no sizes, nothing to choose on - and it cannot hold a
 * search box at all. Three groups and a growing collection made both of those the
 * binding constraint rather than an acceptable trade, so this is a popover built like
 * `FolderPicker`: the same trigger, the same type-to-filter row, the same dismissal.
 *
 * Three columns rather than three stacked sections. Each list is short on its own -
 * a handful of loops, fewer clusters, fewer factories still - and side by side the
 * whole library is one glance with no scrolling, which is what makes "what have I
 * got" answerable. Stacked, the factories would sit below the fold of a list that is
 * mostly loops, and a category you have to scroll to find is a category nobody uses.
 *
 * Empty columns keep their heading and say so. The alternative is a layout that
 * reflows as the filter narrows - two columns, then one, then two again - and a
 * popover whose geometry moves while you type is one you cannot aim at.
 *
 * Loops and clusters land on this canvas. A factory cannot: it *is* a canvas, so it
 * leaves through `onPickFactory` and comes back as its own tab.
 */
function LibraryPicker({
  library,
  onPick,
  onPickFactory,
}: {
  library: LibraryIndex;
  onPick: (entry: LoopEntry) => void;
  /** By slug: the server reads the entry, so the graph never round-trips the browser. */
  onPickFactory: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /**
   * Type-to-filter across all three columns at once.
   *
   * One box rather than one per column, because the question it answers is "where is
   * the thing called reader" and the answer includes which category it turned out to
   * be in. Three boxes would make you know that first, which is the thing you came
   * here to find out.
   */
  const [filter, setFilter] = useState('');
  const root = useDismissOnOutside<HTMLDivElement>(open, () => setOpen(false));
  const [alignRight, setAlignRight] = useState(false);

  // Measured before the popover renders, so it appears on the correct side the first
  // time rather than jumping there. The filter starts empty on every open: it narrowed
  // a list you have since walked away from.
  useEffect(() => {
    if (!open) return;
    const anchor = root.current?.getBoundingClientRect();
    if (anchor) setAlignRight(anchor.left + LIB_WIDTH > window.innerWidth - LIB_MARGIN);
    setFilter('');
  }, [open, root]);

  const q = filter.trim().toLowerCase();
  /*
   * Name, description and tags. The description because it is the line an entry was
   * written to be chosen on, and the tags because they are the only reason to add one
   * - a tag nobody can search is a tag doing nothing.
   */
  const match = (e: LoopEntry | FactoryEntry): boolean =>
    q === '' ||
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.tags.some((t) => t.toLowerCase().includes(q));

  const loops = library.loops.filter(match);
  const clusters = library.clusters.filter(match);
  const factories = library.factories.filter(match);
  const total = library.loops.length + library.clusters.length + library.factories.length;
  const shown = loops.length + clusters.length + factories.length;
  const empty = total === 0;

  const label = empty
    ? 'Nothing in the library yet. Save a loop, a cluster or a factory and it appears here.'
    : 'Take a loop, a cluster or a factory out of the library';

  return (
    <div className="libpick" ref={root}>
      <button
        className="with-icon"
        disabled={empty}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="hero-bookmark-square" />
        Library
      </button>

      {open && (
        <div
          className={`libpick-pop${alignRight ? ' align-right' : ''}`}
          role="dialog"
          aria-label="The library"
        >
          {/*
            The same filter row the folder picker uses, down to the class names. Two
            popovers in one app that both narrow a list by typing should not be two
            different experiences, and Escape behaves the same way in both: it clears
            the filter first and closes second.
          */}
          <div className="picker-filter">
            <Icon name="hero-magnifying-glass" />
            <input
              autoFocus
              value={filter}
              placeholder="Type to filter"
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter !== '') {
                  setFilter('');
                  e.stopPropagation();
                }
              }}
            />
            {/* How much of the library the filter is hiding. Only while it is hiding
                any: a count that says 6 of 6 is noise on a row you are typing into. */}
            {q !== '' && (
              <span className="libpick-count">
                {shown} of {total}
              </span>
            )}
          </div>

          <div className="libpick-cols">
            <LibraryColumn
              title="Loops"
              empty="No loops yet."
              entries={loops}
              onPick={(e) => {
                onPick(e as LoopEntry);
                setOpen(false);
              }}
            />
            <LibraryColumn
              title="Clusters"
              empty="No clusters yet."
              entries={clusters}
              onPick={(e) => {
                onPick(e as LoopEntry);
                setOpen(false);
              }}
            />
            <LibraryColumn
              title="Factories"
              empty="No factories yet."
              entries={factories}
              onPick={(e) => {
                onPickFactory(e.slug);
                setOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One column of the library: a heading, a count, and the entries under it.
 *
 * One component for all three because the three are the same list of the same shape
 * with different consequences on click, and the consequence is the caller's business.
 * What each entry *is* still shows through: a cluster says how many nodes it arrives
 * as and a factory how many loops it brings, because those are the facts you want
 * before picking rather than after.
 */
function LibraryColumn({
  title,
  empty,
  entries,
  onPick,
}: {
  title: string;
  /** Shown in place of the list. The column keeps its heading either way. */
  empty: string;
  entries: (LoopEntry | FactoryEntry)[];
  onPick: (entry: LoopEntry | FactoryEntry) => void;
}) {
  return (
    <div className="libpick-col">
      <div className="libpick-head">
        {title}
        {entries.length > 0 && <span className="libpick-n">{entries.length}</span>}
      </div>
      <div className="libpick-list">
        {entries.map((entry) => {
          // What this entry arrives as, when that is more than one thing. A plain loop
          // says nothing: one session is the unmarked case, and a badge reading "1"
          // on every loop in the column would be a column of badges saying nothing.
          const size =
            entry.kind === 'factory'
              ? `${entry.loops.length} loop${entry.loops.length === 1 ? '' : 's'}`
              : entry.kind === 'cluster'
                ? `${entry.cluster!.size} nodes`
                : '';
          return (
            <button
              key={entry.slug}
              className="libpick-entry"
              title={
                entry.description.length > 0
                  ? `${entry.description}${size === '' ? '' : `\n\n${size}`}`
                  : size
              }
              onClick={() => onPick(entry)}
            >
              <span className="libpick-name">
                {entry.name}
                {size !== '' && <span className="libpick-size">{size}</span>}
              </span>
              {/*
                The description, on its own line and clipped to one.
                
                This is what the select could never show, and it is the thing an entry
                is chosen on - the name is an identifier and the description is the
                sentence that says whether you want it. One line because the column is
                a list you scan; the whole of it is on the tooltip, and the prompt
                itself is one click away in the panel.
              */}
              {entry.description.length > 0 && (
                <span className="libpick-desc">{entry.description}</span>
              )}
            </button>
          );
        })}
        {entries.length === 0 && <p className="libpick-empty">{empty}</p>}
      </div>
    </div>
  );
}

/**
 * Keep this loop in the library.
 *
 * Icon only, and small. It is not one of the things you came to this panel to do -
 * you came to write a prompt - and it earns its place by being there at the moment
 * a prompt starts working rather than by being large enough to compete with the
 * name beside it.
 *
 * The confirmation is the button itself becoming a tick for a second. A loop is
 * saved by writing a file into your checkout, so the durable confirmation is
 * `git status`; this only has to say the request landed.
 */
function SaveToLibrary({
  loop,
  onSaved,
  onError,
}: {
  loop: Loop;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const timer = useRef(0);

  // The panel keeps this mounted across selections, so a tick left over from the
  // last loop would otherwise claim this one had been saved too.
  useEffect(() => {
    setSaved(false);
    window.clearTimeout(timer.current);
  }, [loop.id]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const writable = loop.prompt.trim().length > 0;
  // Named for what it is, in the tooltip and in the label a screen reader reads.
  // The button saves a component, and a cluster told "save this loop" would be
  // describing the entry wrongly - the shape goes into the file with the prompt.
  const kind = loop.cluster ? 'cluster' : 'loop';

  return (
    <button
      className={`icon-only${saved ? ' saved' : ''}`}
      disabled={!writable}
      title={
        writable
          ? // Where the file lands is in the README and in `git status` a moment
            // later. A tooltip is read in the half-second before a click, so it
            // gets the action and nothing about the mechanism.
            `Save this ${kind} to the library`
          : `A ${kind} with an empty prompt has nothing to share`
      }
      aria-label={`Save this ${kind} to the library`}
      onClick={() => {
        void api
          .saveToLibrary({
            name: loop.name,
            prompt: loop.prompt,
            // The cluster's shape, when it is one. What the prompt was written for
            // is part of the prompt: a loop written for a ring of five reading each
            // other's lines does something else entirely on its own.
            ...(loop.cluster ? { cluster: loop.cluster } : {}),
          })
          .then(() => {
            setSaved(true);
            onSaved();
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setSaved(false), 1600);
          })
          .catch((e: Error) => onError(e.message));
      }}
    >
      <Icon name={saved ? 'hero-check' : 'hero-bookmark-square'} />
    </button>
  );
}

/**
 * Turn a loop into a cluster, and a cluster back into a single loop.
 *
 * One button rather than two, because there is one question here - how many sessions
 * is this component - and the answer is a toggle. The glyph names the destination
 * rather than the current state, so it reads as the thing a click will do: three
 * joined nodes on a loop, the loop's circular arrows on a cluster.
 *
 * On the way in the shape is `NEW_CLUSTER`, the same defaults the toolbar's `Loop
 * cluster` starts from. On the way out it is dropped rather than remembered: a loop
 * *is* the absence of a cluster - see `Loop.cluster` - so there is nowhere in the
 * document to park a size for a component that is not a cluster, and converting back
 * and forth therefore returns the defaults rather than what you had. The panel's own
 * controls are one row away, and a conversion is not the place to be clever.
 *
 * Only while the component is stopped, and this is the one control on the panel that
 * is not live. Everything else here - the size, the model, the tool scope - is a
 * setting a running loop picks up on its next turn. This is not a setting: runners are
 * keyed per member, so changing how many members there are changes every key, and the
 * host retires whichever sessions the new document no longer names. Converting a
 * running component would therefore stop it, and it would stop it as a side effect of
 * a button that says nothing about stopping. A turn in flight has claimed an item off
 * a queue and not yet written what it did with it, which is exactly the work Stop
 * exists to let finish.
 *
 * So it greys out, and the tooltip says which button to press first. Refusing is the
 * honest version of a thing this button cannot do without doing something else as
 * well.
 */
function ConvertKind({
  loop,
  running,
  onConvert,
}: {
  loop: Loop;
  running: boolean;
  onConvert: (cluster: Cluster | undefined) => void;
}) {
  const toCluster = loop.cluster === undefined;
  const label = toCluster ? 'Convert to a cluster' : 'Convert to a single loop';
  return (
    <button
      className="icon-only"
      disabled={running}
      title={
        running
          ? // Named as what it is rather than as "this component", because the word
            // is the thing the operator is looking at and Stop is on its card.
            `Stop this ${toCluster ? 'loop' : 'cluster'} before converting it`
          : label
      }
      aria-label={label}
      onClick={() => onConvert(toCluster ? { ...NEW_CLUSTER } : undefined)}
    >
      <Icon name={toCluster ? 'cluster' : 'hero-arrow-path'} />
    </button>
  );
}

/**
 * Where this factory runs.
 *
 * The directory is the agents' working directory, so it is shown rather than
 * buried in a settings dialog: it is the single most consequential thing about a
 * factory, and the loops in it can write anywhere below it.
 *
 * Only the directory. Import and Export used to be split across this bar and the
 * tab strip, one in each, which put the two halves of the same idea - a factory as
 * a file, moving between machines - in two different places. They are together in
 * the strip now, beside the tabs they open and save, and this line is about the
 * folder: what it is, and the button that goes and finds it.
 */
function BaseDirBar({
  baseDir,
  running,
  git,
  parameters,
  servers,
  resources,
  onChange,
  onParameters,
  onOpenFactory,
  onBranchOff,
}: {
  baseDir: string;
  running: boolean;
  /** What git makes of the directory, or null before the first answer. */
  git: GitState | null;
  /** The factory's parameters, edited in the panel this bar folds open. */
  parameters: Parameter[];
  /** Only to warn when a parameter takes a name a server already answers to. */
  servers: McpServer[];
  /** Same warning, other kinds: a parameter can shadow a skill or steering file. */
  resources: FactoryResources;
  onChange: (dir: string) => void;
  onParameters: (next: Parameter[]) => void;
  /** Open the factory found in another directory, as its own tab. */
  onOpenFactory: (dir: string) => void;
  /** Branch off into a worktree and move there. */
  onBranchOff: () => void;
}) {
  const [draft, setDraft] = useState(baseDir);
  /**
   * Whether the parameters panel is folded open. Local, and deliberately not saved.
   *
   * It is a way of looking at the bar rather than a property of the factory, and it
   * costs one click to get back. A document that remembered it would be a document
   * that differs between two people looking at the same factory.
   */
  const [open, setOpen] = useState(false);

  // The field follows the factory when the server changes it - on load, or after a
  // move that the server relocated - but not while you are mid-edit in it.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(baseDir);
  }, [baseDir]);

  // Deleting the last parameter takes the panel and its arrow away, so the fold
  // state has to go with them - otherwise adding one again would open a panel the
  // operator never asked to open.
  const count = parameters.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  /**
   * Add a parameter, and show it.
   *
   * Opening the panel is the whole point of the click: a row added into a folded
   * panel is a row nobody can see, and the next thing anyone wants to do with a new
   * parameter is name it. The name starts valid and unique rather than blank, so the
   * row is a real parameter from the first render and the invalid-name path is
   * somewhere you can only get to deliberately.
   */
  function add(): void {
    const taken = new Set(parameters.map((p) => p.name.toLowerCase()));
    let name = 'param';
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `param${n}`;
    onParameters([...parameters, { name, value: '' }]);
    setOpen(true);
  }

  const label = open ? 'Hide the parameters' : 'Show the parameters';

  return (
    <>
    <div className={`dirbar${open ? ' params-open' : ''}`}>
      <Icon name="hero-folder" className="dirbar-icon" />
      <span className="dirbar-label">Runs in</span>
      {/*
        The name a prompt uses for this directory, shown where the directory is.

        The bar is the one place both halves of `@project` are visible at once - the
        token and the path it stands for - so it is where the token can be learned
        without being explained. An operator who has seen this line once knows what
        to write, and knows which directory it will land in.

        Not a button. The prompt box's own `@` menu is where you insert one, beside
        `@input` and the tools; this is the definition, not a second way to type it.
      */}
      <code
        className="dirbar-token"
        title={`Write @project in a loop's prompt to mean this directory${
          baseDir.length > 0 ? `: ${baseDir}` : ''
        }.\n\n@loop is the other one - a loop's own folder for scratch and notes, under /.kirofactory/loops/.`}
      >
        @project
      </code>
      <input
        className="dirbar-path"
        value={draft}
        spellCheck={false}
        placeholder="/path/to/your/project"
        title={
          running
            ? 'Changing this stops the running loops first, so no turn finishes into a directory the factory has left'
            : 'The working directory for every loop in this factory'
        }
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          onChange(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(baseDir);
            e.currentTarget.blur();
          }
        }}
      />
      <code className="dirbar-internal" title="Queues, loop folders and this factory's document live here">
        /.kirofactory
      </code>
      {/*
        What git makes of this directory, and the one control that changes it.
        
        On the bar permanently rather than tucked into a panel, because it is the other
        half of what this line is already for. The path says where the loops write; this
        says whether any of it can be undone. The loops hold a shell
        and no human approves anything mid-run, so "is this version controlled" is not a
        detail - it is the difference between a run you can walk away from and one you
        cannot, and it should be visible before you press start rather than discovered
        after.
        
        Three states, and they are the three a directory can be in: see `GitState`.
      */}
      <GitBadge git={git} running={running} onBranchOff={onBranchOff} />
      {/*
        Beside the field, not in place of it. Typing a path is still the fastest way
        in when you know it - pasting one especially - and the picker is for when you
        do not. It starts from whatever the field holds, so the two are one control.
      */}
      {/*
        Two answers, because walking to a folder that already holds a factory used to
        be a dead end: the listing marked it, and the only button available was the
        one the server refuses. Now the same walk ends in either move-here or
        open-that-one, and the picker offers whichever the folder supports.
      */}
      <FolderPicker current={baseDir} onPick={onChange} onOpenFactory={onOpenFactory} />
      {/*
        The show-the-files button that lived here is gone deliberately: the file
        panel now rests on the project view, so "point the panel at the project"
        stopped being a job. Opening the panel belongs to its own fold arrow.
      */}
      {/*
        The parameters, on the same bar and behind a separator.

        Here because this bar is already where a prompt's vocabulary is defined next
        to the thing it stands for: `@project` sits beside the path it resolves to,
        and `@topic` sits beside the value it resolves to. An operator who has read
        this line once knows both halves of both.

        Behind a separator because they answer a different question. Everything left
        of it is *where* the loops run; this is *what with*, and the two sharing a row
        without a break would read as one setting in five parts.
      */}
      <span className="dirbar-sep" />
      {count > 0 && (
        <button
          className="dirbar-params-chip"
          title={`${count} parameter${count === 1 ? '' : 's'} - ${label.toLowerCase()}`}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {/*
            The names, in the colour a prompt will show them in. Three at most: this
            is a glance at what the factory takes, not the list - the list is one
            click below, and a bar that grew with the eighth parameter would push the
            path field out of the window.
          */}
          {parameters.slice(0, 3).map((p) => (
            <code key={p.name} className="tok-param">
              @{p.name}
            </code>
          ))}
          {count > 3 && <span className="dirbar-params-more">+{count - 3}</span>}
        </button>
      )}
      <button
        className="icon-only"
        title="Add a parameter - a named value the prompts here can write as @name"
        aria-label="Add a parameter"
        onClick={add}
      >
        <Icon name="hero-tag" />
      </button>
    </div>

    {/*
      The parameters themselves, folding out of the bar above.

      Always mounted while there is at least one, and folded with `max-height` rather
      than unmounted, because the fold is the thing being animated: a panel that
      leaves the tree has nothing to transition from. It goes when the last parameter
      does, which is also when the arrow goes.
    */}
    {count > 0 && (
      <div className={`dirbar-params${open ? ' open' : ''}`} id="factory-parameters">
        <div className="dirbar-params-list">
          {parameters.map((p, i) => (
            <ParamRow
              key={i}
              param={p}
              others={parameters.filter((_, n) => n !== i)}
              servers={servers}
              resources={resources}
              onChange={(next) =>
                onParameters(parameters.map((q, n) => (n === i ? next : q)))
              }
              onRemove={() => onParameters(parameters.filter((_, n) => n !== i))}
            />
          ))}
        </div>
      </div>
    )}

    {/*
      The fold, borrowed from kiro-flock's single cluster view.

      One glyph, rotated rather than swapped: `⌃` points down when there is something
      to open and up when it is open, which reads as the direction the panel will
      travel rather than as its current state. It is pulled up by its own margin and
      painted in the page background so it sits *in* the bar's bottom border rather
      than under it - the notch is what makes it look like part of the bar instead of
      a button parked below one.

      After the panel in the DOM on purpose: the same negative margin then lands on
      whichever border is above it, the bar's when closed and the panel's when open,
      so one rule covers both states.
    */}
    {count > 0 && (
      <button
        className={`dirbar-fold${open ? ' open' : ''}`}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls="factory-parameters"
        onClick={() => setOpen((was) => !was)}
      >
        {/* Decorative: the button is already labelled, and a screen reader reading
            the raw arrowhead character would be reading punctuation. */}
        <span aria-hidden="true">&#8963;</span>
      </button>
    )}
    </>
  );
}

/**
 * One parameter: its name, its value, and what it is for.
 *
 * The name is held in a draft and committed on blur, the way the path field above it
 * is, and for a sharper version of the same reason. A half-typed path is a different
 * directory; a half-typed name is a *different parameter*, so committing per
 * keystroke would rename `@topic` to `@t` and then `@to` and leave every prompt
 * mentioning it pointing at nothing along the way.
 *
 * Invalid names are reverted rather than refused with a message. A name has to be
 * writable as `@name` to be reachable at all, and the server's parse drops one that
 * is not - so a row left holding `my topic` would look saved and be gone on reload.
 * Typing is sanitised as it goes, which handles almost everything, and the blur
 * revert catches the two cases sanitising cannot: a name that collides with another
 * parameter, and one of the four reserved words the prompt defines for itself.
 *
 * The value commits per keystroke, because it is free text with no invalid state and
 * the save is debounced anyway.
 */
function ParamRow({
  param,
  others,
  servers,
  resources,
  onChange,
  onRemove,
}: {
  param: Parameter;
  /** The factory's other parameters, so a rename cannot land on one of their names. */
  others: Parameter[];
  servers: McpServer[];
  /** Skills and steering files, which a parameter's name can shadow the same way. */
  resources: FactoryResources;
  onChange: (next: Parameter) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(param.name);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setName(param.name);
  }, [param.name]);

  const taken = new Set(others.map((p) => p.name.toLowerCase()));
  const valid =
    NAME_ONLY.test(name) && !RESERVED.has(name.toLowerCase()) && !taken.has(name.toLowerCase());

  /*
   * A server, skill or steering file of the same name is shadowed, and that is
   * worth saying out loud.
   *
   * Allowed, because parameters winning their name is the rule and a factory should
   * not be blocked by what happens to be in someone's mcp.json or `.kiro/`. But
   * `@github` in a prompt will substitute a value instead of granting the github
   * server, which is not what anyone writing it would assume - so the row says so
   * where the name is being chosen, which is the only moment the choice is cheap.
   *
   * Only the highest-precedence casualty is named: without the parameter the token
   * would have resolved to that one, so it is the meaning actually being taken,
   * and one badge saying one true thing beats three saying overlapping ones.
   */
  const lower = param.name.toLowerCase();
  const owns = (s: { name: string }): boolean => s.name.toLowerCase() === lower;
  const shadowed =
    servers.find(owns) ?? resources.skills.find(owns) ?? resources.steeringFiles.find(owns);
  const shadowedKind = servers.some(owns)
    ? 'a tool'
    : resources.skills.some(owns)
      ? 'a skill'
      : 'steering';

  return (
    <div className="param-row">
      <code className="param-at">@</code>
      <input
        className={`param-name${valid ? '' : ' invalid'}`}
        value={name}
        spellCheck={false}
        aria-label="Parameter name"
        title={
          valid
            ? 'The name a prompt writes after @. Letters, digits, - and _.'
            : RESERVED.has(name.toLowerCase())
              ? `@${name} is part of the prompt's own vocabulary, so it cannot be a parameter.`
              : taken.has(name.toLowerCase())
                ? 'Another parameter already has this name.'
                : 'A name has to start with a letter or digit and hold only letters, digits, - and _.'
        }
        onFocus={() => {
          focused.current = true;
        }}
        /*
         * Sanitised as it is typed rather than validated after. The alternative is a
         * field that accepts `my topic`, goes red, and has to be argued with; this
         * one simply cannot hold a name that is not a name, and the hyphen appearing
         * under the cursor teaches the rule faster than the tooltip does.
         */
        onChange={(e) =>
          setName(
            e.target.value
              .replace(/[^A-Za-z0-9_-]+/g, '-')
              .replace(/^[^A-Za-z0-9]+/, '')
              .slice(0, 40),
          )
        }
        onBlur={() => {
          focused.current = false;
          if (valid && name !== param.name) onChange({ ...param, name });
          else if (!valid) setName(param.name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setName(param.name);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="param-eq">=</span>
      <input
        className="param-value"
        value={param.value}
        spellCheck={false}
        /*
         * Named as what an empty one does rather than left blank. An unset parameter
         * is not neutral: the prompt keeps the token instead of the value, and the
         * agent is told it is a gap. Saying so here is cheaper than finding out from
         * a turn.
         */
        placeholder="not set - prompts keep the @name until it has a value"
        aria-label={`Value of @${param.name}`}
        title={`What @${param.name} becomes in every prompt in this factory.`}
        onChange={(e) => onChange({ ...param, value: e.target.value })}
      />
      <input
        className="param-desc"
        value={param.description ?? ''}
        spellCheck={false}
        placeholder="what it is for"
        aria-label={`What @${param.name} is for`}
        title="Carried into the prompt beside the value, and into the document for whoever inherits the factory."
        onChange={(e) => {
          const description = e.target.value;
          const { description: _old, ...rest } = param;
          onChange(description.trim().length > 0 ? { ...rest, description } : rest);
        }}
      />
      {shadowed && (
        <span
          className="param-shadow"
          title={
            shadowedKind === 'a tool'
              ? `There is also an MCP server called ${shadowed.name}. A parameter wins its name, so @${shadowed.name} in a prompt will be replaced by this value rather than granting that server. Rename the parameter if you meant the tool.`
              : shadowedKind === 'a skill'
                ? `There is also a skill called ${shadowed.name}. A parameter wins its name, so @${shadowed.name} in a prompt will be replaced by this value rather than pointing at that skill. Rename the parameter if you meant the skill.`
                : `There is also a steering file called ${shadowed.name}. A parameter wins its name, so @${shadowed.name} in a prompt will be replaced by this value rather than naming those rules. Rename the parameter if you meant the steering.`
          }
        >
          <Icon name="hero-wrench" />
          shadows {shadowedKind}
        </span>
      )}
      <button
        className="danger icon-only"
        title={`Delete @${param.name}`}
        aria-label={`Delete @${param.name}`}
        onClick={onRemove}
      >
        <Icon name="hero-trash" />
      </button>
    </div>
  );
}

/**
 * Whether the loops are working somewhere version controlled, and where that leads.
 *
 * One badge with three faces, and the shape of it follows from the three states
 * being genuinely different situations rather than three values of one setting:
 *
 *   not a repository - a warning, and nothing to press. Whatever the loops do here
 *                      is not recoverable, and the fix is `git init`, which is not
 *                      this app's to run: initialising someone's directory as a side
 *                      effect of them looking at a badge would be worse than saying
 *                      so plainly.
 *   a checkout       - the branch, and the offer to branch off. The loops are working
 *                      in the same tree and on the same branch as you are, which is
 *                      fine as long as it was a choice.
 *   a worktree       - the branch, and no offer, because this is what the offer
 *                      leads to. The main checkout is named in the tooltip, since a
 *                      worktree's whole point is the one it came from.
 *
 * There is no un-branch-off button. Pointing the factory back at the main checkout is
 * the field two controls to the left, and removing the worktree deletes the queues in
 * it - a thing to do deliberately in a terminal, not a thing to offer beside a path.
 */
function GitBadge({
  git,
  running,
  onBranchOff,
}: {
  git: GitState | null;
  running: boolean;
  onBranchOff: () => void;
}) {
  // Nothing at all until the answer arrives. A badge that says "not versioned" for
  // the length of a round trip and then corrects itself is worse than a gap.
  if (git === null) return null;

  if (git.kind === 'none') {
    return (
      <span
        className="dirbar-git none"
        title={`${git.reason ?? 'Not a git repository'}. The loops hold a shell, so nothing they do in here can be undone. Run git init if you want that to be recoverable.`}
      >
        <Icon name="branch" />
        not versioned
      </span>
    );
  }

  const worktree = git.kind === 'worktree';
  const label = git.detached === true ? 'detached HEAD' : (git.branch ?? 'unknown');

  return (
    <>
      <span
        className={`dirbar-git${worktree ? ' worktree' : ''}${git.detached === true ? ' detached' : ''}`}
        title={
          git.detached === true
            ? 'On no branch, so any commit the loops make is reachable only by its hash. Check out a branch before letting them commit.'
            : worktree
              ? `A worktree of ${git.mainRoot ?? 'another checkout'}, on its own branch. The loops work here without touching that one.`
              : `The branch the loops are working on, in your own checkout. Anything they change, you see.${
                  git.unborn === true ? ' Nothing is committed yet.' : ''
                }`
        }
      >
        <Icon name="branch" />
        {label}
        {worktree && <span className="dirbar-git-kind">worktree</span>}
      </span>
      {/*
        Only offered from an ordinary checkout: from a worktree there is nothing to
        offer, and without a repository there is nothing to branch. Disabled while
        anything is going, like the path field beside it and for the same reason -
        this moves the factory, and a turn in flight would finish into the directory
        being left. The server refuses it too; this is so the button says why first.
      */}
      {!worktree && (
        <button
          className="with-icon"
          onClick={onBranchOff}
          disabled={running || git.unborn === true}
          title={
            git.unborn === true
              ? 'This repository has no commits yet, and a worktree needs something to branch from. Make one commit first.'
              : running
                ? 'Stop the loops first. Branching off moves the factory, and a turn in flight would finish into the directory it left.'
                : 'Give this factory its own branch and checkout, so the loops work without touching this one'
          }
        >
          <Icon name="branch" />
          Branch off
        </button>
      )}
    </>
  );
}

/**
 * The loop's output, newest at the bottom, pinned to the bottom while you are
 * already there. Scrolling up to read something stops the pin, because a view that
 * yanks itself away mid-sentence is worse than one that needs a scroll.
 */
function Output({ lines }: { lines: OutputLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /*
   * Keyed on the array, not its length: streamed text is joined into the last line,
   * so most updates grow a line rather than adding one, and a pin that only follows
   * new lines drifts away from the bottom for as long as the agent keeps talking.
   * A layout effect, so the scroll lands before paint instead of one frame after -
   * per keystroke of streamed text, that frame is a visible stutter.
   */
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      className="output"
      ref={box}
      onScroll={(e) => {
        // Scrolling up to read something unpins the view. A log that yanks itself
        // away mid-sentence is worse than one that needs a scroll.
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {lines.length === 0 ? (
        <span className="empty">No output yet. Press Start.</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`line ${line.kind}`}>
            {line.text}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The chat under the log: a message for the running loop.
 *
 * A message sent while a turn is running interrupts it: the turn is killed and
 * the message opens the replacement, together with a transcript of the work it
 * cut short. An operator who types here is reacting to something wrong now, and
 * a message that waits for the loop to finish being wrong arrives too late.
 * The message itself is not appended here: it comes back on the event stream as
 * a `user` line like every other line, so the log stays the single record and a
 * message that never echoes is a message that never arrived.
 *
 * Disabled while the loop is stopped: a message for a loop that is not running
 * would sit queued until someone remembers to start it, and a chat box that
 * accepts messages nobody is hearing reads as working when it is not. The
 * placeholder says what to do instead.
 */
function SteerBox({ running, onSend }: { running: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  const send = (): void => {
    const message = text.trim();
    if (message.length === 0) return;
    onSend(message);
    setText('');
  };

  return (
    <div className="steer">
      <textarea
        className="steer-input"
        rows={1}
        value={text}
        disabled={!running}
        placeholder={running ? 'Say something to this loop - it interrupts the turn' : 'Start the loop to talk to it'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter is a new line: the convention every chat box
          // trained everyone on.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="steer-send" disabled={!running || text.trim().length === 0} onClick={send}>
        Send
      </button>
    </div>
  );
}

/**
 * A wire: where it goes, how its producer delivers, what is outstanding, and the
 * button that removes it.
 *
 * What is shown is the producer's whole outbox rather than this one wire, because
 * the mode is the producer's. A queue is one list - the same list every loop on it
 * is seeing, and any of them may take an item from it. A topic is every
 * subscriber's folder at once, under a heading each, so a broadcast can be seen
 * arriving everywhere instead of having to be checked one wire at a time.
 *
 * Either way the list is exactly what is outstanding: taking an item removes it, so
 * an item here is work nobody has started.
 */
function WirePanel({
  factoryId,
  wire,
  fromName,
  consumers,
  busy,
  onMode,
  onDelete,
}: {
  factoryId: string;
  wire: Wire;
  fromName: string;
  /** Every loop this producer delivers to, in document order, for the headings. */
  consumers: { id: string; name: string }[];
  /** A loop at either end is running, so the mode must not be changed under it. */
  busy: boolean;
  onMode: (mode: WireMode) => void;
  /** Removes the whole fan-out. One wire goes by the × on the canvas. */
  onDelete: () => void;
}) {
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);

  /*
   * Polled for the same reason the wire labels are: the agents add and remove these
   * files themselves, so the folder is the only thing that knows what is in it.
   *
   * Asked by producer rather than by wire, so one request answers for the whole
   * fan-out. Keyed on `wire.from` and the mode, which means selecting a sibling wire
   * of the same producer does not refetch - it is the same outbox, and that is the
   * point of showing it this way.
   */
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void api
        .outbox(factoryId, wire.from)
        .then((next) => {
          if (live) setOutbox(next);
        })
        .catch(() => undefined);
    };
    read();
    const poll = window.setInterval(read, QUEUE_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [wire.from, wire.mode, factoryId]);

  const many = consumers.length > 1;
  const toNames = consumers.map((c) => c.name).join(', ');
  const nameOf = (id: string | null): string =>
    id === null ? '' : (consumers.find((c) => c.id === id)?.name ?? id);

  /*
   * The queue's folder, which the server names rather than this file rebuilding it.
   * It used to be a copy of `channelDir` here, which is a second implementation of
   * the layout to keep in step. A topic's folders are named under their headings.
   */
  const total = outbox?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;

  /**
   * What the delete does, for the icon button's tooltip and accessible name.
   *
   * The old label, word for word, and nothing more. A tooltip replacing a label should
   * be that label: it is read in the half-second before a click, so the count - which
   * is the one thing the bin cannot say for itself - has to be the whole of it.
   *
   * It briefly also explained the per-wire × here and that was two mistakes. The
   * sentence wrapped the tooltip across the panel, and the × is hover-only on one
   * wire, so a tooltip is no place to teach it. The confirmation says it instead,
   * where there is room and where you are actually deciding.
   */
  const deleteWhat = many ? `Delete all ${consumers.length} wires` : 'Delete wire';

  /**
   * Throw away the work waiting, keeping the wires.
   *
   * The counterpart of the delete beside it, and the distinction is worth being exact
   * about: that button removes the wiring and loses the work with it, this one loses
   * only the work. Emptying a backlog you have decided is stale should not require
   * deleting the design and drawing it again.
   *
   * Scope is the producer's folders, all of them, which is the same scope the panel is
   * already showing - so there is no question here about whose queue is meant. Asks
   * first, always: unlike the delete, there is no wiring change to make the
   * consequence visible afterwards, so the confirmation is the only thing standing
   * between a click and work that is gone.
   */
  function clearQueue(): void {
    setConfirm({
      title: `Throw away ${total} item${total === 1 ? '' : 's'} waiting?`,
      // One sentence: what survives, and what does not. The title already says how
      // many and the panel underneath says which folders, so restating either here is
      // reading the dialog to someone who is looking at it. The claim race went too -
      // an item a consumer takes half a second before you click is not a caveat that
      // changes the decision, and a dialog is not the place to teach the queue model.
      body: 'The wires stay and the loops keep running. Only the work waiting is lost.',
      action: 'Throw it away',
      onConfirm: () => {
        void api
          .clearOutbox(factoryId, wire.from)
          .then(setOutbox)
          .catch(() => undefined);
      },
    });
  }
  const dir = outbox?.groups.find((g) => g.to === null)?.dir ?? '';

  return (
    <>
      {/*
        The producer and everyone it delivers to, on one line.
        
        Not `from → to` any more: the panel describes the whole fan-out, so a heading
        naming one branch of it would be describing something narrower than what is
        underneath. `A → B, C` is the shape of the thing.
      */}
      <div className="wire-head">
        <span className="wire-route">
          {fromName} <Icon name="hero-arrow-right" className="arrow" /> {toNames}
        </span>
        {/*
          Empty the queue, keeping the wire. Before the delete rather than after it, so
          the row runs from the recoverable action to the irrecoverable one.

          Not tinted with `danger`. It loses work, so it is not harmless, but the wiring
          survives and the loops carry on filling the folder again - where the bin beside
          it takes the design with it. Two red buttons side by side would make that the
          same decision twice.

          Hidden rather than disabled when the queue is empty. There is nothing to throw
          away and nothing to explain about why not; a greyed button would be a question
          the panel has already answered right underneath, where it says what is waiting.
        */}
        {total > 0 && (
          <button
            className="icon-only"
            onClick={clearQueue}
            title={`Throw away the ${total} item${total === 1 ? '' : 's'} waiting`}
            aria-label={`Throw away the ${total} items waiting`}
          >
            <Icon name="hero-archive-box-x-mark" />
          </button>
        )}
        {/*
          Icon-only, with the label it replaced on the tooltip.
          
          The label was the widest thing in the panel and grew with the fan-out, so on
          a producer with three consumers it pushed the route above it - the `A → B, C`
          that tells you what you have selected - down to an ellipsis. The route is what
          deserves the width. A bin tinted with `danger` is not ambiguous about what it
          does, and the count is the one thing it cannot say for itself, which is all
          the tooltip is for.
        */}
        <button
          className="danger icon-only"
          aria-label={deleteWhat}
          title={deleteWhat}
          onClick={() => {
            // Everything on every folder this producer delivers into, since that is
            // what goes. Worth a question when there is work to lose, and worth not
            // asking when there is none.
            if (total > 0) {
              setConfirm({
                title: many
                  ? `Delete all ${consumers.length} wires out of ${fromName} and the ${total} item${total === 1 ? '' : 's'} waiting?`
                  : `Delete this wire and the ${total} item${total === 1 ? '' : 's'} waiting on it?`,
                body: `The folders go with them, and nothing else is reading them, so the work on them is lost.${
                  many ? ` To remove just one branch, use the × at the end of it instead.` : ''
                }`,
                action: many ? 'Delete all wires' : 'Delete wire',
                onConfirm: onDelete,
              });
              return;
            }
            onDelete();
          }}
        >
          <Icon name="hero-trash" />
        </button>
      </div>

      {/*
        The mode, and the one control a wire has.
        
        Segmented rather than a checkbox because neither mode is the negation of the
        other, and the line underneath says what the choice does to *this* wiring -
        naming the loops actually involved, rather than explaining the concept in the
        abstract every time.
        
        It sets the mode for every wire out of the producer, not just this one, so it
        says so whenever there is more than one. A control that looks local and
        rewrites three wires is the surprise the old per-wire mode was protecting
        against; being explicit is what replaces that protection.
      */}
      <div className="wire-mode">
        <div className="seg" role="group" aria-label={`How ${fromName} delivers`}>
          {(['queue', 'topic'] as const).map((m) => (
            <button
              key={m}
              className={wire.mode === m ? 'on' : ''}
              aria-pressed={wire.mode === m}
              // The mode it already is stays pressable-looking but does nothing;
              // only the switch is locked, so the control still reads as a choice
              // rather than going flat while a loop runs.
              disabled={busy && wire.mode !== m}
              // What switching does to the backlog. On the button rather than in a
              // line of prose under it: it matters at the moment you reach for it,
              // and not before.
              title={
                wire.mode === m
                  ? undefined
                  : m === 'topic'
                    ? 'Copies the current backlog to every consumer.'
                    : 'Gathers every copy into one backlog. Duplicates of an item collapse into one.'
              }
              onClick={() => wire.mode !== m && onMode(m)}
            >
              <Icon name={m === 'queue' ? 'hero-queue-list' : 'hero-megaphone'} />
              {m === 'queue' ? 'Queue' : 'Topic'}
            </button>
          ))}
        </div>
        <p className="hint">
          {wire.mode === 'queue'
            ? many
              ? `One backlog, shared by ${toNames}. Each item goes to whichever loop takes it first.`
              : `${toNames} takes items from ${fromName}'s queue. Wire another loop to ${fromName} and they share this backlog.`
            : many
              ? `Each of ${toNames} gets its own copy of everything ${fromName} sends.`
              : `${toNames} gets its own copy of everything ${fromName} sends.`}
        </p>
        {/*
          The lock's reasoning is on `title` rather than inline. It is worth keeping
          and not worth reading every time, and the heading above already says the
          mode belongs to the producer and its whole fan-out.
        */}
        {busy && (
          <p
            className="hint locked"
            title="Switching moves the folders those loops are writing to, and an agent already mid-turn was given the old paths."
          >
            <Icon name="hero-lock-closed" />
            Stop the loops to change this.
          </p>
        )}
      </div>

      {/* The queue's own path is shown here; a topic's sits under each heading. */}
      {wire.mode === 'queue' && dir.length > 0 && <code className="wire-dir">{dir}</code>}

      {/*
        Everything the producer is delivering, not just what is on this wire.
        
        A queue is one list, which is what it always was. A topic is every
        subscriber's folder at once, under a heading each: the same item standing
        under all of them is the mode visibly doing its job, and that is exactly what
        was impossible to see when the panel showed one wire and you had to click
        between three of them to compare.
      */}
      <div className="queue">
        {total === 0 ? (
          <span className="empty">
            Nothing waiting. Items are removed from the queue when a loop takes one.
          </span>
        ) : wire.mode === 'queue' ? (
          <>
            <h3>
              <Icon name="hero-queue-list" />
              Waiting <span className="count">{total}</span>
            </h3>
            <Items items={outbox?.groups[0]?.items ?? []} />
          </>
        ) : (
          (outbox?.groups ?? []).map((group) => (
            <section className="outbox-group" key={group.to ?? 'queue'}>
              <h3>
                <Icon name="hero-megaphone" />
                <span className="wire-route">
                  {fromName} <Icon name="hero-arrow-right" className="arrow" /> {nameOf(group.to)}
                </span>
                <span className="count">{group.items.length}</span>
              </h3>
              <code className="wire-dir">{group.dir}</code>
              {group.items.length === 0 ? (
                <span className="empty">Nothing waiting.</span>
              ) : (
                <Items items={group.items} />
              )}
            </section>
          ))
        )}
      </div>

      <Confirm ask={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

/**
 * A list of items waiting in one folder.
 *
 * Its own component because a topic renders it once per subscriber, and the same
 * item appearing in several of these lists - same id, same timestamp - is what the
 * panel is trying to show.
 */
function Items({ items }: { items: QueueItem[] }) {
  /*
   * Every field is checked before use, whatever the type declares. An item is a
   * JSON file an agent wrote, and agents write what their prompt led them to:
   * items with no `ts`, no `producer`, tombstones with a `state` and a `note` and
   * nothing this type names. One `undefined.slice` here took the whole app to a
   * black screen, which is a lot of blast radius for one loop's file format.
   */
  return (
    <>
      {items.map((item, i) => (
        <article className="item" key={typeof item.id === 'string' ? item.id : `item-${i}`}>
          <div className="item-head">
            <span className="producer">
              {typeof item.producer === 'string' ? item.producer : ''}
            </span>
            <span className="ts">{typeof item.ts === 'string' ? item.ts.slice(11, 19) : ''}</span>
          </div>
          <div className="item-body">
            {typeof item.artifact === 'string' && item.artifact.length > 0
              ? item.artifact
              : typeof item.payload === 'string'
                ? item.payload
                : item.payload !== undefined
                  ? JSON.stringify(item.payload, null, 2)
                  : // Nothing this panel knows by name: show the whole file, which
                    // is at least the truth about what is sitting on the queue.
                    JSON.stringify(item, null, 2)}
          </div>
        </article>
      ))}
    </>
  );
}

/* --------------------------------------------------------------- references */

/*
 * What counts as a reference in a prompt.
 *
 * This grammar is shared with `server/mcp.ts`, and the two have to agree: a token
 * this file colours but the server does not resolve is a promise the prompt breaks,
 * and the operator has no way to tell which happened. A dot is not part of a name,
 * so `@aws-docs.` at the end of a sentence resolves and the full stop stays
 * prose. The guard stops an `@` mid-word from being a reference, so an email
 * address in a prompt is left alone.
 */
const NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';
const GUARD = '(?<![A-Za-z0-9_-])';

/** One capture group, so `split` hands back the references along with the prose. */
const TOKEN_SPLIT = new RegExp(`(${GUARD}@${NAME})`, 'g');

/** The reference the caret is sitting in, if it is in one. Matches a bare `@`. */
const TOKEN_AT_CARET = new RegExp(`${GUARD}@([A-Za-z0-9_-]*)$`);

/** Every reference in a prompt, for the MCP scope to match against server names. */
const TOKEN_ALL = new RegExp(`${GUARD}@(${NAME})`, 'g');

/**
 * Whether a bare string could be written after an `@` and be found again.
 *
 * What the parameters bar validates a name against, and the same expression
 * `server/mcp.ts` exports under this name for the parse to use. A parameter whose
 * name fails this is one no prompt can reach, so the server drops it - which is why
 * the bar has to refuse it here rather than let it look saved.
 */
const NAME_ONLY = new RegExp(`^${NAME}$`);

/**
 * The server names a prompt asks for, lowercased.
 *
 * The queue and directory vocabulary is left out: `prompt.ts` defines those itself,
 * so they are not names to look up.
 *
 * This list is a copy of `RESERVED` in `server/mcp.ts` and has to stay equal to it.
 * Not an import: that module reaches for `node:fs`, so pulling it into the bundle
 * would take the build down. The two agreeing is what keeps the scope UI honest - if
 * this list is short a name, the UI offers a grant the runner will not make.
 */
const RESERVED = new Set(['input', 'output', 'project', 'loop']);

/**
 * `claimed` is the factory's parameter names, which share this namespace and win it.
 *
 * Excluded for the same reason `RESERVED` is, and it matters in the same place: this
 * set is what the scope menu ticks as "named by the prompt, so granted anyway". A
 * parameter left in would show as a granted server the runner never grants, which is
 * the exact dishonesty the note above is about. `serversNamedIn` in server/mcp.ts
 * takes the same argument and drops the same names.
 */
function namedInPrompt(prompt: string, claimed: Iterable<string> = []): Set<string> {
  const taken = new Set([...claimed].map((c) => c.toLowerCase()));
  const out = new Set<string>();
  for (const match of prompt.matchAll(TOKEN_ALL)) {
    const name = match[1]!.toLowerCase();
    if (!RESERVED.has(name) && !taken.has(name)) out.add(name);
  }
  return out;
}

/**
 * Tallest the menu gets, however much room there is.
 *
 * Sized to show a whole small factory's vocabulary without scrolling: four group
 * headings and a dozen or so rows. It was 220, which fitted three groups and about six
 * rows - enough while the vocabulary was two wires, two directories and the tools, and
 * not enough once parameters became a fourth group. A menu that scrolls on its first
 * open is one you arrow through blind, and the whole point of the list is that you can
 * see what a prompt is allowed to name.
 *
 * Still a ceiling rather than a height: the menu is capped to the room actually
 * available on whichever side it opens, so this only decides how tall it is allowed to
 * get when there is room to spare.
 */
const MENU_MAX = 340;

/**
 * Shortest the menu is allowed to be squeezed to before it stops shrinking.
 *
 * Two rows and a heading, roughly. Below this the list is not a list any more and
 * the honest thing is to overhang the window edge slightly rather than render a
 * sliver: a caret with 20px under it and no room above is a case that needs the
 * menu somewhere, and the clamp on `top` keeps it inside the window regardless.
 */
const MENU_MIN = 96;

/**
 * How wide the menu is, for clamping it inside the window.
 *
 * The stylesheet fixes `.ref-menu` to exactly this, and that is the point: the
 * clamp has to know the width, and measuring the element means placing it, seeing
 * how wide it came out and placing it again. It used to be "roughly how wide the
 * menu wants to be", which was harmless while the menu was clamped inside the
 * prompt box and is not now that the clamp is the window's edge - a menu 30px
 * wider than this guess would hang 30px off the screen.
 */
const MENU_WIDTH = 220;

/** Between the caret's line and the menu, on whichever side it opens. */
const MENU_GAP = 4;

/** Margin kept between the menu and the edge of the window, on every side. */
const MENU_EDGE = 8;

/**
 * The menu's headings, in the order it shows them.
 *
 * One list, used by the `Suggestion` type and by the render. It was two - a union
 * on the type and a literal array in the JSX - and they drifted the moment a third
 * group was added: `Project` type-checked everywhere and then vanished from the
 * menu, because the render still looped over the two it knew about and filtered the
 * new one out. A group missing from here cannot be given to a suggestion, so the
 * two cannot disagree again.
 */
const GROUPS = ['Wires', 'Dir', 'Parameters', 'Tools', 'Skills', 'Steering'] as const;

/** What the picker offers, and what a matching token is coloured as. */
interface Suggestion {
  /** Inserted verbatim, `@` included. */
  token: string;
  /** The right-hand column: what this resolves to, when that is worth saying. */
  hint: string;
  cls: 'tok-in' | 'tok-out' | 'tok-mcp' | 'tok-dir' | 'tok-param' | 'tok-skill' | 'tok-steer';
  group: (typeof GROUPS)[number];
}

/** How much of a folder name a hint shows before it is cut short. */
const HINT_MAX = 8;

/**
 * A directory as `../name`: the last segment, and only so much of it.
 *
 * The menu opens at the caret inside a prompt box, so its width is a constraint
 * rather than a preference - a full absolute path made it wider than the box it
 * belongs to and pushed the tokens, which are the thing being chosen, off to one
 * side. The last segment is the part that identifies the folder anyway; everything
 * before it is shared by every entry here and says nothing.
 *
 * `../` rather than `…/` so it reads as a path fragment at a glance. The whole
 * hint is the definition in miniature - the tooltip on the directory bar and the
 * prompt itself carry the full path for anyone who needs it.
 */
function shortDir(path: string): string {
  const name = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? path;
  return `../${name.length > HINT_MAX ? `${name.slice(0, HINT_MAX - 1)}…` : name}`;
}

/**
 * How much of a parameter's value a hint shows. Longer than `HINT_MAX`, because a
 * folder is identified by its last segment and a value is not identified by
 * anything: the first words are all there is to recognise it by.
 */
const VALUE_MAX = 16;

/** A value on one line, cut to fit the hint column. Newlines collapse to spaces. */
function shortValue(value: string): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX - 1)}…` : flat;
}

/**
 * Everything a prompt can name, in the order the menu shows it.
 *
 * Wires first: they are what a prompt is usually about, they change as you rewire,
 * and there are always exactly two of them however many tools there are - so the
 * top of the menu is the same two entries every time you open it, which is what
 * makes reaching for one fast. The directories are fixed for the life of the loop
 * and mostly need naming once. Tools last, being the open-ended list.
 *
 * The list is ordered for the hand, in other words, not by what depends on what.
 *
 * The queue hints are the wiring, so an operator who writes `@input` into a loop
 * nothing feeds sees that before the loop runs and says the folder was empty. The
 * directory hints are the folders, shortened - see `shortDir`.
 */
function suggestions(
  servers: McpServer[],
  reads: number,
  writes: number,
  baseDir: string,
  loopId: string,
  parameters: Parameter[],
  skills: Skill[],
  steeringFiles: SteeringFile[],
): Suggestion[] {
  const queue = (n: number, dir: string): string =>
    n === 0 ? `nothing wired ${dir}` : `${n} queue${n === 1 ? '' : 's'} ${dir}`;

  return [
    { token: '@input', hint: queue(reads, 'in'), cls: 'tok-in', group: 'Wires' },
    { token: '@output', hint: queue(writes, 'out'), cls: 'tok-out', group: 'Wires' },
    { token: '@project', hint: shortDir(baseDir), cls: 'tok-dir', group: 'Dir' },
    // The loop's folder is named after the loop, so its id is its last segment -
    // which is all the hint shows. The path is built server-side by `loopDir`, and
    // this deliberately does not reimplement it to say the same eight characters.
    { token: '@loop', hint: shortDir(loopId), cls: 'tok-dir', group: 'Dir' },
    /*
     * The factory's parameters, hinted with the value they carry.
     *
     * The value rather than the description, because the value is the thing that
     * decides whether this is the parameter you meant - two runs of the same factory
     * differ by exactly these, and picking `@topic` blind is picking a variable
     * whose contents you are guessing at. A blank one says so instead of showing an
     * empty column: unset is the state worth noticing before you write it into a
     * prompt, since the prompt will keep the token rather than the nothing.
     */
    ...parameters.map(
      (p): Suggestion => ({
        token: `@${p.name}`,
        hint: p.value.trim().length === 0 ? 'not set' : shortValue(p.value),
        cls: 'tok-param',
        group: 'Parameters',
      }),
    ),
    ...servers.map(
      (s): Suggestion => ({
        token: `@${s.name}`,
        // Only the workspace ones are worth labelling: they come from the factory's
        // own directory, so they are the ones that change when it moves.
        hint: s.scope === 'workspace' ? 'workspace' : '',
        cls: 'tok-mcp',
        group: 'Tools',
      }),
    ),
    /*
     * Skills hint with their description, the way parameters hint with their value:
     * a skill's name is often a project codeword and the description is the only
     * line that says what following it would mean. Steering files have no
     * description to offer, so they take the servers' convention instead - only the
     * workspace ones are labelled, being the ones that change when the factory
     * moves.
     */
    ...skills.map(
      (s): Suggestion => ({
        token: `@${s.name}`,
        hint: shortValue(s.description),
        cls: 'tok-skill',
        group: 'Skills',
      }),
    ),
    ...steeringFiles.map(
      (s): Suggestion => ({
        token: `@${s.name}`,
        hint: s.scope === 'workspace' ? 'workspace' : '',
        cls: 'tok-steer',
        group: 'Steering',
      }),
    ),
  ];
}

/** Separators are noise when filtering, so `@awsd` still finds `aws-docs`. */
function loosely(s: string): string {
  return s.toLowerCase().replace(/[-_.\s]/g, '');
}

/**
 * What colour a token in the mirror gets, or nothing when it resolves to nothing.
 *
 * Parameters are tested before servers, which is the same precedence the runner
 * applies and has to be: they share one flat namespace, a parameter wins its name,
 * and a token coloured as a tool that is actually substituted as a value would be
 * the panel telling the operator the opposite of what will happen.
 *
 * Colour is carrying more weight here than it does for the others. `@input` and
 * `@project` are learnable words with a fixed meaning, but a parameter and a tool
 * are both arbitrary names the factory supplies, so the tint is the only thing
 * distinguishing "this becomes a value" from "this hands over a capability" - which
 * is why `--param` is the one saturated hue in the set rather than a near-white.
 */
function classOf(
  token: string,
  servers: Set<string>,
  params: Set<string>,
  skills: Set<string>,
  steering: Set<string>,
): Suggestion['cls'] | null {
  if (token === '@input') return 'tok-in';
  if (token === '@output') return 'tok-out';
  if (token === '@project' || token === '@loop') return 'tok-dir';
  const name = token.slice(1).toLowerCase();
  if (params.has(name)) return 'tok-param';
  if (servers.has(name)) return 'tok-mcp';
  // Skills after servers because servers are the incumbent: a prompt that says
  // `@github` today must keep meaning the server after someone drops a `github`
  // skill into `.kiro/skills/`. Skills before steering on no stronger grounds than
  // that the order must be fixed. This is the same test order `namedIn` applies
  // server-side in resources.ts, and the two agreeing is what keeps the colours
  // honest.
  if (skills.has(name)) return 'tok-skill';
  return steering.has(name) ? 'tok-steer' : null;
}

/**
 * The mirror's content: the prompt with its references wrapped, and a zero-width
 * marker where the caret is.
 *
 * The marker is the whole reason the menu can appear at the caret rather than
 * bolted to the bottom of the box. Measuring a caret in a textarea normally means
 * building a throwaway mirror to measure against - but this component already keeps
 * one that is guaranteed to lay text out identically, so the position is a
 * `getBoundingClientRect` away.
 *
 * A chunk containing the caret is split into two spans of the same class, so a
 * reference the caret is inside keeps its colour: two adjacent spans styled alike
 * are indistinguishable from one.
 */
function mirrorNodes(
  text: string,
  servers: Set<string>,
  params: Set<string>,
  skills: Set<string>,
  steering: Set<string>,
  caret: number | null,
  marker: React.RefObject<HTMLSpanElement>,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  let placed = false;

  const emit = (chunk: string, cls: string | null, key: string): void => {
    const wrap = (t: string, k: string): React.ReactNode => (
      <span key={k} className={cls ?? undefined}>
        {t}
      </span>
    );

    // `<=` so a caret resting at the end of a chunk lands here; `!placed` so a
    // caret on a boundary does not get a marker on both sides of it.
    const inside =
      caret !== null && !placed && caret >= offset && caret <= offset + chunk.length;

    if (!inside) {
      nodes.push(wrap(chunk, key));
    } else {
      placed = true;
      const at = caret! - offset;
      nodes.push(wrap(chunk.slice(0, at), `${key}a`));
      nodes.push(<span key={`${key}c`} ref={marker} className="prompt-caret" />);
      nodes.push(wrap(chunk.slice(at), `${key}b`));
    }
    offset += chunk.length;
  };

  // `split` on a pattern with one group yields prose, reference, prose, reference…
  const parts = text.split(TOKEN_SPLIT);
  parts.forEach((part, i) => {
    emit(part, i % 2 === 1 ? classOf(part, servers, params, skills, steering) : null, `p${i}`);
  });
  return nodes;
}

/**
 * Write a reference into the prompt: replace `[from, to)` with the token, keep the
 * caret after it, and give the textarea back its focus.
 *
 * One function because there are two writers with one behaviour. The `@` picker
 * replaces the fragment the operator typed; the skills and steering dropdowns
 * insert at whatever the caret was when the click left the box. Both must pad the
 * same way (a space after, so the next word typed does not fuse onto the
 * reference) and both must restore the caret the same way, and a splice written
 * twice is a padding rule that drifts.
 *
 * The focus round-trip runs a frame later, after the new value has been through
 * the parent's state: a controlled textarea otherwise puts the caret at the end.
 */
function spliceReference(
  el: HTMLTextAreaElement | null,
  value: string,
  from: number,
  to: number,
  token: string,
  onChange: (next: string) => void,
): void {
  const before = value.slice(0, from);
  const after = value.slice(to);
  const pad = /^[\s]/.test(after) ? '' : ' ';
  const caret = from + token.length + pad.length;

  onChange(`${before}${token}${pad}${after}`);
  requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(caret, caret);
  });
}

/**
 * The prompt box: a highlighted mirror, a transparent textarea over it, and the
 * `@` picker.
 *
 * A textarea cannot contain coloured spans, so this is the standard overlay: a
 * `pre` underneath holding the same text with the references wrapped, and the
 * textarea on top with transparent text and a visible caret. You are reading the
 * `pre` and typing into the textarea.
 *
 * The two only stay aligned if they agree on every metric that affects wrapping -
 * font, size, line height, padding, width, wrap mode - so those live in one CSS
 * rule that both share rather than being set twice. Scroll position is mirrored on
 * every scroll and on every change, because typing at the bottom of a long prompt
 * scrolls the textarea without firing a scroll event in time.
 *
 * The picker opens on typing only, never on a click or an arrow key. Clicking after
 * a reference you wrote ten minutes ago is not a request to replace it, and an
 * editor that pops a menu every time you put the caret somewhere is one you fight.
 */
function PromptBox({
  value,
  onChange,
  area,
  servers,
  reads,
  writes,
  baseDir,
  loopId,
  parameters,
  skills,
  steeringFiles,
}: {
  value: string;
  onChange: (next: string) => void;
  /**
   * The textarea, owned by the parent rather than here, because the settings-row
   * dropdowns below this box splice references in at its caret - and the caret
   * lives on the element. Everything else about the element is still this
   * component's business.
   */
  area: React.RefObject<HTMLTextAreaElement>;
  servers: McpServer[];
  /** Wires into this loop, and out of it, so `@input`/`@output` hints are true. */
  reads: number;
  writes: number;
  /** Where the factory runs, which is what `@project` resolves to. */
  baseDir: string;
  /** This loop's id, which is the last segment of what `@loop` resolves to. */
  loopId: string;
  /** The factory's parameters: offered by the menu, and tinted in the mirror. */
  parameters: Parameter[];
  /** Skills and steering files this machine and directory carry - same treatment. */
  skills: Skill[];
  steeringFiles: SteeringFile[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLPreElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const chosen = useRef<HTMLLIElement>(null);

  /** Open picker: where the `@` is, where the caret is, and what was typed between. */
  const [menu, setMenu] = useState<{ from: number; caret: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  /**
   * Where the menu goes, in viewport coordinates, and how tall it may be there.
   *
   * Viewport rather than box-relative because the menu is portalled to the body
   * and positioned `fixed` - see the render. `height` is the room actually
   * available on the side that was chosen, so the menu shrinks and scrolls near an
   * edge instead of hanging off it.
   */
  const [pos, setPos] = useState<{ top: number; left: number; height: number } | null>(null);

  const names = useMemo(() => new Set(servers.map((s) => s.name.toLowerCase())), [servers]);
  const paramNames = useMemo(
    () => new Set(parameters.map((p) => p.name.toLowerCase())),
    [parameters],
  );
  const skillNames = useMemo(() => new Set(skills.map((s) => s.name.toLowerCase())), [skills]);
  const steeringNames = useMemo(
    () => new Set(steeringFiles.map((s) => s.name.toLowerCase())),
    [steeringFiles],
  );
  const all = useMemo(
    () => suggestions(servers, reads, writes, baseDir, loopId, parameters, skills, steeringFiles),
    [servers, reads, writes, baseDir, loopId, parameters, skills, steeringFiles],
  );
  const shown = useMemo(() => {
    if (!menu) return [];
    const q = loosely(menu.query);
    return q.length === 0 ? all : all.filter((s) => loosely(s.token.slice(1)).includes(q));
  }, [all, menu]);

  // Nothing matched is the menu closed, not an empty menu: an operator typing an
  // ordinary `@` in prose should not have a panel appear and stay.
  const open = menu !== null && shown.length > 0;
  const index = Math.min(active, Math.max(0, shown.length - 1));

  const sync = (): void => {
    const el = area.current;
    const pre = back.current;
    if (el && pre) {
      pre.scrollTop = el.scrollTop;
      pre.scrollLeft = el.scrollLeft;
    }
  };

  /**
   * Put the menu at the caret, in viewport coordinates, inside the window.
   *
   * Viewport rather than box-relative because the menu is portalled out to the
   * body: nothing above it can clip it and nothing above it can outrank it, which
   * is the whole reason for the portal. `.panel-top` declares `container-type:
   * size`, and that implies layout containment - which makes it both a stacking
   * context and the containing block for any absolutely positioned descendant. An
   * absolute menu in there could not paint over the settings row below it however
   * high its `z-index`, and its `overflow-y: auto` cut the list off mid-group. A
   * fixed, portalled menu has neither problem.
   *
   * Chooses a side by which has more room and then *caps the height to that room*,
   * rather than flipping on a guess about the menu's height. The old code compared
   * against MENU_MAX and anchored `bottom` when it did not fit below, which keeps
   * the menu on screen only while the space above happens to be big enough - near
   * the top of the window it moved the overflow rather than removing it. Capping
   * means the menu is always inside the window on every edge: given little room it
   * becomes a short scrolling list, which is legible, where a tall list half off
   * the screen is not.
   */
  const place = (): void => {
    if (!open) {
      setPos(null);
      return;
    }
    const m = marker.current;
    if (!m) return;
    const caret = m.getBoundingClientRect();

    // The window, less a margin, is the only boundary that matters now.
    const below = window.innerHeight - caret.bottom - MENU_GAP - MENU_EDGE;
    const above = caret.top - MENU_GAP - MENU_EDGE;
    // Below unless above is genuinely roomier: the caret's own line is where the
    // eye already is, and a menu that drops from it reads as belonging to the
    // character just typed. Flipping up is the concession, not the preference.
    const up = below < Math.min(MENU_MAX, above);
    const height = Math.max(MENU_MIN, Math.min(MENU_MAX, up ? above : below));
    // Where the chosen side wants it, then clamped to the window regardless. The
    // clamp is what closes the last gap: with almost no room on either side the
    // height stops shrinking at MENU_MIN, and without this the menu would overhang
    // by the difference. Clamped, it slides to sit against the edge and overlaps
    // the caret's own line instead, which is recoverable - a menu off the screen
    // is not.
    const wanted = up ? caret.top - MENU_GAP - height : caret.bottom + MENU_GAP;

    setPos({
      top: Math.max(MENU_EDGE, Math.min(wanted, window.innerHeight - height - MENU_EDGE)),
      left: Math.max(
        MENU_EDGE,
        Math.min(caret.left, window.innerWidth - MENU_WIDTH - MENU_EDGE),
      ),
      height,
    });
  };

  useLayoutEffect(sync, [value]);
  useLayoutEffect(place, [open, menu, value]);

  /*
   * Follow the caret when anything moves it, because a fixed menu cannot.
   *
   * An absolutely positioned menu rode along with its box for free; this one is
   * pinned to the viewport, so a scroll of the panel's top half or a resized window
   * would leave it hanging in space next to nothing. `capture` is what catches the
   * scroll: `.panel-top` is the element that scrolls and scroll events do not
   * bubble, so a listener on `window` only hears it on the way down.
   *
   * Re-placing rather than closing. A menu that vanished the moment the panel
   * nudged would be a menu you could lose by touching the trackpad while reading
   * it, and the placement is one `getBoundingClientRect` - cheap enough to do on a
   * scroll frame.
   */
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  });

  // Keyboard navigation is useless if the row it lands on is out of view, and the
  // list scrolls as soon as there are more than a handful of tools.
  useLayoutEffect(() => {
    chosen.current?.scrollIntoView({ block: 'nearest' });
  }, [index, open]);

  /** Replace the typed `@fragment` with the reference - see `spliceReference`. */
  function accept(pick: Suggestion): void {
    if (!menu) return;
    spliceReference(area.current, value, menu.from, menu.caret, pick.token, onChange);
    setMenu(null);
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    onChange(next);

    const found = TOKEN_AT_CARET.exec(next.slice(0, caret));
    setMenu(found ? { from: caret - found[0].length, caret, query: found[1] ?? '' } : null);
    setActive(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) {
      if (e.key === 'Escape' && menu) setMenu(null);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (Math.min(i, shown.length - 1) + 1) % shown.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (Math.min(i, shown.length - 1) - 1 + shown.length) % shown.length);
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        accept(shown[index]!);
        break;
      case 'Escape':
        e.preventDefault();
        setMenu(null);
        break;
      // The caret has moved off the fragment the menu was filtering on, and
      // nothing here tracks where to.
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        setMenu(null);
        break;
      default:
        break;
    }
  }

  // A trailing newline is not rendered by `pre`, so without this the highlight
  // stops one line short of the caret when the prompt ends on a blank line.
  const mirrored = value.endsWith('\n') ? `${value}\n` : value;

  return (
    <div className="prompt-box" ref={box}>
      <pre className="prompt-back" ref={back} aria-hidden="true">
        {mirrorNodes(
          mirrored,
          names,
          paramNames,
          skillNames,
          steeringNames,
          open ? menu.caret : null,
          marker,
        )}
      </pre>
      <textarea
        ref={area}
        className="prompt"
        spellCheck={false}
        /*
         * "Where the work lands" rather than "what to write out".
         *
         * Writing out used to mean a queue, because a queue was the only place a
         * loop had to put anything. The usual answer now is the project, and a
         * placeholder that only suggests writing out gives the same nudge towards
         * the loop's own folder that the prompt itself was fixed to stop giving.
         */
        placeholder="What should this loop do every iteration? Say what to read, what one increment of work looks like, and where the work lands. Type @ to name a queue, a directory, a parameter or a tool."
        value={value}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onScroll={() => {
          sync();
          place();
        }}
        // Losing focus with a menu open is either a click elsewhere or a tab away;
        // both mean the menu is stale. A click on the menu itself never gets here,
        // because the rows refuse focus.
        onBlur={() => setMenu(null)}
        aria-autocomplete="list"
        aria-expanded={open}
      />

      {/*
        Portalled to the body, and this is the fix for a menu that was both clipped
        and painted under its neighbours.

        It has to leave the subtree. `.panel-top` is a size container, which means
        layout containment, which makes it a stacking context *and* the containing
        block for absolute children - so no `z-index` inside it could lift the menu
        over the settings row, and its `overflow-y: auto` cut the list short. Both
        are properties of the ancestor, not of the menu, so no amount of styling
        here could have answered either.

        Nothing about the interaction changes. The rows already refused focus with
        `preventDefault` on `mousedown`, precisely so the textarea's `onBlur` would
        not fire when one was clicked, and that works identically from a portal:
        focus never moves, so React's synthetic events still reach these handlers
        through the component tree they were written in, wherever the DOM node
        happens to live.
      */}
      {open &&
        pos &&
        createPortal(
        <ul className="ref-menu" style={{ top: pos.top, left: pos.left, maxHeight: pos.height }} role="listbox">
          {GROUPS.map((group) => {
            const items = shown.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <li className="ref-group" key={group}>
                <div className="ref-head">{group}</div>
                <ul>
                  {items.map((s) => {
                    const i = shown.indexOf(s);
                    return (
                      <li
                        key={s.token}
                        ref={i === index ? chosen : undefined}
                        className={`ref-item${i === index ? ' on' : ''}`}
                        role="option"
                        aria-selected={i === index}
                        // Focus never leaves the textarea, so the blur that would
                        // close the menu before the click landed never happens.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          accept(s);
                        }}
                        onMouseEnter={() => setActive(i)}
                      >
                        <span className={`ref-token ${s.cls}`}>{s.token}</span>
                        {s.hint && <span className="ref-hint">{s.hint}</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>,
          document.body,
        )}
    </div>
  );
}
