---
name: KiroFactory-skill
description: Design and generate Factory for Kiro documents (factory.json) - loops, loop clusters, wires, queues and topics that run unattended agent pipelines over a codebase or a set of documents - including Kiro Dark Factories, whose heavy work runs as remote Kiro Flock clusters and whose local loops do only what needs the operator's machine. Use when building a factory, parallelising autonomous work across several agent loops or cluster nodes, writing or fixing loop prompts, choosing queue versus topic delivery, sizing a cluster or setting its comms or its flock algorithm (amorphous, mesh, swarm, single), scoping tools and MCP servers per loop, choosing stop conditions, combining the factory with a flock, deciding what goes local versus remote, writing a flock direction as a loop prompt, sizing run modes and intervals for an unattended multi-day run, or debugging a factory that stalls, duplicates work, waits on itself, idles a remote cluster, loops forever, runs up cost, or writes output to the wrong place.
---

# Factory for Kiro

A factory is a floor of **loops** joined by **wires**. Each loop is a name and a prompt. It runs
a turn, then another, until stopped. Each turn is a fresh agent session, so a loop's only memory
is what it left on disk.

That single property drives every design decision here. There is no conversation, no shared state
in RAM, no orchestrator holding the plan. The disk is the program's memory and the prompts are its
code.

## The document

One JSON file is the whole factory. It is also the interchange format: export writes exactly this,
import reads exactly this.

**A factory is a folder.** The document lives at `<project>/.kirofactory/factory.json`, and the
folder that holds `.kirofactory/` is the project the loops work in. So a document carries no
location and no identity:

- **Do not write `id`.** The app mints one the first time the folder is opened and writes it back.
  An invented or copied id is how two factories end up claiming the same identity.
- **Do not write `baseDir`.** The folder the document sits in is the base directory. A `baseDir` in
  the file is ignored.

```json
{
  "kirofactory": 1,
  "name": "MyFactory",
  "parameters": [
    { "name": "topic", "value": "quantum error correction", "description": "what this run is about" }
  ],
  "loops": [
    {
      "id": "loop-planner",
      "name": "Planner",
      "prompt": "...",
      "autoPause": false,
      "tools": ["read", "write", "shell"],
      "mcp": [],
      "model": "some-model-id",
      "x": 0,
      "y": 0
    }
  ],
  "wires": [
    { "id": "loop-a-loop-b-w01", "from": "loop-a", "to": "loop-b", "mode": "queue" }
  ]
}
```

Fields, and what absent means:

| Field | Meaning |
|---|---|
| `parameters` | Factory-level named values every prompt here can write as `@name`. **Absent means none.** See below. |
| `autoStop` | Let the loop stop itself when its agent judges the job done. Two-turn handshake: the agent declares `NO FURTHER WORK`, then must confirm with `CONFIRM STOP` on the next turn having contributed nothing. |
| `stopAfterIterations` | End the run after this many turns *of that run* - a restart gives the full count again. Integer ≥ 1. |
| `stopAfterHours` | End the run this long after Start. Fractions allowed. A turn already going finishes first. |
| `autoPause` | Wait for work instead of taking a turn on an empty queue. |
| `disabled` | Left out of every start - its own button, `Run all`, an API call. Everything else still works and the floor greys it. Absent or `false` means startable. |

The four run-mode fields above are **exclusive: set at most one**. Absent everything means run
forever, which is what documents written before these fields existed mean by not having them. A
document carrying several resolves narrowest-first - `autoStop`, then `stopAfterIterations`, then
`stopAfterHours`, then `autoPause` - and the panel reads them back the same way, so what it shows
is what runs. `disabled` is not a run mode and combines with any of them.

| `intervalSeconds` | Whole seconds to idle between turns. **Absent means none**, and `0` is written as absent. Taken *after* a turn, so Start still runs one immediately; Stop or a message to the loop cuts the wait short. Applies per session, so every node of a cluster waits its own. |

`intervalSeconds` is **not** a run mode and combines with all of them: the mode decides whether
another turn starts, this decides when. Use it for a loop whose work arrives on someone else's
schedule - polling an external system, spending a budget over a day, staying inside a rate limit.
Do not use it to stop a starved loop spinning; that is `autoPause`, which resumes on the queue
rather than on a clock. The panel's rungs are 10s, 30s, 1m, 5m, 15m, 30m, 1h, 2h, 5h, 12h, 24h; a
hand-written value off that ladder is kept as written.
| `tools` | Built-in tool names, exactly as the panel emits them. **Absent means all**, and stays all as new categories ship. Present means exactly these, frozen. One panel row is not always one name - write every name the row stands for: `read`; `write`; `glob`, `grep` (the panel's *search*); `code`; `shell`; `web`, `web_search`, `web_fetch` (the panel's *web* - on the surface this app runs against `web` alone grants nothing); `subagent`; `knowledge`; `todo_list`; `introspect`. The shipped default for a new loop is every name above except `subagent`. |
| `mcp` | MCP server names the loop may load. **Absent means all**. `[]` means none. Servers the prompt names with `@` are granted on top. |
| `model` | Model id. Absent means the machine default. The catalogue is discovered at runtime, so do not invent ids. Leave absent unless you know the id. |
| `worktree` | Give every session of this component its own git checkout of the repository, on its own branch. **Absent means no**, and all the loops share `baseDir`. See below. |
| `cluster` | Run this component as several sessions instead of one. **Absent means a plain loop.** See below. |
| `remote` | Run this component as a cluster on a Kiro Flock the operator already has, not on this machine. **Absent means local.** `{ "kind": "flock", "connection": "<id>", "algorithm"?: "amorphous"\|"mesh"\|"swarm"\|"single", "neighbourRadius"?: n, "swarmK"?: k, "taskSize"?: "small"\|"medium"\|"large"\|"xlarge", "browser"?: true, "trustDeploy"?: true, "selfOptimizing"?: true }`. See below. |
| `x`, `y` | Position on the factory floor. Required by the renderer, meaningless to behaviour. |

### Parameters

`parameters` are named values the whole factory shares, and the one reference in a prompt that is
**substituted** rather than defined:

```json
{
  "parameters": [
    { "name": "topic", "value": "quantum error correction", "description": "what this run is about" },
    { "name": "depth", "value": "survey" }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | The token without the `@`. Letters, digits and dashes, same rule as a loop id. |
| `value` | What `@name` becomes. Free text. Blank is allowed and reads as unset. |
| `description` | What it is for, for whoever inherits the factory. Absent when not worth saying. |

`research @topic to a depth of @depth` reaches the agent as `research quantum error correction to
a depth of survey`. Everything else a prompt can write resolves to a folder or a capability that
gets explained in a section above the instruction, because those are too large to sit inside a
sentence. A parameter is the opposite: a short value the sentence reads *through*.

Three properties worth designing around:

**Substitution happens per turn, not at save.** So the value can be changed between runs, or while
a loop is running, and the next iteration picks it up. That is the whole reason to reach for one:
the prompt is written once and the thing the run is *about* is set from the directory bar.

**It is factory-level, never per loop.** A parameter is what this run is about, and every loop
wants the same answer. Six loops with six copies of one value is six places to change it and a
factory whose loops disagree.

**A blank value keeps its token.** The prompt still says `@topic` and the agent is told that
parameter is unset. Substituting nothing would turn `research @topic thoroughly` into a sentence
that still reads as an instruction while quietly asking for something else.

`@project`, `@loop`, `@input` and `@output` are reserved and a parameter cannot take those names.
Parameters share the rest of the namespace with MCP server names and a parameter wins, so a
parameter named after a server you hold substitutes a value where the prompt looks like it grants a
tool. Do not name one after a server. A parameter never grants anything.

Use one for the subject of the run, a target path, a depth or budget, an audience, a house style
name. Do not use one for anything long: a plan, a rules document or a set of conventions belongs in
a file in `@project` that the loops read, which is rule 2.

### Own checkout, per session

`worktree: true` gives every session of a component a full git checkout of the repository, on a
branch of its own, instead of all of them sharing `baseDir`.

Reach for it when parallel sessions would otherwise edit the same files. Rule 3 exists because two
agents writing one document clobber each other, and splitting the artefact is the answer that
needs no git. This is the other answer, and it is the better one when the work genuinely cannot be
split by file: a cluster of eight refactoring one codebase, several agents each trying a whole
approach, anything where the unit of work is a change across many files rather than one file.

```
~/projects/
  shop/                  the repository, the factory's baseDir, machinery in .kirofactory/
  shop-loops/            one container for all of this repo's session checkouts
    api-writer/          a plain loop's checkout      branch kirofactory/shop-api-writer
    worker-n1/           cluster member 1's checkout  branch kirofactory/shop-worker-n1
    worker-n2/           cluster member 2's checkout  branch kirofactory/shop-worker-n2
```

What changes for the prompt: inside such a session `@project` **is** that session's checkout, so
the agent works and commits there and is told which branch it is on. The machinery stays in the
factory's base directory and is named by absolute path, so `@loop`, queues and topics do not fork.
Coordination is shared; the working tree is not.

What that means for a design:

- **The branches have to be merged by something.** The app never merges. Either a fan-in loop that
  holds `shell` does it, or you tell the operator it is theirs to do with git. A factory that
  produces eight branches and no plan for them has not finished.
- **A flock cluster's broadcasts get less useful.** A neighbour naming a file is naming a file in
  *its* checkout, reachable only through its branch. Each member is told so, but if the ring's
  whole value was pointing at each other's files, isolated plus own checkouts is the honest shape.
- **The document carries the intent and nothing else.** Which session got which directory lives in
  `.kirofactory/worktrees.json`, so an exported factory carries no absolute paths from one machine.
- **It needs a repository with at least one commit**, and it is read once at Start. Like a
  cluster's shape, it cannot be changed while the component runs.
- **First start is slow.** One `git worktree add` per session, serialised because git holds a lock.
  Say so when handing over a design that gives a cluster of twelve its own checkouts.

Release, beside the checkbox in the panel, removes the checkouts again through git. It never
forces, so a checkout with uncommitted changes refuses and stays, and branches are never deleted.

### Loop clusters

`cluster` turns one component into several agent sessions running the same prompt at once:

```json
{ "cluster": { "mode": "fixed", "size": 4, "comms": "isolated" } }
```

| Field | Values |
|---|---|
| `mode` | `fixed` - exactly `size` nodes, started together. `scaled` - one node per waiting item, with `size` as the ceiling. |
| `size` | 2 to 16. Clamped, not rejected: a `1` becomes 2 and a `500` becomes 16. |
| `comms` | `isolated` - nodes never see each other. `flock` - a radius-1 ring, described below. |

**A cluster is one loop with several sessions, and wires see one loop.** On a queue that makes
it exactly N separate consumers: `channelDir` keys the folder on the producer, every node reads
the one folder, and they compete for items by atomic rename. So **a cluster is the way to write
rule 4's worker pool once instead of N times** - one prompt, one set of grants, one box - and it
is the better answer whenever the pooled consumers would have been identical.

On a topic it is *not* N separate consumers. A topic delivers one copy per subscribing loop, and
a cluster is one subscriber: N nodes share one copy and compete for it, where N separate loops
would each get their own copy and each work every item. A topic feeding a single cluster
therefore behaves like a queue. If every node must see every item, draw separate loops.

Reach for N separate loops instead when the workers are *not* identical: different prompts,
different grants, different models, one that needs its own wire - or when each must receive its
own copy from a topic. A cluster has one of each by construction.

Every node gets its own `@loop` at `loops/<id>/n<i>/` (one-based: `n1`, `n2`, ...), so rule 3 (one
file per work unit) still
applies across nodes and the sibling contention note is added to the prompt automatically -
you do not need to write "your input is shared" into a cluster's prompt the way you do for a
hand-drawn pool.

`scaled` counts the items on the folders the component reads plus the nodes currently working
one, so it does nothing on a component with no input wire: that cluster runs one node. Use
`fixed` for anything without a queue feeding it. A `scaled` cluster also needs `autoPause: true`:
the supervisor sheds only nodes that have gone idle waiting for work, and without `autoPause`
a node is never idle, so the cluster grows and never shrinks.

**`comms: "flock"`** gives the nodes a ring: each reads its two neighbours' recent broadcasts,
and ends each turn with a line starting `BROADCAST:` carrying one JSON object
(`{"action","result","next_intent"}`). The runner reads the neighbours and appends the broadcast
itself, so the prompt does not need to mention files or paths. Append-only, one log per node,
under `loops/<id>/flock/`.

Use it when nodes can usefully avoid each other's work in ways the queue cannot express -
overlapping research, exploratory work with no clean item boundary, several agents converging on
one design. Leave it `isolated` when the queue already partitions the work cleanly, which is most
pools: the ring costs prompt space and a little judgement per turn, and buys nothing when items
are already disjoint.

Members do not vote and there is no quorum. Each still runs its own `autoStop` handshake, so a
cluster converges node by node rather than all at once.

**A cluster's shape cannot be changed while it runs.** `mode`, `size` and `comms` are locked in
the panel until the component is stopped, and so is converting between a loop and a cluster.
Nodes are keyed per member, so changing how many there are changes every key: turning the size
down retires the nodes past it, and a retiring node has claimed an item off a queue it has not yet
written back. Design the size you want rather than planning to tune it mid-run, and tell the
operator that resizing means Stop, change, Start.

There is no validator. A document either parses or it does not.

Everything a factory needs on disk lives under one folder inside `baseDir`:

```
<baseDir>/.kirofactory/factory.json          the design
<baseDir>/.kirofactory/queues/<from>/        one per producer, shared by its queue wires
<baseDir>/.kirofactory/topics/<from>/<to>/   one per topic subscriber
<baseDir>/.kirofactory/loops/<id>/           one folder per loop, its scratch and output
<baseDir>/.kirofactory/loops/<id>/n1/, n2/   one per cluster node, its own @loop
<baseDir>/.kirofactory/loops/<id>/flock/     a cluster's ring logs, one file per node
<baseDir>/.kirofactory/worktrees.json        which session owns which checkout, per machine
<baseDir>/.kirofactory/remote.json           which remote loop drives which flock cluster, per machine
<baseDir>/.kirofactory/remote/<conn>/<id>/   a remote loop's bridge folder: items in flight
```

A component with `worktree: true` also gets directories *outside* `baseDir`: one checkout per
session under `<parent>/<repo>-loops/`, beside the repository. Those are made and removed through
git, never by the app's own deletes.

### Remote loops

`remote` makes the component a cluster on a Kiro Flock: the nodes are Fargate tasks on the
operator's flock, the prompt is the cluster's direction, and the queues are the cluster's own S3
(`environment/<clusterId>/queue/in|out|claimed/`). The factory moves items between the loop's wires
and those folders. Everything else about wiring is unchanged - a remote loop reads and writes
wires exactly as a local cluster does.

```json
{ "remote": { "kind": "flock", "connection": "fc-9k2x" }, "cluster": { "size": 6 }, "autoPause": true }
```

**`algorithm` is how the nodes talk**, the flock's own four. `amorphous` (the default; leave it
out) is a ring, each node reading its neighbours within `neighbourRadius`; it scales and the
neighbours' log lines are what let nodes split work without being told who takes what. `mesh` is
every node reading every other - fine up to a handful. `swarm` is each node reading the `swarmK`
most recently active, for larger clusters where a mesh is too much. `single` is no peers: each node
works the direction alone, so `size` single nodes are that many independent fire-and-forget runs,
and queue items still work because the queue hands out the work. Single is the one algorithm that
allows `cluster.size: 1`; the others floor at 2. Write `swarmK` only with `swarm` (clamped to
`1..size-1`) and `neighbourRadius` only matters to amorphous (`1..floor(size/2)`).

What the parse forces, so do not write otherwise: `cluster.mode` is `fixed`, `cluster.comms` is
`flock`, and `cluster.size` has **no local ceiling** (the flock's own cap applies at Start).
`tools`, `mcp`, `worktree`, `autoStop` and `stopAfterIterations` are dropped - remote agents run
`kiro-cli` with its defaults plus the flock's `s3` MCP server and have nothing from this machine,
no checkout, and no single iteration count. `intervalSeconds` is capped at 3600. The run modes
that remain are wait for work (`autoPause`, which maps to the flock's autopause), run forever, and
`stopAfterHours` (enforced by the factory, so it fires while the factory is up or at reconnect).

**Prompts for a remote loop must not name `@project`, an MCP server, a skill or a steering
file**: there is nothing on the flock to answer to them, and Start refuses with the list.
`@input`, `@output`, `@loop` and parameters are fine; the first three become S3 paths. The
direction the nodes read tells them to move an item from `queue/in/` to `queue/claimed/in/` when
they take it and to write results to `queue/out/`; you do not write that protocol into the prompt.
Two nodes may take the same item; that is accepted and the cluster converges. Delivery onto the
downstream wires is at least once, so a consumer should key on the item `id`.

`connection` names an entry in the operator's own `~/.kirofactory/flocks.json`. It is machine-
local: a library entry carries it blank and the operator picks a connection when the design lands
on a canvas. Do not invent one. The cluster id on the flock is derived from the connection, the
factory and the loop, so it is never written in the document.

**Nothing in the document stops a remote cluster.** Deleting the loop, closing the factory,
disabling it (refused while live), editing it - none of these touch the flock. Only the operator's
Stop, Force stop, Delete, or the `stopAfterHours` mode do. Say so when handing over a design with
a remote loop: it bills until somebody stops it.

**The document and the flock stay in step while the factory is attached**, both ways, latest
writer wins. An edit on the flock's dashboard (model, interval, autopause, direction, and the
restart-required size, algorithm, radius, K, task size, browser) lands in the document within
fifteen seconds; an edit to the document reaches the flock at once. A direction edited on the
flock comes back as the prompt with `@input`-style words restored; parameter values stay values.
So a document is not a one-shot: what the operator tunes on either side is what the design says.
A design with several remote loops and the local loops around them is a **dark factory**; see
the section of that name below before writing one.

That is the only place the app writes inside a project. There are two ways to get a generated
document open, and which one is right depends on where the document already is.

**Write the document straight into the project and tell the operator to Open that folder.** Save
it as `<project>/.kirofactory/factory.json`, with no `id` and no `baseDir`, then say: press
**Open** and click the project's row, or paste its path and press Enter. The factory opens in
place and the app gives it an id. This is also how a closed tab comes back - the folder is still
there, so nothing was lost by closing it.

**A document from somewhere else wants Import**: drop the JSON onto the factory floor, or use the
Import button. The app then asks which folder it goes in, starting in the default folder for new
factories, and refuses a folder that already holds a factory. If a factory with the same id is
already on this machine, the import gets a fresh id, because it is a copy.

A factory cannot be moved to another folder in place, and two factories cannot share one. To use
a design somewhere else, Export it and Import it there.

`+` creates an empty factory in a folder of its own inside the default folder: `app/workspaces/`
unless the operator picked another one in the Open picker.

## Wires

A wire is a folder. Nothing is pushed: wiring tells the downstream loop where to look. An item is
a small JSON file **named `*.json`** - every counter, panel and waiting consumer reads that
extension and nothing else, and a name starting with `.` is not an item. **Taking one moves it
out** into the taking loop's own folder. The move is
the claim, and a rename is atomic, so two loops racing for one item cannot both win. The agent does
the move with a shell command, so this holds only for a consumer that holds `shell` - see Least
privilege below.

Because taking removes, a queue shows exactly what is outstanding and nothing else. There is no
record on the wire of what already crossed it.

**`queue`** is the default and the sharing one. Every queue wire out of one loop points at the
*same* folder. Wiring a second consumer does not make a second queue, it puts a second worker on
one backlog. This is how you parallelise a slow step.

**`topic`** gives each subscriber its own folder and the producer writes a copy into each, so
everybody sees everything.

Always write `mode` explicitly on every wire. A wire without one falls into legacy resolution -
topics wherever a loop fans out, queues elsewhere - which exists for old documents, not for new
ones.

### The producer-mode rule

**Mode belongs to the producer, not to the wire.** Every wire out of one loop carries the same
mode, always. A producer either has one shared backlog or a copy per consumer, never a mix.

This is the constraint that shapes topologies, and the one most likely to bite. If one loop fans
out to two workers *and* a logger, all three wires are the same mode: either the logger competes
with the workers for items, or the workers each get a private copy and do everything twice.

The fix is never a clever wire. It is a second producer loop. **One producer per kind of work.**

### Fanning in needs no mechanism

Several wires into one loop are simply several folders under its `@input`. There is no merge step.
The prompt tells the consumer to look in all of them and take from whichever has something. On a
fan-in wire the mode switch is a genuine no-op, because wires from different producers get a
folder each under either mode.

## Prompt tokens

Four names a prompt can use. They are names, not paths, because the folder depends on the wiring.

- **`@input`** the folders this loop reads work from
- **`@output`** where it hands work on
- **`@project`** the base directory, the thing being built
- **`@loop`** this loop's own folder for scratch, claimed items, and notes to its next turn

Plus one per entry in `parameters`, written as **`@name`**, which is substituted with that
parameter's value rather than defined above the instruction. See Parameters above.

Naming an MCP server with `@name` grants it on top of the `mcp` list, so a prompt can never
promise a tool the agent does not hold. `@project` and `@loop` are reserved and cannot be shadowed
by a server name.

**Always name `@project` explicitly.** This is the mistake operators make. `@loop` is the nearer
folder and the easier place for an agent to drift into, so a prompt that never mentions the project
tends to produce notes *about* the work instead of the work. A loop with nothing wired downstream
has no `@output`, and its result is the change it made in the project.

## Design rules

These are what separate a factory that converges from one that spins.

### 1. Write idempotent, self-terminating prompts

A loop runs forever until stopped. There is no iteration cap and no done state. So every prompt
must answer two questions: *what if this is already done*, and *what if there is nothing to do*.

Give it a shape:

> Do only the phase that is not yet done, then stop for this turn.

> When there is nothing left, write nothing and say so.

Without the second line a loop will invent work to justify its turn, and the work it invents is
usually damage.

### 2. Work items on wires, shared knowledge in files

Put only hand-offs on queues. Anything several loops need to *read* belongs in a file in
`@project`: a plan, a verified-facts file, a manifest, a rules document.

This is the highest-leverage decision available. Knowledge in files means the loops producing it
need no wiring at all, which turns whole workstreams into independent loops with no upstream
dependency. Knowledge on wires means one consumer takes it and the rest never see it.

### 3. One file per work unit, where the work is code

For code, parallel loops should not share one output file. Two agents editing one source file
clobber each other and the build breaks in ways neither of them caused.

So split the artefact. If the deliverable is one document, make it a thin index plus one file per
section, and give each worker exactly one file. If it is one config, split by concern. The index
belongs to a single integrator loop, never to the workers.

This is a rule about correctness, not a ban. For prose that is meant to converge - a research
finding, a design note, a Kiro Flock cluster arguing towards one document - several nodes writing
one file is fine and often the point: each turn re-reads the file, notices what a neighbour
changed, and corrects or builds on it. A clobbered paragraph costs one more turn; a clobbered
source file costs a broken build. Choose per artefact.

### 4. Use worker pools on the slow steps

One producer, `queue` mode, several identical consumers. They compete for items off one backlog,
so throughput scales and no scheduling logic is needed.

**Prefer a `cluster` when the consumers are identical**, which for a pool they usually are: one
component, one prompt, one set of grants, and the contention note is added to its prompt for you.
Use several separate loops when the workers genuinely differ - different prompts, grants, models,
or one that needs a wire of its own.

For a hand-drawn pool, tell every consumer that its input is contested:

> Your `@input` is shared with the other workers, so an item that vanishes mid-turn was claimed by
> a peer and is not lost.

Without that line, a vanishing item reads as a fault and the agent starts investigating.

### 5. Keep judgement steps single

Pool the mechanical steps. Do not pool the ones that need one view of the whole. Voice consistency,
final approval, holding a global constraint, keeping an index ordered: these are one loop each.
Splitting them produces an artefact that reads like several agents wrote it, because several did.

### 6. Coordinate gaps through a needs list, not by blocking

When a worker finds a dependency missing, blocking is wrong: the turn is wasted and the queue
backs up. Instead have it reference the expected path, record the gap in a shared needs file, and
carry on. Independent loops treat that file as their work list.

The result is a system that self-organises without anyone scheduling it, and where a missing
dependency degrades one slide, section or module rather than the run.

### 7. Fold one-off setup into the loop that needs it

Do not add a scaffold loop that runs once and then idles forever. Make it phase one of the loop
that depends on it:

> If the project is not set up, set it up this turn and stop. If it is, go on to the plan.

Fewer loops, no dead floor space, and no gating wire whose only job is to say "ready".

### 8. Isolate shared external resources

If several loops drive one external thing (a browser, a dev server, a port), the prompt must say
how to share it. Have each loop open its own context, address its target directly, and never use
an API that moves global state for everyone. Have each loop check the resource is up and start it
detached if not, rather than assuming another loop did.

### 9. Budget the loops that never rest

Every turn is a model call, whether or not there was anything to do. `autoPause` only helps a loop
with a wire into it - a loop with no input has nothing to wait for and *cannot* pause, so it takes
a turn every interval, forever, at full price. Producers are the same once dispatch is finished:
"write nothing and say so" terminates the work, not the spending.

`autoStop` is the answer for exactly these loops. With it on, the agent may end the run itself:
it closes a turn with a line starting `NO FURTHER WORK:` and a reason, gets exactly one more turn
to check again, and stops the loop by closing that turn with `CONFIRM STOP:` having contributed
nothing in between. Anything else - work found, an operator message, the mode changed - withdraws
the declaration and the loop carries on. Only the confirmation stops it, so a queue that is
momentarily quiet cannot kill a consumer. Put `autoStop: true` on producers and finite jobs; the
loop's prompt does not need to mention the phrases, the runner teaches them each turn.

`stopAfterIterations` and `stopAfterHours` are the blunt versions, for when the budget is the
constraint rather than the work: a cap on turns, or a deadline from Start. Both count the run
rather than the loop's life, so a restart is a fresh allowance, and both let a turn in flight
finish. Reach for them on an exploratory loop whose "done" nobody can describe yet, and for
`autoStop` when the agent can genuinely tell.

`intervalSeconds` is the other lever on the same problem, and it works the opposite way round:
those three end the run, this one slows it. A source loop that genuinely has to keep watching
something is the case it is for - it cannot pause, and stopping it defeats the point, so the only
honest saving left is asking less often. An hourly interval on a watcher is the difference between
twenty-four model calls a day and hundreds. Do not reach for it before `autoPause` on a loop that
*has* an input: a queue that signals beats a clock that guesses.

So count the restless loops in any design: everything with no input, plus every producer past its
useful life. Fold what you can into consumers as a phase (rule 7), give the finite ones
`autoStop`, and tell the operator plainly which loops remain theirs to stop by hand once the
factory has converged - knowing which ones is the designer's to say.

Stopping by hand is per component: each card carries Stop, which lets the turn in flight finish,
and a bolt beside it which kills that turn where it stands. Both act on one component, so a single
loop stuck in a long turn no longer means force stopping the whole factory. Worth saying out loud
when you hand over a design whose loops can run for minutes: Stop is the one to press, and the
bolt is for when Stop is taking longer than the operator can wait. A killed turn can leave
half-written files, and on a cluster the bolt takes every node at once.

## Reference topology

Most useful factories are a variant of this:

```
   Planner ──queue──▶ Worker pool ──queue──▶ Review pool ──queue──▶ Gate ──queue──▶ Integrator

   Independent enrichment loops (no wires): research, assets, generated artefacts
```

Read it as five decisions:

1. **Planner** turns the goal into one work item per unit and dispatches one per turn, keeping a
   ledger in `@loop` so nothing is dispatched twice.
2. **Worker pool** does the bulk work, one unit per turn, one file each.
3. **Review pool** verifies against reality rather than against intent: run it, render it, test it.
4. **Gate** is a single loop applying consistency rules across everything that passes.
5. **Integrator** holds the index, runs the build, and reports what is still open.

Plus loops with no input at all, enriching shared files that everyone reads. These are free
parallelism: they start immediately and depend on nothing.

Critical path depth stays around five stages no matter how wide the work is. Width is however many
loops you can usefully afford at once.

## Least privilege

Loops run unattended and nobody approves anything mid-run. A loop drawn on the floor starts with
nine of the ten built-in grants - everything except `subagent`, **so `shell` is on** - and no MCP
servers; the operator can save a different default in `~/.kirofactory/grants.json`. A document
that omits `tools` or `mcp` entirely means unrestricted on that axis, so a hand-written or imported
loop with no grant keys holds every tool and every server. The containment is the directory you
point them at.

**Every consumer needs `shell`.** Taking an item off a queue is a *move* - the file leaves the
queue folder for the loop's own folder, and the move is the claim. `write` lets an agent create
and edit files but not unlink one, so a consumer granted only `read, write` cannot actually take
anything. What it does instead is invent a workaround: copy the item and leave a "claimed"
tombstone note in the queue. The count then never goes down, peers must read prose to learn an
item is taken, and the claim stops being atomic. If a loop has a wire *into* it, grant `shell`.

Narrow each loop to what it actually needs:

| Loop kind | Typical grant |
|---|---|
| Planner or scaffolder (no input wire) | `read`, `write`, `glob`, `grep`, and no MCP |
| Writer or transformer consuming a queue | `read`, `write`, `glob`, `grep`, `shell`, and no MCP |
| Researcher (no input wire) | `read`, `write`, `web`, `web_search`, `web_fetch`, plus the specific search or docs servers |
| Verifier driving a tool | `read`, `write`, `glob`, `grep`, `shell`, plus that one server |
| Integrator | `read`, `write`, `glob`, `grep`, `shell` |

Spell every name a capability needs, per the `tools` row above: a researcher granted `web` alone
cannot search or fetch, and a planner without `glob`, `grep` can list a directory but never search it.

`"mcp": []` is meaningfully different from omitting the key: it means no MCP tools at all, whereas
omitting means every server the machine has enabled. For a loop that only moves text around, `[]`
is the right answer.

### Scoping is all or nothing, so remote servers need care

Granting anything at all changes the mechanism. A loop with no `mcp` key runs on the machine's own
configuration. The moment the key is present the loop runs under a generated agent that loads
**none** of that configuration and is handed exactly its grants instead. So a grant list is not a
filter over what the loop would otherwise have had - it is the whole set.

That matters for **remote servers**, the ones configured with a `url` rather than a `command`.
A remote server needs `kiro-cli` itself to have authenticated to it, interactively, once: it will
open a browser, and a loop's turn has no browser. If it has never been authenticated, the server
simply fails to connect, and because the grant took the machine's other servers away the loop ends
up with no MCP tools at all rather than with one missing. The agent then reports that the tools it
was promised are absent and goes looking for the configuration, which costs turns.

So before scoping a loop to a remote server, check the operator has used it from `kiro-cli` and
not only from the IDE - they are separate credential stores, and the IDE having it proves nothing
about the CLI. `/mcp` in an interactive session lists the servers and their real status; `/mcp
auth` runs the flow. Local `command` servers have none of this problem.

Two smaller notes on the same subject. A server the machine has disabled is dropped from a grant
silently, because the configuration decides what exists and this only names things. And a machine
with a dozen servers enabled can take long enough to bring them all up that a turn starts before
the slow ones have registered, so a trusted loop's toolset is not perfectly stable turn to turn -
another reason to grant narrowly and deliberately.

## Layout

Position loops in columns by pipeline stage, roughly 360 to 400 apart on `x`, and stack pooled
peers 140 to 160 apart on `y` around the column centre. Put the independent loops in the first
column below the planner: they have no wires, and grouping them says so.

Use readable ids (`loop-planner`, `loop-write-a`) rather than generated ones - a hand-written
document is read by humans far more often than a generated one. **Ids must be filesystem-safe:
letters, digits and dashes only.** A loop's id becomes a folder path
(`.kirofactory/loops/<id>/`), so an id containing `/` or `..` puts the loop's folder somewhere
else entirely.

Wire ids are conventionally `<from>-<to>-<suffix>`. Only uniqueness matters.

## Before you run it

- Every wire's `from` and `to` name a loop that exists.
- No producer has two different modes across its fan-out.
- Every pooled consumer's prompt says its input is contested.
- Every prompt says what to do when there is nothing to do.
- Every prompt names `@project` if it is supposed to change the project.
- Every `@name` a prompt writes is a reserved token, a parameter that exists, or a server the loop
  holds. A token standing for nothing reaches the agent as a token.
- No parameter is named after an MCP server, and nothing long is a parameter: a plan or a rules
  document is a file in `@project`, not a value.
- Every component with `worktree: true` has something that merges its branches, or the operator has
  been told that is theirs. The base directory is a repository with at least one commit.
- The last loop in each chain has an `@output` or is told its result is the change itself.
- No two parallel loops write the same *source* file. Prose several nodes converge on is fine.
- Every loop with a wire into it holds `shell`, because taking an item is a move and `write`
  alone cannot unlink the source.
- Consumers have `autoPause: true`. Loops with no input cannot pause: a loop with nothing wired
  in never waits, so it spends a turn every interval until stopped by hand.
- The operator knows which loops to stop once the factory converges (rule 9).
- Any loop scoped to a remote MCP server names one the operator has authenticated from `kiro-cli`,
  not only from the IDE.
- No cluster is sized on the assumption it can be resized while running.
- `baseDir` is a dedicated, version-controlled working directory.

**Dry-run the topology before spending anything.** Start the app with `LOOP_DRIVER=echo` and the
whole machinery runs without calling a model: loops take turns, items move across wires, queues
fill and drain. Wrong wiring, a starving consumer, or a mixed fan-out shows up in minutes, for
free. Only then run it against a real model.

A quick structural check is worth running on any generated document:

```bash
python3 -c "
import json,sys
from collections import defaultdict
d=json.load(open('.kirofactory/factory.json'))
ids={l['id'] for l in d['loops']}
print('loops',len(d['loops']),'wires',len(d['wires']))
print('dangling:',[w['id'] for w in d['wires'] if w['from'] not in ids or w['to'] not in ids])
m=defaultdict(set)
for w in d['wires']: m[w['from']].add(w['mode'])
print('mixed fan-out:',{k:sorted(v) for k,v in m.items() if len(v)>1} or 'none')
"
```

## Anti-patterns

**A loop with no stop condition.** It will keep producing after the work is done, and the output
gets worse each turn.

**One producer fanning out to different kinds of consumer.** The mode is shared, so one kind
starves or the other duplicates. Split the producer.

**Parallel loops sharing a source file.** Split the artefact instead. (A shared prose document that
the nodes are meant to converge on is the exception, see rule 3.)

**A queue used to distribute reference material.** One consumer takes it and the others never see
it. Put it in a file.

**A loop whose prompt never names `@project`.** You get commentary in the loop folder instead of
work in the codebase.

**A gating loop that exists only to say "ready".** Fold it into the consumer as a phase.

**Pooling the step that needs global consistency.** The artefact ends up sounding like a committee.

**A consumer without `shell`.** It cannot move an item out of the queue, so it improvises -
copies plus tombstone notes - and the queue count stops meaning anything while peers risk redoing
claimed work. Narrowing tools must never narrow away the claim mechanism itself.

**An invented model id.** The catalogue is discovered from the CLI at runtime. Omit `model` unless
you have confirmed the id exists.

**Scoping a loop to a remote MCP server nobody has authenticated from the CLI.** The grant takes
the machine's other servers away and the remote one cannot complete a browser login inside a turn,
so the loop gets no MCP tools at all and spends its turns discovering that. Check with `/mcp`
first; the IDE having the server proves nothing about `kiro-cli`.

**A plan or a rules document as a parameter.** A parameter is substituted into the middle of a
sentence, so a long one produces an unreadable prompt. Shared knowledge is a file in `@project`,
which is rule 2 and does not change because a new mechanism exists.

**A parameter named after an MCP server.** The parameter wins, so the prompt substitutes a value
where it looks like it grants a tool, and the loop is short a capability it appears to have asked
for.

**Own checkouts with nothing that merges them.** Eight branches is eight branches. Either a fan-in
loop merges them or the operator does, and a design that says neither has not finished.

**Blocking on a missing dependency.** Record the gap and carry on.

## Worked example

A factory that brings a codebase's documentation up to date. Three stages plus one independent
loop, four files of output, no contention.

```json
{
  "kirofactory": 1,
  "name": "DocsFactory",
  "loops": [
    {
      "id": "loop-survey",
      "name": "Surveyor",
      "prompt": "Survey @project and plan the documentation. Do only the phase that is not done.\n\nPHASE 1: if @project/docs/PLAN.md does not exist, read the source tree and write PLAN.md listing one entry per module that needs a document: the module path, the target file under @project/docs/, and the questions that document has to answer. Create each target as a one-line stub. Then stop.\n\nPHASE 2: emit to @output one item for one module whose document is still a stub, one per turn. Keep a ledger in @loop so nothing is dispatched twice. When all are dispatched, write nothing and say so.",
      "autoPause": false,
      "tools": ["read", "write"],
      "mcp": [],
      "x": 0,
      "y": 0
    },
    {
      "id": "loop-doc-a",
      "name": "Writer A",
      "prompt": "Take one item from @input, exactly one, then stop. @input is shared with the other writer, so an item that vanishes was claimed by a peer.\n\nRead @project/docs/PLAN.md and @project/docs/CONVENTIONS.md. Read the module the item names, then write its document at the path the item gives, in @project/docs/. That file is the only thing you may edit: never touch the index or another writer's file.\n\nAnswer the questions the plan lists, with real examples taken from the code rather than invented ones. If something in the code is genuinely unclear, write what you know and append the open question to @project/docs/OPEN.md rather than guessing.\n\nHand the document to @output with its path.",
      "autoPause": true,
      "tools": ["read", "write", "shell"],
      "mcp": [],
      "x": 380,
      "y": -80
    },
    {
      "id": "loop-doc-b",
      "name": "Writer B",
      "prompt": "Take one item from @input, exactly one, then stop. @input is shared with the other writer, so an item that vanishes was claimed by a peer.\n\nRead @project/docs/PLAN.md and @project/docs/CONVENTIONS.md. Read the module the item names, then write its document at the path the item gives, in @project/docs/. That file is the only thing you may edit: never touch the index or another writer's file.\n\nAnswer the questions the plan lists, with real examples taken from the code rather than invented ones. If something in the code is genuinely unclear, write what you know and append the open question to @project/docs/OPEN.md rather than guessing.\n\nHand the document to @output with its path.",
      "autoPause": true,
      "tools": ["read", "write", "shell"],
      "mcp": [],
      "x": 380,
      "y": 80
    },
    {
      "id": "loop-verify",
      "name": "Verifier",
      "prompt": "Take one document from @input, exactly one. Look in every folder under @input and take from whichever has something.\n\nRun every command and code sample in that document against @project and correct what does not work, editing only that file. A sample that cannot be made to work comes out and its gap goes into @project/docs/OPEN.md.\n\nThen check the document against @project/docs/CONVENTIONS.md and fix what fails.\n\nHand it to @output with what you changed.",
      "autoPause": true,
      "tools": ["read", "write", "shell"],
      "mcp": [],
      "x": 760,
      "y": 0
    },
    {
      "id": "loop-index",
      "name": "Integrator",
      "prompt": "Take everything waiting in @input this turn, not one item.\n\nKeep @project/docs/README.md linking every finished document in the order PLAN.md gives, with nothing orphaned and nothing listed twice. Append one line per finished document to @project/docs/STATUS.md.\n\nWhen every entry in PLAN.md is finished, write a final section in STATUS.md listing what is done and every unresolved item in OPEN.md, then say the documentation is complete and write nothing further.",
      "autoPause": true,
      "tools": ["read", "write", "shell"],
      "mcp": [],
      "x": 1140,
      "y": 0
    },
    {
      "id": "loop-conventions",
      "name": "Conventions",
      "prompt": "Nothing feeds you a queue. Derive the house style for documentation in @project from the documents that already exist there and from any contributor guide, and keep it in @project/docs/CONVENTIONS.md: structure, heading style, how examples are formatted, what a document must always state.\n\nOne improvement per turn, and only where the existing file is wrong or silent. When the conventions cover what the writers need, say so and write nothing.",
      "autoPause": false,
      "tools": ["read", "write"],
      "mcp": [],
      "x": 0,
      "y": 240
    }
  ],
  "wires": [
    { "id": "loop-survey-loop-doc-a-w1", "from": "loop-survey", "to": "loop-doc-a", "mode": "queue" },
    { "id": "loop-survey-loop-doc-b-w2", "from": "loop-survey", "to": "loop-doc-b", "mode": "queue" },
    { "id": "loop-doc-a-loop-verify-w3", "from": "loop-doc-a", "to": "loop-verify", "mode": "queue" },
    { "id": "loop-doc-b-loop-verify-w4", "from": "loop-doc-b", "to": "loop-verify", "mode": "queue" },
    { "id": "loop-verify-loop-index-w5", "from": "loop-verify", "to": "loop-index", "mode": "queue" }
  ]
}
```

Note what the example does *not* do. The conventions loop has no wire, because every writer needs
to read its output. The open-questions file is shared rather than piped, because three different
loops append to it. The index belongs to the integrator alone. And each writer owns exactly one
file per turn.

Note also what it costs. The Surveyor and the Conventions loop have no input, so neither can
pause: both keep taking turns - each one a model call - after their work has converged, saying
there is nothing to do. That is rule 9 in practice: tell the operator to stop the Conventions loop
once CONVENTIONS.md settles, and the Surveyor once everything is dispatched. The four consumers
pause themselves.

And note the grants: every loop with a wire into it - both writers, the verifier, the integrator -
holds `shell`, because taking an item is a move. The two loops without input hold only `read` and
`write`, since nothing reaches them through a queue.

## Working with an operator

Read the project before designing. A factory is shaped by the artefact it produces: how the work
splits into units, which units are independent, and where the one global view has to sit. Ask what
the deliverable is and what "done" looks like, because "done" is what the terminating clauses in
every prompt are testing for.

Write the plan in prose first and agree the topology, then generate the JSON. The document is
cheap to regenerate and the topology is the part worth arguing about.

Before writing a prompt from scratch, look in `library/` in the app's repository: it holds
components that have already worked, one JSON file each, and their prompts name `@input` and
`@output` rather than folders, so they drop into any factory unchanged. Three folders, and the
picker groups them the same way:

- `library/loops/` one loop, a name and a prompt. No id and no position: both are assigned when it
  lands on a floor.
- `library/clusters/` the same thing carrying its `cluster` block, because a prompt written for a
  ring of five reading each other does something else entirely on its own.
- `library/factories/` a whole design: loops, wires and parameters. Positions are kept, since they
  are the diagram. What it drops is the id and the base directory. Picking one opens a new tab
  rather than adding to the floor you are on.

The folders organise without deciding: whether an entry is a loop or a cluster is read off its
`cluster` field, so a misfiled entry still works.

**A factory entry is the shape to contribute a whole design in**, and its parameters travel with
it, names and values both, as the worked example of what it expects.

Then say plainly what the factory will do unattended, and where its blast radius ends.

## Dark factory

A dark factory is a document with at least one remote loop: a cluster whose nodes are Fargate
tasks on a Kiro Flock. The factory draws the pipeline and moves items; the flock does the work and
keeps working when the laptop is closed. Everything above about the document, wires, `@tokens`
and the library still holds. What follows is the plain factory reshaped around one lesson learned
the hard way: **a flock is a self-organising system, and the factory's job is to feed and observe
it, not to manage it.** Read the flock skill (`kiro-flock-compact`, sections 1, 2, 8 and the File
Writing / Verification blocks) for how a cluster behaves; the operator's guide to the shapes is
`DARK-FACTORY.md` in the repository.

### The one failure to design against

The first dark factory built with these two tools stalled four separate ways, all from the same
mistake: treating the remote cluster as a worker that needs a manager.

| What was done | What happened |
|---|---|
| Local loop uploads the seed, remote cluster builds from it | Cluster started first, found an empty share, wrote `BLOCKED` notes and idled. Seed loop did one phase per turn and never reached the upload. |
| Remote cluster told "these files are owned by the local machine, never write them" | Cluster could not unblock itself. It built against guessed data instead. |
| Consumers in Wait for work, producers in Auto stop | Each side waited for the other's item. Items piled up in queues while the loop that should read them was asleep. |
| Architect / builders / reviewers / gate / integrator as separate clusters, claim files to coordinate | 143 coordination notes for 28 units of work. Three agents flipped one contract back and forth. |
| `tools: [read, write, shell]`, `mcp: []` on local loops | Loops could not reach the flock MCP or run the real app. |

The flock skill says all of this up front: let agents self-organise, do not put per-agent
instructions in a direction, never-idle priority lists, redundancy is a feature. The design rules
above about pools, gates and claim ledgers are for *local* loops that cannot see each other. A
flock ring can. Do not import the factory's topology habits onto a flock.

### Dark factory rules

**1. The flock is complete on its own.** Write the remote direction so the cluster could finish the
whole job if every local loop were deleted. It has the internet, Node, npm, the AWS CLI with the
agent role, and S3. It can fetch its own data, write its own seed, run its own tests, call Bedrock,
and judge its own output. Anything the direction says the cluster may not create is a thing the
cluster will wait for. State the deliverable, the hard rules, and the unit list *inside the
direction*. Do not point at a plan file the local side has to upload first; if a plan file is
useful, tell the cluster to write it from the direction when it is missing.

**2. Local loops do only what genuinely needs the machine.**

| Needs the machine | Why |
|---|---|
| Binary assets into S3 | `s3_write` is text-only on the flock; the AWS CLI on the node works too, so even this is optional |
| The operator's git history | Commits on the operator's branch |
| The operator's AWS credentials | When the agent role must not have Bedrock or deploy rights |
| Scraping a site that blocks data centres | Residential IP |
| Showing the operator a running UI | Browser on the laptop |

Everything else is remote. A local loop that does remote-able work is a dependency the flock did
not need. Three local roles cover nearly every project: **Harvest** (real data in, offered to the
share), **Sync** (pull, real build, real run, report, commit), and nothing else.

**3. Wires carry news, never permission.** A wire is a folder; `Wait for work` is what makes a loop
sleep on it. In a dark factory **no loop uses Wait for work** (`autoPause: true`). Every loop is Run
forever on its own clock: the remote cluster with `autoPause: false` and `intervalSeconds` 30 to
120 (the flock's `loopIntervalSeconds`); local loops with no run mode field (reads as Run forever)
and `intervalSeconds` on the hour ladder (30 min, 1 h) - a local loop with no interval spins at full
speed and bills every turn. Prompts then say: "Take whatever is in `@input`. An empty `@input`
changes nothing; you proceed anyway." A loop that can act on an item but never needs one is
independent and still informed.

Draw the wires. Harvest -> cluster ("fresh data on the share"), cluster -> Sync ("this changed"),
Sync -> cluster ("the real build and real pages say this"). Each producer has exactly one mode
(queue). A wire-less design throws away the only channel the two sides have; a wire-with-Wait-for-
work design turns that channel into a lock. The UI default for a *new* loop is Auto stop; switch it.
Remote loops offer only Autopause, Run forever and After N hours; never pick Autopause for a cluster
whose work has no natural end, and remember autopause on the flock pauses after three idle
iterations while the Fargate tasks keep billing.

**4. One cluster, one direction, never idle.** Follow flock skill section 8 for the remote loop: a
single amorphous cluster, radius 2, 8 to 16 nodes, `autoPause: false`, and a priority list the
direction says to work top-down, exactly one item per iteration:

1. Fix an open issue (one file per issue in `ops/issues/`, delete when verified).
2. Build the next missing unit from the list, one per iteration, picking one your neighbours' last log lines do not name.
3. Verify a unit you did not build, with the real data; file what you find.
4. Generate and judge real output (for an app: run it, call the model, score the pages).
5. Improve the templates or prompts from what was judged.
6. Work a backlog that never drops below 20 items, and keep that file bounded (rewrite, cap at N items, archive done ones): a never-idle cluster told to keep a backlog appended it to 309 KB in four hours.

Include the flock's `## NEVER DO THIS` block verbatim, with the project's own additions (never
deploy, never return HTML, never edit a contract without updating all consumers in the same
iteration). Do **not** split roles into clusters (architect, builders, reviewers, gate). Do **not**
ask for CLAIM, WITHDRAW or BLOCKED notes; neighbours read the log line, that is the coordination.
Do **not** reserve a phase for "agent 0". Two agents on one unit is fine; the later one re-syncs
and merges.

The other algorithms have their places. `mesh` for a handful of nodes that must all see every
change. `swarm` when the cluster is large enough that a ring spreads news too slowly. `single` for
a pool of lone workers on queue items with no shared project to converge on - a fan-out of
independent jobs - where neighbours would only be noise; it is also the one that runs at one node.
For a shared project built in S3, amorphous.

**5. File writing and verification, stated from iteration zero.** Copy both blocks from the flock
skill into every remote direction. *File writing*: S3 is the working tree; `s3_sync_local` to work,
`s3_write` before the iteration ends, sync again right before writing; local disk only to install,
build, run; binaries via `aws s3 cp` into the same prefix; never node_modules, dist, zips.
*Verification contract*: "I wrote it" is not "it works"; done means fresh sync, clean install,
typecheck, tests, run with real data; a fix is verified against the bytes on the share. Left
unstated, a flock takes hours to invent these and claims drift from reality in the meantime.

**6. The share is a folder the cluster owns, and the local side reads.** Put the project at a fixed
prefix (`environment/<share-id>/`) and name it in two parameters: `share` (the path, for the
direction) and `share_id` (the folder name, for `env_upload` / `env_download_all` / `env_list` on
the local side). The factory's own queue folders live under the cluster's `environment/kf-<id>/`;
keep the project out of there so a factory re-import (new `kf-` id) does not orphan it. Nothing on
the share is "owned by the local machine". Harvest *offers* fresh real data by uploading it; the
direction tells the cluster to prefer real data when present and to make its own when absent. Sync
*pulls* the whole share and never pushes source back; its feedback is a report file plus a queue
item. Single writer for source (the cluster), single writer for the report (Sync), no ownership
rule that can block anyone.

**7. All tools, all MCP servers.** Omit `tools` and `mcp` on every loop. A document that names no
grant is unrestricted. Narrowing a local loop to `[read, write, shell]` and `mcp: []` took away the
flock MCP it needed and the ability to run the app. A dark factory is pointed at a directory and a
flock you are willing to let an unattended agent loose on; that is the containment, not the grant
list. Remote loops cannot carry `tools` or `mcp` at all (the server rejects them). The one case
for narrowing is a text-only loop with no queue and no need to run anything, and a dark factory
rarely has one.

**8. Start order does not matter, and clean the share when you mean it.** Because nothing waits,
Start all three in any order. Starting the cluster before any seed exists is fine: priority 2
makes it fetch the data itself. What *does* matter is leftovers: a previous run's files on the
share are the new run's starting state. Clean `environment/<share-id>/` from the flock dashboard
for a fresh build; otherwise say so in the direction ("continue from what is on the share").

**9. Budget and stop.** Fargate bills while running *and* paused. Only the zap (bolt) ends the
tasks; Pause and Stop all do not. Say in the hand-over which card to zap and that `After N hours`
is the only timed stop a remote loop offers. Each cluster iteration and each Sync run also costs
model calls; the interval is the lever, set from measured `durationMs`, not aspiration.

**10. Tune on either side.** The settings and the direction sync both ways while the factory is
attached, latest writer wins, so an operator may tune the cluster from the flock's dashboard
mid-run and the document follows. Design for that: do not hard-code in a local prompt a value the
remote loop's settings carry (its interval, its node count); read it from the document if needed.

### Reference dark topology

```
LOCAL (hourly)             REMOTE (30 s, forever)                 LOCAL (30 min)
Harvest ──queue──▶  DevCluster (12 nodes, amorphous, r=2)  ──queue──▶  Sync
real data, images,          builds and improves the whole           pull, build for real,
look; "fresh seed"          project in S3; "this changed"           run, judge, report, commit
                                        ▲                                   │
                                        └───────────────queue───────────────┘
                                                "real build says this"
```

Three loops, three queue wires, no Wait for work, no grants, one cluster. This shape worked: in
about four hours a 12-node cluster produced a full multi-workspace TypeScript project that built
green locally and passed every hard-rule check on real generated pages.

### Before you run a dark factory

- Every loop: no `autoPause: true`. Local loops carry `intervalSeconds`; the remote carries the flock interval.
- No loop carries `tools` or `mcp`.
- The remote direction contains: the deliverable and hard rules in full, the unit list in build order, the never-idle priority list, `## NEVER DO THIS`, the File Writing block, the Verification contract, and an explicit "empty `@input` means nothing" line.
- The remote direction names nothing as "local-only, never write it".
- Every prompt names `@project` (local) or the share path (remote). `@project` is refused on a remote loop.
- Each producer has one wire mode. Fan-in needs nothing.
- Parameters `share` and `share_id` exist and match.
- The flock connection id is per machine; a document moved to another laptop needs its connection picked again.
- The operator knows: which card to zap, that the share holds the previous run, and that `kiro-cli` (not the IDE) must have the flock MCP for the local loops.
- Local loops that call AWS die silently when the AWS SSO session expires mid-run (Bedrock "Could not load credentials", the flock MCP's "Browser login timed out"); refresh before a multi-hour run, and name that as the usual cause of a sudden wave of fallbacks.

Check structurally with the factory's own parser and remote validator rather than a hand-rolled
script: import `server/factory.ts` `parse` and `server/flock/validate.ts` `startProblems` from
`app/` and run them on the document.

### Anti-patterns, dark-factory edition

**A seed loop the cluster waits for.** The cluster idles until a human notices. Let the cluster
seed itself; let the local loop offer better data.

**Wait for work on either side.** Items queue while the reader sleeps. Run forever on a clock, read
whatever arrived.

**Hand-over items ("ready", "milestone").** They race, duplicate and go stale; the next side
processes an old one. Send change notes and reports, never permission to proceed.

**Role clusters with claim files.** Coordination notes outnumber work. One cluster, one direction,
neighbours' log lines.

**"Agent 0 does X."** Per-agent instructions in a shared direction; the flock skill forbids it, and
the node that holds the item is never the one you named.

**Narrow grants on local loops.** The loop that needs the flock MCP or the dev server has neither.

**No wires at all.** Independence by amputation. The sides stop learning from each other.

**Leaving the previous run on the share and expecting a fresh build.** The cluster continues from
what it finds.

**A Sync loop whose commit is gated on a green test run.** One flaky test leaves the local repo
rounds behind the share. Commit on install, typecheck and build passing; report test failures
separately.

## Safety

Loops run with whatever they are granted, a shell included by default, and no human in the loop. Point a factory at a dedicated
working directory, keep the work under version control, and narrow `tools` and `mcp` per
loop so the one that only rewrites text does not also hold shell.
