/**
 * Every glyph in the app: one borrowed icon set, and two brand marks.
 *
 * The icons are [Heroicons](https://heroicons.com) v2.2.0, 24px outline, under
 * their own `hero-` names. Keeping the names identical is the point: an icon can be
 * looked up on heroicons.com by the name it is called here.
 *
 * The two exceptions are the wordmark's own marks, and they are exceptions because
 * no icon library has them: `factory`, drawn here to Heroicons' grid and stroke, and
 * `Ghost`, which is Kiro's mascot and is a filled shape rather than an outline, so it
 * is a component of its own rather than an entry in the path table.
 *
 * The usual way to consume Heroicons is a Tailwind plugin that pulls the SVGs at
 * build time. This app has no Tailwind and no build step for assets, so the path
 * data is inlined. That is a deliberate copy: fourteen icons is a few hundred bytes
 * against a dependency and a plugin, and inlining is what lets the icon inherit
 * `currentColor` and size from whatever it sits inside.
 *
 * Only the icons actually used are here. Adding one means copying its `d` out of
 * `optimized/24/outline/<name>.svg` in the heroicons repo, unchanged.
 */

/**
 * Path data, keyed by name. An array is an icon drawn with more than one path,
 * which several outline icons are.
 *
 * A `hero-` prefix means the icon is Heroicons, unmodified, and can be looked up
 * under that name. A name without the prefix is ours, drawn to the same grid and
 * stroke because Heroicons has no equivalent. There are three of those: `factory`,
 * `branch` and `cluster`.
 */
const PATHS = {
  /*
   * A factory, and the one glyph here that is not Heroicons.
   *
   * Heroicons has no factory. `building-office-2` was standing in for one and it
   * reads as exactly what it is, an office block - wrong for a product whose whole
   * metaphor is production. So this is drawn rather than borrowed, on the same 24
   * grid at the same 1.5 stroke with the same rounded joins, so it sits in the set
   * without looking imported from somewhere else.
   *
   * One closed outline: a chimney on the left, three north-light sawtooth bays, and
   * a body that closes along the ground. Being closed is what makes it read as a
   * building - the first attempt drew the roof, the chimney and the ground as three
   * separate strokes, and at this size a row of unconnected ascending shapes reads
   * as a bar chart. The silhouette is unambiguous; the parts were not.
   *
   * The sawtooth is the load-bearing detail. It is the roof every factory pictogram
   * uses, and unlike a truck bay or a puff of smoke it survives being 21px across.
   */
  factory:
    'M2.25 20.25V6.75H6v7.5l5.25-3.75V14.25L16.5 10.5v3.75l5.25-3.75v9.75Z',

  /* A loop. Circular arrows, which is what the component actually does. */
  'hero-arrow-path':
    'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',

  /*
   * A loop cluster, and the third glyph here that is not Heroicons.
   *
   * Three circles joined by three lines. Heroicons has nothing for this - its
   * `users` and `user-group` are people, `square-3-stack-3d` is layers of one
   * thing, and `rectangle-stack` is already what the card's own stacked boxes say
   * visually. None of them means "several of the same agent, aware of each other",
   * which is exactly what a cluster is.
   *
   * So it is drawn on the same 24 grid at the same 1.5 stroke as `factory` and
   * `branch`. The nodes-and-edges silhouette is the one every distributed-systems
   * diagram uses, and unlike a crowd of figures it stays legible at the 10px the
   * card's chips render at: three dots and the lines between them survive being
   * small because the shape is read from its outline.
   *
   * Deliberately close to `branch`, which is also three circles, and deliberately
   * distinct: `branch` is a trunk with one node off to the side and reads as
   * asymmetric, this is an equilateral triangle with every node joined to every
   * other. Hierarchy against a peer group, which is the difference that matters.
   *
   * The connecting lines stop at the circles' edges rather than running to their
   * centres - three units of radius trimmed off each end - so the joins read as
   * edges between nodes instead of spokes through them.
   */
  cluster: [
    // The three nodes: top, bottom-left, bottom-right. Radius 3.
    'M9 6.5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    'M3.5 17.5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    'M14.5 17.5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    // The three edges, trimmed to the circles.
    'M10.66 9.18 7.84 14.82',
    'M13.34 9.18l2.82 5.64',
    'M9.5 17.5h5',
  ],

  'hero-play':
    'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z',
  'hero-stop':
    'M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z',

  /* Force stop: the kill, as opposed to the square's polite request. */
  'hero-bolt': 'm3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z',

  /*
   * Disable a loop: the power symbol, a broken ring with a stem through the gap.
   *
   * Chosen over an eye or a lock because both already mean something here - the
   * lock is MCP scoping - and because "parked, will not start" is what a power
   * button says everywhere else. It is the same glyph in both states; the button
   * colours it rather than swapping it, so the card does not appear to grow a new
   * control when a loop is parked.
   */
  'hero-power': ['M12 3.75v6.75', 'M6.7 7.05a7.5 7.5 0 1 0 10.6 0'],

  'hero-plus': 'M12 4.5v15m7.5-7.5h-15',
  'hero-minus': 'M5 12h14',

  /*
   * A factory parameter: a named value the prompts here can write as `@name`.
   *
   * A luggage tag, which is the glyph for "this thing has a name written on it" -
   * and the parameter bar is a row of names with values on them. Deliberately not
   * the wrench or the chip: those are already a loop's tools and its model, and a
   * parameter is neither a capability nor a machine.
   */
  'hero-tag': [
    'M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z',
    'M6 6h.008v.008H6V6Z',
  ],

  /* Fit the whole factory on screen: arrows drawing the corners inward. */
  'hero-arrows-pointing-in':
    'M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25',

  'hero-x-mark': 'M6 18 18 6M6 6l12 12',
  'hero-trash':
    'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',

  /* Import and export: into the app, out of the app. */
  'hero-arrow-up-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5',
  'hero-arrow-down-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',

  'hero-chevron-right': 'm8.25 4.5 7.5 7.5-7.5 7.5',
  'hero-chevron-left': 'M15.75 19.5 8.25 12l7.5-7.5',

  /* A wire: one loop to the next. */
  'hero-arrow-right': 'M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3',

  /*
   * A git branch, and the second glyph here that is not Heroicons.
   *
   * Heroicons has no version-control icons at all - no branch, no commit, no merge -
   * so this is drawn on the same 24 grid at the same 1.5 stroke as `factory`, for the
   * same reason: the thing it labels is permanent on screen and the alternatives all
   * meant something else already. `hero-arrows-pointing-in` and the folders are
   * spoken for, and an icon that means "directory" cannot also mean "the branch that
   * directory is on".
   *
   * The standard silhouette: a trunk with a node at each end, and one node off to the
   * side joined by a curve. Three circles and two strokes, which survives 13px
   * because the shape is recognised from its outline rather than its detail.
   */
  branch: [
    // The trunk, between its two nodes.
    'M6.75 6.75v10.5',
    // Off the side node, curving back in to meet the trunk.
    'M17.25 6.75v1.5a4.5 4.5 0 0 1-4.5 4.5h-6',
    'M4.5 4.5a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0',
    'M4.5 19.5a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0',
    'M15 4.5a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0',
  ],

  'hero-folder':
    'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',

  /*
   * Pick a different directory: the folder standing open, waiting to be chosen.
   *
   * The open folder against the closed one beside it in the bar. The closed folder
   * labels the path, and this one is the control that changes it - same object in
   * two states, which is a smaller thing to learn than an ellipsis would be.
   *
   * Also the tree in the file panel's own header, for a folder that is expanded.
   * That is the same idea in a different place and reads the same way.
   */
  'hero-folder-open':
    'M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 6v3.776',

  /*
   * Look at the files in the directory: a document under a magnifier.
   *
   * Deliberately not a folder of any kind, which is the whole reason it exists.
   * This button sits immediately beside the folder picker and the two do opposite
   * things - one changes which directory the factory runs in, the other leaves it
   * alone and shows you what is inside it. Both drawn as a folder, they read as one
   * feature with a duplicated button, and the destructive one is not the one you
   * would guess.
   *
   * A document rather than a folder is the distinction that carries it: the picker
   * is about the container, this is about the contents.
   */
  'hero-document-magnifying-glass':
    'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Zm3.75 11.625a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',

  /* Up a directory, and all the way home: the two moves the picker makes. */
  'hero-arrow-up': 'M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18',

  /* Type-to-filter, in the picker's list. */
  'hero-magnifying-glass':
    'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  'hero-home':
    'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',

  /*
   * Save to the library.
   *
   * A bookmark rather than either tray arrow: those two already mean import and
   * export here, which are about moving a whole factory between machines. This is
   * keeping one loop in a collection, and a bookmark is the glyph everything else
   * uses for exactly that.
   */
  'hero-bookmark-square':
    'M16.5 3.75V16.5L12 14.25 7.5 16.5V3.75m9 0H18A2.25 2.25 0 0 1 20.25 6v12A2.25 2.25 0 0 1 18 20.25H6A2.25 2.25 0 0 1 3.75 18V6A2.25 2.25 0 0 1 6 3.75h1.5m9 0h-9',

  /* Done. Shown for a moment in place of an action that succeeded. */
  'hero-check': 'm4.5 12.75 6 6 9-13.5',

  /*
   * The interval a loop leaves between turns: a clock.
   *
   * Distinct from `hero-pause` next to it on purpose, because the two marks sit
   * side by side on a card that has both and they mean different waits - one for
   * an item to arrive, one for a length of time to pass. A clock is the only
   * glyph here that says "a duration" rather than "stopped".
   */
  'hero-clock': 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',

  /* Scoped MCP access: the loop's agent gets only the servers it was granted. */
  'hero-lock-closed':
    'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z',

  /* Waits for work: the loop pauses itself on an empty queue. */
  'hero-pause': 'M15.75 5.25v13.5m-7.5-13.5v13.5',

  /* Narrowed built-in tools: the loop's agent gets fewer than all of them. */
  'hero-wrench': [
    'M21.75 6.75a4.5 4.5 0 0 1-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 1 1-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 0 1 6.336-4.486l-3.276 3.276a3.004 3.004 0 0 0 2.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852Z',
    'M4.867 19.125h.008v.008h-.008v-.008Z',
  ],

  /* The model a loop runs on. */
  'hero-cpu-chip':
    'M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z',

  /*
   * Throw away what is waiting on a queue: a lidded box with its contents crossed out.
   *
   * Not a bin, and that is the whole requirement. The bin means "remove this thing" -
   * the wire, the loop - and this button sits in the same panel meaning "keep the
   * thing, empty it". Two bins a few pixels apart, however they were drawn, would be
   * one glyph for the reversible action and the irreversible one.
   *
   * A box reads as a container with contents, which is what a queue is, and nothing
   * else in this app uses the silhouette.
   */
  'hero-archive-box-x-mark':
    'm20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125 2.25 2.25m0 0 2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z',

  /* A queue. Items in a line, waiting. */
  'hero-queue-list':
    'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z',

  /*
   * A topic: said once, heard by everyone listening.
   *
   * Paired with the queue glyph on the wire's mode control, and the pairing is the
   * point - a line of items to be shared against a broadcast to all comers.
   */
  'hero-megaphone':
    'M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102-9.111a20.845 20.845 0 0 0 1.44-4.282c.267-.578.976-.779 1.527-.461l.657.379c.523.302.71.964.463 1.511-.401.891-.732 1.821-.985 2.783m0 9.18a24.301 24.301 0 0 1 8.835 2.535M10.34 6.66a24.301 24.301 0 0 0 8.835-2.535m0 0A23.74 23.74 0 0 0 21 12c0 2.836-.497 5.556-1.41 8.078',
} as const;

export type IconName = keyof typeof PATHS;

/**
 * An icon sized and coloured by whatever it sits in.
 *
 * No size prop: `.icon` is `1em` square in the stylesheet, so an icon beside text
 * matches that text without either being told a pixel value. Override with a class
 * when something needs to be bigger than its label, which the brand mark is.
 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  /*
   * Widened before it is used, and it has to be.
   *
   * `PATHS` is `as const`, so indexing it gives a union of string literals and
   * readonly tuples of different lengths. `.map` over that union has one signature per
   * member and TypeScript will not unify them, which is an error rather than an
   * inconvenience - narrowing on `typeof` after widening is what makes the two cases
   * one array again.
   */
  const d: string | readonly string[] = PATHS[name];
  const paths = typeof d === 'string' ? [d] : d;
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ the ghost */

/**
 * Kiro's ghost, taken from the mark kiro.dev serves as its own icon.
 *
 * Three of these come off the factory in the wordmark, which is the joke the repo's
 * cover image already tells: a factory whose product is Kiro sessions. Every loop is
 * a Kiro session, so the ghosts are what the thing makes.
 *
 * Two things differ from the icons above, both because this is a mascot and not a UI
 * glyph. It is filled rather than stroked - an outlined ghost at 16px is a blob with
 * a wobble - and the eyes are holes rather than shapes: body and eyes are one path
 * with `fill-rule: evenodd`, so the eyes show whatever is behind the ghost instead of
 * being painted a colour that would have to be kept in step with the background.
 *
 * The viewBox is the mark's own bounding box rather than the 1200 square it is served
 * in, so the ghost fills the space it is given instead of sitting in a quarter of it.
 */
const GHOST =
  // Body.
  'M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z' +
  // Left eye.
  'M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z' +
  // Right eye.
  'M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z';

export function Ghost({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `ghost ${className}` : 'ghost'}
      viewBox="272.87 202.68 653.73 795.07"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path fillRule="evenodd" clipRule="evenodd" d={GHOST} />
    </svg>
  );
}
