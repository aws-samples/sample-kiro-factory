/**
 * Walk the filesystem and come back with a directory.
 *
 * The base directory is an absolute path, and an absolute path is a miserable
 * thing to type: it is long, it is exact, and a typo in it is a factory pointed at
 * a folder that does not exist. So the field on the folder line keeps a small
 * button beside it, and this is what the button opens.
 *
 * It has to ask the server for every listing, because a browser will not tell you
 * an absolute path - a file input names a file and hands over bytes, a directory
 * input hands over relative paths under a folder it declines to name, and neither
 * is a path. The server is on the same machine as the directories, so `/api/browse`
 * answers and this only draws.
 *
 * One directory at a time, no tree: a tree wants to remember what you expanded, and
 * nothing here is a place you stay. You go down until you are standing in the
 * project, and then you press the button that says so.
 *
 * Which button depends on what the caller asked for, because a folder can answer two
 * different questions. `onPick` is "put this factory here", which is the directory
 * bar. `onOpenFactory` is "the factory in here, open it", which is how a closed tab
 * comes back - and it is offered only when the listing says a factory is actually in
 * the folder, so it is never a guess.
 *
 * Walking is not the only way back to a closed factory, though, and `showFactories`
 * is the other: a second tab in the same popover, listing the factories the server
 * remembers but is not showing. It belongs in this popover rather than a control of
 * its own, because both tabs are the same question asked two ways, "which factory do
 * you want open", and both answer it with the one call, `onOpenFactory(dir)`.
 *
 * That tab also carries the way back to a factory the server does *not* remember:
 * "Find factories", which scans the home directory and adopts what it finds. It
 * lives here rather than somewhere more prominent because it is the same question a
 * third time - and because a control for it out on the toolbar would be a button
 * most operators never need, next to the one they should reach for first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Confirm, type ConfirmAsk } from './Confirm.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { api, type BrowseDir } from './api.ts';
import type { FactoryRef } from './types.ts';

/** The popover's width and the gap to keep from the window edge. Must agree with
    `.picker-pop` in the stylesheet, which owns the real value. */
const POP_WIDTH = 420;
const MARGIN = 16;

/**
 * The tooltip for one folder: its path, and what the factory in it means for you.
 *
 * Shared by the rows and the current directory so the two cannot end up phrasing the
 * same fact differently. The path stays first because that is what a tooltip on a
 * truncated name is mostly for.
 */
function factoryHint(
  at: { path: string; factory: boolean; open: boolean; factoryName?: string },
): string {
  if (!at.factory) return at.path;
  const which = at.factoryName === undefined ? 'A factory' : `"${at.factoryName}"`;
  return at.open
    ? `${at.path}\n\n${which} is already open, so going in only switches to its tab.`
    : `${at.path}\n\n${which} lives here, and can be opened as its own tab.`;
}

export function FolderPicker({
  current,
  disabled,
  label,
  icon = 'hero-folder-open',
  title = 'Choose a different directory',
  showFactories = false,
  onPick,
  onOpenFactory,
}: {
  /** Where to start looking. The path the field is holding right now. */
  current: string;
  disabled?: boolean;
  /**
   * Text beside the icon on the trigger. Absent leaves it icon-only, which is what
   * the directory bar wants - there is a labelled field right next to it saying
   * what the button is about. A picker standing on its own in the tab strip has no
   * such neighbour, so it says so itself.
   */
  label?: string;
  icon?: IconName;
  title?: string;
  /**
   * Offer the factories the app already knows about, as a second tab.
   *
   * For the picker that stands on its own and produces a tab, where "open a factory"
   * is the whole job and the folder is only how you say which one. The picker in the
   * directory bar leaves it off: it is a field's browse button, its list of folders
   * is about the factory already in front of you, and a list of other factories
   * there would be an invitation to leave rather than a way to fill in the field.
   *
   * Needs `onOpenFactory` to mean anything, since that is the only thing a row does.
   */
  showFactories?: boolean;
  /**
   * Take the folder you are standing in.
   *
   * Optional, because the two things you can do with a folder here are separable: a
   * picker offered only to reopen a factory has no business moving one.
   */
  onPick?: (dir: string) => void;
  /**
   * Open the factory that is already in the folder you are standing in.
   *
   * Offered only when there is one, which the listing knows. This is what makes the
   * `factory` tag actionable instead of a warning: before, walking to a folder that
   * held a factory left you with a button that would be refused and a sentence
   * telling you to go and find the JSON.
   */
  onOpenFactory?: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<BrowseDir | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which side of the button the popover hangs from.
   *
   * It is anchored to a button that lives near the right end of the directory bar,
   * so growing rightward from the button's left edge - the default - puts most of
   * it past the window. Measured at open rather than hardcoded, so the popover
   * follows the button if the bar is ever rearranged.
   */
  const [alignRight, setAlignRight] = useState(false);
  /**
   * Type-to-filter over the current listing. A home directory or a big projects
   * folder is a hundred rows, and scrolling for one name you already know is the
   * same misery typing the path was supposed to fix. Local to the listing: it
   * narrows what is shown, never what is on disk, and descending clears it.
   */
  const [filter, setFilter] = useState('');
  /**
   * Which of the two lists is showing. Only ever `factories` when `showFactories` is
   * set, since the strip that switches it is not rendered otherwise.
   */
  const [tab, setTab] = useState<'folders' | 'factories'>('folders');
  /**
   * The factories the server remembers, as they were when the tab was opened.
   *
   * Fetched rather than pushed: the event stream's `factories` frame carries the open
   * list, so nothing here would ever hear about a close. Null is "not asked yet",
   * which is what tells the empty line apart from the loading one.
   */
  const [known, setKnown] = useState<FactoryRef[] | null>(null);
  const [knownError, setKnownError] = useState<string | null>(null);
  /**
   * The scan: the question waiting to be confirmed, whether one is running, and what
   * the last one came back with.
   *
   * `scanNote` outlives the scan on purpose. It is the only report there is - the
   * counts do not appear anywhere else, and the list below cannot show the difference
   * between a factory adopted a moment ago and one that was always there - so it
   * stays until the popover closes or the operator switches tabs. Errors land in the
   * same line: both are the same sentence, "here is what pressing that did".
   */
  const [scanAsk, setScanAsk] = useState<ConfirmAsk | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const go = useCallback((to?: string): void => {
    setBusy(true);
    setError(null);
    void api
      .browse(to)
      .then((next) => {
        setDir(next);
        // A directory you cannot read comes back as itself with nothing in it, and
        // the reason it gave is worth showing: an empty list and a refused list
        // look identical otherwise.
        setError(next.note ?? null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  // Every open starts from the path in the field, not from wherever the last
  // browse ended up. The field is the current answer, so it is the honest place to
  // begin, and a stale listing from ten minutes ago is not.
  useEffect(() => {
    if (!open) return;
    // Before the popover has rendered, so it appears on the right side first time
    // rather than jumping there. POP_WIDTH must agree with `.picker-pop` in the
    // stylesheet; measuring the popover itself would mean rendering it misplaced.
    const anchor = root.current?.getBoundingClientRect();
    if (anchor) setAlignRight(anchor.left + POP_WIDTH > window.innerWidth - MARGIN);
    go(current.trim().length > 0 ? current : undefined);
  }, [open, current, go]);

  // Every open starts on Folders, whichever tab the last one ended on. The trigger
  // says "a folder on this machine", so opening onto a list of factory names would be
  // the button doing something other than what it claims, and Folders is also the tab
  // that always has something in it.
  useEffect(() => {
    if (!open) {
      setTab('folders');
      setKnown(null);
      setKnownError(null);
      setScanAsk(null);
      setScanNote(null);
    }
  }, [open]);

  /**
   * Read the factories the server remembers, all of them.
   *
   * Shared by the tab arriving and by a finished scan, so the two cannot end up with
   * different ideas of what the list is.
   */
  const loadKnown = useCallback((): void => {
    setKnownError(null);
    void api
      .known()
      .then(setKnown)
      .catch((e: Error) => {
        setKnown([]);
        setKnownError(e.message);
      });
  }, []);

  // Asked for on arrival at the tab, and again on coming back to it, because a close
  // in another window is invisible from here otherwise. One read of a small file on
  // the same machine, so freshness is worth more than the request saved.
  useEffect(() => {
    if (!open || tab !== 'factories') return;
    loadKnown();
  }, [open, tab, loadKnown]);

  // Escape closes, and so does a press anywhere else. Both are on the document
  // rather than on the popover: the point of dismissing is that you clicked the
  // thing you actually wanted, and that thing is somewhere else.
  //
  // Both stand down while the scan's confirm is up. A modal `<dialog>` handles its
  // own Escape and its own backdrop, and this listener would otherwise answer the
  // same keypress by closing the popover out from under it - so cancelling the
  // question would also throw away the tab it was asked from. The dialog is rendered
  // inside `root`, so `contains` already keeps a click on it from counting as
  // outside; only the key needs saying.
  useEffect(() => {
    if (!open || scanAsk !== null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, scanAsk]);

  // Descending leaves the scroll position where the last folder's list had it,
  // which reads as the new list opening halfway down. Back to the top on arrival,
  // and the filter goes too: it was a question about the folder you just left.
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setFilter('');
  }, [dir?.path]);

  function choose(): void {
    if (dir && onPick) onPick(dir.path);
    setOpen(false);
  }

  function openHere(): void {
    if (dir && onOpenFactory) onOpenFactory(dir.path);
    setOpen(false);
  }

  const shown = (dir?.entries ?? []).filter(
    (entry) => filter === '' || entry.name.toLowerCase().includes(filter.toLowerCase()),
  );

  /**
   * The closed factories, in the order the server gave them, narrowed by the filter.
   *
   * `!open` is applied here rather than asked of the server, which answers with
   * everything on purpose. The open ones are already tabs, and a row that only
   * switched to a tab already in the strip above is a decision left for later.
   *
   * The filter matches the name only. The path is on the row and would widen what
   * matches, but a factory is a name to the person looking for it, and a directory
   * of worktrees is a column of paths that differ by one segment.
   */
  const closed = (known ?? []).filter(
    (ref) => !ref.open && (filter === '' || ref.name.toLowerCase().includes(filter.toLowerCase())),
  );

  // The filter was a question about the list that was showing, so it does not follow
  // you across. Same reasoning as clearing it on descending into a folder, and the
  // scan's report goes with it: it describes this list, and on the folder tab there
  // is nothing for it to be about.
  function pickTab(next: 'folders' | 'factories'): void {
    setTab(next);
    setFilter('');
    setScanNote(null);
  }

  function openKnown(ref: FactoryRef): void {
    if (onOpenFactory) onOpenFactory(ref.baseDir);
    setOpen(false);
  }

  /**
   * Run the scan, having been told to.
   *
   * The counts come from the answer, and the list is re-read afterwards rather than
   * rebuilt from it. Rebuilding is tempting - the three buckets hold entries, so it
   * would save a request - and it is wrong: those buckets are what the *walk* met,
   * and the registry also holds factories the walk cannot reach. One in a pruned
   * folder, one on another volume, one whose directory has been deleted since. Every
   * such factory would vanish from the list the moment a scan finished, which is a
   * feature for finding factories losing them.
   *
   * So the buckets are the report and `known()` is the list. It is one read of a small
   * file on the same machine, which is what the tab already does on arrival.
   *
   * The counts name what the operator cares about, in the order they care: how many
   * are new, then whether anything moved, then the reassuring remainder. Zero-valued
   * clauses are dropped, because "0 moved" is a fact nobody asked for, and a scan
   * that changed nothing says so in words instead of three zeroes.
   */
  function runScan(): void {
    setScanning(true);
    setScanNote(null);
    void api
      .scanFactories()
      .then((result) => {
        loadKnown();
        const parts = [
          result.added.length > 0 ? `${result.added.length} added` : '',
          result.updated.length > 0 ? `${result.updated.length} moved` : '',
          result.skipped.length > 0 ? `${result.skipped.length} already known` : '',
        ].filter((p) => p !== '');
        setScanNote(
          result.found === 0
            ? 'No factories found in your home folder.'
            : `Found ${result.found}: ${parts.join(', ')}.`,
        );
      })
      .catch((e: Error) => setScanNote(e.message))
      .finally(() => setScanning(false));
  }

  /** Ask before walking the home directory, then run it. */
  function askScan(): void {
    setScanAsk({
      title: 'Find factories on this machine?',
      body:
        'Looks through your home folder for factories and adds every one it finds to ' +
        'this list. Takes a few seconds.',
      warning: 'Nothing is opened and nothing on disk changes - the list just gets longer.',
      action: 'Find factories',
      onConfirm: runScan,
    });
  }

  return (
    <div className="picker" ref={root}>
      <button
        className={label === undefined ? 'icon-only' : 'with-icon'}
        disabled={disabled}
        // The default title is "Choose", not "Browse". The button next to this one in
        // the directory bar browses - it shows the files in the directory - and this
        // one changes which directory it is. Two buttons both offering to browse a
        // folder is how you click the wrong one.
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name={icon} />
        {label}
      </button>

      {open && (
        <div
          className={`picker-pop${alignRight ? ' align-right' : ''}`}
          role="dialog"
          aria-label="Choose a folder"
        >
          {/*
            The two ways of naming a factory you want open: where it is, or what it is
            called. A strip rather than a mode switch on the trigger, because they are
            not different tools. You reach for the same button and then say which
            question you can answer, and often the second one only after the first has
            not worked.

            Only when the caller asked, so the directory bar's picker is untouched: one
            row of tabs above a folder listing that has no second list under it would be
            furniture with nothing behind it.
          */}
          {showFactories && onOpenFactory && (
            <div className="picker-tabs" role="tablist" aria-label="What to choose from">
              <button
                role="tab"
                aria-selected={tab === 'folders'}
                className={tab === 'folders' ? 'on' : ''}
                title="Walk to the folder a factory is in"
                onClick={() => pickTab('folders')}
              >
                <Icon name="hero-folder" />
                Folders
              </button>
              <button
                role="tab"
                aria-selected={tab === 'factories'}
                className={tab === 'factories' ? 'on' : ''}
                title="Factories this app has seen and is not showing"
                onClick={() => pickTab('factories')}
              >
                <Icon name="factory" />
                Factories
              </button>
            </div>
          )}

          {tab === 'folders' && (
          <div className="picker-head">
            <button
              className="icon-only"
              disabled={!dir || dir.parent === null || busy}
              title="Up one folder"
              aria-label="Up one folder"
              onClick={() => dir?.parent !== null && go(dir?.parent ?? undefined)}
            >
              <Icon name="hero-arrow-up" />
            </button>
            <button
              className="icon-only"
              disabled={busy}
              title="Home"
              aria-label="Home"
              onClick={() => go(dir?.home)}
            >
              <Icon name="hero-home" />
            </button>
            {/*
              The path is the title of the popover, and it is long, so it scrolls
              rather than wrapping the header onto three lines. Kept selectable:
              sometimes what you came for is the text, not the folder.
            */}
            <code className="picker-path" title={dir === null ? '' : factoryHint(dir)}>
              {dir?.path ?? '…'}
            </code>
            {/*
              The folder you are standing in, marked the same way its children are.

              Without it the current directory is the one folder the popover cannot
              describe: you walk into a factory and the row that said so scrolls out
              of existence, leaving a path and a button whose label is the only clue.
              Same pill, same place in the reading order, so arriving somewhere and
              looking at it from outside give the same answer.
            */}
            {dir?.factory === true && (
              <span className={`picker-tag${dir.open ? ' is-open' : ''}`}>
                <Icon name="factory" />
                {dir.factoryName ?? 'factory'}
              </span>
            )}
          </div>
          )}

          {/*
            Type to narrow the listing. Focused on open, because the fastest use of
            this popover is type-a-few-letters, Enter - and Enter descends when the
            filter has narrowed the list to one folder, so that use needs no mouse.
            Escape clears the filter first and closes the popover second.

            Shared by both tabs, and it is the same control in both: narrow what is on
            screen, then Enter when one thing is left. What Enter then does differs
            only because the lists differ, a folder being somewhere to go into and a
            factory being something to open.
          */}
          <div className="picker-filter">
            <Icon name="hero-magnifying-glass" />
            <input
              autoFocus
              value={filter}
              placeholder={tab === 'factories' ? 'Type to filter by name' : 'Type to filter'}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter !== '') {
                  setFilter('');
                  e.stopPropagation();
                }
                if (e.key !== 'Enter') return;
                if (tab === 'factories') {
                  if (closed.length === 1 && closed[0] !== undefined) openKnown(closed[0]);
                } else if (shown.length === 1 && shown[0] !== undefined) {
                  go(shown[0].path);
                }
              }}
            />
          </div>

          {tab === 'folders' ? (
          <div className="picker-list" ref={list}>
            {shown.map((entry) => (
              <button
                key={entry.path}
                className={`picker-entry${entry.factory ? ' has-factory' : ''}${
                  entry.open ? ' is-open' : ''
                }`}
                title={factoryHint(entry)}
                onClick={() => go(entry.path)}
              >
                <Icon name="hero-folder" />
                <span className="picker-name">{entry.name}</span>
                {/*
                  The factory in this folder, by name.

                  Said in the listing rather than after you choose the folder, because
                  it decides both of the things you might have come here to do: two
                  factories cannot share a directory - their documents would be the
                  same file - so a move onto it would be refused, and the factory
                  sitting in it is one you can open instead.

                  Its name and not just the word "factory", because the folder name is
                  the less informative of the two. Projects are called `api` and `web`
                  while the factory in them is called what it builds, and a folder of
                  worktrees is a column of near-identical names with the useful label
                  locked inside each one. Falls back to the bare word when the document
                  is unreadable, which is the one case where the factory cannot say.
                */}
                {entry.factory && (
                  <span className="picker-tag">
                    <Icon name="factory" />
                    {entry.factoryName ?? 'factory'}
                  </span>
                )}
              </button>
            ))}
            {dir && shown.length === 0 && !busy && (
              <p className="picker-empty">
                {dir.entries.length > 0
                  ? `Nothing here matches "${filter}".`
                  : error ?? 'No folders in here.'}
              </p>
            )}
            {error && dir && shown.length > 0 && <p className="picker-empty">{error}</p>}
          </div>
          ) : (
            /*
              The factories the app remembers, most recently a tab first. Server order,
              untouched: it is already "recently open first", which is the order you
              want a history in, and re-sorting it here by name would throw that away
              for an alphabet nobody is looking for.
            */
            <div className="picker-list">
              {closed.map((ref) => (
                <button
                  key={ref.id}
                  className="picker-entry picker-known"
                  title={factoryHint({
                    path: ref.baseDir,
                    factory: true,
                    open: ref.open,
                    factoryName: ref.name,
                  })}
                  onClick={() => openKnown(ref)}
                >
                  <Icon name="factory" />
                  {/*
                    Name over path, two lines. The name is what the operator is looking
                    for and the path is how they tell two of the same name apart, which
                    is the ordinary case for worktrees of one project: same factory
                    name, sibling directories, and the last segment of the path is the
                    only thing that differs. Truncation is from the left in CSS for the
                    same reason, since the end of a path is the part that identifies it.
                  */}
                  <span className="picker-known-text">
                    <span className="picker-name">{ref.name}</span>
                    <code className="picker-known-dir">{ref.baseDir}</code>
                  </span>
                </button>
              ))}
              {known !== null && closed.length === 0 && (
                <p className="picker-empty">
                  {knownError ??
                    (filter !== ''
                      ? `No factory here is called "${filter}".`
                      : 'Nothing closed. Every factory this app knows about is already a tab.')}
                </p>
              )}
              {knownError !== null && closed.length > 0 && (
                <p className="picker-empty">{knownError}</p>
              )}
            </div>
          )}

          {/*
            What the last scan did, or what it failed to do.

            Outside the scrolling list rather than in it, because it is about the
            button below and not about any row above - and because a report that
            scrolls out of sight the moment you look at the list it is describing is
            not a report. Held until the popover closes or the tab changes.
          */}
          {tab === 'factories' && scanNote !== null && (
            <p className="picker-note" role="status">
              {scanNote}
            </p>
          )}

          <div className="picker-foot">
            {/*
              The folder you are standing in is the one you get. There is no
              highlighted row to confuse this with: clicking a row goes into it, and
              this takes where you are, which means the deepest folder is reachable
              without a listing of its own.
            */}
            {/*
              Gone entirely when a factory is already in the folder, rather than
              offered and refused.

              Two factories cannot share a directory - their documents would be the
              same file - so `Host.setBaseDir` rejects the move, and a button whose
              only outcome is an error is worse than no button: it reads as the
              obvious thing to press, and the popover has just gone to the trouble of
              highlighting the row that makes it impossible. What is left in the
              footer is the action that folder actually supports.

              It also hides the one move that would have worked, pointing a factory
              back at a directory it used to occupy, because the id in that document
              is its own and the server would allow it. The picker cannot tell that
              case apart - the listing says a factory is there, not whose - and the
              field beside the button still takes a typed path for it.

              Gone in the home directory too, and that one is not about occupancy: the
              list of factories lives in `~/.kirofactory/`, which is the folder a
              factory based here would want for itself, so the server refuses it. Same
              reasoning as above for hiding rather than offering - `Host.setBaseDir`
              has the message for anyone who types the path in anyway.
            */}
            {onPick && tab === 'folders' && dir?.factory !== true && dir?.path !== dir?.home && (
              <button className="with-icon" disabled={!dir || busy} onClick={choose}>
                <Icon name="hero-check" />
                Use this folder
              </button>
            )}
            {/*
              And the other thing a folder can be: the factory already in it.

              Enabled only when there is one, so pressing it is never a guess - and
              when that factory is already a tab it says switch, because that is
              honestly all it does.

              Both of these are about the folder you are standing in, so both are gone
              on the Factories tab, where there is no folder you are standing in. A row
              there is the whole action: one press, and the factory it names opens.
              Cancel is what is left, which is all that tab needs.
            */}
            {onOpenFactory && tab === 'folders' && (
              <button
                className="with-icon"
                disabled={!dir || busy || !dir.factory}
                title={
                  dir?.factory !== true
                    ? 'No factory in this folder. Walk into the one that holds it.'
                    : factoryHint(dir)
                }
                onClick={openHere}
              >
                <Icon name="hero-folder-open" />
                {/*
                  The name when there is one, because by this point the operator has
                  walked somewhere specific and the button is the confirmation that it
                  is the right somewhere. Truncated in CSS rather than here: a factory
                  called something long should still show as much of itself as the
                  footer has room for.
                */}
                <span className="picker-open-name">
                  {dir?.factory !== true
                    ? 'Open this factory'
                    : dir.open
                      ? 'Switch to it'
                      : `Open ${dir.factoryName === undefined ? 'this factory' : `"${dir.factoryName}"`}`}
                </span>
              </button>
            )}
            {/*
              And the way back to a factory this app has never seen.

              The Factories tab's counterpart to the two folder actions: those are
              about the folder you walked to, and this is for when you cannot walk to
              it because you do not remember where it is. Only on this tab, because a
              scan's whole result is this list getting longer - pressing it from the
              folder listing would change something you are not looking at.

              Behind a confirm, and the confirm is not about danger: nothing is
              deleted and nothing is opened. It is about the seconds. A button that
              silently makes the popover unresponsive while it reads a home directory
              reads as broken, so the dialog says a wait is coming and the operator
              agrees to it.
            */}
            {tab === 'factories' && (
              <button
                className="with-icon"
                disabled={scanning}
                title="Look through your home folder for factories that are not in this list"
                onClick={askScan}
              >
                <Icon
                  name={scanning ? 'hero-arrow-path' : 'hero-magnifying-glass'}
                  className={scanning ? 'picker-scanning' : undefined}
                />
                {scanning ? 'Looking…' : 'Find factories…'}
              </button>
            )}
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {/*
            Mounted inside the popover, not beside it. A modal `<dialog>` draws in the
            browser's top layer wherever it sits in the DOM, so this costs nothing
            visually and buys the one thing that matters: the click that confirms is
            inside `root`, so the outside-press listener does not read it as a press
            somewhere else and close the popover mid-question.
          */}
          <Confirm ask={scanAsk} onClose={() => setScanAsk(null)} />
        </div>
      )}
    </div>
  );
}
