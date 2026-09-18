/**
 * The shell: a strip of tabs, and the factory one of them is showing.
 *
 * A tab is a factory, and a factory is a directory. They are independent designs
 * that happen to be open in the same window - nothing is shared between them, and
 * a factory keeps running when you switch away from it, which is why the strip
 * shows a dot on the ones that are busy.
 *
 * The active factory is mounted with `key`, so switching tabs remounts the view
 * rather than reconciling it. That is deliberate: a canvas holds drag state, output
 * buffers and queue timers, and none of it should survive being pointed at a
 * different factory.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Confirm, type ConfirmAsk } from './Confirm.tsx';
import { FactoryView } from './FactoryView.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import { Icon } from './Icon.tsx';
import { Tabs } from './Tabs.tsx';
import { api, subscribe } from './api.ts';
import type { FactoryRef, GrantDefaults, ModelCatalog } from './types.ts';

/** Which tab was open, so a reload comes back to the factory you were in. */
const STORE_ACTIVE = 'active-factory';

/**
 * The active factory rides in the URL fragment as well as localStorage.
 *
 * The fragment wins on load: it survives a refresh like the stored value does,
 * but it can also be copied - a URL that says which factory it means is a link to
 * that factory, which a localStorage key can never be. The stored value remains
 * as the fallback for a URL with no fragment, which is how the app is opened
 * from a bookmark of the bare address.
 */
function initialActive(): string | null {
  const fragment = window.location.hash.slice(1);
  return fragment.length > 0 ? decodeURIComponent(fragment) : window.localStorage.getItem(STORE_ACTIVE);
}

export function App() {
  const [factories, setFactories] = useState<FactoryRef[]>([]);
  const [active, setActive] = useState<string | null>(initialActive);
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** True for a second after the factory was kept, so the button can say so. */
  const [kept, setKept] = useState(false);
  /**
   * Bumped whenever this shell writes to the library, so the view refetches it.
   *
   * A counter rather than the library itself. The collection is read by the picker on
   * the view's toolbar and by nothing up here, so lifting the whole thing into this
   * component to keep one button honest would put the state a long way from its only
   * reader. What actually has to cross the boundary is the fact that it changed.
   *
   * The view's own save - the bookmark beside a loop's name - needs none of this,
   * because it already refreshes what it owns. This is only for the factory-level save
   * living on a row the picker cannot see.
   */
  const [librarySaved, setLibrarySaved] = useState(0);
  /**
   * Which models a loop can run on. Machine-wide, so it belongs to the shell.
   *
   * Read by the loop panel and by nothing up here, which by the reasoning above would
   * argue for keeping it in the view. The difference is that the view is keyed by the
   * active factory, so switching tabs remounts it and empties its state - and this
   * particular state costs a round trip to refill, which the picker spends every
   * switch while showing nothing. The catalogue is the same answer for every factory,
   * so there is nothing to refill it from but the same request again.
   *
   * Held here it is fetched once per page load, beside the factory list rather than a
   * round trip behind it, and a tab switch costs nothing.
   */
  const [models, setModels] = useState<ModelCatalog>({ models: [] });
  /**
   * What a new loop starts out allowed to use. Machine-wide for the same reason the
   * catalogue is: it is the operator's own default, the same answer for every tab.
   *
   * The initial value is the shipped default rather than an empty or "unknown" one,
   * so a loop added in the moment before the fetch lands is narrow rather than wide.
   * That is the safe direction to be wrong in, and it is only wrong at all for an
   * operator who saved a *wider* default - who then sees it corrected on the next
   * loop rather than getting an agent they did not ask for on this one.
   *
   * `saved: false` is part of that: unknown reads as "nobody has chosen", so the
   * panel's hint shows. An operator who has chosen loses the hint a moment later
   * when the real answer arrives, which is the harmless order to get it wrong in.
   */
  const [grants, setGrants] = useState<GrantDefaults>({
    // The same list as `SHIPPED` in server/grants.ts. Duplicated rather than
    // fetched-then-waited-for, because the point is to have a narrow answer before
    // the request lands; the canvas resolves it through the tool table anyway, so a
    // name that drifts out of the table is dropped rather than seeded.
    tools: [
      'read',
      'write',
      'glob',
      'grep',
      'code',
      'shell',
      'web',
      'web_search',
      'web_fetch',
      'knowledge',
      'todo_list',
      'introspect',
    ],
    mcp: [],
    saved: { tools: false, mcp: false },
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const keptTimer = useRef(0);

  // A pending tick would otherwise fire against an unmounted component.
  useEffect(() => () => window.clearTimeout(keptTimer.current), []);

  /**
   * Fetch the catalogue. `retry` is for the picker's button after a failure.
   *
   * Only a retry the operator asked for passes it: a plain load must not, or the
   * server would start a fresh kiro-cli probe for every tab that happens to open.
   */
  const loadModels = useMemo(
    () =>
      (retry = false): void => {
        void api
          .models(retry)
          .then(setModels)
          .catch(() =>
            setModels({ models: [], failed: true, reason: 'the server did not answer' }),
          );
      },
    [],
  );

  useEffect(() => {
    void api
      .factories()
      .then((list) => {
        setFactories(list);
        setLoaded(true);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoaded(true);
      });

    /*
     * Started here, in the same tick as the factory list rather than after it: the two
     * answers have nothing to do with each other, and the server has usually had the
     * catalogue in hand since its own startup, so this is a fast request that only
     * looked slow for being queued behind the one above.
     */
    loadModels();

    /*
     * Alongside the other two, and the cheapest of the three: a small file the server
     * reads on demand, with no probe behind it. A failure keeps the shipped default
     * already in state, which is the same answer the server would have given an
     * operator who never saved one - so there is nothing to report and nothing to
     * retry.
     */
    void api.grants().then(setGrants).catch(() => {});

    /*
     * The strip needs to know which factories are working, and that arrives on the
     * same stream the views use. Tracked here rather than per view because a view
     * that is not mounted cannot report anything.
     *
     * Every loop's last known state is kept, not just a flag per factory, because
     * of the one event that has to clear the dot: a loop stopping. That event says
     * nothing about the factory's other loops, so answering "is anything still
     * going" takes remembering what the others last said. The map lives in a ref -
     * it is bookkeeping for deriving `busy`, not something to render.
     */
    const states = new Map<string, Map<string, string>>();
    const mark = (factoryId: string): void => {
      const running = [...(states.get(factoryId)?.values() ?? [])].some((s) => s !== 'stopped');
      setBusy((prev) => {
        if (prev.has(factoryId) === running) return prev;
        const next = new Set(prev);
        if (running) next.add(factoryId);
        else next.delete(factoryId);
        return next;
      });
    };

    return subscribe({
      onFactories: setFactories,
      onFactory: (doc) =>
        // A rename or a move: the strip carries the name, so it has to follow.
        setFactories((prev) =>
          prev.map((f) => (f.id === doc.id ? { ...f, name: doc.name, baseDir: doc.baseDir } : f)),
        ),
      // The whole picture, sent on connect: replaces whatever was remembered, so a
      // loop deleted while the stream was down does not haunt the dot.
      onStatusAll: ({ factory, status }) => {
        states.set(factory, new Map(status.map((s) => [s.id, s.state])));
        mark(factory);
      },
      // One loop's change - `paused` counts as busy, because a loop waiting for an
      // item is still a factory doing something. A stop only clears the dot when it
      // was the last loop going, which is exactly what the map answers.
      onStatus: (s) => {
        const forFactory = states.get(s.factory) ?? new Map<string, string>();
        forFactory.set(s.id, s.state);
        states.set(s.factory, forFactory);
        mark(s.factory);
      },
    });
  }, [loadModels]);

  /*
   * Keep a valid tab selected: the one the URL or storage asked for if it is
   * still open, otherwise the first. Also covers closing the active tab, and
   * opening the app for the first time with nothing stored.
   *
   * Gated on `loaded`, and that gate is the whole correctness of restoring a tab.
   * Before the list arrives `factories` is empty, and an empty list makes every
   * remembered id look closed - so without the gate this ran once on mount,
   * decided the id in the URL was stale, and dropped the app onto the first tab
   * before there was anything to check against.
   */
  useEffect(() => {
    if (!loaded) return;
    if (factories.length === 0) {
      if (active !== null) setActive(null);
      return;
    }
    if (active === null || !factories.some((f) => f.id === active)) {
      setActive(factories[0]!.id);
    }
  }, [factories, active, loaded]);

  useEffect(() => {
    if (!active) return;
    window.localStorage.setItem(STORE_ACTIVE, active);
    // `replaceState` rather than assigning `location.hash`, so flicking through
    // tabs does not stack a history entry per click for Back to wade through.
    window.history.replaceState(null, '', `#${encodeURIComponent(active)}`);
  }, [active]);

  // A hand-edited fragment is a navigation, and so is Back across a full page
  // load. Whether the id actually exists is settled by the effect above, which
  // falls back to the first tab like any other stale id.
  useEffect(() => {
    const onHash = (): void => {
      const fragment = window.location.hash.slice(1);
      if (fragment.length > 0) setActive(decodeURIComponent(fragment));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function add(): void {
    setError(null);
    void api
      .createFactory()
      .then((doc) => setActive(doc.id))
      .catch((e: Error) => setError(e.message));
  }

  /**
   * Close a tab.
   *
   * The factory's files are left exactly where they are - its document, its queues
   * and everything its loops wrote. Closing is forgetting the tab, not deleting the
   * work, and the confirm says so because "close" reads like it might not be.
   *
   * Deleting lives in the same dialog, because it is the same decision taken one
   * step further - but behind a typed keyword, because it is the step that cannot
   * be taken back. It removes the factory's own data and only that: everything
   * under `.kirofactory` in the base directory, which is the one place the app
   * writes. A factory pointed at a real project deletes its dot-folder there,
   * never the project.
   */
  function close(ref: FactoryRef): void {
    setConfirm({
      title: `Close "${ref.name}"?`,
      body:
        `Its files stay in ${ref.baseDir}. Press Open and walk back to that folder ` +
        `to get this factory back, exactly as it is now.`,
      action: 'Close tab',
      onConfirm: () => {
        setError(null);
        void api.closeFactory(ref.id).catch((e: Error) => setError(e.message));
      },
      danger: {
        label: 'Delete factory',
        keyword: 'delete',
        description:
          `Or delete it: the document, queues and everything its loops wrote under ` +
          `${ref.baseDir}/.kirofactory are removed for good. The rest of the directory is untouched.`,
        onConfirm: () => {
          setError(null);
          void api.deleteFactory(ref.id).catch((e: Error) => setError(e.message));
        },
      },
    });
  }

  function rename(ref: FactoryRef, name: string): void {
    const next = name.trim();
    if (next.length === 0 || next === ref.name) return;
    void api.patchFactory(ref.id, { name: next }).catch((e: Error) => setError(e.message));
  }

  /**
   * A dragged tab was dropped: put the strip in its new order.
   *
   * Reordered locally first rather than waiting for the server's answer, because a
   * tab that snaps back for a round trip and then jumps again reads as a glitch.
   * The server's list still wins when it arrives - it is the same list, unless the
   * request failed, in which case the revert is exactly what should happen.
   */
  function reorder(ids: string[]): void {
    setFactories((prev) =>
      [...prev].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    );
    void api
      .reorderFactories(ids)
      .then(setFactories)
      .catch((e: Error) => {
        setError(e.message);
        // The optimistic order is now a lie; the server's list is the truth.
        void api.factories().then(setFactories).catch(() => undefined);
      });
  }

  /**
   * Import a factory from a file.
   *
   * The file is the whole factory, so this is the counterpart of Export: the way a
   * factory arrives from somewhere else. Reopening one that was closed on this
   * machine is `openFolder` instead - the folder is still there, and it is the
   * factory rather than a copy of it.
   *
   * The server decides where an imported factory lands: the `baseDir` in the file is
   * used when that directory exists on this machine, and otherwise it says where it
   * put it instead.
   */
  function onFile(file: File): void {
    setError(null);
    // Guarded here rather than in the drop targets, so the file dialog and the
    // canvas drop refuse a non-factory file with the same sentence.
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
      setError(`${file.name} is not a factory file. A factory is the JSON that Export writes.`);
      return;
    }
    void file
      .text()
      .then((text) => api.importFactory(JSON.parse(text)))
      .then(({ factory, note }) => {
        setActive(factory.id);
        if (note) setError(note);
      })
      .catch((e: Error) => setError(`import failed: ${e.message}`));
  }

  /**
   * Open the factory that is already in a directory.
   *
   * The other way in, and the one that makes closing a tab reversible. A factory
   * lives in its folder - document, queues, everything its loops wrote - so closing
   * only ever forgot the tab. Until this, though, the way back was the JSON that
   * Export writes, which meant a factory nobody had thought to export was closed
   * for good with all of it still sitting on disk.
   *
   * The same handler serves the strip and the picker in the directory bar, because
   * the outcome is the same in both: a different factory in front of you, which is
   * the shell's business either way.
   */
  function openFolder(dir: string): void {
    setError(null);
    void api
      .openFactory(dir)
      .then(({ factory, note }) => {
        setActive(factory.id);
        if (note) setError(note);
      })
      .catch((e: Error) => setError(e.message));
  }

  /**
   * Take a factory out of the library, as a new tab.
   *
   * The fourth way in, and the only one that starts from a design rather than from a
   * factory that already exists somewhere. Import and Open both recover a particular
   * factory and keep its identity; a library entry is a template, so every take-out is
   * a new factory that happens to share a shape. The server mints the id and picks the
   * directory - see the route - so there is nothing to ask before doing it.
   *
   * Offered from the library picker on the view's own toolbar, because that is where
   * the library is, and handled here because the result is a tab.
   */
  function openLibraryFactory(slug: string): void {
    setError(null);
    void api
      .openLibraryFactory(slug)
      .then(({ factory }) => setActive(factory.id))
      .catch((e: Error) => setError(e.message));
  }

  /**
   * Keep the open factory in the library.
   *
   * The document is fetched rather than held, because this shell only knows tabs - a
   * name, an id and a directory - and what is worth sharing is the graph. One request
   * on a button nobody presses twice a minute is cheaper than this component tracking
   * a document it has no other use for.
   *
   * A name already in the library comes back as a conflict rather than an entry, and
   * turns into the question it is: replace what is there, or cancel and rename the
   * factory first. Confirming runs this same function again with `overwrite` set -
   * the document is fetched afresh, which is right, since nothing stops it changing
   * while the dialog sits open.
   */
  function keepFactory(overwrite = false): void {
    if (!active) return;
    setError(null);
    void api
      .getFactory(active)
      .then((doc) =>
        api.saveFactoryToLibrary({
          name: doc.name,
          loops: doc.loops,
          wires: doc.wires,
          ...(doc.parameters !== undefined ? { parameters: doc.parameters } : {}),
          ...(overwrite ? { overwrite } : {}),
        }).then((saved) => ({ saved, name: doc.name })),
      )
      .then(({ saved, name }) => {
        if ('conflict' in saved) {
          setConfirm({
            title: 'Replace library factory?',
            body:
              `The library already has a factory named "${name}".\n\n` +
              'Replacing it keeps its description, author and tags, and swaps in ' +
              'this canvas. Cancel to rename the factory and save it separately.',
            action: 'Replace',
            onConfirm: () => keepFactory(true),
          });
          return;
        }
        setKept(true);
        window.clearTimeout(keptTimer.current);
        keptTimer.current = window.setTimeout(() => setKept(false), 1600);
        // The picker that would show this entry belongs to the view, and the view
        // reads the library once on mount. Saying so is the whole reason `librarySaved`
        // exists - without it the factory you just kept is missing from the picker
        // until something remounts, which is a reload.
        setLibrarySaved((n) => n + 1);
      })
      .catch((e: Error) => setError(e.message));
  }

  return (
    <div className="app">
      <nav className="tabstrip">
        {/*
          The wordmark says "Kiro factory", with "as a software" tucked small and
          grey over "factory", so the whole reads as the sentence "Kiro, as a
          software factory". The product name is the big word, as tall as the
          stacked pair beside it, and the factory glyph stands on the same ground
          line as all of it.

          Text rather than an image, so it is in the interface's own font, scales with
          it, stays selectable and searchable, and cannot go out of date the way a
          checked-in SVG does.
        */}
        <div className="brand">
          <Icon name="factory" className="brand-icon" />
          <span className="brand-kiro">Kiro</span>
          <span className="brand-stack">
            <span className="brand-sub">as a software</span>
            <span className="brand-factory">factory</span>
          </span>
        </div>

        <Tabs
          factories={factories}
          active={active}
          busy={busy}
          onSelect={setActive}
          onRename={rename}
          onClose={close}
          onAdd={add}
          onReorder={reorder}
        />

        <span className="spacer" />
        {error && (
          <span className="error" title={error} onClick={() => setError(null)}>
            {error}
          </span>
        )}
        {/*
          Open, Import and Export, together.
          
          Import and Export used to be a tab-strip button and a folder-line button,
          one each, which split the two halves of a single idea across two rows: a
          factory is a file, and these are the way in and the way out. Both are about
          a whole factory rather than anything inside one, so both belong up here
          beside the tabs - and side by side, one is the answer to the other being
          there.
          
          Open is the third, and it is here for the same reason: it produces a tab.
          It is also the only one of the three that works with nothing open at all,
          which is exactly the state a closed factory leaves you in.
          
          The split between Open and Import is worth keeping straight, and the titles
          carry it: Open takes a folder on this machine, where a factory already is.
          Import takes the JSON that Export wrote, which may have come from another
          machine entirely. Overloading Import with a folder mode would have made one
          button mean both, and the paths they take through the server genuinely
          differ - Open keeps the factory's identity, Import may have to invent one.

          `showFactories` is on this one and only this one. It puts a second tab in the
          popover listing the factories the app has seen and is not showing, which is
          the shorter way to do what this button exists for: closing a tab leaves you
          with the folder path as the only thing that will bring it back, and this is
          the app volunteering it. The picker in the directory bar has no business
          offering to leave the factory whose directory it is editing.
        */}
        <FolderPicker
          current={factories.find((f) => f.id === active)?.baseDir ?? ''}
          label="Open"
          icon="hero-folder-open"
          title="Open a factory from its folder on this machine"
          showFactories
          onOpenFactory={openFolder}
        />
        <button
          className="with-icon"
          onClick={() => fileInput.current?.click()}
          title="Add a factory from the JSON that Export writes"
        >
          <Icon name="hero-arrow-up-tray" />
          Import
        </button>
        {/*
          A plain link, not a fetch: the server sets the file name in
          content-disposition, so the download is named after the factory without
          the browser being told twice.
          
          With nothing open it becomes a disabled button rather than a styled span,
          because an anchor cannot be disabled: `href` is what makes it a link, and
          taking it away leaves something that looks like the button beside it and
          does nothing when pressed. A real `<button disabled>` is inert, is skipped
          by the keyboard, and already looks disabled everywhere else in here.
        */}
        {active ? (
          <a
            className="button with-icon"
            href={api.exportUrl(active)}
            download
            title="Save this factory as one JSON file"
          >
            <Icon name="hero-arrow-down-tray" />
            Export
          </a>
        ) : (
          <button className="with-icon" disabled title="No factory open to export">
            <Icon name="hero-arrow-down-tray" />
            Export
          </button>
        )}
        {/*
          The library, which is the other way out and the reason it sits here.
          
          Export writes one file for one person to carry; this writes one file into the
          repository for everyone who clones it. Both are a whole factory leaving, and
          neither is about anything inside one, so both belong on this row rather than
          on the view's toolbar - the bookmark button down there keeps a single loop,
          which is a different scope of the same idea.
          
          Icon only, unlike the three beside it. Those are three words that have to be
          told apart - Open, Import and Export are all "a factory arrives or leaves" and
          the label is what says which - whereas this one is the same bookmark glyph,
          with the same meaning, as the button that keeps a single loop. Learning it
          once covers both. It also stops a fourth label pushing this row into the tab
          strip on a narrow window, which is exactly what it did with one.
          
          The confirmation is the button becoming a tick for a second, which is the one
          thing a label would have carried and the glyph carries anyway. What durably
          confirms it is `git status`: the entry is a file in your checkout now, and
          that is the thing you would send.
        */}
        <button
          className={`icon-only${kept ? ' saved' : ''}`}
          disabled={!active}
          title={
            active
              ? 'Keep this factory in the library, for anyone with this repository'
              : 'No factory open to keep'
          }
          aria-label="Keep this factory in the library"
          // Wrapped so the click event cannot ride in as `overwrite`, which is
          // exactly the argument a bare `onClick={keepFactory}` would pass.
          onClick={() => keepFactory()}
        >
          <Icon name={kept ? 'hero-check' : 'hero-bookmark-square'} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so choosing the same file twice fires a change both times.
            e.target.value = '';
            if (file) onFile(file);
          }}
        />
      </nav>

      {active ? (
        <FactoryView
          key={active}
          factoryId={active}
          onImportFile={onFile}
          onOpenFactory={openFolder}
          onOpenLibraryFactory={openLibraryFactory}
          librarySaved={librarySaved}
          models={models}
          onRetryModels={() => loadModels(true)}
          grants={grants}
          onGrantsChange={setGrants}
        />
      ) : (
        <div className="no-factory">
          {loaded && (
            <p>
              No factories open. Press <button onClick={add}>New factory</button> to start one, or Open to
              go back to a factory whose folder is still there.
            </p>
          )}
        </div>
      )}

      <Confirm ask={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
