/**
 * What a loop is actually told each iteration.
 *
 * The loop's behaviour is the operator's prompt and nothing else. This file adds
 * only the part the operator cannot know: which project this is, where this loop's
 * queues are on disk this run, and the protocol for taking work off one.
 *
 * The project comes first, because a factory that does not know what it is
 * building is not one. The agent's working directory is a real codebase and the
 * point of every loop is to change it; `.kirofactory` - under it, or back in the
 * factory's base directory when the session works in a checkout of its own - is
 * coordination: queues between loops, scratch and notes within one. Saying so is
 * not decoration.
 * Without it a loop reads a prompt made entirely of `.kirofactory` paths, concludes
 * that folder is its world, and delivers its work into the machinery.
 *
 * Nothing is ever pushed to a loop. A wire is a folder, and wiring two loops
 * together means telling the downstream one where to look. That is the whole
 * mechanism, and it is why a loop wired to an empty folder simply finds nothing
 * rather than failing.
 *
 * `@project`, `@loop`, `@input`, `@output`, `@some-mcp-server` and the names of the
 * skills and steering files this machine carries are the
 * vocabulary the operator writes with. They are defined here, above the operator's own text,
 * because a prompt saying "claim an item from @input" is unusable if the agent
 * reads the phrase before it has been told what @input is. The panel offers them from a
 * picker so the operator does not have to know a folder path that changes with the
 * wiring, or the exact spelling of a server in a config file.
 *
 * The factory's parameters share that namespace and are the one exception to the
 * rule above: they are *substituted* into the operator's text rather than defined
 * over it. The others resolve to a folder or a capability, which is too large to sit
 * inside a sentence and has to be explained beside it; a parameter resolves to a
 * short value the sentence reads through, so `research @topic thoroughly` should
 * reach the agent with the topic in it. See `applyParameters` in factory.ts, and the
 * parameters section below for the one thing that is still said out loud - which
 * values were filled in, and which were left standing because they are unset.
 */
import * as path from 'node:path';
import type { ClusterComms, Loop, Parameter, WireMode } from './factory.ts';
import { INTERNAL, applyParameters, nodeLabel } from './factory.ts';
import { serversNamedIn, type McpServer } from './mcp.ts';
import { namedIn, type Skill, type SteeringFile } from './resources.ts';

export interface QueueView {
  /**
   * Absolute path of the queue folder.
   *
   * Absolute unconditionally, not relative when it happens to be reachable from
   * the agent's cwd: a session working in its own checkout has no machinery
   * under it at all, and one prompt shape that cannot drift from another beats
   * a shorter path. The runner resolves these against `home` before they get
   * here.
   */
  dir: string;
  /**
   * Loops on the other end, so the prompt can say who it is talking to.
   *
   * More than one when the folder is shared, which for an output is a queue
   * feeding several readers. A folder, not a wire, is the unit here: two wires
   * onto one shared queue are one entry with two peers, because from inside the
   * turn they are one place to write.
   */
  peers: string[];
  mode: WireMode;
  /** Other loops taking from the same folder, for an input that is contested. */
  rivals?: string[];
}

export interface PromptInput {
  loop: Loop;
  reads: QueueView[];
  writes: QueueView[];
  /**
   * Absolute path of the directory the agent works in - the project.
   *
   * Named in the prompt rather than left implicit: an agent that has not been
   * told what its directory is reads the machinery paths as the whole of its
   * world. The factory's base directory for an ordinary loop, or this session's
   * own checkout when the loop opted into one.
   */
  cwd: string;
  /**
   * Absolute path of the factory's base directory - where `.kirofactory`
   * lives. Equal to `cwd` for a loop without its own checkout; the machinery's
   * absolute location either way, which is why the prompt derives its "the
   * machinery is here" sentence from this and never from `cwd`.
   */
  home: string;
  /** Absolute path of the folder this loop owns for scratch and claimed items. */
  ownDir: string;
  /**
   * Present when this session works in a checkout of its own. The prompt then
   * says so: what branch the directory is on, that sibling loops have checkouts
   * of their own, and that a committed `.kirofactory` inside the checkout is a
   * copy rather than the live machinery.
   */
  checkout?: { branch: string };
  iteration: number;
  /** MCP servers loops here can reach, so `@name` in the prompt can be resolved. */
  mcpServers?: McpServer[];
  /**
   * Skills this machine and project carry, so `@name` can be resolved to one.
   *
   * kiro-cli loads them for every loop regardless of this list - they are
   * metadata it offers the agent on demand, not something the factory grants. The
   * list is here only so a prompt that names one can have it described and be
   * told to actually open it, which is the whole of what naming a skill does.
   * Absent means none were found, and then the prompt says nothing about skills.
   */
  skills?: Skill[];
  /**
   * Steering files in context this turn, so `@name` can be resolved to one.
   *
   * Not the operator's steer messages - see `steerSection` below for those. These
   * are `.kiro/steering/*.md`, which kiro-cli has already put in the agent's
   * context before the prompt is read; naming one emphasises it rather than
   * loading it.
   */
  steeringFiles?: SteeringFile[];
  /**
   * The factory's parameters, so `@name` in the prompt can be filled in.
   *
   * The whole set rather than the ones this loop uses: which of them the prompt
   * names is a question about the prompt, and `applyParameters` is what answers it.
   * Absent means the factory has none, which is every factory before they existed.
   */
  parameters?: Parameter[];
  /**
   * Where the loop's auto-stop handshake stands, when the loop has it on.
   *
   * `armed` is the standing case: the agent is told it may declare that there is
   * no further work. `confirm` is the turn after such a declaration: the agent is
   * told what it said last time and asked to either withdraw it by doing work or
   * confirm it and stop the loop. Absent means the loop does not stop itself and
   * the prompt says nothing about it - which is every loop before this existed.
   */
  autoStop?: 'armed' | 'confirm';
  /**
   * Which member of a cluster this session is, when the component is one.
   *
   * Absent for a plain loop, and then the prompt says nothing about clusters at
   * all. Present and the agent is told it is one of several running this same
   * prompt - which it has to know, because otherwise "take an item from @input"
   * plus a folder that keeps losing items reads as a broken queue rather than as
   * a pool with siblings on it.
   */
  cluster?: { self: number; size: number; comms: ClusterComms };
  /**
   * What this member's ring neighbours last said. Only for a flock cluster.
   *
   * Already read off disk by the runner rather than being paths to go and fetch -
   * see `Runner.readFlock` for why the reading happens on that side.
   */
  flock?: FlockView;
}

/** One member's view of the ring: its neighbours, and their recent entries. */
export interface FlockView {
  neighbours: { member: number; entries: string[] }[];
}

/**
 * The exact phrases the runner scans a turn for. Exported so the runner and the
 * prompt cannot drift apart - the words the agent is told to say and the words
 * the loop listens for are the same constant.
 *
 * Matched at line start, case-insensitively, with anything allowed after them:
 * kiro-flock's autopause learned this the hard way, where an exact match missed
 * 69% of idle broadcasts because agents decorate ("idle - diagnosis complete").
 */
export const DECLARE_SENTINEL = 'NO FURTHER WORK';
export const CONFIRM_SENTINEL = 'CONFIRM STOP';

/**
 * What a flock member ends its turn with, for its neighbours to read.
 *
 * A line in the turn text rather than a file the agent writes, for the same
 * reason the other two sentinels are: it costs the agent nothing, it cannot be
 * half-done, and the runner is already scanning the turn for phrases. An agent
 * asked to append JSON to a specific path instead has to be trusted to get the
 * path right, to append rather than overwrite, and to do it at all - three ways
 * to lose a broadcast, against zero.
 */
export const BROADCAST_SENTINEL = 'BROADCAST';

/** `A`, `A and B`, `A, B and C`. */
function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * `- \`dir\` (from: Peer)`, or the same with `to:`, plus what sharing it means.
 *
 * The note is the whole point of the annotation: a folder two loops take from
 * behaves differently from one only this loop can see, and an agent cannot tell
 * which it is by looking. Silence on a plain folder - a queue with one reader and
 * one writer needs no explanation, and reads as one.
 */
function list(queues: QueueView[], preposition: 'from' | 'to', clustered = false): string[] {
  return queues.map((q) => {
    const peers = `${preposition}: ${names(q.peers)}`;
    let note = '';
    if (preposition === 'to') {
      if (q.mode === 'topic') note = ', its own copy';
      else if (q.peers.length > 1) note = ', one shared queue: each item goes to one of them';
    } else if (q.mode === 'topic') {
      /*
       * A topic folder belongs to the subscribing *loop*, and a cluster is one
       * loop with several sessions - so for a cluster member "your own copy" is
       * wrong in the one way that matters: it reads as private, and a node that
       * takes it literally reads the item without moving it, which is the thing
       * the claim protocol below says never to do. `rivals` cannot carry this,
       * because it names other loops and siblings are the same loop.
       */
      note = clustered
        ? ', one copy for this cluster, shared with your sibling nodes: each item goes to whichever takes it first'
        : ', your own copy of everything sent';
    } else if (q.rivals && q.rivals.length > 0) {
      note = `, shared with ${names(q.rivals)}: each item goes to whichever takes it first`;
    } else if (clustered) {
      note = ', shared with your sibling nodes: each item goes to whichever takes it first';
    }
    return `- \`${q.dir}\` (${peers}${note})`;
  });
}

export function buildPrompt(input: PromptInput): string {
  const { loop, reads, writes, cwd, home, ownDir, iteration } = input;
  const parameters = input.parameters ?? [];
  const params = applyParameters(loop.prompt, parameters);
  /*
   * Servers are looked up in the prompt as the operator wrote it, not in the filled
   * text, and the difference matters: a parameter whose value happens to contain
   * `@github` would otherwise grant the github server to a loop nobody granted it
   * to. A value is data. Only the operator's own text names capabilities.
   */
  const named = serversNamedIn(
    loop.prompt,
    input.mcpServers ?? [],
    parameters.map((p) => p.name),
  );
  /*
   * The other two kinds of reference, resolved against the raw prompt for exactly
   * the reason above and in the precedence order the plan fixes: parameters, then
   * servers, then skills, then steering files.
   *
   * The order has to be fixed somewhere and this is the server's half of it; the
   * panel's `classOf` keeps the same order on its side. Servers come before skills
   * because servers are the incumbent - a prompt that says `@github` today must go
   * on meaning the server after someone drops a `github` skill onto the machine.
   * So each lookup claims everything that outranks it, and the stakes are mild in
   * this direction: a shadowed skill costs a paragraph of prompt, where a shadowed
   * server would have cost a capability.
   */
  const claimedByParams = parameters.map((p) => p.name);
  const serverNames = (input.mcpServers ?? []).map((s) => s.name);
  const skills = input.skills ?? [];
  const namedSkills = namedIn(loop.prompt, skills, [...claimedByParams, ...serverNames]);
  const namedSteering = namedIn(loop.prompt, input.steeringFiles ?? [], [
    ...claimedByParams,
    ...serverNames,
    ...skills.map((s) => s.name),
  ]);
  const out: string[] = [];

  // A cluster member says which member it is in its own title, because every
  // member runs this identical prompt and the number is the only thing that
  // distinguishes them. It is also the first thing an agent reads, which is where
  // "you are not the only one doing this" belongs.
  out.push(
    input.cluster === undefined
      ? `# ${loop.name} - iteration ${iteration}`
      : `# ${loop.name} - node ${nodeLabel(input.cluster.self)} of ${input.cluster.size}, iteration ${iteration}`,
  );
  out.push('');

  /* -------------------------------------------------------------- the ground */

  /*
   * The one distinction the rest of this prompt depends on: the project is the
   * work, `.kirofactory` is the machinery.
   *
   * It comes first because everything after it is a path inside the machinery,
   * and an agent that meets those paths before it has been told what the
   * surrounding directory is concludes they are its whole world - which is
   * exactly what loops did while this section was missing. They treated their own
   * folder as the deliverable and never touched the project they were pointed at.
   */
  out.push('## Where you are working - `@project` and `@loop`');
  out.push('');
  out.push(
    `You are working in \`${cwd}\`. That is your working directory and it is the project - ` +
      'a real codebase that this factory exists to build. Source, tests, documentation and ' +
      'configuration live there under ordinary paths, and you change them in place with the tools you ' +
      'have, the same way you would work on any repository.',
  );
  out.push('');
  /*
   * The machinery, named by absolute path.
   *
   * It used to be "one folder in it is not the project", which was true for as
   * long as the machinery sat under the working directory - per-session
   * checkouts ended that, and the sentence now locates it instead of carving it
   * out. One wording for both modes, derived from `home`, so a reader of this
   * file never has to ask which mode a prompt was built in: when the loop has
   * no checkout the path is simply inside the working directory, and the
   * sentence is still true.
   */
  out.push(
    `The loops of this factory coordinate through one folder of machinery: \`${path.join(home, INTERNAL)}\`. ` +
      'Queues, claimed items and each loop\'s own scratch space are in there, and every machinery ' +
      'folder below is named by absolute path. Read and write inside it as the sections below ' +
      'describe, but do not restructure it, do not delete it, and do not mistake anything in it for ' +
      'the work - a file in the machinery is a message or a note, never a deliverable.',
  );
  out.push('');
  /*
   * The two directories named, together and in contrast.
   *
   * Together because the mistake being prevented is confusing them, and a definition
   * that only says what `@project` is leaves `@loop` as the nearer, more concrete
   * folder an agent drifts towards. Side by side, the choice the operator made by
   * writing one rather than the other is legible.
   */
  out.push('Your instructions below name these two directories:');
  out.push('');
  out.push(
    `- **\`@project\`** - \`${cwd}\`, the codebase itself. Not any folder inside it. ` +
      '"Implement it in `@project`" means put the work in the project, wherever it belongs there.',
  );
  out.push(
    `- **\`@loop\`** - \`${ownDir}\`, your own folder. Scratch, working files, claimed queue items ` +
      'and notes to your future self. Nothing here is a deliverable.',
  );
  out.push('');
  /*
   * Only for a session in its own checkout, because only then is any of it
   * true - and then all of it matters. The committed-copy clause earns its
   * place in any repository that tracks its `.kirofactory`: every checkout gets
   * a stale copy of it sitting beside the real thing, and an agent that
   * mistakes the copy for the machinery delivers its work into a folder nobody
   * reads.
   */
  if (input.checkout !== undefined) {
    out.push(
      `This project directory is a checkout of its own, on the branch \`${input.checkout.branch}\`. ` +
        'Other loops of this factory are working in their own checkouts of the same repository, so ' +
        'their edits are not in your files and yours are not in theirs - commit on this branch as ' +
        'you finish work, and reach a sibling\'s work through its branch if you ever need it. If a ' +
        '`.kirofactory` folder appears inside this checkout, it is a committed copy riding along ' +
        'with the repository, not the live machinery: the live machinery is at the absolute path ' +
        'above, and it is the only one to read or write.',
    );
    out.push('');
  }

  /* ------------------------------------------------------------- the cluster */

  /*
   * Before `@input`, deliberately.
   *
   * The sharing note on a contested folder says "shared with your 3 sibling
   * members", and that sentence is meaningless to an agent that has not yet been
   * told it has siblings. Worse, a member that meets the shared queue first and
   * the explanation second has already formed the belief that the queue is its
   * own, which is the belief that turns a sibling's win into a bug report.
   */
  if (input.cluster !== undefined) {
    const { self, size, comms } = input.cluster;
    out.push('## You are one of several');
    out.push('');
    out.push(
      `This component is a cluster of ${size} nodes and you are node ${nodeLabel(self)}. Every node ` +
        'runs the prompt below in its own session, at the same time, competing for the same work. ' +
        `Your own folder \`${ownDir}\` is yours alone - no other node reads or writes it - so nothing ` +
        'you keep there is visible to them and nothing they keep is visible to you.',
    );
    out.push('');
    out.push(
      'Take one unit of work and do that. Do not try to do the whole queue: the other nodes are ' +
        'working through it alongside you, and two nodes on one item is the one outcome this shape ' +
        'is meant to avoid.',
    );
    out.push('');
    if (comms === 'isolated') {
      /*
       * Said out loud rather than left as an absence.
       *
       * An agent told it has siblings and not told how to reach them will look for
       * the channel - a shared status file, a note in the queue, a lock - and
       * inventing one is worse than having none, because the invention is
       * unco-ordinated and lands in the queue folder or the project.
       */
      out.push(
        'The nodes do not communicate. There is no channel to them, no shared file to coordinate ' +
          'through, and none is wanted: do not invent one, and do not write anything intended for a ' +
          'sibling to read. Claiming an item is the only coordination there is, and it is enough.',
      );
      out.push('');
    }
  }

  /* ---------------------------------------------------------- the vocabulary */

  out.push('## What @input and @output mean');
  out.push('');
  out.push(
    'Your instructions below may refer to `@input` and `@output`. They are not literal paths. ' +
      'They are names for the queue folders this loop is wired to, which change as the wiring changes, ' +
      'and for this iteration they resolve to the following.',
  );
  out.push('');

  out.push('**`@input`**');
  if (reads.length === 0) {
    out.push(
      '- Nothing is wired into this loop, so `@input` is empty. If your instructions tell you to read ' +
        'something, read it from wherever they say - a file, a repository, an API - not from a queue.',
    );
  } else {
    out.push(...list(reads, 'from', input.cluster !== undefined));
    if (reads.length > 1) {
      out.push('');
      out.push('`@input` means all of the folders above. Treat them as one pool of work.');
    }
  }
  out.push('');

  out.push('**`@output`**');
  if (writes.length === 0) {
    /*
     * A loop with no downstream is a loop whose output is the project.
     *
     * This used to send the work to `ownDir`, which was the single most misleading
     * line in the prompt: the terminal loop is usually the one that actually
     * builds something, and it was being told to put it in the machinery folder
     * where nobody would ever look for it.
     */
    out.push(
      '- Nothing is wired out of this loop, so there is no queue to deliver to. That does not mean ' +
        'there is nowhere for your work to go: it goes into the project itself, as changes to real ' +
        'files. Say in your reply what you changed.',
    );
  } else {
    out.push(...list(writes, 'to'));
    if (writes.length > 1) {
      out.push('');
      out.push(
        '`@output` means all of the folders above, and they are separate deliveries: write your ' +
          'result to every one of them. Writing a shared queue once is enough for every loop on it.',
      );
    }
  }
  out.push('');

  /* ---------------------------------------------------------- the tool names */

  /*
   * Only the servers this prompt actually names are described. The agent has every
   * enabled server loaded either way, so listing all of them here would bury the
   * operator's instruction under a catalogue nobody asked for.
   *
   * The reference deliberately stops at the server. Which of its tools to call is
   * a decision that depends on what the instruction below is asking for, and the
   * agent is the thing holding both - so it decides, rather than the operator
   * having to name a tool they would then have to keep in step with the server.
   */
  if (named.length > 0) {
    out.push('## What the @tool names mean');
    out.push('');
    out.push(
      'Your instructions below refer to the tools listed here. Each one names an MCP server whose ' +
        'tools you have available this turn - it is the name of the server, not of a tool on it. ' +
        'Work out from the instruction which of that server\'s tools does what is being asked; list ' +
        'the tools it offers first if you are not sure.',
    );
    out.push('');
    for (const server of named) {
      out.push(`- \`@${server.name}\` - the \`${server.name}\` MCP server.`);
    }
    out.push('');
  }

  /* --------------------------------------------------------- the skill names */

  /*
   * Only the skills this prompt names, for the reason the section above gives: a
   * machine can carry twenty of them and a catalogue would bury the instruction.
   *
   * The instruction to load is the entire point. A skill is metadata until it is
   * opened - the agent sees a name and a one-line description and decides for
   * itself whether to read the body - and the failure this section exists for is
   * an agent that had exactly the right skill sitting there and never opened it.
   * Naming it does not grant it, because it was never withheld; it says out loud
   * that the operator meant this one.
   *
   * The body is deliberately not here. Copying it into every turn's prompt would
   * pay for it whether the agent needed it or not, and leave two copies to drift.
   */
  if (namedSkills.length > 0) {
    out.push('## What the @skill names mean');
    out.push('');
    out.push(
      'Your instructions below name skills. Each one is a skill you already have available this ' +
        'turn - you are not being given it, you are being told which one the instruction means. ' +
        'Load it and work from it rather than from the summary here, which is only enough to ' +
        'recognise it by.',
    );
    out.push('');
    for (const skill of namedSkills) {
      /*
       * A skill's description is written as prose in its own frontmatter and
       * usually ends in a full stop, so it is trimmed of one before the sentence
       * this bullet finishes with. Cheaper than asking every skill author to
       * write a fragment.
       */
      const about = skill.description.trim().replace(/\.+$/, '');
      out.push(
        `- \`@${skill.name}\` - the \`${skill.name}\` skill${about.length > 0 ? `: ${about}` : ''}. ` +
          'Load it and follow it where the instruction concerns this.',
      );
    }
    out.push('');
  }

  /* ------------------------------------------------------ the steering names */

  /*
   * Steering is already in the agent's context before it reads a word of this
   * prompt - kiro-cli puts it there - so unlike a skill there is nothing to ask
   * for. Naming one is emphasis: of everything in context, this is the part the
   * instruction below is leaning on.
   *
   * Not the operator's steer messages, which are a different thing that
   * unfortunately shares the word; those arrive appended to this prompt, and
   * `steerSection` is where they are explained.
   */
  if (namedSteering.length > 0) {
    out.push('## What the @steering names mean');
    out.push('');
    out.push(
      'Your instructions below name steering files. These are already in your context and you are ' +
        'following them regardless - naming one says the instruction below depends on it in ' +
        'particular.',
    );
    out.push('');
    for (const file of namedSteering) {
      out.push(
        `- \`@${file.name}\` - your \`${file.name}\` steering rules, already in your context. ` +
          'Where the instruction names them, they take priority.',
      );
    }
    out.push('');
  }

  /* ---------------------------------------------------------- the parameters */

  /*
   * The one part of the vocabulary that has already been applied by the time the
   * agent reads about it, which is why this section is written in the past tense.
   *
   * It is here at all because a prompt is the record of a turn as well as its
   * instruction. Read back from a log, a substituted prompt says what the loop was
   * asked to do but not why it said "quantum computing" - the operator sees the
   * value and has to remember it came from a parameter. Four lines make the turn
   * self-explaining, and they cost nothing: a parameter's value is short by nature.
   *
   * Only the ones this prompt names, matching the tool section directly above for
   * the same reason it gives: a factory's other parameters are not this loop's
   * business, and listing them would bury the instruction under a catalogue.
   */
  if (params.named.length > 0) {
    out.push('## What the @parameter names stood for');
    out.push('');
    out.push(
      'Your instructions below use this factory\'s parameters. A parameter is a named value set ' +
        'once for the whole factory, so every loop in it reads the same answer.',
    );
    out.push('');
    for (const p of params.named) {
      const about = p.description !== undefined ? ` ${p.description}.` : '';
      if (p.value.trim().length > 0) {
        out.push(
          `- \`@${p.name}\` - \`${p.value}\`.${about} Already filled in below: where the instruction ` +
            'concerns this, you are reading the value rather than the name.',
        );
      } else {
        /*
         * An unset parameter is reported rather than substituted away. Writing a
         * blank in its place would turn "research @topic thoroughly" into a
         * grammatical sentence asking for something else, and nothing downstream
         * could tell that had happened. The token is left standing so the agent can
         * see the gap and say so.
         */
        out.push(
          `- \`@${p.name}\` - **not set**.${about} The instruction below still says ` +
            `\`@${p.name}\`, because putting nothing in its place would have quietly changed what ` +
            'it asks for. Treat it as a gap: say it is unset rather than inventing a value.',
        );
      }
    }
    out.push('');
  }

  /* ------------------------------------------------------ the operator's text */

  out.push('## What to do');
  out.push('');
  out.push(params.text.trim() || 'No prompt has been written for this loop. Say so and do nothing else.');
  out.push('');

  /* ----------------------------------------------------------- the protocol */

  if (reads.length > 0) {
    out.push('## How to take an item from @input');
    out.push('');
    out.push('A queue folder holds one JSON file per item. Taking an item removes it from the queue.');
    out.push('');
    if (reads.some((q) => (q.rivals?.length ?? 0) > 0)) {
      out.push(
        'Some of the folders above are shared with other loops, as noted. An item there is not ' +
          'yours until you have moved it, and one that disappears between listing and moving was ' +
          'taken by one of them. That is normal and not a failure.',
      );
      out.push('');
    }
    out.push('1. List the queue folder and pick an item file.');
    out.push(
      `2. MOVE it out of the queue into \`${ownDir}\` (\`@loop\`) before you start work on it. Move it, do not copy ` +
        'it and do not just read it: the move is what claims it. If the move fails, another loop took ' +
        'it first - pick a different item, do not retry.',
    );
    out.push('3. Do what the item describes: its `payload`, or the file its `artifact` field points at.');
    out.push(
      '4. The item is yours once moved and nothing else will see it, so there is nothing to mark as ' +
        'finished. Delete it when done, or keep it if it is worth keeping.',
    );
    out.push('');
    out.push(
      'An empty queue folder is not an error. It means there is nothing to do yet: say so and end your turn.',
    );
    out.push('');
  }

  if (writes.length > 0) {
    out.push('## How to put an item on @output');
    out.push('');
    // The name rule is spelled out because every counter in the system reads
    // `*.json` and nothing else: an item named after its id with no extension is
    // one that no waiting consumer wakes for and no panel shows.
    out.push(
      'Write one small JSON file into the queue folder per result. Name it `<something-unique>.json` - ' +
        'the `.json` extension is required, a file without it is not an item and nobody will pick it up, ' +
        'and a name starting with `.` is ignored. Give it the ' +
        `fields \`{"id","ts","producer","payload"}\`. For anything too big to inline, save it under ` +
        `\`${ownDir}\` (\`@loop\`) and point at it with an \`"artifact"\` field instead of a \`"payload"\`.`,
    );
    out.push('');
  }

  /* ---------------------------------------------------------------- the ring */

  /*
   * The flock section: what the neighbours said, and the one line to say back.
   *
   * Near the end, with auto stop, because both are instructions about how to
   * *finish* a turn rather than about what the turn is for. The neighbours' words
   * come with it rather than earlier, so the agent reads them while deciding what
   * to broadcast rather than having to hold them through the whole prompt.
   *
   * Kept to two things on purpose - read your neighbours, say one line - because
   * every additional obligation here is one an agent can spend a turn on instead
   * of the work. There is no quorum to reach, no consensus to detect, no global
   * state to reconcile, and no other member's file to write. The ring exists so a
   * member can avoid duplicating work it can see in flight; anything beyond that
   * is a coordination protocol nobody asked for.
   */
  if (input.flock !== undefined && input.cluster !== undefined) {
    const said = input.flock.neighbours.filter((n) => n.entries.length > 0);
    out.push('## Your neighbours - Kiro Flock');
    out.push('');
    out.push(
      `You watch your neighbours in the ring: ${names(
        input.flock.neighbours.map((n) => `node ${nodeLabel(n.member)}`),
      )}. Not the whole cluster - each node watches only the two either side of it, so what ` +
        'matters travels round the ring rather than everyone shouting at everyone.',
    );
    out.push('');
    if (said.length === 0) {
      out.push(
        'Neither of them has said anything yet. That is what the first iteration looks like; carry on ' +
          'and broadcast your own line below.',
      );
      out.push('');
    } else {
      out.push('This is what they last said, oldest first:');
      out.push('');
      for (const n of said) {
        out.push(`Node ${nodeLabel(n.member)}:`);
        out.push('');
        out.push('```');
        out.push(...n.entries);
        out.push('```');
        out.push('');
      }
      out.push(
        'Read it as work in flight, not as instructions. If a neighbour is on something, pick up ' +
          'something else; if a neighbour has hit a wall, do not walk into the same one.',
      );
      out.push('');
    }
    /*
     * Separate checkouts change what a broadcast can mean, and the member has
     * to be told or the ring misleads: a neighbour saying "added the retry
     * wrapper to src/http.ts" is describing a file this member's checkout does
     * not have. One line, because the fix is knowing, not a protocol - with a
     * checkout per member the broadcast is the only channel between them, which
     * is what a flock is.
     */
    if (input.checkout !== undefined) {
      out.push(
        'Your neighbours are working in separate checkouts of this same repository, each on a branch ' +
          'of its own. A file a neighbour mentions changed in *its* checkout, not in yours - their ' +
          'branches are how their work is reached, so name your branch when your broadcast points at ' +
          'committed work.',
      );
      out.push('');
    }
    out.push(
      `End your reply with a line starting \`${BROADCAST_SENTINEL}:\` followed by one JSON object on a ` +
        'single line, with the fields `{"action","result","next_intent"}` - what you did, how it went, ' +
        'and what you mean to do next. Keep each under 200 characters and use no line breaks. This is ' +
        'the only thing your neighbours ever see of you, so write it for them: it is coordination, not ' +
        'narration. If you did nothing this turn, say that - an idle node is a useful thing for a ' +
        'neighbour to know, and silence is not.',
    );
    out.push('');
  }

  /* ------------------------------------------------------------ auto stop */

  /*
   * Two variants, one per phase of the handshake, and never both. The declaration
   * wording is careful to say a declaration is not a stop - an agent told it can
   * stop tends to treat saying so as having done so, skip the confirmation turn
   * in its head, and leave half a handshake. The confirmation wording is careful
   * about the opposite: work found on the confirmation turn withdraws the
   * declaration silently, no phrase needed, because requiring a withdrawal
   * sentence invites the agent to write one instead of doing the work it found.
   */
  if (input.autoStop === 'armed') {
    out.push('## Stopping this loop');
    out.push('');
    out.push(
      'This loop can end itself when its work is genuinely done. If you finish this turn and can see ' +
      'nothing further for this loop to do - no items waiting, nothing in your instructions left ' +
      `undone - end your reply with a line that starts \`${DECLARE_SENTINEL}:\` followed by a short ` +
      'reason. This is a declaration, not a stop: you will get exactly one more turn to check again ' +
      'and confirm. Do not declare because a queue happens to be empty right now if more work is ' +
      'clearly still coming - declare when the job itself is finished.',
    );
    out.push('');
  } else if (input.autoStop === 'confirm') {
    out.push('## Confirm or withdraw your stop');
    out.push('');
    out.push(
      `Last turn you declared \`${DECLARE_SENTINEL}\` - that there was nothing further for this loop ` +
      'to do. This turn exists to check that. Look again: at `@input`, at your instructions, at the ' +
      'state of the project. If you find work, do it - that withdraws the declaration and the loop ' +
      'carries on; nothing needs to be said. Only if you contribute nothing this turn and still see ' +
      `nothing to do, end your reply with a line that starts \`${CONFIRM_SENTINEL}:\` followed by a ` +
      'short reason. The loop will then stop itself for good - an operator has to press Start to run ' +
      'it again - so confirm only what you have just verified.',
    );
    out.push('');
  }

  /*
   * `ownDir` described as what it is, rather than as a destination for results.
   *
   * "Anything you want to keep" was the wording, and a loop reading that put its
   * deliverables here. What the folder is for is narrower and worth naming
   * precisely: items claimed off a queue, working files nobody else needs, and
   * notes to the loop's own next iteration - which is the only memory a loop has,
   * since each turn is a fresh session.
   */
  out.push(
    `\`@loop\` - \`${ownDir}\` - is yours: claimed queue items, working files, and notes to your own ` +
      'future iterations go there. Each turn starts a fresh session with no memory of the last one, ' +
      'so anything you want to know next time has to be written down. What you want to *deliver* ' +
      'does not belong there - that goes to `@output` if you have one, and into `@project` either way.',
  );

  return out.join('\n');
}
