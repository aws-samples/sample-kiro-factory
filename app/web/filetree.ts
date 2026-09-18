/**
 * A flat list of file paths, made into a tree.
 *
 * Ported from the flock dashboard's environment panel, which does the same job
 * against S3 keys instead of a folder walk. The shape of the problem is identical:
 * the server has no idea which folders are open, so it sends a flat list and the
 * nesting is worked out here, fresh, every time the list changes.
 *
 * That rebuild is why expansion state lives outside the tree, as a set of folder
 * paths rather than a flag on a node. A node from the previous build is gone the
 * moment new files arrive; a path string survives, so a folder you opened stays
 * open across a poll that added a file three levels down.
 *
 * Everything here is pure, which is the other half of the port: these functions
 * came across from vanilla JS unchanged, and the React in LoopFiles.tsx is only
 * the rendering.
 */
import type { LoopFileEntry } from './api.ts';

export interface FileNode {
  kind: 'file';
  name: string;
  /** Path relative to the loop's folder. The id a viewer asks for. */
  path: string;
  size: number;
  /** Milliseconds, for sorting. 0 when the server had no timestamp. */
  time: number;
  mtime: string;
}

export interface FolderNode {
  kind: 'folder';
  name: string;
  /**
   * Path relative to the loop's folder, with a trailing slash.
   *
   * The slash is what keeps a folder's key from colliding with a file of the same
   * name beside it, which is the one way a set of open paths could go wrong.
   */
  path: string;
  children: Node[];
  /** Every descendant file's size, summed. */
  size: number;
  /** The newest write anywhere inside. */
  time: number;
  mtime: string;
}

export type Node = FileNode | FolderNode;

export type SortMode = 'name' | 'modified' | 'size';

/**
 * Build the tree.
 *
 * Folders are inferred from the paths themselves - the server sends files and
 * nothing else, so a folder exists here exactly when something is in it. An empty
 * directory on disk is therefore invisible, which is the right answer for a panel
 * whose question is "what has this loop written".
 */
export function buildTree(files: LoopFileEntry[]): FolderNode {
  const root = folder('', '');
  // Folder nodes by path, so a second file in a folder finds the node the first
  // one created rather than walking the children array looking for it.
  const index = new Map<string, FolderNode>([['', root]]);

  for (const entry of files) {
    const parts = entry.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const name = parts[parts.length - 1]!;

    let parent = root;
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix += `${part}/`;
      let next = index.get(prefix);
      if (!next) {
        next = folder(part, prefix);
        index.set(prefix, next);
        parent.children.push(next);
      }
      parent = next;
    }

    const time = entry.mtime.length > 0 ? Date.parse(entry.mtime) : 0;
    parent.children.push({
      kind: 'file',
      name,
      path: entry.path,
      size: entry.size,
      time: Number.isNaN(time) ? 0 : time,
      mtime: entry.mtime,
    });
  }

  aggregate(root);
  return root;
}

function folder(name: string, path: string): FolderNode {
  return { kind: 'folder', name, path, children: [], size: 0, time: 0, mtime: '' };
}

/**
 * Give every folder its descendants' total size and its newest write.
 *
 * One pass over the tree, so it is cheap enough to redo on every poll. Worth
 * having because the two numbers are the only way a collapsed folder says anything
 * at all: a row reading `4.2K · 14:03` is a folder you can tell is being written
 * to without opening it.
 */
function aggregate(node: FolderNode): void {
  let size = 0;
  let time = 0;
  let mtime = '';
  for (const child of node.children) {
    if (child.kind === 'folder') aggregate(child);
    size += child.size;
    if (child.time > time) {
      time = child.time;
      mtime = child.mtime;
    }
  }
  node.size = size;
  node.time = time;
  node.mtime = mtime;
}

/**
 * Sort one folder's children: folders first, then by the chosen mode.
 *
 * Folders before files regardless of mode, because that is what every file manager
 * does and the alternative is a folder buried among the files by its aggregate
 * size. Name is always the tiebreak, so the order is stable rather than however
 * the walk happened to return things.
 */
export function sortNodes(nodes: Node[], mode: SortMode): Node[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (mode === 'modified' && b.time !== a.time) return b.time - a.time;
    if (mode === 'size' && b.size !== a.size) return b.size - a.size;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/* ------------------------------------------------------------- what a file is */

/**
 * Extension to highlight.js language.
 *
 * A lookup rather than highlight.js's own auto-detection, which guesses from
 * content and gets short files wrong - a three-line JSON fragment is equally good
 * Python. The file name is the better evidence and it is free.
 *
 * Every language here is in the `common` bundle that LoopFiles.tsx imports, which
 * is the constraint on the list: naming one that is not registered would highlight
 * nothing and fall back to plain text.
 */
const LANGS: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.svg': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.php': 'php',
  '.pl': 'perl',
  '.diff': 'diff',
  '.patch': 'diff',
};

/** The language to highlight a file as, or null to show it as plain text. */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  // The two file names that are a type without having an extension.
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return LANGS[lower.slice(dot)] ?? null;
}

/**
 * Is this markdown?
 *
 * Case-insensitive, unlike the flock original - which tested `.md` against the raw
 * key and so showed `NOTES.MD` as plain text. Loops name their own files and
 * nothing stops one shouting.
 */
export function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/* -------------------------------------------------------------------- display */

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * A timestamp, as short as it can be and still unambiguous.
 *
 * Time alone for today, which is the common case and the one where the date is
 * noise. A date once it is not today, because `14:03` on a row written last week
 * reads as fresh and is the one thing this column must not do.
 */
export function fmtWhen(ms: number): string {
  if (ms <= 0) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}
