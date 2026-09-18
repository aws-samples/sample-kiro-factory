/**
 * Where a loop sits, where its wires attach, and the curve between them.
 *
 * Harvested from the previous canvas, which is the one part of its UI worth
 * keeping: bezier wires between draggable boxes are fiddly to get right and this
 * was already right. Trimmed of the badge-chip sizing that served features that
 * no longer exist.
 *
 * Pure functions, no React, no DOM.
 */
import type { Loop } from './types.ts';

// Grown along with the base font size: the name and the Start button have to fit
// without the box clipping them. Grown twice since, for the two rows that sit
// between the name and the foot - the model the loop runs on, and the chips
// saying whether it is scoped or waiting. Four rows at the old height touched.
//
// A minimum rather than a fixed height at render time (see Canvas), so a wrapped
// chip row grows the box. Wires still attach at half of this, which is why the
// stylesheet is handed this number rather than using `50%`.
export const NODE_W = 248;
export const NODE_H = 132;

/**
 * How many boxes a cluster's stack draws before it gives up counting.
 *
 * Five, then an ellipsis carrying the real number. The stack is there to say "this
 * is several" at a glance from across the canvas, and past about five offset
 * rectangles it stops saying that and starts saying "this is a texture": nobody
 * counts six overlapping edges, and the sixteenth would be 45px of offset eating
 * the card beside it. So the drawing tops out and the count goes into words, which
 * is the one form that stays exact at any size.
 */
export const STACK_MAX = 5;

/**
 * How far each box behind the top one is offset, down and to the right.
 *
 * Down-right rather than up-right, and that choice is load-bearing: it leaves the
 * *top* box at exactly `loop.x, loop.y`, which is where `outAnchor`, `inAnchor` and
 * the port dots in the stylesheet all already are. A stack offset the other way
 * would have every wire in the factory meeting a box that is no longer where the
 * geometry says it is, and the ports would float off the card they belong to.
 *
 * So a cluster costs the wire code nothing. What it costs is extent - the stack
 * reaches further right and further down than one card - which is `frame` and
 * `loopAt` below, and nothing else.
 */
export const STACK_STEP = 7;

/** How many boxes are actually drawn for a component: 1, or the stack's depth. */
export function stackDepth(loop: Loop): number {
  if (!loop.cluster) return 1;
  return Math.min(STACK_MAX, loop.cluster.size);
}

/**
 * How far past its own box a component's drawing reaches, in each direction.
 *
 * Zero for a plain loop, which is what keeps every measurement below identical for
 * a factory with no clusters in it.
 */
export function stackOverhang(loop: Loop): number {
  return (stackDepth(loop) - 1) * STACK_STEP;
}

/**
 * Which part of the world the canvas is showing.
 *
 * `x`/`y` are the world coordinate sitting under the viewport's top-left corner,
 * and `scale` is screen pixels per world unit. Everything below is one equation
 * rearranged:
 *
 *     screen = (world - origin) * scale
 *
 * Loop positions in the document are world coordinates and always have been - the
 * canvas simply used to show the one window onto them where origin was 0,0 and
 * scale was 1, which is why running off the right edge meant running out of room.
 */
export interface View {
  x: number;
  y: number;
  scale: number;
}

/**
 * How far out and in the canvas will zoom.
 *
 * Out far enough that a wide factory fits on a laptop screen, and no further:
 * past a third of full size a loop card is a rectangle with unreadable text on
 * it, which is a map rather than an editor. In is capped at 2 because the cards
 * are already sized to be read at 1.
 */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2;

export const DEFAULT_VIEW: View = { x: 0, y: 0, scale: 1 };

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** The world point under a point on screen, screen measured from the canvas corner. */
export function toWorld(view: View, screen: { x: number; y: number }): { x: number; y: number } {
  return { x: screen.x / view.scale + view.x, y: screen.y / view.scale + view.y };
}

/**
 * The transform that puts world coordinates on screen, for an SVG `transform`
 * attribute.
 *
 * Translate then scale, in that order, with the origin at the top-left: the
 * translation is therefore in screen pixels, which is why it carries the `* scale`.
 *
 * Unitless and space-separated, because that is what the attribute takes. The CSS
 * property spells the same transform differently, hence the pair below - they are
 * one function reading two ways round, and the wire layer and the card layer must
 * agree exactly or the wires will not meet the boxes.
 */
export function viewTransform(view: View): string {
  return `translate(${-view.x * view.scale} ${-view.y * view.scale}) scale(${view.scale})`;
}

/** The same transform for a CSS `transform` property: px, and comma-separated. */
export function viewTransformCss(view: View): string {
  return `translate(${-view.x * view.scale}px, ${-view.y * view.scale}px) scale(${view.scale})`;
}

/**
 * Zoom about a fixed point on screen.
 *
 * The point under the cursor stays under the cursor, which is what makes a wheel
 * zoom feel like moving a camera rather than jumping somewhere new. Solve
 * `screen = (world - origin) * scale` for the origin that holds `world` at
 * `screen` once the scale has changed, which is the one line below.
 */
export function zoomAt(view: View, screen: { x: number; y: number }, scale: number): View {
  const next = clampZoom(scale);
  const w = toWorld(view, screen);
  return { x: w.x - screen.x / next, y: w.y - screen.y / next, scale: next };
}

/**
 * The view that shows every loop at once, centred, with room around the edge.
 *
 * Measured with the standard card height rather than the rendered one, because a
 * card grows when its chip row wraps and this is geometry with no access to the
 * DOM. The pad absorbs the difference - being a few pixels generous about where a
 * factory ends costs nothing here.
 *
 * Never zooms past 1: framing three loops should not blow them up to fill the
 * screen, it should just put them in the middle.
 */
export function frame(
  loops: Loop[],
  viewport: { width: number; height: number },
  pad = 64,
): View {
  if (loops.length === 0 || viewport.width === 0 || viewport.height === 0) return DEFAULT_VIEW;
  const left = Math.min(...loops.map((l) => l.x));
  const top = Math.min(...loops.map((l) => l.y));
  // A cluster's stack reaches past its own box, down and to the right, so the
  // far edges have to account for it or Fit clips the boxes behind the top one.
  // The near edges do not: the top box is at `loop.x, loop.y` and the stack only
  // ever grows away from it. See `stackOverhang`.
  const right = Math.max(...loops.map((l) => l.x + NODE_W + stackOverhang(l)));
  const bottom = Math.max(...loops.map((l) => l.y + NODE_H + stackOverhang(l)));
  const scale = clampZoom(
    Math.min(1, viewport.width / (right - left + pad * 2), viewport.height / (bottom - top + pad * 2)),
  );
  // Centre the bounding box: the slack left over in world units, halved.
  return {
    x: (left + right) / 2 - viewport.width / scale / 2,
    y: (top + bottom) / 2 - viewport.height / scale / 2,
    scale,
  };
}

/** Where a wire leaves a loop: the middle of its right edge. */
export function outAnchor(loop: Loop): { x: number; y: number } {
  return { x: loop.x + NODE_W, y: loop.y + NODE_H / 2 };
}

/** Where a wire arrives at a loop: the middle of its left edge. */
export function inAnchor(loop: Loop): { x: number; y: number } {
  return { x: loop.x, y: loop.y + NODE_H / 2 };
}

/** Cubic bezier between two anchors, bowed horizontally like a dataflow editor. */
export function wirePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/**
 * How far right of a loop its shared trunk runs before it splits.
 *
 * Long enough that the split reads as a junction rather than as curves leaving the
 * box at odd angles, and short enough that the badge sitting on the junction still
 * belongs to the producer rather than floating in the middle of the canvas.
 */
export const TRUNK_LEN = 64;

/**
 * Where a producer's shared queue splits toward its readers.
 *
 * Level with the output port rather than aimed at the average of the readers: the
 * trunk then always leaves the box straight, so the shape says "one wire out of
 * here, divided" no matter where the readers have been dragged to.
 */
export function junction(loop: Loop): { x: number; y: number } {
  const a = outAnchor(loop);
  return { x: a.x + TRUNK_LEN, y: a.y };
}

/** The straight run from a loop's output to its junction. */
export function trunkPath(a: { x: number; y: number }, j: { x: number; y: number }): string {
  return `M ${a.x} ${a.y} L ${j.x} ${j.y}`;
}

/**
 * The point halfway along that curve, for putting a label on it.
 *
 * It really is just the average of the endpoints, not an approximation. The two
 * control points in `wirePath` are offset from the anchors by the same `dx` in
 * opposite directions, so evaluating the cubic at t=0.5 cancels them out
 * exactly: (P0 + 3P1 + 3P2 + P3) / 8 reduces to (P0 + P3) / 2.
 */
export function wireMidpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
