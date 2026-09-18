/**
 * The tab strip: one folder tab per open factory, and what happens when there are
 * more of them than fit.
 *
 * Split out of the shell because none of this is about factories. It is about a row
 * that can overflow, which needs measuring, a wheel handler, buttons that appear
 * only when they are useful, and keeping the active tab on screen. The shell should
 * not have to hold any of that to know which factory you are looking at.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import type { FactoryRef } from './types.ts';

/** How much of the visible width one press of a scroll button moves. */
const NUDGE = 0.7;

/**
 * Where a dragged tab would land: beside which tab, on which side of it.
 *
 * Side-of-a-tab rather than an index into the list, because the indicator is drawn
 * on a tab's edge and the list can change under a drag - a factory finishing a
 * rename resizes the row mid-gesture, and an id survives that where an index lies.
 */
type DropSpot = { id: string; side: 'left' | 'right' };

export function Tabs({
  factories,
  active,
  busy,
  onSelect,
  onRename,
  onClose,
  onAdd,
  onReorder,
}: {
  factories: FactoryRef[];
  active: string | null;
  /** Ids of factories with loops running, which the tab marks with a dot. */
  busy: Set<string>;
  onSelect: (id: string) => void;
  onRename: (ref: FactoryRef, name: string) => void;
  onClose: (ref: FactoryRef) => void;
  onAdd: () => void;
  /** The full id list in its new order; the caller owns persisting it. */
  onReorder: (ids: string[]) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Whether there is anything to scroll to, in each direction. */
  const [more, setMore] = useState({ left: false, right: false });
  /** The tab being dragged, and where it would land if released now. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropSpot | null>(null);

  const measure = useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // A pixel of slack: fractional widths mean scrollLeft rarely reaches max
    // exactly, and without it the right button never turns off.
    setMore({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();

    // Three things change whether the row overflows: the tabs, the element's own
    // width, and the window's. The observer covers the first two - a renamed tab
    // resizes without anything here being told - and the listener the third.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    window.addEventListener('resize', measure);

    /*
     * Vertical wheel scrolls the row sideways, which is what a trackpad flick over
     * a tab strip is expected to do.
     *
     * Attached by hand rather than with onWheel because React registers wheel
     * listeners as passive, where preventDefault does nothing: the row would scroll
     * and the page would scroll with it.
     */
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // a real sideways gesture
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      el.removeEventListener('wheel', onWheel);
    };
  }, [measure, factories.length]);

  // Switching to a tab that is scrolled out of sight brings it back. `nearest` on
  // both axes so this cannot scroll the page underneath.
  useEffect(() => {
    scroller.current
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [active, factories.length]);

  function nudge(direction: -1 | 1): void {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * NUDGE, behavior: 'smooth' });
  }

  /**
   * Which side of a hovered tab the pointer is on. The midpoint is the natural
   * threshold: past halfway across a tab, you mean the far side of it.
   */
  function spotFor(e: React.DragEvent<HTMLDivElement>, id: string): DropSpot {
    const box = e.currentTarget.getBoundingClientRect();
    return { id, side: e.clientX < box.left + box.width / 2 ? 'left' : 'right' };
  }

  function finishDrag(): void {
    setDragging(null);
    setDrop(null);
  }

  /**
   * Turn the current drag into a new id order, or nothing if releasing here would
   * change nothing - dropping a tab beside itself is a cancelled drag, not an
   * update, and the caller should not have to notice the difference.
   */
  function orderAfterDrop(): string[] | null {
    if (!dragging || !drop) return null;
    const ids = factories.map((f) => f.id).filter((i) => i !== dragging);
    const at = ids.indexOf(drop.id);
    if (at === -1) return null; // the target tab closed mid-drag
    ids.splice(drop.side === 'left' ? at : at + 1, 0, dragging);
    const before = factories.map((f) => f.id);
    return ids.some((id, i) => id !== before[i]) ? ids : null;
  }

  return (
    <div className="tabs-wrap">
      {/*
        The scroll buttons are rendered only when there is something in that
        direction. A permanently visible pair that does nothing most of the time is
        two more things to look at and no more capable.
      */}
      {more.left && (
        <button className="tab-scroll" onClick={() => nudge(-1)} title="Scroll tabs left" aria-label="Scroll tabs left">
          <Icon name="hero-chevron-left" />
        </button>
      )}

      <div className="tabs" ref={scroller} onScroll={measure} role="tablist">
        {factories.map((f) => (
          <div
            key={f.id}
            className={`tab${f.id === active ? ' active' : ''}${f.id === dragging ? ' dragging' : ''}${
              drop?.id === f.id && dragging !== f.id ? ` drop-${drop.side}` : ''
            }`}
            role="tab"
            aria-selected={f.id === active}
            title={`${f.name}\n${f.baseDir}\n\nDouble-click to rename, drag to reorder`}
            onClick={() => onSelect(f.id)}
            onDoubleClick={() => setRenaming(f.id)}
            // Not draggable while its name is being edited, so selecting text in the
            // rename input cannot start hauling the whole tab around.
            draggable={renaming !== f.id}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              // Some browsers refuse to start a drag with nothing in the payload.
              e.dataTransfer.setData('text/plain', f.id);
              setDragging(f.id);
            }}
            onDragEnd={finishDrag}
            onDragOver={(e) => {
              if (!dragging || dragging === f.id) return;
              e.preventDefault(); // without this the browser forbids the drop
              e.dataTransfer.dropEffect = 'move';
              const spot = spotFor(e, f.id);
              if (drop?.id !== spot.id || drop.side !== spot.side) setDrop(spot);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const ids = orderAfterDrop();
              finishDrag();
              if (ids) onReorder(ids);
            }}
          >
            <Icon name="factory" className="tab-icon" />
            {renaming === f.id ? (
              // Rendered inside the tab rather than replacing it, so the shape and
              // the row's width do not jump the moment you start typing.
              <input
                className="tab-rename"
                defaultValue={f.name}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null);
                  onRename(f, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="tab-name">{f.name}</span>
            )}
            {busy.has(f.id) && <span className="tab-dot" title="This factory has loops running" />}
            <button
              className="tab-close"
              title="Close this tab. The files stay on disk."
              aria-label={`Close ${f.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(f);
              }}
            >
              <Icon name="hero-x-mark" />
            </button>
          </div>
        ))}
      </div>

      {more.right && (
        <button className="tab-scroll" onClick={() => nudge(1)} title="Scroll tabs right" aria-label="Scroll tabs right">
          <Icon name="hero-chevron-right" />
        </button>
      )}

      {/* Outside the scroller, so it is reachable however many tabs are open. */}
      <button className="tab-add" onClick={onAdd} title="New factory" aria-label="New factory">
        <Icon name="hero-plus" />
      </button>
    </div>
  );
}
