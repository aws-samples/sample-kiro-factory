# The library

Loops, clusters and whole factories that worked, kept as files so they can be shared.

A loop is a name and a prompt, so a loop worth keeping is a small JSON file and
nothing more. Everything in this folder shows up in the **Library** picker on the
toolbar, and picking something puts it on the factory floor - or, for a factory, opens it as
a new tab.

## Three kinds, three folders

```
library/loops/       one loop: a name and a prompt
library/clusters/    the same, running several sessions
library/factories/   a whole design: loops, wires and parameters
```

The split is for whoever is reading the repository rather than for the app. The
audience of a committed folder of JSON is people, and one flat directory mixing a
single prompt with a whole wired-up factory is a directory nobody browses twice.

The folders organise without deciding. Whether an entry is a loop or a cluster is read
off its `cluster` field, not off where it sits, so a misfiled entry still works and
simply waits for a reviewer to move it. Files left directly in `library/` are read too,
as loops and clusters - that is not for the entries here, which were moved into their
folders when the split happened, but for a checkout with an uncommitted entry in the
old place.

## A loop

One file per loop, `loops/<slug>.json`:

```json
{
  "kirofactoryLoop": 1,
  "name": "Verifier",
  "description": "Checks each item against the thing it came from.",
  "prompt": "take one item from @input and check it against ...",
  "author": "your-github-handle",
  "tags": ["review"]
}
```

`prompt` is the only field that has to be there. A file without one is skipped, since a
loop with no prompt has nothing to share. `name` falls back to the filename, and the
rest to empty.

There is no `id`, `x` or `y`. Those describe where a loop sits on one particular
factory, which is not something a shared loop can know - they are assigned when the
entry is dropped into a factory.

## A cluster

A cluster is a loop with one more field, and so is a file with one more field:

```json
{
  "kirofactoryLoop": 1,
  "name": "Reviewers",
  "description": "Five readers racing for items off one queue.",
  "prompt": "take one item from @input and ...",
  "cluster": { "mode": "fixed", "size": 5, "comms": "isolated" }
}
```

`cluster` takes `mode` (`fixed` or `scaled`), `size` (2 to 16) and `comms` (`isolated`
or `flock`). All three are clamped rather than refused: a size of 500 becomes 16, an
unrecognised mode becomes `fixed`, and a bare `{}` becomes the smallest isolated
cluster. A hand-written file should never disappear out of the picker without saying
why.

The shape is kept because it is part of what the prompt was written for rather than
part of where the card sits. A prompt written for a ring of five reading each other's
lines does something else entirely on its own, so an entry that dropped the shape would
be sharing something that no longer works. That is the same test `x` and `y` fail: they
describe one factory's floor, this describes the loop.

## A factory

A whole design, `factories/<slug>.json`: the loops, how they are wired, and the
parameters they read.

```json
{
  "kirofactoryLibrary": 1,
  "name": "Research pipeline",
  "description": "Finds sources on a topic, then writes them up.",
  "author": "your-github-handle",
  "tags": ["research"],
  "parameters": [
    { "name": "topic", "value": "quantum computing", "description": "what to research" }
  ],
  "loops": [
    { "id": "l1", "name": "Find", "prompt": "search for @topic and ...", "x": 60, "y": 60 },
    { "id": "l2", "name": "Write", "prompt": "take one item from @input and ...", "x": 320, "y": 60 }
  ],
  "wires": [{ "id": "w1", "from": "l1", "to": "l2", "mode": "queue" }]
}
```

`loops` is the field that has to be there; an entry with none is skipped, because a
factory with nothing in it is not a design. The loops and wires go through the same
reader a factory document does, so run modes resolve by precedence, cluster sizes are
clamped, and a wire pointing at a loop that is not there is dropped rather than
carried around.

**Positions are kept**, which is the one place a factory entry differs from a loop
entry. A single loop's position is where somebody else's card happened to sit and means
nothing here, but a factory's positions are the diagram - which loop feeds which, read
left to right - so an entry that dropped them would arrive as a heap of boxes at the
origin with the design lost.

**There is no `baseDir` and no `id`.** The directory is a path on whichever machine
shared the entry, and the identity belongs to a factory rather than to a template:
every take-out is a new factory that happens to share a shape, so it gets a fresh id
and the directory is chosen when it is taken out. Loop ids *are* kept, because the
wires are matched by them and a new factory has nothing for them to collide with.

**Parameters travel with it**, names and values both. A parameterised factory whose
parameters were stripped would arrive with every prompt full of `@topic` tokens
standing for nothing, and the values that came with it are the worked example of what
it expects. Whoever takes it out changes them on the directory bar, which is one click.

A parameter's `name` has to be writable as `@name` - letters, digits, `-` and `_`,
starting with a letter or digit - and cannot be `input`, `output`, `project` or `loop`,
which the prompt defines for itself. Names that fail either test are dropped on read.

## Writing prompts that travel

**`@input` and `@output`** are how a prompt names its queues. They are names rather
than paths, so a prompt written against them works wherever it is wired. Use them
instead of hard-coded folders, which is what makes an entry portable in the first
place.

**`@name`** is a parameter, and it is what lets one design serve more than one job: a
research pipeline that reads `@topic` is the same pipeline whatever the topic is. A
factory entry brings its own parameters; a loop or cluster entry does not, so a prompt
naming `@topic` in one of those relies on the factory it lands in having a parameter of
that name. Say so in the description when it does.

Anything else after an `@` is read as an MCP server, so avoid naming a parameter after
a tool you expect to be available - the parameter wins, and `@github` will substitute a
value rather than granting the server.

## Contributing

The library grows by pull request. If something earned its place in your factory, it
will probably earn one in someone else's.

1. Get it working in the app.
2. For a loop or a cluster, press the bookmark button next to its name. For a whole
   factory, press **To library** in the top nav. Either writes the file here, in the
   folder for what it is, with the `cluster` block or the wires and parameters already
   filled in.
3. Open the file and fill in `description`, `author` and any `tags`. The buttons cannot
   know those.
4. Commit the one file and open a pull request.

Saving writes into your checkout, so an entry shows up in `git status` as exactly the
file you would send.

Some things that help an entry get merged:

- **A prompt that says what to produce, not how to feel about it.** Loops run
  unattended, so "add one sentence and hand it on" beats "be creative".
- **One round, one item.** A prompt that takes the whole queue at once cannot be
  paced, and a queue that empties in one turn tells you nothing about backlog.
- **A description someone can pick from.** It is the line shown under the name in the
  picker, so it is what people choose on.
- **Parameters with a description each**, on a factory. The name says what to write in
  a prompt; the description says what a good value looks like.

Names do not have to be unique. Saving something whose name is taken writes
`name-2.json` rather than refusing, so nothing interrupts the moment you decided it was
worth keeping. Renaming during review is fine.

## A word on what you are sharing

A prompt is instructions to an agent running with every tool permitted, in whatever
directory the factory points at. A factory entry is several of those, already wired
together. Read one before you run it, and write yours so it reads plainly to whoever
does.
