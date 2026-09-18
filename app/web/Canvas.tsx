/**
 * The canvas: loop boxes you can drag, and wires between them.
 *
 * Each box carries its name, a start/stop button and its iteration count. That is
 * the entire per-loop UI. Clicking a box selects it, which opens its prompt and
 * its output in the panel beside the canvas.
 *
 * Wiring is a drag from the dot on a loop's right edge to anywhere on another
 * loop. There is no port model: a loop has one input side and one output side,
 * and multiple wires can share either.
 *
 * A wire is drawn according to its mode, so the wiring can be read without
 * clicking through it. Queue wires out of one loop are one trunk that splits at a
 * junction, with a single count on it, because they are one folder being shared.
 * A topic wire is its own curve with its own count, drawn as a double rail because
 * every subscriber gets a copy. See `groupWires`.
 *
 * The canvas is a window onto an unbounded plane, not a fixed board: dragging the
 * background moves the window, and the wheel zooms it. Loop coordinates in the
 * document are world coordinates, and this component is the only place that knows
 * the difference between those and pixels on screen - `at()` converts a pointer
 * into the world, and one shared transform puts the world back on screen. So
 * dragging, wiring and hit-testing are written as if the old fixed board were
 * still there, and work at any zoom.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import {
  DEFAULT_VIEW,
  NODE_H,
  NODE_W,
  STACK_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  type View,
  clampZoom,
  frame,
  inAnchor,
  junction,
  outAnchor,
  stackDepth,
  stackOverhang,
  toWorld,
  trunkPath,
  viewTransform,
  viewTransformCss,
  wireMidpoint,
  wirePath,
  zoomAt,
} from './geometry.ts';
import {
  aggregate,
  intervalLabel,
  liveMembers,
  memberCount,
  type Factory,
  type Loop,
  type LoopStatus,
  type Selection,
  type Wire,
} from './types.ts';

interface Props {
  factory: Factory;
  status: Map<string, LoopStatus>;
  /** Outstanding item count per wire id. */
  queues: Record<string, number>;
  /**
   * What a loop runs on when it has not chosen, so the card can name it.
   *
   * A card says the model whether or not the loop pinned one - which model a loop
   * is on is worth reading at a glance, and "the default" is an answer the canvas
   * can only give if it is told what the default is. Absent when model discovery
   * found nothing, and then a loop with no model of its own shows none.
   */
  defaultModel?: string;
  /**
   * Bumped by the view when a document arrives carrying loops: frame them.
   *
   * A request rather than an instruction, and this component has the last word on it -
   * see the effect that reads it. Framing has to happen here because it needs the
   * surface's measured size, which nothing above this has.
   */
  fitOnLoad?: number;
  selected: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onChange: (factory: Factory) => void;
  /** Remove one wire, from the × at its arriving end. */
  onDeleteWire: (wireId: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  /** Kill the turn in flight on this component, rather than let it finish. */
  onForceStop: (id: string) => void;
  /**
   * Park a loop, or wake it. Only the card offers this, so the callback is only
   * needed here - see the button for why it lives nowhere else.
   */
  onDisable: (id: string, disabled: boolean) => void;
  /**
   * Told where the window is, so the toolbar can put a new loop where you are
   * looking rather than at world origin.
   *
   * A callback and not lifted state on purpose: the view changes on every frame of
   * a pan, and holding it above would re-render the whole panel - output log
   * included - at pointer speed. The parent is expected to stash it in a ref.
   */
  onView?: (view: View) => void;
  /**
   * A factory file dropped on the canvas. The canvas is where a factory is looked
   * at, so it is where one dragged out of a Finder window is expected to land -
   * the same import the tab strip's button does, without the file dialog. The
   * handler owns parsing and errors; the canvas only says a JSON file arrived.
   */
  onImportFile: (file: File) => void;
}

type Drag =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | { kind: 'wire'; from: string; x: number; y: number }
  /**
   * Moving the window. `from` is where on screen the press landed and `origin` is
   * where the window was at the time, both fixed for the gesture: the view is then
   * a function of the current pointer position rather than an accumulation of
   * deltas, so it cannot drift over a long drag.
   *
   * `moved` is what tells a pan from a click. A press on the background that goes
   * nowhere is still the way to clear the selection.
   */
  | { kind: 'pan'; from: { x: number; y: number }; origin: { x: number; y: number }; moved: boolean };

/** How far the pointer may travel before a background press stops being a click. */
const CLICK_SLOP = 3;

/** Where the window is remembered, per factory. */
const STORE_VIEW = 'canvas-view';

/**
 * Kiro Flock itself, which the badge on a flock cluster links to.
 *
 * The badge names something that exists outside this app, and the `local` on it is
 * an admission that what runs here is the small version - a ring of subprocesses
 * coordinating through a folder rather than a cluster of instances coordinating
 * through object storage. A name with no way to go and read about the thing it names
 * is the half of that admission that was missing.
 */
const FLOCK_URL = 'https://github.com/aws-samples/sample-kiro-flock/';

function storedView(factoryId: string): View {
  const raw = window.localStorage.getItem(`${STORE_VIEW}:${factoryId}`);
  if (raw === null) return DEFAULT_VIEW;
  try {
    const v = JSON.parse(raw) as Partial<View>;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.scale)) return DEFAULT_VIEW;
    return { x: v.x!, y: v.y!, scale: clampZoom(v.scale!) };
  } catch {
    return DEFAULT_VIEW;
  }
}

/**
 * How the wires out of a loop are drawn, which is the one place the mode is
 * visible without clicking anything.
 *
 * `single` is one curve from box to box: a topic wire, or a queue wire that
 * happens to be the only one on its queue. `shared` is the queue two or more
 * wires are sitting on, drawn as one trunk leaving the producer and splitting at a
 * junction. The shape is the claim: one backlog, several taps. Three separate
 * curves would say three backlogs, which is what this change was about.
 */
type Group = { kind: 'single'; wire: Wire } | { kind: 'shared'; from: string; wires: Wire[] };

function groupWires(wires: Wire[]): Group[] {
  const out: Group[] = [];
  const queues = new Map<string, Wire[]>();
  for (const w of wires) {
    if (w.mode === 'topic') {
      out.push({ kind: 'single', wire: w });
      continue;
    }
    const onQueue = queues.get(w.from) ?? [];
    onQueue.push(w);
    queues.set(w.from, onQueue);
  }
  for (const [from, onQueue] of queues) {
    // One tap is not a fan-out, so it keeps the plain shape. Drawing a trunk and a
    // single branch for it would put a kink in every ordinary wire on the canvas.
    out.push(onQueue.length === 1 ? { kind: 'single', wire: onQueue[0] } : { kind: 'shared', from, wires: onQueue });
  }
  return out;
}

/**
 * `3m`, `45m`, `2h`, `1.5h` - a time budget short enough for a chip on a card.
 *
 * Sub-hour values become minutes because the stepper's ladder starts at 0.05 of
 * an hour, and `0.05h` on a card is a number the reader has to do arithmetic on
 * before it means anything.
 */
function shortDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${Math.round(hours * 10) / 10}h`;
}

/**
 * How long is left of a timed run, beside the iteration count.
 *
 * A countdown rather than the end time, because the question a person has while
 * watching a factory is "how much longer", and an end time is that question
 * plus arithmetic against a clock they have to find. The end time is on the
 * tooltip for when the absolute answer is the one wanted.
 *
 * Its own component with its own interval, so the tick re-renders 30 characters
 * rather than the whole canvas: a second-by-second update at the Canvas level
 * would re-render every card and every wire, at speed, forever.
 *
 * The remaining time is derived from the server's absolute deadline on each
 * tick, so the display cannot drift from the machinery the way a locally
 * decremented number would after a tab sleep or a slow frame.
 */
function Countdown({ at, kind }: { at: number; kind: 'limit' | 'next' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = at - now;
  /*
   * Past zero, and the two kinds mean opposite things by it.
   *
   * A spent time limit is not a stopped loop - the check happens between turns, so
   * a long turn runs well past it - and "time up" is the honest reading: the budget
   * is gone, the loop ends when the turn in flight does. A due interval is the
   * happier case: the wait is over and the turn is opening, which is a moment, not
   * a state. Both beat a negative number or a bare zero.
   */
  if (left <= 0) {
    return kind === 'limit' ? (
      <span
        className="countdown spent"
        title="The time limit has passed. The loop stops when the turn in flight finishes."
      >
        time up
      </span>
    ) : (
      <span className="countdown due" title="The interval is up - the next turn is opening.">
        starting…
      </span>
    );
  }

  const secs = Math.floor(left / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  // Coarse when there is a lot left, fine when there is not: hours and minutes
  // above an hour, minutes and seconds below it, and seconds alone in the last
  // minute - which is the only point at which a second is worth reading.
  const text = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  /*
   * The words are what separate the two lines when a card is showing both, so they
   * carry the distinction rather than relying on position: "next turn in 4m 12s"
   * over "2h 30m left" reads correctly in either order, which a bare pair of
   * durations would not.
   */
  return kind === 'limit' ? (
    <span
      className="countdown"
      title={`Time limit reached at ${new Date(at).toLocaleTimeString()}. A turn already going is allowed to finish.`}
    >
      {text} left
    </span>
  ) : (
    <span
      className="countdown next"
      title={`Waiting out this loop's interval. The next turn opens at ${new Date(at).toLocaleTimeString()}, and Stop or a message to the loop cuts the wait short.`}
    >
      next turn in {text}
    </span>
  );
}

/** `A`, `A and B`, `A, B and C`. */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The badge tooltip, and the only explanation of the two modes on the canvas.
 *
 * Says what the count means rather than restating it, because the number is
 * already on screen and what an operator cannot see is whether it is one backlog
 * being shared or a copy of its own.
 */
function tipFor(mode: Wire['mode'], pending: number, readers: string[]): string {
  const items = `${pending} item${pending === 1 ? '' : 's'}`;
  if (mode === 'topic') {
    return `Topic: ${items} waiting for ${names(readers)}, its own copy of everything sent. Click the wire to switch it to a queue.`;
  }
  if (readers.length > 1) {
    return `Queue: ${items}, one backlog shared by ${names(readers)}. Each item goes to whichever takes it first. Click a wire to switch it to a topic.`;
  }
  return `Queue: ${items} waiting for ${names(readers)}. Wire another loop here and they share this backlog. Click the wire to switch it to a topic.`;
}

/** The queue depth, and the tooltip that says what kind of queue it is. */
function Count({
  at,
  pending,
  tip,
  onSelect,
}: {
  at: { x: number; y: number };
  pending: number;
  tip: string;
  /** Selecting the badge is selecting the wire: it is the wire's most visible part. */
  onSelect?: () => void;
}) {
  // Wide enough for the digits, so a three-figure backlog is not clipped.
  const w = Math.max(22, String(pending).length * 9 + 13);
  return (
    <g
      className="wire-count"
      transform={`translate(${at.x - w / 2} ${at.y - 10})`}
      onPointerDown={
        onSelect &&
        ((e) => {
          e.stopPropagation();
          onSelect();
        })
      }
    >
      {/* SVG has no title attribute; a <title> child is the tooltip. */}
      <title>{tip}</title>
      <rect width={w} height={20} rx={10} />
      <text x={w / 2} y={14}>
        {pending}
      </text>
    </g>
  );
}

/**
 * The × that removes one wire, sitting just before where it arrives.
 *
 * At the arriving end because that is the end that identifies the wire: several
 * wires leave a producer and they are drawn as one thing, so the only unambiguous
 * place to say "this branch" is where it lands. It is hidden until the wire is
 * hovered, which is what keeps a canvas of ten wires from being a canvas of ten
 * delete buttons.
 *
 * Deleting used to be a toolbar button acting on the selection, which stopped
 * working once selecting a wire came to mean selecting the whole fan-out: the
 * toolbar could no longer tell which branch was meant. That button now removes all
 * of them, and this is how a single one goes.
 */
function Unwire({
  at,
  label,
  onDelete,
  onHover,
}: {
  /** The loop's input dot, which the × covers exactly. */
  at: { x: number; y: number };
  label: string;
  onDelete: () => void;
  /**
   * Keeps the hover alive while the pointer is on the ×.
   *
   * The × lives in a different layer from the wire that summoned it, so moving onto
   * it is leaving the wire. Without this it would vanish from under the pointer on
   * the way to being clicked.
   */
  onHover: (hovering: boolean) => void;
}) {
  return (
    <g
      className="wire-x"
      transform={`translate(${at.x} ${at.y})`}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerDown={(e) => {
        e.stopPropagation();
        onDelete();
      }}
    >
      <title>{label}</title>
      {/* Filled, so the × reads against the dot and the card it sits on. */}
      <circle r={9} />
      <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />
    </g>
  );
}

export function Canvas({
  factory,
  status,
  queues,
  defaultModel,
  fitOnLoad = 0,
  selected,
  onSelect,
  onChange,
  onDeleteWire,
  onStart,
  onStop,
  onForceStop,
  onDisable,
  onView,
  onImportFile,
}: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** A file from outside is being dragged over the canvas, so say it will land. */
  const [dropping, setDropping] = useState(false);
  /**
   * The one wire under the pointer, which is the only wire showing its ×.
   *
   * State rather than a CSS `:hover`, for two reasons that both come from where the
   * × has to be. It sits on the consumer's input dot, and that dot is part of the
   * loop card - which is a later layer than the wire SVG and paints over it, so an ×
   * drawn with its wire would be half-covered by the card. It therefore lives in an
   * overlay above the cards, which puts it outside the group a CSS hover could key
   * off. And keying off the group was wrong anyway: a shared queue draws its
   * branches inside one `.wire`, so hovering anywhere on it revealed every branch's
   * × at once. One id can only ever mean one wire.
   */
  const [hoverWire, setHoverWire] = useState<string | null>(null);
  /**
   * Where the window is. Restored per factory, because which corner of a large
   * design you were working on is part of where you left off - and a canvas that
   * jumps back to the origin on every reload is one you re-pan every time.
   */
  const [view, setView] = useState<View>(() => storedView(factory.id));

  /** A pointer event as a point on the canvas, in screen pixels from its corner. */
  const screenAt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = surface.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  /** A pointer event as a point in the world, which is what loops are placed in. */
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } =>
    toWorld(view, screenAt(e));

  /** Zoom by a step, about the middle of the window - what the +/- buttons do. */
  const zoomBy = (factor: number): void => {
    const box = surface.current?.getBoundingClientRect();
    setView((v) =>
      zoomAt(v, { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 }, v.scale * factor),
    );
  };

  const fitAll = (): void => {
    const box = surface.current?.getBoundingClientRect();
    setView(frame(factory.loops, { width: box?.width ?? 0, height: box?.height ?? 0 }));
  };

  /**
   * Frame a design the first time it arrives, when there is no window to restore.
   *
   * A factory taken out of the library brings its loops at whichever coordinates they
   * had on somebody else's canvas, and the default window is the world origin - so
   * without this, a design laid out a few hundred pixels in opens half off the corner
   * of the screen, and the first thing anyone has to do is press Fit. Importing a file
   * and opening a folder land in exactly the same place, so all three are covered by
   * the same rule rather than by three special cases.
   *
   * Two guards, and both are the point.
   *
   * A remembered window wins. `storedView` restores the corner you were working in, and
   * that is a deliberate choice this must not overrule: on a factory you have opened
   * before, being re-framed on every reload would undo the panning every time. Read at
   * mount, because the effect below is about to write one.
   *
   * And it happens once. After the first frame the window belongs to whoever is
   * driving - a second document arriving, from a save or another tab's edit, is not a
   * reason to move the camera out from under them.
   *
   * `useLayoutEffect` so the framing is painted with the loops rather than one frame
   * after them, which would show as the canvas visibly jumping on open.
   */
  const [hadView] = useState(
    () => window.localStorage.getItem(`${STORE_VIEW}:${factory.id}`) !== null,
  );
  const framed = useRef(false);
  useLayoutEffect(() => {
    if (hadView || framed.current || fitOnLoad === 0 || factory.loops.length === 0) return;
    framed.current = true;
    fitAll();
    // `fitAll` reads the loops and the surface, neither of which belongs in a
    // dependency list that is deliberately only about the request arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitOnLoad, hadView, factory.loops.length]);

  /*
   * Wheel to pan, ctrl or pinch to zoom.
   *
   * A native listener rather than React's `onWheel`, because React attaches wheel
   * handlers passively and a passive handler cannot call `preventDefault` - and
   * without that, ctrl-wheel and a trackpad pinch are taken by the browser to zoom
   * the page. macOS reports a pinch as a wheel event with `ctrlKey` set, which is
   * why the same branch serves both gestures.
   */
  useEffect(() => {
    const el = surface.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const s = { x: e.clientX - box.left, y: e.clientY - box.top };
      setView((v) =>
        e.ctrlKey || e.metaKey
          ? // Exponential so a notch is a constant ratio rather than a constant
            // number of pixels: zooming out then in returns you where you started.
            zoomAt(v, s, v.scale * Math.exp(-e.deltaY / 300))
          : { ...v, x: v.x + e.deltaX / v.scale, y: v.y + e.deltaY / v.scale },
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Written after things settle, not on every frame of a pan: localStorage is
  // synchronous, and there is nothing to be gained from recording a window the
  // pointer is still moving.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(`${STORE_VIEW}:${factory.id}`, JSON.stringify(view));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [factory.id, view]);

  useEffect(() => {
    onView?.(view);
  }, [onView, view]);

  const loopAt = (x: number, y: number): Loop | undefined =>
    // Reversed so the topmost box wins when two overlap. A cluster's rect includes
    // the boxes stacked behind it, which are as droppable as the front one - they
    // are the same component, and a wire dropped on a visible part of it should
    // land rather than fall through to the canvas.
    [...factory.loops]
      .reverse()
      .find(
        (l) =>
          x >= l.x &&
          x <= l.x + NODE_W + stackOverhang(l) &&
          y >= l.y &&
          y <= l.y + NODE_H + stackOverhang(l),
      );

  function onPointerMove(e: React.PointerEvent): void {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const s = screenAt(e);
      // The window moves opposite the pointer - you are dragging the paper, not the
      // camera - and the screen delta is divided by the scale to become a world one.
      setView((v) => ({
        ...v,
        x: drag.origin.x + (drag.from.x - s.x) / v.scale,
        y: drag.origin.y + (drag.from.y - s.y) / v.scale,
      }));
      if (!drag.moved && Math.hypot(s.x - drag.from.x, s.y - drag.from.y) > CLICK_SLOP) {
        setDrag({ ...drag, moved: true });
      }
      return;
    }
    const p = at(e);
    if (drag.kind === 'move') {
      onChange({
        ...factory,
        loops: factory.loops.map((l) =>
          l.id === drag.id ? { ...l, x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) } : l,
        ),
      });
    } else {
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  }

  function onPointerUp(e: React.PointerEvent): void {
    // A press on the background that never went anywhere is a click, and a click on
    // the background clears the selection. Dragging the canvas must not, or every
    // pan would close the panel you were reading.
    if (drag?.kind === 'pan' && !drag.moved) onSelect(null);
    if (drag?.kind === 'wire') {
      const p = at(e);
      const target = loopAt(p.x, p.y);
      // No self-wires, and no duplicate of a connection that already exists.
      const exists = factory.wires.some((w) => w.from === drag.from && w.to === target?.id);
      if (target && target.id !== drag.from && !exists) {
        onChange({
          ...factory,
          wires: [
            ...factory.wires,
            // A new wire takes the mode its producer already has, and is a queue
            // only when it is the producer's first: wire a second loop to a fresh
            // producer and the two share one backlog, which is the common case and
            // the right default. But the mode is a property of the whole fan-out -
            // every wire out of one loop carries the same value - so a wire drawn
            // onto a producer that already broadcasts has to arrive as a topic.
            // It used to arrive as a queue regardless; the server normalised the
            // mixed document to all-topic and stored that, this view kept its own
            // copy, and the panel then described one wire as a queue that on disk
            // was a topic, until a reload.
            {
              id: `${drag.from}-${target.id}-${Date.now().toString(36)}`,
              from: drag.from,
              to: target.id,
              mode: factory.wires.find((w) => w.from === drag.from)?.mode ?? ('queue' as const),
            },
          ],
        });
      }
    }
    setDrag(null);
  }

  const byId = new Map(factory.loops.map((l) => [l.id, l]));

  /**
   * The producer whose fan-out is selected, if any.
   *
   * Selection is still one wire - that is what a click lands on and what the panel
   * is opened for - but what gets drawn as selected is every wire out of the same
   * loop. See `isSelected` below.
   */
  const selectedFrom =
    selected?.kind === 'wire'
      ? factory.wires.find((w) => w.id === selected.id)?.from
      : undefined;

  return (
    <div
      className={`canvas${drag?.kind === 'pan' ? ' panning' : ''}${dropping ? ' dropping' : ''}`}
      ref={surface}
      /*
       * A factory file can be dropped straight onto the canvas. Only drags that
       * carry files are claimed - `preventDefault` on dragover is what makes an
       * element a drop target at all, so a drag of anything else falls through to
       * the browser untouched. Which file it is stays unknown until the drop:
       * during the drag the browser reports types but not names, so a .txt lights
       * the canvas up too, and is refused with a message only when it lands.
       */
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Leaving to a child fires this too; only leaving the canvas itself counts.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        const file =
          files.find(
            (f) => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json',
          ) ?? files[0];
        if (file) onImportFile(file);
      }}
      // The dot grid is the only thing that shows the window moving over empty
      // space, so it is drawn in world terms too: spacing scales with the zoom and
      // the pattern is offset by wherever the window is.
      style={{
        backgroundSize: `${22 * view.scale}px ${22 * view.scale}px`,
        backgroundPosition: `${-view.x * view.scale}px ${-view.y * view.scale}px`,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // A pan holds the pointer, so it survives leaving the canvas; the other two
      // drags do not, and are still abandoned at the edge.
      onPointerLeave={() => {
        if (drag?.kind !== 'pan') setDrag(null);
      }}
      onPointerDown={(e) => {
        // Only presses on the background: the cards and the wire hit-paths stop
        // their own events, and the layers between them take no pointer events at
        // all, so anything arriving here landed on empty canvas.
        if (e.target !== surface.current) return;
        // Captured so a fast drag keeps panning once the pointer is over a card, or
        // outside the window entirely.
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({
          kind: 'pan',
          from: screenAt(e),
          origin: { x: view.x, y: view.y },
          moved: false,
        });
      }}
    >
      <svg className="wires">
        <g transform={viewTransform(view)}>
        {groupWires(factory.wires).map((group) => {
          /*
           * Selecting a wire lights up the whole fan-out it belongs to.
           *
           * The mode is a property of the producer, so its wires are one thing, and
           * the panel shows all of them together - highlighting only the branch that
           * was clicked said the opposite, and made a mode change look like it had
           * applied to one of three. A shared queue already drew itself as a group
           * for this reason; a topic now reads the same way.
           */
          const nameOf = (id: string): string => byId.get(id)?.name ?? id;
          const isSelected = (w: Wire): boolean => selectedFrom !== undefined && w.from === selectedFrom;

          if (group.kind === 'single') {
            const w = group.wire;
            const from = byId.get(w.from);
            const to = byId.get(w.to);
            if (!from || !to) return null;
            const a = outAnchor(from);
            const b = inAnchor(to);
            const d = wirePath(a, b);
            const pending = queues[w.id] ?? 0;
            return (
              <g
                key={w.id}
                className={`wire ${w.mode}${pending > 0 ? ' has-work' : ''}${isSelected(w) ? ' selected' : ''}`}
              >
                <path className="wire-line" d={d} />
                {/* A topic delivers a copy per subscriber, so it is drawn as two
                    rails: the thin background-coloured line splits the thick one. */}
                {w.mode === 'topic' && <path className="wire-core" d={d} />}
                {/* Items on the move, only while there are any. */}
                <path className="wire-flow" d={d} />
                {/*
                  The fat transparent copy is what you actually hit: it is the only
                  part of a 2px curve a pointer can reasonably land on. Deleting a
                  wire moved to the panel, so a click here selects rather than
                  destroys.
                */}
                <path
                  className="wire-hit"
                  d={d}
                  onPointerEnter={() => setHoverWire(w.id)}
                  onPointerLeave={() => setHoverWire((h) => (h === w.id ? null : h))}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect({ kind: 'wire', id: w.id });
                  }}
                />
                <Count
                  at={wireMidpoint(a, b)}
                  pending={pending}
                  tip={tipFor(w.mode, pending, [nameOf(w.to)])}
                  onSelect={() => onSelect({ kind: 'wire', id: w.id })}
                />
              </g>
            );
          }

          const producer = byId.get(group.from);
          if (!producer) return null;
          const a = outAnchor(producer);
          const j = junction(producer);
          const trunk = trunkPath(a, j);
          // Every wire here is the same folder, so they all report the same depth.
          const pending = queues[group.wires[0].id] ?? 0;
          const readers = group.wires.map((w) => nameOf(w.to));
          return (
            <g
              key={`q-${group.from}`}
              className={`wire queue shared${pending > 0 ? ' has-work' : ''}${
                group.wires.some((w) => isSelected(w)) ? ' selected' : ''
              }`}
            >
              <path className="wire-line" d={trunk} />
              <path className="wire-flow" d={trunk} />
              {group.wires.map((w) => {
                const to = byId.get(w.to);
                if (!to) return null;
                const end = inAnchor(to);
                const d = wirePath(j, end);
                return (
                  <g key={w.id} className={`branch${isSelected(w) ? ' selected' : ''}`}>
                    <path className="wire-line" d={d} />
                    <path className="wire-flow" d={d} />
                    <path
                      className="wire-hit"
                      d={d}
                      onPointerEnter={() => setHoverWire(w.id)}
                      onPointerLeave={() => setHoverWire((h) => (h === w.id ? null : h))}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onSelect({ kind: 'wire', id: w.id });
                      }}
                    />
                  </g>
                );
              })}
              {/* One badge, on the junction, because there is one backlog. The
                  backlog is not a wire, so the badge selects the first branch -
                  arbitrary among equals, and the panel it opens describes the
                  shared queue either way. */}
              <Count
                at={j}
                pending={pending}
                tip={tipFor('queue', pending, readers)}
                onSelect={() => onSelect({ kind: 'wire', id: group.wires[0]!.id })}
              />
            </g>
          );
        })}
        {drag?.kind === 'wire' && byId.get(drag.from) && (
          <path
            className="wire-draft"
            d={wirePath(outAnchor(byId.get(drag.from)!), { x: drag.x, y: drag.y })}
          />
        )}
        </g>
      </svg>

      {/*
        The cards, carried by the same transform as the wires.
        
        A layer of its own rather than transforming each card, so a pan is one
        composited move instead of one style write per loop. It takes no pointer
        events, which is what leaves the background underneath pressable for a pan;
        the cards switch them back on for themselves.
      */}
      <div className="canvas-space" style={{ transform: viewTransformCss(view) }}>
      {factory.loops.map((loop) => {
        /*
         * One status for the whole component, collapsed from its members'.
         *
         * A card is a component, so everything below reads the aggregate rather
         * than a runner: a plain loop's aggregate is its own single status, so this
         * changes nothing for one, and a cluster's is the most-alive member's state
         * with the members' iterations summed. See `aggregate` for the two rules
         * and why they are those.
         */
        const agg = aggregate(loop, status);
        const state = agg.state;
        const running = state === 'running';
        // Paused is live, so the button stays Stop: the loop is waiting for an item
        // and Start would be offering to do something it is already doing.
        const live = state !== 'stopped';
        /*
         * Which kind of pause this is, for the two beacons that report one each.
         *
         * Both false on a running or stopped card, and both false on a paused
         * cluster whose members disagree about why - see `aggregate`. That is the
         * quiet case on purpose: a grey mark still says the setting is on, and
         * lighting the wrong beacon would be worse than lighting neither.
         */
        const starved = state === 'paused' && agg.pausedFor === 'work';
        const idling = state === 'paused' && agg.pausedFor === 'interval';
        const iteration = agg.iteration;
        const deadlineAt = agg.deadlineAt;
        const nextTurnAt = agg.nextTurnAt;
        const hasIn = factory.wires.some((w) => w.to === loop.id);
        const hasOut = factory.wires.some((w) => w.from === loop.id);
        const total = memberCount(loop);
        const running_members = liveMembers(loop, status);
        const flock = loop.cluster?.comms === 'flock';
        return (
          <div
            key={loop.id}
            className={`loop${running ? ' running' : ''}${state === 'paused' ? ' paused' : ''}${state === 'stopping' ? ' stopping' : ''}${loop.disabled ? ' disabled' : ''}${selected?.kind === 'loop' && selected.id === loop.id ? ' selected' : ''}${loop.cluster ? ' cluster' : ''}${flock ? ' flock' : ''}`}
            // Min rather than fixed height: a chip row that wraps grows the box
            // instead of being clipped by it. The wire ports stay pinned to the
            // standard height's midline, which is where geometry.ts attaches the
            // curves regardless of how tall the box actually got - hence handing
            // the stylesheet the constant rather than letting it guess with `50%`.
            style={
              {
                left: loop.x,
                top: loop.y,
                width: NODE_W,
                minHeight: NODE_H,
                '--node-h': `${NODE_H}px`,
                /*
                 * The stack is drawn by the stylesheet off these two, from boxes
                 * behind the card rather than boxes beside it - see `.loop.cluster`
                 * and the `--stack-*` custom properties there. Kept here as numbers
                 * because the depth is a document fact and the step is a geometry
                 * constant, and CSS should not be the place either is decided.
                 */
                /*
                 * Deliberately no extra padding for the stack.
                 *
                 * An earlier version grew the card by the overhang so the exposed
                 * slivers behind it would be draggable. Under the global
                 * `box-sizing: border-box` that does the opposite of what it looks
                 * like: `width` is the border box, so padding comes *out* of the
                 * content, and a five-deep cluster was laying its name and chips
                 * out in 28px less room than a plain loop - the one visible effect
                 * being cluster cards that wrapped their chip row sooner.
                 *
                 * The slivers being outside the drag handle costs nothing worth
                 * that: the card is 248 by 132 of grab area against a 7px strip,
                 * and `loopAt` counts the full extent anyway, so a wire dropped on
                 * the stack still lands.
                 */
                ...(loop.cluster
                  ? {
                      '--stack-depth': stackDepth(loop),
                      '--stack-step': `${STACK_STEP}px`,
                    }
                  : {}),
              } as React.CSSProperties
            }
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect({ kind: 'loop', id: loop.id });
              const p = at(e);
              setDrag({ kind: 'move', id: loop.id, dx: p.x - loop.x, dy: p.y - loop.y });
            }}
          >
            {/*
              The Kiro Flock badge, above the title and half outside the card.
              
              Only on a cluster whose members talk to each other, because it is
              saying something specific and rare: these agents are reading each
              other. Every other setting on a card is a grey chip in the row below,
              and this deliberately is not one of those - a chip among chips would
              file "the members coordinate" alongside "the tools are narrowed",
              which is the wrong weight by a long way.
              
              `local` is the part that keeps it honest. Kiro Flock proper is a
              cluster of EC2 instances coordinating through S3; this is a ring of
              subprocesses coordinating through a folder. Same idea, same name, and
              the small grey word is what stops the badge overclaiming.
              
              Which is why it is a link. The badge names a thing that exists
              elsewhere, and `local` is a claim about the difference between the two -
              both of those are only checkable if there is somewhere to go and check,
              so the badge goes there. A new tab: the factory it was clicked from is
              still running.
            */}
            {flock && (
              <a
                className="flock-badge"
                href={FLOCK_URL}
                target="_blank"
                rel="noreferrer"
                title={'Kiro Flock local: amorphous computing cluster\n\nOpens the project on GitHub.'}
                // The card's own press selects the loop and arms a drag. Stopped
                // here, the same way every other control on a card stops it: this
                // is a link, and a click on it is going somewhere rather than
                // picking the component up.
                onPointerDown={(e) => e.stopPropagation()}
                // An anchor is natively draggable, which on this canvas means a
                // press that misses being a click starts the browser's own link
                // drag - ghost image, drop target highlighting and all - over a
                // surface that already listens for dropped factory files.
                draggable={false}
              >
                <span className="flock-kiro">Kiro</span>
                <span className="flock-flock">flock</span>
                <span className="flock-local">local</span>
              </a>
            )}
            {/*
              The boxes behind the front one, one per member up to the cap.
              
              Real elements rather than a pair of pseudo-elements, because the depth
              varies and `::before`/`::after` can only ever draw two. Inert to the
              pointer and hidden from the reader: they carry no content and say
              nothing a screen reader needs, since the count is in the chip row and
              in the panel as words.
              
              Drawn first so they paint underneath the card's own background, which
              is what makes the front box read as the front box.
            */}
            {loop.cluster &&
              /*
               * Deepest box first, and the order is not cosmetic.
               *
               * They all sit at the same z-index, so tree order decides which paints
               * on top, and each one has an opaque background. Rendered nearest-first
               * the deepest box painted last and covered its shallower siblings -
               * leaving of each only the few pixels the box in front had not reached
               * yet, which reads as a set of broken top-left corners with no bottom
               * or right edges at all.
               *
               * Reversed, the nearest box is topmost and each deeper one shows
               * exactly the band it reaches past the one in front: four clean stepped
               * edges instead of four fragments. Doing it here rather than with a
               * computed z-index per box keeps the whole rule "later is nearer",
               * which is the one CSS already applies to siblings.
               */
              Array.from({ length: stackDepth(loop) - 1 }, (_, i) => stackDepth(loop) - 1 - i).map(
                (depth) => (
                  <span
                    key={depth}
                    className="stack-box"
                    aria-hidden="true"
                    style={{ '--i': depth } as React.CSSProperties}
                  />
                ),
              )}
            {/*
              The stack is not the whole story: there are more members than boxes.
              
              An ellipsis on the deepest box, shown only past the cap. Six offset
              rectangles do not read as six - nobody counts overlapping edges - so
              past five the drawing stops growing and says "and more" instead, with
              the exact number in the chip row above. Two ways of saying it, each
              doing what it is good at: the stack for the glance, the chip for the
              count.
            */}
            {loop.cluster && total > stackDepth(loop) && (
              <span className="stack-more" aria-hidden="true">
                …
              </span>
            )}
            {/*
              The loop icon: circular arrows, the same glyph the toolbar's Add loop
              uses. It spins while the loop runs, which is the one place in the app
              where an icon is doing more than labelling - the box already says
              `running` through its border, and this says it at a glance from across
              the canvas.

              A waiting loop keeps the coloured border and loses the spin, which is
              the distinction that matters: it is live, and it is not working.
            */}
            <div className="loop-name" title={loop.name}>
              {/*
                A cluster wears the cluster glyph instead of the loop's circular
                arrows, and it does not spin. The spin means "a turn is in flight",
                which is a true thing to say about one session and a muddle about
                five: with three members working and two waiting there is no single
                answer for one glyph to give. What the card says instead is the
                honest version - `3 of 5` in the chip row, counted.
              */}
              <Icon name={loop.cluster ? 'cluster' : 'hero-arrow-path'} className="loop-icon" />
              <span className="loop-label">{loop.name}</span>
              {/*
                Disable, top right of the card and nowhere else.
                
                Only here on purpose: it is not a property of the design the way
                the run mode is, it is a hand on one box saying "not this one, not
                now". Putting it in the settings row would file it with the
                decisions that get exported and shared; on the card it sits with
                Start and Stop, which is the company it keeps.
              */}
              <button
                className={`loop-disable${loop.disabled ? ' on' : ''}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onDisable(loop.id, !loop.disabled)}
                title={
                  loop.disabled
                    ? 'Disabled: left out of Start and Run all. Click to enable.'
                    : 'Disable: the loop stays on the floor, wired and editable, but no Start will run it.'
                }
                aria-label={loop.disabled ? 'Enable loop' : 'Disable loop'}
              >
                <Icon name="hero-power" />
              </button>
            </div>
            {/*
              The model, on a row of its own under the name.
              
              Not in the title row, where it competed with the name for width and
              truncated one of them, and not among the chips below, where it is
              several times longer than any of them and pushed them out of the box.
              A line to itself is the only place a model id fits at full length.

              Shown for every loop, pinned or not, because "which model" is worth
              reading at a glance and a blank space is not an answer. A loop
              running the default is dimmed, so the card still distinguishes a
              choice from an inheritance.
            */}
            {(loop.model ?? defaultModel) !== undefined && (
              <span
                className={`loop-model${loop.model === undefined ? ' inherited' : ''}`}
                title={
                  loop.model === undefined
                    ? `Runs on ${defaultModel}, the default for this machine. Pick a model in the panel to pin one.`
                    : `Runs on ${loop.model}.`
                }
              >
                {loop.model ?? defaultModel}
              </span>
            )}
            {/*
              What is set on this loop, visible without opening the panel.

              Only departures from the defaults are marked: a trusted, always-on,
              default-model loop - the common case - shows nothing, so a marker on
              a card always means someone chose something. The lock is the one
              that must not be missable: it says this loop's tools are scoped.
            */}
            {(loop.cluster !== undefined ||
              loop.mcp !== undefined ||
              loop.tools !== undefined ||
              loop.worktree === true ||
              loop.autoPause ||
              loop.autoStop ||
              loop.stopAfterIterations !== undefined ||
              loop.stopAfterHours !== undefined ||
              loop.intervalSeconds !== undefined) && (
              <div className="loop-marks">
                {/*
                  How many members, and how many of them are up.
                  
                  First in the row because it is the one chip that says what the
                  component *is* rather than how it is configured - everything else
                  here is a departure from a default, and this is the subject those
                  departures are about.

                  Two tones, like `waits` and `ends`: grey for the setting, green
                  while members are actually running. `3 of 5` counts, which is the
                  answer the stack of boxes cannot give - the stack tops out at five
                  and says "several", and this says how many. A scaled cluster reads
                  `3 of 5 max`, because for that mode five is a ceiling rather than a
                  count and a bare `3 of 5` would look like two members had failed.
                */}
                {loop.cluster !== undefined && (
                  <span
                    className={`mark mark-cluster${running_members > 0 ? ' mark-cluster-live' : ''}`}
                    title={
                      loop.cluster.mode === 'scaled'
                        ? `Auto scaled: one node per waiting item, up to ${total}. ${running_members} live now.`
                        : `${total} nodes, each an agent session running this prompt. ${running_members} live now.`
                    }
                  >
                    <Icon name="cluster" />
                    {running_members > 0 ? `${running_members} of ${total}` : `${total}`}
                    {loop.cluster.mode === 'scaled' ? ' max' : ''}
                  </span>
                )}
                {/*
                  Each session works in its own checkout. On the card because two
                  identically configured loops would otherwise be indistinguishable
                  here, and this is the more expensive one - in disk, in first-start
                  time, and in where its work ends up (its own branches, not the
                  factory's directory).
                */}
                {loop.worktree === true && (
                  <span
                    className="mark mark-mcp"
                    title={
                      loop.cluster !== undefined
                        ? `Each of the ${loop.cluster.size} sessions works in its own checkout of the repository, committing to its own branch.`
                        : 'Works in its own checkout of the repository, committing to its own branch.'
                    }
                  >
                    <Icon name="branch" />
                    worktree
                  </span>
                )}
                {loop.mcp !== undefined && (
                  <span
                    className="mark mark-mcp"
                    title="MCP access is scoped: the agent gets only the servers granted in the panel, plus any the prompt names."
                  >
                    <Icon name="hero-lock-closed" />
                    mcp
                  </span>
                )}
                {loop.tools !== undefined && (
                  <span
                    className="mark mark-mcp"
                    title={`Built-in tools are narrowed: ${loop.tools.length === 0 ? 'none granted' : loop.tools.join(', ')}.`}
                  >
                    <Icon name="hero-wrench" />
                    tools
                  </span>
                )}
                {loop.autoPause && (
                  /*
                    Same two-tone beacon as "ends" below: grey is the setting,
                    colour is the event. Green and breathing while the loop is
                    actually paused on an empty queue, because unlike the yellow
                    one this is a live state - the loop is up and will move the
                    moment an item lands.

                    The cause is checked as well as the state, because a loop can
                    also be paused sitting out its interval and this beacon must
                    not claim the queue is empty when it is not the reason.
                  */
                  <span
                    className={`mark${starved ? ' mark-waiting-now' : ''}`}
                    title={
                      starved
                        ? 'Waiting for work now - nothing on the incoming queue. Resumes by itself when an item lands.'
                        : 'Waits for work instead of taking a turn on an empty queue.'
                    }
                  >
                    <Icon name="hero-pause" />
                    waits
                  </span>
                )}
                {loop.intervalSeconds !== undefined && (
                  /*
                    The interval, in the same two tones as the beacons either side:
                    grey is the setting, green and breathing is the loop actually
                    sitting out the gap right now.

                    Its own mark rather than a note on "waits", because they are
                    different settings that happen to look alike from outside - one
                    waits for something to arrive, the other waits for a clock - and
                    a loop with both would otherwise have no way to say so. It earns
                    the room: a loop idling an hour between turns looks stalled, and
                    this is the only thing on a quiet canvas that says it is not.
                  */
                  <span
                    className={`mark${idling ? ' mark-waiting-now' : ''}`}
                    title={
                      idling
                        ? `Idling between turns - the next one opens after ${intervalLabel(loop.intervalSeconds)}. Stop or a message to the loop cuts the wait short.`
                        : `Leaves ${intervalLabel(loop.intervalSeconds)} between turns. Taken after a turn, so Start still runs one straight away.`
                    }
                  >
                    <Icon name="hero-clock" />
                    {intervalLabel(loop.intervalSeconds)}
                  </span>
                )}
                {(loop.autoStop ||
                  loop.stopAfterIterations !== undefined ||
                  loop.stopAfterHours !== undefined) && (
                  /*
                    One mark for all three stop modes, in two tones. Grey is the
                    setting - this loop ends on its own terms - and the label says
                    which terms. Yellow is the event: it did, and the colour holds
                    until the next start so someone walking back to a quiet canvas
                    can tell a loop that finished from one a person stopped.
                  */
                  <span
                    className={`mark${agg.autoStopped ? ' mark-auto-stopped' : ''}`}
                    title={
                      agg.autoStopped
                        ? 'Stopped itself. Start clears this.'
                        : loop.stopAfterIterations !== undefined
                          ? `Stops after ${loop.stopAfterIterations} turns of a run.`
                          : loop.stopAfterHours !== undefined
                            ? `Stops ${shortDuration(loop.stopAfterHours)} after Start.`
                            : 'May stop itself: the agent declares there is no further work, then confirms it on one more turn.'
                    }
                  >
                    <Icon name="hero-stop" />
                    {loop.stopAfterIterations !== undefined
                      ? `${loop.stopAfterIterations} turns`
                      : loop.stopAfterHours !== undefined
                        ? shortDuration(loop.stopAfterHours)
                        : 'ends'}
                  </span>
                )}
              </div>
            )}
            <div className="loop-foot">
              {/*
                Start is disabled on a parked loop rather than hidden: the button
                is where the operator looks to find out whether a loop runs, and a
                greyed one that says why answers that. Stop stays live regardless -
                a loop disabled while running is still running, and taking away the
                way to stop it would be the one genuinely unhelpful reading of
                "disabled".
              */}
              <button
                className={`${live ? 'stop' : 'start'} with-icon`}
                disabled={!live && loop.disabled}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => (live ? onStop(loop.id) : onStart(loop.id))}
                title={!live && loop.disabled ? 'This loop is disabled. Enable it to start it.' : undefined}
              >
                <Icon name={live ? 'hero-stop' : 'hero-play'} />
                {live ? 'Stop' : 'Start'}
              </button>
              {/*
                Force stop, for this component only. The toolbar's bolt with a
                smaller blast radius: same glyph, same red, same icon-only shape,
                because it is the same act and an operator who has learned the one
                on the toolbar should not have to learn this one.
                
                Beside Stop rather than replacing it, and the pair is the point: Stop
                is what you press, and the bolt is what you press when Stop is taking
                longer than you can wait. A turn deep in an edit can run for minutes,
                and until now the only way out of one loop's long turn was to force
                stop the entire factory - every other loop's turn killed to get at the
                one that would not finish.
                
                Rendered always and disabled when there is nothing to kill, which is
                the rule Start follows on a parked loop three lines up: the row is
                where the operator looks to find out what a component can be told, and
                a button that appears only once it is needed is a button nobody knows
                is there. It also keeps the iteration count from jumping sideways every
                time a loop starts.
              */}
              <button
                className="icon-only force-stop"
                disabled={!live}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onForceStop(loop.id)}
                title={
                  live
                    ? // Says what it does and what it costs, which is the whole
                      // reason this is not simply a second Stop. The member count is
                      // in it because sixteen killed turns are sixteen folders that
                      // could hold half-written work, not one.
                      `Force stop: kill the turn${total > 1 ? 's' : ''} in flight now. ${
                        total > 1 ? `All ${total} nodes go together. ` : ''
                      }A killed agent can leave half-finished work on disk.`
                    : 'Nothing running to force stop'
                }
                aria-label="Force stop"
              >
                <Icon name="hero-bolt" />
              </button>
              {/*
                The iteration count is where the loop says what it is doing, so the
                wait goes here rather than in a badge of its own. `#3 waiting` reads
                as one fact - three turns done, none in progress - which is what a
                separate label next to the number would have to be read as anyway.
              */}
              <span className="iteration">
                {iteration > 0 ? `#${iteration}` : ''}
                {/*
                  Paused used to say "waiting" here as well. The waits mark above
                  now carries that - green and breathing while the pause is live -
                  and one beacon saying it is enough.
                */}
                {/*
                  The clocks, beside the count of turns spent: how long until the
                  next turn, and how much of a timed run is left.

                  Beside the iteration count because all three answer the same
                  shape of question - how far through is this - so they belong on
                  one reading rather than in a chip above.

                  Stacked when both are present, next turn on top. That order is
                  nearest-first: the interval resolves in seconds or minutes and the
                  run's deadline in hours, so the number that is about to change
                  leads and the slow one sits under it. A column rather than a
                  wrapped row, because two durations flowing into each other on one
                  line is a single unreadable string of digits; with only one clock
                  showing it collapses to exactly the line it always was.
                */}
                {(nextTurnAt !== undefined || deadlineAt !== undefined) && (
                  <span className="clocks">
                    {nextTurnAt !== undefined && <Countdown at={nextTurnAt} kind="next" />}
                    {deadlineAt !== undefined && <Countdown at={deadlineAt} kind="limit" />}
                  </span>
                )}
                {/*
                  The drain, said where the loop says everything else. The output
                  log already carries "stopping after this turn"; without this the
                  box read `stopped` for the whole drain, which for a long turn
                  looked like a Stop button that worked instantly on a loop that
                  visibly kept going.
                */}
                {state === 'stopping' && (
                  <span className="shutting-down">final iteration, shutting down gracefully</span>
                )}
              </span>
            </div>
            {/*
              The input dot is the counterpart of the output dot, so a box reads as
              something with a left side that receives and a right side that sends,
              rather than a box with one unexplained dot on it.

              Purely a marker: it takes no pointer events, and it does not need to.
              A wire is dropped on a loop by coordinate (see `loopAt`), not by
              hitting a target, so the whole box is the drop area and this dot only
              says where the wire will land.
            */}
            <div className={`port-in${hasIn ? ' wired' : ''}`} />
            <div
              className={`port-out${hasOut ? ' wired' : ''}`}
              title="Drag to another loop to wire them"
              onPointerDown={(e) => {
                e.stopPropagation();
                const p = at(e);
                setDrag({ kind: 'wire', from: loop.id, x: p.x, y: p.y });
              }}
            />
          </div>
        );
      })}
      </div>

      {/*
        The × that unwires, in a layer of its own above the cards.
        
        It has to be above them, because it sits on the consumer's input dot and that
        dot belongs to the card - drawn with its wire it would be half-covered by the
        box it points at. Exactly one is ever rendered, for the wire under the
        pointer, which is also what stops a shared queue from showing an × on every
        branch when you hover the trunk.
        
        Several wires arriving at one loop all land on the same dot, so their ×s
        would occupy the same spot. That is fine and invisible: only the hovered one
        exists.
      */}
      {(() => {
        const w = hoverWire === null ? undefined : factory.wires.find((x) => x.id === hoverWire);
        const to = w && byId.get(w.to);
        if (!w || !to) return null;
        return (
          <svg className="wires wires-over">
            <g transform={viewTransform(view)}>
              <Unwire
                at={inAnchor(to)}
                label={`Remove the wire to ${to.name}`}
                onDelete={() => {
                  setHoverWire(null);
                  onDeleteWire(w.id);
                }}
                onHover={(hovering) => setHoverWire(hovering ? w.id : null)}
              />
            </g>
          </svg>
        );
      })()}

      {/*
        Zoom out, zoom in, and fit the whole factory.
        
        In the corner rather than the toolbar: it acts on the canvas, and the
        toolbar is about the factory. Fit is the one that matters - it is the way
        back when you have panned somewhere empty, and on a design too wide to read
        it is the overview. The percentage is a readout, and clicking it returns to
        full size, which is the move you want after pinching by accident.
      */}
      <div className="view-controls">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(1 / 1.25)}
          disabled={view.scale <= ZOOM_MIN}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <Icon name="hero-minus" />
        </button>
        <button
          className="zoom-level"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setView((v) => ({ ...v, scale: 1 }))}
          title="Back to full size"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => zoomBy(1.25)}
          disabled={view.scale >= ZOOM_MAX}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <Icon name="hero-plus" />
        </button>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={fitAll}
          disabled={factory.loops.length === 0}
          title="Fit every loop on screen"
          aria-label="Fit every loop on screen"
        >
          <Icon name="hero-arrows-pointing-in" />
        </button>
      </div>
    </div>
  );
}
