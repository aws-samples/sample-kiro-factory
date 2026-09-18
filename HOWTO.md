# How a factory for kiro works

The [README](README.md) says what this is and how to start it. This is the rest: every part of the app, and why it behaves the way it does.

## The factory floor

**The floor is unbounded.** Drag the background to pan, and the wheel pans too; ctrl-wheel or a trackpad pinch zooms about the cursor, so whatever is under the pointer stays under it. Zooming about the cursor rather than about the centre of the screen is what makes a wide design feel like moving a window over it instead of operating a control. Loop positions are world coordinates and the window onto them is what moves, so a factory that outgrows the viewport is reached by panning rather than running off the edge and staying there.

**A corner control** zooms in steps, says which level you are at, returns to full size when clicked, and fits every loop on screen. Fit is both the overview for a design too wide to read and the way back after panning somewhere empty. Each factory remembers its own pan and zoom, so the corner of a large design you were working on is part of where you left off, and `Add loop` lays its cascade from the corner of what is on screen rather than from world origin, so a loop added after panning lands where you are looking.

## Loops and wires

**A loop** has a name and a prompt. No pace, no iteration cap, no retry policy. It runs a turn, then runs another, until you press stop - or until [the run mode you picked](#how-a-run-ends) ends it. Each turn is a fresh session, so a loop's memory is whatever it left on disk rather than a conversation that grows until it falls over.

**Stop lets the turn already in flight finish**, because a turn killed halfway has claimed an item off a queue and not yet written what it did with it. While it drains the card reads *final iteration, shutting down gracefully* and still offers Stop rather than Start; it flips to stopped when the turn is done.

A restart is a pause in one loop's life, not a new loop: the iteration counter keeps counting and the output log survives, with a "started again" line as the seam between runs.

**The bolt beside Stop kills the turn where it stands.** Stop is the polite request and it can take minutes when an agent is deep in an edit, so the pair is the point: Stop is what you press, and the bolt is what you press when Stop is taking longer than you can wait. It is tinted like the danger it is, because a killed agent can leave files in a state nobody chose, and on a cluster it takes every node at once. It is rendered always and greyed when there is nothing running, on the same reasoning as Start on a parked loop: the row is where you look to find out what a component can be told, and a button that appears only once it is needed is one nobody knows is there.

**`Run all` and `Stop all` on the toolbar do the same to every loop in the factory**, and the toolbar carries the same bolt with the wider blast radius. Same glyph, same red, same icon-only shape as the one on a card, because it is the same act - which is why the per-card one was worth adding: until it existed, one loop stuck in a long turn meant killing every other loop's turn to get at it. `Run all` skips [disabled](#parking-a-loop) loops.

**You can talk to a running loop.** A message box under the output log sends a message to the loop: sent mid-turn it interrupts the turn and opens a replacement one that carries your message plus a transcript of the work it cut short, so the fresh session knows what it is answering. Sent between turns, or to a paused loop, it queues for the next turn - and a loop waiting for work wakes for one, because the message is work. A stopped loop has no box to type into; start it first. The exchange reads as a conversation in the log: your message in green with a bar on the left, and the turn it opens marked as answering it. The panel around it splits prompt above, log and chat below, on a draggable divider whose arrow sweeps between prompt-maximised, the even split, and log-maximised.

**Three keys act on the selected loop**: cmd-C copies it, cmd-V pastes it, backspace deletes it. Paste brings everything except identity and connections - prompt, stop conditions, tool and MCP scoping, model, cluster shape - because copying a configured loop is how you avoid configuring it twice, while a wire is a fact about two loops and not the copy's to inherit. Repeated pastes cascade down and right instead of stacking. The clipboard outlives a tab switch, so a loop can be copied from one factory and pasted into another with nothing selected there. Copy and delete act on loops and clusters only: a wire selection is a whole fan-out, so there is nothing coherent for them to mean there. Paste needs no selection at all. They also stand aside wherever they would mean something else - inside the prompt box backspace is backspace, with text selected cmd-C is the browser's, and a question on screen owns the keyboard until it is answered.

**A wire** is a folder. Wiring two loops together tells the downstream one where to look; nothing is pushed. An item is a small JSON file in that folder, named `*.json` (that extension is what every count and every waiting consumer looks for), and taking one *moves* it out into the taking loop's own folder. The move is what claims it: a rename is atomic, so two loops racing for the same item cannot both get it. The agent performs the move itself with a shell command, so a consumer needs `shell` - which the default grant includes; a loop narrowed below it cannot take an item at all.

Because taking an item removes it, a queue shows exactly what is outstanding and nothing else. There is no record on the wire of what already crossed it. What a loop did is in the loop's own output.

**Click a wire and you get the whole fan-out it belongs to**, not the one branch you clicked, because a fan-out is drawn as one trunk and selecting less than that would not match what is on screen. The panel lists the work waiting: one list for a queue, since every branch of a queue fan-out reads the same folder, and one list per subscriber for a topic, each under a heading naming the consumer. Which is the comparison you actually want, who is behind and who is keeping up, in one place instead of three clicks.

Removing a single branch is the `×` at the end of the wire where it arrives, the only place on the floor that still points at one branch unambiguously. The panel's delete button removes the producer's whole fan-out, and the queue with it when no other loop is reading it.

## Queues and topics

A wire delivers one of two ways, and which way is the only thing there is to set. The panel switches it.

**Queue** is the default, and the sharing one. Every queue wire out of a loop points at the *same* folder, so wiring a second consumer to a producer does not make a second queue. Both read one backlog and each item goes to whichever gets there first, which is how you put two workers on one slow step.

The floor draws that as what it is: one trunk leaving the producer, splitting at a junction, carrying one count. The count sits on the junction rather than on each branch because there is one folder, and the panel says who it is shared with.

**Topic** is the broadcasting one. A topic wire gets a folder of its own, the producer writes a copy into each, and every subscriber sees everything. Its wire is drawn as a double rail with a count of its own, because a copy per subscriber is what that count is counting.

The mode belongs to the producer rather than to the individual wire, so a fan-out is one shared backlog or a copy each and never half of both. A per-wire setting could express the mixture, and nothing on screen could show it: a wire is drawn the same way under either mode, so a producer feeding three loops could have been sharing with two and copying to the third with no way to tell. The panel switches the mode for everything the producer sends, and says so whenever there is more than one wire to say it about.

Switching carries the backlog across instead of stranding it in the folder nobody is reading any more. Going to topic fans the one queue out to every subscriber; going to queue gathers every subscriber's copies into one folder, where duplicates of the same item collapse into one. The switch is locked while a loop at either end of the fan-out is running, because switching moves folders whose paths an agent mid-turn was already handed.

Taking an item is identical either way: move it out of the folder, and the move is the claim. A prompt reading a shared folder is told which of its inputs are contested and who it is racing, because a shared folder looks identical to a private one and an item vanishing mid-turn would otherwise read as a fault rather than as somebody else getting there first.

**Fanning in needs no mechanism at all.** Several wires into one loop are just several folders listed under its `@input`, and the prompt tells the consumer to treat them as one pool of work: look in all of them, take from whichever has something. There is no merge step on disk. And on a fan-in wire the queue/topic switch is a genuine no-op, which is why the panel looks the same either way: the modes only differ in which folder a wire delivers into, keyed by the producer. Wires arriving from *different* producers get a folder each under either mode, with one writer and one reader per folder, so there is nothing to share and nobody to copy for. The choice only starts to matter the moment a producer fans *out*.

A document whose wires name no mode is read generously: a loop that fans out gets topics, and everything else queues. One that arrives with a single fan-out already mixed resolves to topic, because keeping a copy somebody was promised is the recoverable direction and dropping deliveries is not.

## How a run ends

**Run mode is one dropdown in the settings row under the prompt**, and the one thing on a loop that is about when it runs rather than what it does. Five choices, exactly one at a time. The three that need no number come first; the two counted ones sit below them, because a budget is the less common thing to be choosing.

**Auto stop** is the default for a new loop, and the only mode that ends when the *work* ends rather than when a number does. The agent may close a turn with a `NO FURTHER WORK:` line, which is a declaration and not a stop: it gets exactly one more turn, told what it said and asked to check again. Finding work withdraws the declaration silently - doing the work *is* the withdrawal, no phrase needed - and only closing that second turn with `CONFIRM STOP:`, having contributed nothing, actually ends the run. Two turns rather than one because "looks done to me" is precisely the judgement an agent gets wrong on a queue that happens to be empty, and the costs are lopsided: a spurious extra turn is cents, a spurious stop strands a factory. An operator message withdraws a pending declaration too - somebody leaning in clearly wants something. The prompt teaches the phrases each turn, so a loop's own prompt never needs to mention them.

**Wait for work** spends a turn only when an item is waiting. It resumes by itself the moment one lands, so there is no pause to remember to leave - a pause you had to lift by hand would deadlock the ordinary case, a slow producer feeding a fast consumer. A waiting loop is live rather than idle: it keeps its colour, still offers `Stop`, keeps the tab's running dot and the base directory lock. The card's `waits` mark turns green and breathes while the pause is on. A loop with nothing wired into it never waits - there would be nothing to wait for, and the panel says so instead of leaving you to work it out.

**Run forever** takes turn after turn until Stop is pressed, even with nothing to read. Right for a loop whose input is a file, or whose job has no end.

**After iterations** and **after hours** are the blunt versions, for when the budget is the constraint rather than the work. Picking either reveals a small stepper beside the dropdown. Both measure the current run, not the loop's life, so a restart is a fresh allowance - a cap of five on a loop already at #40 means five more turns, which is the only reading that is any use. Both decide whether another turn *starts*, never cut one short.

The hours arrows walk a ladder rather than counting up in ones: 3 minutes, then the quarter hours, then whole hours thinning out through 12 to a day. Hours are not used evenly, and an even step small enough to reach three minutes would put a day out of reach of the hand. Typing is still free between the ends, so a deliberate 1.5 stays 1.5 - the arrows move to the next rung past wherever the value is rather than snapping it onto the ladder.

A timed loop counts down on its card, beside the number of turns it has taken: `2h 14m left`, tightening to minutes and seconds under the hour and to seconds in the last one. The tooltip gives the wall-clock time the limit lands at, for when the absolute answer is the one you want. Past the deadline it reads `time up` in yellow, which is the honest state rather than a zero: the limit only decides whether another turn *starts*, so a long turn can run a while past it, and the loop stops when that turn finishes.

Changing the mode takes effect on the loop's next iteration, with no restart, and it marks the card: `ends`, `10 turns`, `2h` or `waits`, one of the marks a card carries for any setting that is not at its default. When a loop stops itself - by any of the three stop modes - that mark turns yellow and stays yellow until the next Start, so a factory you come back to hours later distinguishes a loop that finished from one somebody stopped.

## Loop clusters

**`Loop cluster` beside `Add loop` puts a component on the floor that runs several sessions instead of one.** A cluster has a name and a prompt like any loop, and every one of its **nodes** runs that same prompt in its own session at the same time. The card says so by being a stack: one box per node behind the front one, up to five, and past five the stack stops growing and shows a `…` past its corner with the real count in the chip on the card. The chip counts what is up as well as what exists - `3 of 5` - because a stack can say "several" and cannot say how many.

**A cluster is one loop with several sessions, and wires see it as one loop.** That is the whole difference between a cluster of five and five loops drawn side by side, and it matters most for topics.

On a **queue** the two are the same. The folder belongs to the producer, every reader takes from it, and whether the readers are five nodes of one cluster or five separate loops they compete for what is in it: taking an item is a move, a rename is atomic, and two racing for one item cannot both win. Wiring a cluster to a producer is the way to put five workers on a slow step without drawing five boxes and keeping five prompts in step.

On a **topic** they are not the same. A topic delivers one copy per *subscribing loop*, and a cluster is one subscribing loop. Five separate loops on a topic each get their own copy of every item, five copies in all, and each loop works every item. A cluster of five on the same topic gets one copy, into one folder, and its five nodes compete for it exactly as they would on a queue. So a topic feeding a single cluster behaves like a queue; the broadcast only shows when a second loop, or a second cluster, subscribes alongside it. If you want every node to see every item, draw separate loops.

The one thing nodes do not share is `@loop`. Each gets its own folder under the cluster's, `n1` through `nN`, because claiming an item moves it into `@loop` and `@loop` is also where a node keeps the notes that are its whole memory between turns. One folder for five nodes would have them claiming over each other's filenames and reading each other's notes as their own history. The folder is called what the node bar calls it, so the tab and the file panel agree - and the prompt each node is handed names it the same way, so a log line about `n3` is about the folder called `n3`.

**There are two kinds of cluster**, switched in the panel.

**Fixed size** is exactly the number you set, started together, and it is the plain reading of "several loops at once".

**Auto scaled** runs one node per item instead, counting both the items still waiting on the folders the cluster reads and the nodes currently working one. The size becomes a ceiling rather than a count, and the panel labels it so. A node starts as items arrive and is stopped again once it has gone idle waiting for work, so a burst of twelve items does not leave twelve nodes taking empty turns forever afterwards, and a node mid-item is never the one told to stop. One node is always live while the cluster is started, because a component that reports stopped after being started offers no way to stop it and no way to tell "waiting for the first item" from "did not work". A ceiling is not optional: every node is a `kiro-cli` subprocess on your own machine, and one per message with nothing bounding it does not degrade, it takes the machine down.

Two consequences of how it counts. A scaled cluster needs the `Wait for work` run mode: that is what makes an idle node `paused` rather than spinning on an empty folder, and only paused nodes are shed, so without it the cluster grows to its peak and stays there. And it counts folders, not wires, so a cluster with nothing wired into it has nothing to count, runs one node, and the panel says so rather than leaving you to work it out. A cluster on a topic counts its one copy folder, which is the queue-like behaviour described above.

**And two ways the nodes can relate to each other.**

**Fire and forget** is the default and the subagent-shaped one: nodes never see each other, and the queue they compete over is the only thing they share. The prompt says so out loud rather than leaving it as an absence, because an agent told it has siblings and not told how to reach them goes looking for the channel, and an invented one is worse than none.

**Kiro Flock** gives them a ring. Each node watches its two immediate neighbours - radius 1, wrapping - and ends each turn with one line for them to read. Before a turn the runner reads the neighbours' recent lines off disk and puts them in the prompt; after it, whatever the agent wrote after `BROADCAST:` is appended to that node's own log. One file per node, only ever appended to, and no node ever opens a sibling's log for writing, which is the entire concurrency design: nothing to lock and no read-modify-write to lose a race in. A node that did nothing still writes its line, because an idle neighbour is a useful thing to know and silence is indistinguishable from a node that has died.

A cluster on flock wears a purple glowing badge above its title. That badge is the loudest thing on the floor on purpose - a ring of agents reading each other is the most interesting thing a factory can hold, and it is rare enough to afford it. The small grey `local` is what keeps it honest: Kiro Flock proper is a cluster of cloud instances coordinating through object storage, and this is a handful of subprocesses coordinating through a folder. Same idea, one machine.

**The badge is a link** to [Kiro Flock](https://github.com/aws-samples/sample-kiro-flock/), in a new tab so the factory it was clicked from keeps running. It names something that exists elsewhere and `local` is a claim about the difference between the two, and neither of those is checkable without somewhere to go and check.

The ring is deliberately the smallest thing that could be called coordination. No quorum, no consensus detection, no global view, no radius setting - at these sizes a radius of 2 already shows everybody, so the dial would have one useful position and one that lied. What a node gets is: here is what your neighbours are doing, avoid doing it again.

**The panel shows one node's log at a time**, behind a bar of `n1`, `n2`, `n3` cells with a dot on the ones that are up. A segmented bar rather than a row of separate chips, because the cells are not independent things to act on: they are positions in one cluster and exactly one of them is being looked at, which is what a segmented control means. Switching rather than merging, because a turn's narration arrives as one growing block - five agents streaming into one scroll produce blocks that are five sentences spliced together, and no amount of tagging per line fixes that. Every node has a cell whether or not it has run, so the one you are aiming at does not move as a scaled cluster grows. A message typed in the box goes to the node you are reading, not to all of them - it is a reply to something you just saw, and broadcasting it would put five agents onto a remark meant for one.

Start and Stop on the card act on the whole component. The card's state is its most-alive node, so a cluster with one node working and four waiting reads as working, and its iteration count is the nodes' turns added up, because "how much has this done" is the question the number on a card answers.

**A running cluster's shape is fixed**: the type, the size and the comms dropdown all grey out until it is stopped. They are not settings in the way the row below them is - nothing here is a value a session reads on its next turn, they decide what the component is. Size is the clearest case: nodes are keyed per member, so turning it down retires the ones past the new size, which is a stop the operator did not ask for from a control that says nothing about stopping, and a retiring node has claimed an item off a queue it has not yet written back. Turning it up is the quieter half of the same problem - the new nodes enter the document and nothing starts them, so the control looks like it worked when half of it did. Comms is technically safe to switch live, since the ring's files are created by the first flock turn and a neighbour with no file yet just reads as silence, but what it changes is not a degree of anything: it decides whether these agents are working alone or reading each other, which is a different job arriving between turns. So the rule is one rule - stop, change, start - rather than three controls that each have to be learned.

Turning a cluster's size down stops the nodes past the new size rather than leaving them running invisibly on a queue nobody can see them on. That is the server's behaviour rather than something the panel can now ask for, and it still matters: a factory file can be imported or edited with a smaller size than the one that is running.

**A loop converts to a cluster and back**, on one button in the panel beside the loop's name - between saving it and deleting it, which is the order of how far each goes. The glyph is the destination rather than the state: the three joined nodes on a loop, the loop's circular arrows on a cluster. Converting in gives you the same defaults `Loop cluster` starts from, two isolated nodes at fixed size; converting out drops the shape rather than remembering it, because a loop *is* the absence of a cluster and there is nowhere in the document to park a size for a component that has none. So going in and out again returns the defaults, not what you had, and the settings row is one click away. **The button greys out while the component is running**, in either direction, for the same reason the cluster's own settings do: converting changes every member key at once, so the sessions the new document no longer names get retired and the thing stops as a side effect of a button that says nothing about stopping. A turn in flight has claimed an item off a queue and not yet written what it did with it, which is the work Stop exists to let finish. So the tooltip says to press Stop.

The line this draws is worth stating once: **what a component *is* needs it stopped; how it behaves does not.** The convert button and the cluster row above are the first kind. The run mode, the model, the tool and MCP scope and the prompt itself are the second, and a running loop picks all of those up on its next turn.

## Parking a loop

**The power button top-right of a card disables the loop.** A disabled loop is left out of every start: its own Start button, `Run all`, an API call made directly. Everything else still works - edit it, rewire it, wire *to* it, and its queues still collect items for the day it wakes.

It is a button on the card and nowhere else, on purpose. The run mode is a decision about the design, something you export and share; disabling is a hand on one box saying "not this one, not now", so it keeps company with Start and Stop rather than with the settings. The card fades and its border goes dashed, brightening when you approach it so the way to undo it is not itself half-invisible.

Stop stays live on a disabled loop. Disabling one that is already running does not stop it - taking away the way to stop it would be the one genuinely unhelpful reading of "disabled".

## What a loop may use

**A new loop starts with nine of the ten built-in grants and no MCP servers**: `read`, `write`, `search`, `code`, `shell`, `web`, `knowledge`, `todo_list` and `introspect`. Not `subagent`, and no server. `shell` is in for a structural reason: a consumer claims an item by moving it out of the queue folder, `write` covers create, edit and delete but has no rename, and a consumer without `shell` cannot take anything - it copies the item and leaves a tombstone, the count never drops, and the claim stops being atomic. A default at which no loop can take part in a queue is not a cautious one. `subagent` stays out because it produces a second agent whose grant nobody reviewed; MCP servers stay out because they are where credentials live, and a prompt that names one with `@` gets it regardless. A loop that only rewrites text has no use for `shell` - untick it and that loop has none.

This is a default rather than a ceiling, and it is the operator's to move. Set a loop's `Tools` or `MCPs` to what you want and a `Save as default` appears above that chip; it writes `~/.kirofactory/grants.json`, one axis at a time, and every new loop in every factory on this machine starts there. Per operator on purpose: an exported factory should not carry an opinion about what somebody else's agents may reach. Saving `Tools: all` is allowed and is stored as the decision it is, which is what distinguishes it from the absence of one. That distinction is also how you undo it: remove an axis's key from `grants.json`, or delete the file for both, and the axis goes back to the shipped grant as something nobody has chosen - so the note returns too. There is no button for it, because it is a thing you do once if ever.

Until that decision is made, a loop still holding the shipped grant shows a one-line note above the two chips - *Set which tools and MCP servers this loop may use* - naming whichever axis is still unset, with a `Keep` button beside it. It shows for a loop you add and for each loop of a library factory you open, since a factory arriving as a whole document never passes through the floor's own add. Clicking the note or opening either list retires it for that loop and that session. `Keep` retires it for good: it saves the shipped grant as your default for each unset axis, exactly as `Save as default` would if the loop differed, so the answer "the default is fine" is storable rather than something you re-give every loop. Seeding applies to loops created here: a document that names no grant at all, hand-written or imported, means unrestricted by saying nothing.

**A loop can be scoped to a subset of MCP servers.** A factory whose whole point is several unattended agents should not hand every one of them the same blast radius: the loop writing jokes has no business holding whatever write tools the machine happens to have configured. So a loop carries a list of granted servers, and no list at all means unrestricted - which is a thing a document can say, and a marked loop always means somebody chose something.

The panel has a grant list, with `All servers` at the top as the way back, and reads `MCPs: all` or `MCPs: 2 of 22` above it. A server granted by `All servers`, or named in the prompt, shows ticked and dimmed rather than as a control to click, because that row is reporting a grant rather than offering a choice. The loop card carries an `mcp` chip, alongside `waits` and the other marks for a setting away from its default.

**Naming a server in the prompt asks for it.** The effective set is the grant list plus whatever the prompt names with `@`, because a prompt that says `@pricing` must never run against an agent that does not have it. Both halves are matched against the live config by name, so a granted server that has since been removed or disabled simply drops out instead of failing the turn. That config is `kiro-cli`'s own rather than anything this app keeps: `~/.kiro/settings/mcp.json` plus a `.kiro/settings/mcp.json` under the base directory, the workspace file shadowing the user one where both name the same server. Half the answer therefore comes from the base directory, so two tabs pointed at different projects can offer different servers.

Scoping takes two halves, and neither works alone: `kiro-cli` loads servers from its own config, so a generated agent says not to read that config, and the granted server definitions are written into that agent's own `mcpServers` map instead. Declaring them in the agent rather than handing them over when the session opens is what makes a remote server work exactly like a local one; the protocol channel carries stdio servers only.

**Built-in tools narrow the same way.** The panel grants them one tickbox each for read, write, search, code, shell, web, subagent, knowledge, todo_list and introspect, and reads `Tools: all` or `Tools: N of 10`. A row is a capability rather than always a single name: `search` covers finding files and searching inside them, and `web` covers both searching the web and fetching a page, so the document ends up holding more names than the menu has rows. Re-ticking everything stores nothing again, so `all` is the absence of a setting on the loop rather than a list that happens to be complete - which is also why a saved default of "everything" is stored as an explicit choice instead: the loop can only say it by staying silent, so the default has to be able to say it out loud. There is no gate above the list as there is for the MCP grant, because the usual move here is taking one thing away rather than curating from zero. The card carries a `tools` chip with the granted tags in its tooltip.

An unrestricted loop is granted the `@builtin` wildcard, so categories added by a later `kiro-cli` arrive on their own; a narrowed loop is granted its exact tags, so it stays narrow as `kiro-cli` grows, which is the point of having narrowed it. The two axes do not interfere: granted servers are named in the tool grant as well, so the tool filter never strips what the MCP grant gave.

**A loop can pin the model it runs on**, from a picker in the same settings row. Absent means the machine default. The catalogue is discovered rather than listed, by one throwaway session at startup asking `kiro-cli` what it offers, because a hardcoded list would be stale within a month; discovery coming back empty is not an error either, and with nothing pinned the picker hides itself rather than standing there empty, which would say something had failed without saying what. When there is a catalogue it shows the machine default marked as inherited, so it answers which model rather than none chosen, and the loop follows that default until you pick one. Picking the default by name pins it like any other choice, so the loop then stops following if the machine default changes. A model pinned on a loop that this machine does not list is kept rather than dropped, so a factory carried over from another machine does not lose the choice. The card says the model on a line of its own, pinned or inherited, whenever one is known.

## Reading what a loop wrote

A loop's memory is whatever it leaves on disk, so its folder is the only record of what it did. **Select a loop and a panel appears under the floor listing the files it has written**, which is the difference between reading that record and leaving the app for a terminal to do it. It is collapsible and resizable like the settings panel, mirrored onto the other axis, shut on a fresh browser, and it remembers whether you left it open. It also opens on its own after Branch off, pointed at the changes view.

**Both panels fold rather than being taken down.** Shutting one animates its width or height to zero instead of unmounting it, which is what makes it a slide rather than a disappearance, and is why reopening returns the size you dragged it to with the contents still in place. The chevron that folds a panel sits on the divider it moves, halfway along the edge, and is still there once the panel is shut, so the way back is on the edge that is left rather than somewhere in the toolbar. Shut, that divider is only a rail for the arrow, and gives up its resize cursor because there is nothing left to drag.

Markdown is rendered and source files are highlighted. Both are sanitised on the way in, because this server answers `DELETE` on the same origin as content the agents wrote, and an agent writing a page that can call back into the app is not a threat worth leaving open.

**The list sorts by name, modified or size**, from a dropdown that appears once there is anything to sort. Like the changes comparison it is remembered across sessions and shared by all three sources, because it is a habit rather than a property of what you happen to be looking at.

Files can be deleted one at a time, even while the loop runs. A loop's whole folder can be cleared at once, but the server refuses while the loop is running and says so. That folder holds the item the current turn claimed off a queue, and taking an item is a move, so the copy in there is the only one left. Clearing mid-turn would destroy work no other loop can see is missing.

**The panel browses three sources** - Project, Loop, Changes - and rests on Project: it is what shows before anything is clicked, and what it falls back to when a loop is deselected. Selecting a loop points it at that loop's folder, so you can watch a loop's scratch fill up and then go look at what actually landed in the codebase. Opening and closing the panel is its fold arrow on the divider.

**Files can be dropped onto the panel** and are copied into the root of what it is showing: the project root on the project view, the loop's folder on a loop's view - which is how you hand a running loop an input file by hand. A file of the same name is overwritten, the same bargain as `cp`. The changes view takes nothing, because it is a comparison rather than a folder: there is no "into".

Browsing the project is read-only. There is no delete on that side and no way for a delete to reach a source file, because git is the tool for changing your mind about source. The walk prunes `node_modules`, `.git` and build output, otherwise the file budget goes on dependencies and the tree comes back with no source in it. `.kirofactory` is deliberately not pruned so you can inspect queues, and a loop's own folder is walked whole, since pruning an agent's scratch space would be second-guessing it.

## Git, worktrees and the changes view

**The directory bar says what git makes of the base directory**, permanently: the branch of an ordinary checkout, the branch plus a `worktree` tag for a linked worktree, or an amber "not versioned" warning when there is no repository. The loops hold a shell and no human approves anything mid-run, so whether any of it can be undone is not a detail - it is the difference between a run you can walk away from and one you cannot.

**Branch off** gives a factory a checkout and a branch of its own: one branch off the current HEAD, one worktree beside the repository, and the factory moves into it. The document is written into the new place; the queues and loop folders stay behind in the old `.kirofactory`, because moving items in flight would let two loops claim the same one, and pointing the factory back at the old directory finds them exactly as left. Nothing untracked comes across, so a project that needs installing needs installing again, and removing this worktree afterwards is `git worktree remove` - deliberately not something this app does at the factory level, because deleting the factory's worktree deletes the queues in it. Loops that already have [checkouts of their own](#git-worktrees-and-the-changes-view) keep them across a branch-off: the move stays inside the same repository, so their worktrees are still valid and the record of them is carried into the factory's new home.

**Own checkout** is the same idea per loop. All the loops of a factory normally share one directory, which means two loops editing the same file in the same minute overwrite each other - a cluster of eight is eight agents in one folder. Ticking **own checkout** in a loop's settings gives each of its sessions (the one session of a plain loop, or every member of a cluster) a full worktree of the repository, on a branch of its own, so parallel work is genuinely parallel. On disk it looks like this:

```
~/projects/
  shop/                       the repository, factory baseDir, machinery in .kirofactory/
  shop-loops/                 one container for all of this repo's session checkouts
    api-writer/               a plain loop's checkout        branch kirofactory/<factory>-api-writer
    worker-n1/                cluster member 1's checkout    branch kirofactory/<factory>-worker-n1
    worker-n2/                cluster member 2's checkout    branch kirofactory/<factory>-worker-n2
```

The checkbox records intent only; the checkouts are made when you press Start, one `git worktree add` at a time (git holds a lock, so they cannot be parallel), with progress on the loop's log - a first start of a big cluster on a big repository takes a while, and the confirm dialog says how many checkouts you are agreeing to. Which session got which directory is recorded in `.kirofactory/worktrees.json`, never in the document, so an exported factory carries no absolute paths from your machine. A restart reuses the checkouts it finds; the setting is locked while the loop runs, since each session's checkout is fixed at start.

Inside such a session, `@project` *is* the checkout - the agent works and commits there, and its prompt tells it which branch it is on and that its siblings have checkouts of their own. The machinery (`@loop`, queues, topics) stays in the factory's base directory and is named by absolute path, so coordination never forks. Merging the branches back together is git's job, or a fan-in loop's - the app never does it.

**Release**, next to the checkbox, removes a loop's checkouts again: `git worktree remove` per session, never forced - a checkout with uncommitted or untracked files refuses and stays, which is git's rule rather than the app's - and the branches are never deleted, so committed work survives a release. Unticking the box removes nothing; the next start simply runs in the base directory again, and Release goes with the box, so tick it again to get at the checkouts.

One caveat the panel also states: a Kiro Flock cluster with own checkouts still coordinates over its ring, but a broadcast naming a file points at the sender's checkout, not the reader's. Each member is told so, and told that a neighbour's work is reached through its branch - which is, after all, what a flock is.

**The changes view** is the file panel's third source: what the loops have done to the project, with an inline before/after diff per file. It shows the working tree rather than a pair of commits, so staged, unstaged and untracked all appear, and one dropdown adds the commits made since the branch point - which is what "what has this factory done" means.

**Which comparison is a dropdown in the panel's toolbar, and reading it is the difference between a short list and hundreds of files.** `uncommitted` is the default and compares against HEAD: staged, unstaged and untracked, so it is what this factory has done that is not yet committed. `since branch point` compares against where the current branch left the trunk, which is `origin/HEAD` if the remote names one and otherwise the first of `main`, `master` or `trunk` that exists, locally or on `origin`, and it includes commits. So on a long-lived feature branch that second one lists everything the branch has ever changed, including work no loop was involved in and however many commits you made by hand, no matter how up to date the branch is with its own remote - the comparison is against the trunk, not against the branch's upstream. The choice is remembered across sessions and is per browser rather than per factory, since it is which comparison you think in. Switching clears any open diff and keeps the folders you had unfolded, so the two are one place rather than two. A factory based in a gitignored directory gets told so instead of a silently empty list, and the branch-off question warns about it up front, because a changes view that can never show anything is the likeliest reason to regret the press.

**Worktree loops in the file panel.** A loop with its own checkouts does its work where the main directory cannot show it, so the panel follows: select such a loop and the changes view reads the selected session's checkout (the member strip switches between them), and once the factory has any checkout the project view carries a dropdown listing the main project and every checkout - ten worktrees is ten places the work might be, and the dropdown defaults to the selected loop's. The loop's own `@loop` folder is unaffected: it lives in the machinery, not in the checkout.

## Prompts

**`@input` and `@output`** are how a prompt talks about its queues:

> read whats in the `@input` queue one per round, add a sentence to it and hand it to your `@output`

They are names, not paths, because the folder depends on the wiring and changes when you rewire. Each turn the prompt defines them before your instructions, so the agent knows what they point at. Type `@` in the prompt box to insert one, or to name a directory, a parameter or an MCP server.

**`@project` and `@loop`** are the two directories:

> take a feature from `@input`, implement it in `@project` with tests, and keep your working notes in `@loop`

`@project` is the directory the factory runs in - the codebase the loops are building. It is shown on the bar above the floor beside the path it stands for, so the token and its meaning are in the same place. `@loop` is the folder that loop owns under `.kirofactory/loops/`: scratch, working files, items it claimed off a queue, and notes to its own next iteration, since every turn is a fresh session with no memory of the last.

`@project` is the one an operator forgets they need. `@loop` is the nearer folder and the easier place for an agent to drift into, so a prompt that never mentions the project tends to get work that lands there instead: notes about the feature rather than the feature. Every turn is told the base directory is a real codebase to be changed in place and that `.kirofactory` is coordination rather than product, but naming `@project` is what makes it the instruction rather than the background.

A loop with nothing wired downstream has no `@output` to hand anything to, and is told so: its result is the change it made in the project, not a file in its own folder. Otherwise the last loop in a chain writes its deliverable into `@loop`, where the point of the run quietly ends up as scratch.

**`@name` is a parameter**: a value set once for the whole factory, which every prompt in it can write.

> research `@topic` to a depth of `@depth` and hand a summary to `@output`

Parameters live on the directory bar, folded away behind the arrow at the bottom of it, and the tag button on that bar adds one. They sit there rather than in the panel because that is what they are the same kind of thing as: the bar already shows `@project` beside the path it stands for, and a parameter is a name beside the value it stands for. The fold only exists once there is something in it.

They are the one reference that is **substituted** rather than defined. `@input` and `@project` resolve to a folder and a protocol, which are too large to sit inside a sentence and get explained above your instructions instead; a parameter resolves to a short value the sentence reads through, so the agent is handed *research quantum computing* rather than a token and a definition to apply. The prompt keeps the name, so the value can be changed without editing anything, and a running loop picks the new one up on its next turn - the substitution happens per iteration, not at save.

**A parameter with no value keeps its token.** The prompt still says `@topic` and the agent is told that parameter is unset, rather than the token being replaced by nothing. Substituting a blank would turn "research `@topic` thoroughly" into a sentence that still reads as an instruction and quietly asks for something else, and nothing downstream could tell that had happened.

`@project`, `@loop`, `@input` and `@output` are reserved, so a loop scoped to an MCP server cannot be handed one whose name shadows them, and a parameter cannot take one of those names either. A token that sometimes means a directory and sometimes means a tool would be worse than either.

**Parameters and MCP servers share the rest of that namespace, and a parameter wins it.** Name one after a server you have and the prompt will substitute a value where it looks like it grants a tool, so the row says `shadows a tool` while renaming is still cheap. The colour is the standing distinction: parameters are blue and tool names are pale, which matters because both are arbitrary names the factory supplies and nothing about the words themselves separates *this becomes a value* from *this hands over a capability*. A parameter never grants a server - including to a scoped loop, where naming a server otherwise does - and a parameter's *value* naming one grants nothing either, since only your own text names capabilities.

**`@` also names skills and steering files.** Kiro loads two kinds of context beyond the prompt itself: skills (`.kiro/skills/**/SKILL.md`, on this machine or in the factory's directory) and steering files (`.kiro/steering/*.md`, likewise). kiro-cli picks both up on its own, every loop, every turn - so naming one **reinforces rather than restricts**. `@my-skill` in a prompt gets the skill described above your instructions with a note to actually load and follow it, which matters because a skill is metadata until an agent opens it, and the standing failure is an agent that had the right skill and never did. `@my-steering` points at rules that are already in context and says they take priority here. Nothing is granted, generated or blocked either way, and nothing about the loop's document changes: as with servers, the prompt text is the whole state.

Skills are green in the prompt and steering violet, and the `@` picker offers both in their own groups. Two lists in the settings row, `Skills` and `Steering`, show what this machine and project carry - clicking a row writes its `@name` into the prompt at the caret, a tick marks the ones the prompt already names and those rows do nothing when clicked, and a name that cannot be written after `@` is listed dimmed rather than hidden. They wear the same dress as the MCP and tools menus beside them but hold no checkboxes, because there is nothing to grant: a row is a fact about the machine plus an action on the prompt.

The full order of the namespace, for a name more than one thing answers to: reserved words, then parameters, then MCP servers, then skills, then steering files. Servers beat skills because servers were here first, so `@github` keeps meaning the server after someone drops a `github` skill into `.kiro/skills/`. A shadowed skill costs a missing prompt section rather than a missing capability, but the parameter row still warns - `shadows a skill`, `shadows steering` - while renaming is cheap.

## Many factories

Each tab is a factory: its own loops, its own wires, its own directory. They run independently, and a factory keeps running when you switch away from it, which is what the dot on a tab means. Double-click a tab to rename it. Closing a tab forgets it; the files stay where they are. The close dialog also holds the harder answer: a Delete factory button behind a typed `delete`, which removes the factory's own data and only that - `.kirofactory` under the base directory, the one place the app writes.

A closed factory is still remembered, and the Factories tab of the Open picker lists the ones that are not currently tabs, so getting one back is a click rather than a path you have to have kept. For a factory that is not in that list either - moved, or left behind by another checkout - see [Finding factories again](#finding-factories-again).

**The strip holds as many factories as you open.** `+` at its end opens another, and the `x` on a tab closes that one. Past the point where the tabs stop fitting, the row scrolls rather than squeezing every tab down to nothing, and a scroll button appears at each end only when there is something in that direction, since a permanently visible pair that does nothing most of the time is two more things to look at and no more capable. A vertical wheel gesture over the strip scrolls it sideways, which is what a flick over a row of tabs is expected to do, and switching to a tab that is scrolled out of sight brings it back. `+` sits outside the scroller, so a new factory stays reachable at any tab count, and a tab is capped in width with its name ellipsised, so one long factory name cannot push the rest off the row. A reload comes back to the factory you were working in.

**Import and Export** move a factory as one file, from two buttons at the end of the tab strip, since everything in that row is about whole factories rather than anything inside one. A factory file dropped onto the floor imports the same way, without the file dialog. The export is the whole factory - every loop and every wire as a JSON object in it - so it is the thing to commit, mail, or keep. The `baseDir` inside it is a path on whichever machine wrote it, so on import it is used when that directory exists here and is free, and replaced with a local one when it does not exist or already holds another factory. An import keeps the document's own id when nothing open is using it, so importing a factory you exported reopens that factory rather than adding a copy of it. That is the way back from a closed tab, and it does not have to be an export: the document the factory left in its own directory is the same file and imports the same way.

**Every factory has a base directory**, shown under the toolbar. That is the working directory for every loop in it - the directory the agents start from and can write anywhere below. Point a factory at a project and its loops work on that project. Changing it stops the running loops first, and queues are left where they are rather than being moved out from under work in flight.

**The directory can be picked rather than typed.** An absolute path is a miserable thing to type: long, exact, and a typo in it points the factory at a folder that is not there. A folder button beside the field opens a picker that walks the machine one directory at a time, and `Use this folder` takes wherever you are standing, which is why no row is highlighted: rows are what you descend into, the button takes where you are. It opens on whatever the field is holding, so typing a path and browsing for one are one control rather than two, and typing is still the fastest way in when you already know the path. Each listing tags the subdirectories that already hold a factory, because two factories cannot share a directory and reading that off the listing beats learning it from a refusal after you choose. It does not offer to create a directory; making one is the shell's job.

Picking has to ask the server, because a browser will not report an absolute path at all: a file input names a file and hands over bytes, a directory input hands over relative paths under a folder it declines to name, and neither of those is a path. The server is on the same machine as the directories, so it answers with the listing and the picker only draws. A path that does not exist is not an error either, since it is usually a half-typed one: the walk goes up to the nearest ancestor that does exist, landing as close to what you typed as the disk allows. An unreadable directory comes back as itself with the reason attached rather than as a failure, because an empty listing and a refused one would otherwise look identical.

**The picker filters as you type.** A home directory is a hundred rows, and scrolling for a name you already know is the misery typing the path was supposed to fix. The filter box is focused when the picker opens, Enter descends when it has narrowed the list to one folder - so the fast path is a few letters and Enter, repeated - and Escape clears the filter before it closes the picker. Descending clears it, since it was a question about the folder you just left.

## The library

A loop is a name and a prompt, which makes a loop that worked a small file worth keeping. [`library/`](library/) is a folder of them, committed to this repository and shared by every factory. **Library** on the toolbar takes something out; the bookmark button next to a loop's name puts that loop in, and **To library** in the top nav puts the whole factory in.

**Three kinds, in three folders**: `library/loops/`, `library/clusters/` and `library/factories/`. The split is for whoever is reading the repository rather than for the app - the audience of a committed folder of JSON is people, and one flat directory mixing a single prompt with a whole wired-up factory is a directory nobody browses twice. The folders organise without deciding: whether an entry is a loop or a cluster is still read off its `cluster` field, so a misfiled entry works and just sits in the wrong folder for a reviewer to move.

**The picker is three columns and a search box.** It was a dropdown, and the third category ended that: a native select is as wide as its widest option, so it could only ever show names - no descriptions, nothing to choose on - and it cannot hold a filter at all. The columns each scroll on their own, so a long list of loops does not push the factories out of view, and typing narrows all three at once, because the question "where is the thing called reader" includes which category it turned out to be in. Empty columns keep their heading and say so rather than collapsing, since a popover that reflows while you type is one you cannot aim at.

**Clusters are kept as clusters.** An entry carries the size, the mode and whether the nodes read each other, because that is part of what the prompt was written for rather than part of where the card sits: a prompt written for a ring of five reading each other's lines does something else entirely on its own. A saved cluster comes back out as the cluster it was, so picking is never a guess about how many sessions you are about to start.

**A factory entry is the whole design**: its loops, how they are wired, and its parameters. Picking one opens a new tab rather than adding to the floor you are on - a factory *is* a floor of its own, and dropping one into another would be merging two designs. Every take-out is a new factory rather than a copy of somebody's, so it gets a fresh id, and the directory to run it in is the one thing an entry cannot know: without one it gets a folder of its own, the same as any factory created from the tab strip.

Unlike a loop entry, a factory entry **keeps its positions**. A single loop's position is where somebody else's card happened to sit and means nothing here, but a factory's positions are the diagram - which loop feeds which, read left to right - so an entry that dropped them would arrive as a heap of boxes at the origin with the design lost. What it drops is the base directory and the factory id. Its parameters travel with it, names and values both: a parameterised factory whose parameters were stripped would arrive with every prompt full of tokens standing for nothing, and the values that came with it are the worked example of what it expects.

Saving writes into your checkout rather than into the factory's directory, so an entry appears in `git status` as the file you would send. Filling in its description and opening a pull request is the whole contribution - see [`library/README.md`](library/README.md) for the format and what makes an entry worth sharing.

Prompts in the library name their queues `@input` and `@output` rather than folders, which is what lets one work in a factory it was not written in.

**A loop entry is one loop, never a wired-up group** - that is what a factory entry is for. It carries no position, since where a loop sits belongs to one particular factory; placement is assigned when the entry is dropped. A loop that only makes sense as half of a pair says so in its description, and both get contributed, or the pair goes in as a factory.

## What is on disk

A factory keeps everything in one folder inside its base directory:

```
<baseDir>/.kirofactory/factory.json          the design: loops, prompts, wires, parameters
<baseDir>/.kirofactory/queues/<from>/        one per producer, shared by its queue wires
<baseDir>/.kirofactory/topics/<from>/<to>/   one per topic subscriber
<baseDir>/.kirofactory/loops/<id>/           one folder per loop, for its scratch and output
<baseDir>/.kirofactory/loops/<id>/n1/, n2/   one per cluster node, its own @loop
<baseDir>/.kirofactory/loops/<id>/flock/     a cluster's ring logs, one file per node
<baseDir>/.kirofactory/worktrees.json        which session owns which checkout, for loops with one
```

Loops with **own checkout** on also get a directory *outside* the base directory: one worktree per session under `<parent>/<repo>-loops/`, beside the repository - see [Git, worktrees and the changes view](#git-worktrees-and-the-changes-view) for the layout. Those are checkouts of your repository made through git and removed through git (the Release button), never by the deletes below.

Queue folders are named after the loops rather than after the wire, which is what lets two wires share one, and also means one branch of a fan-out can be removed and drawn again with its work still sitting there. It is the loop's id in the path rather than its name, so renaming a loop leaves its queue where it is. A folder goes only when the last wire delivering into it does, and takes the work with it. A workspace from before that had a folder per wire is moved over on open, each one into the folder its mode now puts it in.

That is the only place this program writes or deletes inside a project of yours, which is what matters once `baseDir` is a codebase rather than a folder inside the app. Saving to [the library](#the-library) is the one deliberate exception, and it writes into your checkout rather than into any factory.

Two things sit outside it. `~/.kirofactory/factories.json` is the list of factories this machine knows and which of them are tabs - local state, not a factory, and losing it loses no design work since every document is still in its own directory. It lives in your home directory rather than in the checkout so that a second clone of this repository, or the app run from somewhere else, sees the same factories - a list kept beside the app would make every factory look lost the moment you cloned again, with nothing on disk having moved. `app/factory.json` is the sample design a fresh clone starts from; on first run it becomes a factory in `app/workspace/`. The sample is committed; `app/workspace/` and `app/workspaces/` are gitignored.

Because that file's own directory is `~/.kirofactory/`, which is also the name of the folder a factory keeps its queues in, **a factory cannot have your home directory as its base directory** - it would want that same folder. Any directory below it is fine. The picker stops offering "Use this folder" when you are standing in your home directory, and typing the path into the directory bar is refused with the reason.

**Every factory you create afterwards gets a folder of its own under `app/workspaces/`**, named by its id, unless you point it somewhere else. The singular `app/workspace` is where the shipped sample lands on a first run, and nothing else lands there: the first factory you create is structurally no different from the fifth. Each one's directory is recorded in the registry, so a factory stays exactly where it is however it got there.

### Finding factories again

The registry tracks directories by absolute path, so moving a factory's folder leaves the entry pointing at nothing, and a factory whose entry was never migrated from an old checkout is not in the list at all. The folder is fine in both cases; only the pointer is stale. **Find factories…**, on the Factories tab of the Open picker, is the way back: it walks your home directory for `.kirofactory` folders and adds everything it finds.

It takes a few seconds and asks before it starts. What it finds lands closed, appended to the list - nothing is opened, no tab appears, and the tab strip does not reorder, so the result is a longer Factories tab and a line saying what happened ("Found 12: 3 added, 1 moved, 8 already known"). A factory already in the list at that exact directory is left alone, including its name and whether it is a tab: the entry is yours, and a scan is not a reason to overwrite it. One whose folder has moved has its entry pointed at the new place, keeping the same factory rather than making a twin. A copy of a factory in a second directory - an export, a duplicated folder - is registered under a new id, because two directories cannot share one.

The walk skips what a home directory is mostly made of: `node_modules`, `.git`, `Library`, the various tool caches, and hidden folders generally. It also stops at eight levels deep, and never looks inside a `.kirofactory` it has found - that folder is a factory's scratch space, and a loop with its own checkout can have whole clones of a repository in there. So a factory parked inside a `node_modules` or fifteen levels down will not be found, and the Folders tab is still how you walk to it.

## Environment

Nothing has to be set: every one of these has a default, and the app is meant to be run with none of them. They exist so that the things which are otherwise baked in - the port, the binary, the folders - can be moved without editing code.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4711` | The port the server listens on. |
| `HOST` | `127.0.0.1` | The interface it binds. Loopback, and setting anything else on its own is refused: the server exits and tells you why. The API has no authentication and the loops hold a shell, so a bind that publishes both to a network has to be meant, not typed. |
| `KIROFACTORY_ALLOW_REMOTE` | unset | `1` is the second half of the sentence `HOST` starts. With both set the bind goes ahead, and the loopback checks on `Host` and `Origin` stand down, since on a host reached from elsewhere they would only refuse the thing you asked for. The token requirement on state-changing requests stays either way. Only worth doing on a trusted, isolated host. |
| `LOOP_DRIVER` | unset | `echo` runs the whole machinery without calling a model. Loops take turns, items move across wires, queues fill and drain, and nothing is spent. It is how to check a topology before paying for it. |
| `KIRO_CLI` | `kiro-cli` | The Kiro binary every session is started from, and the one the model catalogue is discovered through. Set it to an absolute path when it is not on the `PATH`. |
| `GIT` | `git` | The git binary, for the directory bar, the changes view and every worktree operation. |
| `WORKSPACES` | `app/workspaces` | Where a factory created without a directory of its own lands, one folder per id. |
| `REGISTRY` | `~/.kirofactory/factories.json` | The list of factories this machine knows, and which of them are tabs. Local state, not a design. In your home directory so every checkout shares one list; set this to keep a separate one. |
| `LIBRARY_DIR` | `library/` in this checkout | The library the picker reads and the save buttons write to. Point it elsewhere to keep a library of your own outside this repository. |
| `BASE_DIR` | `app/workspace` | Where the shipped sample lands on a first run. |

## Talking to the server yourself

Every request that changes something has to carry `x-kirofactory`, holding a token the server generates at each start. The browser needs no help with this: the token is written into the page as it is served, so opening the URL is all there is to it. Restart the server and an open tab reloads itself once, because its token is now from a previous run and the alternative is a page that looks alive while every button quietly fails.

Doing it by hand takes one flag. The token is printed under the URL at startup:

```bash
curl -X POST -H 'x-kirofactory: <token>' \
  http://127.0.0.1:4711/api/factories/<id>/loops/<loop>/start
```

Reads need none of it, so `curl http://127.0.0.1:4711/api/factories` works as it reads. The asymmetry is deliberate: the export link is an `href` and the event stream is an `EventSource`, and neither can send a header, while a token in the query string would end up in shell history to buy very little - anything running as you can already read the files this server would read for it. What the token is really for is the process that is *not* you: another account on a shared host, or something that got itself run by an install script. It can set any header it likes, and it cannot guess sixteen random bytes.

## A warning about tools

**Whatever a loop has been granted, it uses unattended.** No human approves anything mid-run, which is the point of a loop but also the risk: a permission gate with no UI to configure it just silently blocks a loop that needs to run a build, so there isn't one. A new loop holds `shell` from its first turn - it has to, to claim work off a queue - and no MCP server, so the containment is the directory you point the loops at from the moment you press Start, not from the moment somebody widens a grant. Use a dedicated, version-controlled working directory.

Narrowing and widening are both per loop, from its [grant lists](#what-a-loop-may-use), and what a loop is not granted it does not have - the grant becomes the generated agent's tool list rather than a line in a prompt. `Tools: all` is available and is a reasonable thing to choose; it is simply not where a loop begins.

What runs *without asking* is the other question, and it is not in the UI: within what a loop has been granted, no call waits for a human. That is gated by a flag and an allowlist at the top of `app/server/acp.ts`, and narrowing the default for every loop at once takes both, since while the flag is on the list below it is never consulted.

Two further things are worth being explicit about. Loops inherit the environment of the shell the server was started from, so credentials exported there are available to every agent it runs. And skills and steering files under the project directory are re-read every turn and enter the agent's context, which means a cloned third-party repository can carry instructions of its own: point factories at code you trust, or run in a container.
