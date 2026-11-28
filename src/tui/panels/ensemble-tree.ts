/**
 * The collapsible tree behind the Tools and Skills lists of /ensemble. Pure: items carry a folder path, the folders are derived, and what is
 * open lives in one flat record of overrides (`EnsembleState.tree`) next to the page state, so a tree keeps its shape across detail pages.
 */
export interface TreeItem {readonly path: readonly string[]; readonly name: string}
export interface TreeOptions {
  /** Prefix that keeps the folder keys of different actors and lists apart in one record. */
  readonly scope: string;
  /** Whether a folder at this depth (0 = a root) is open until the person toggles it. */
  readonly defaultOpen: (depth: number) => boolean;
  /** Root folders in this order first, then the rest by name. */
  readonly rootOrder?: readonly string[];
  /** A folder with this name always comes last among its siblings and does not count toward its ancestors. */
  readonly trailing?: string;
  /** Display text of a folder. */
  readonly label?: (name: string) => string;
}
export type Overrides = Readonly<Record<string, boolean>>;
export type TreeRow<T extends TreeItem> =
  | {readonly kind: 'folder'; readonly key: string; readonly path: readonly string[]; readonly name: string; readonly label: string; readonly depth: number; readonly count: number; readonly open: boolean}
  | {readonly kind: 'leaf'; readonly key: string; readonly path: readonly string[]; readonly name: string; readonly depth: number; readonly item: T};

export const folderKey = (scope: string, path: readonly string[]): string => scope + '|' + path.join('/');
export const leafKey = (scope: string, path: readonly string[], name: string): string => scope + '|' + path.join('/') + '#' + name;

interface Node<T extends TreeItem> {readonly name: string; readonly leaves: T[]; readonly folders: Map<string, Node<T>>}
const node = <T extends TreeItem>(name: string): Node<T> => ({name, leaves: [], folders: new Map()});

/** The visible rows: leaves first, then sub-folders, descending only into open folders. */
export function buildTree<T extends TreeItem>(items: readonly T[], overrides: Overrides, options: TreeOptions): TreeRow<T>[] {
  const root = node<T>('');
  for (const item of items) {
    let at = root;
    for (const segment of item.path) {
      let next = at.folders.get(segment);
      if (!next) {next = node<T>(segment); at.folders.set(segment, next);}
      at = next;
    }
    at.leaves.push(item);
  }
  const count = (from: Node<T>): number => from.leaves.length + [...from.folders.values()].filter(child => child.name !== options.trailing).reduce((sum, child) => sum + count(child), 0);
  const total = (from: Node<T>): number => from.leaves.length + [...from.folders.values()].reduce((sum, child) => sum + total(child), 0);
  const rows: TreeRow<T>[] = [];
  const walk = (from: Node<T>, path: readonly string[], depth: number) => {
    for (const item of [...from.leaves].sort((a, b) => a.name.localeCompare(b.name))) rows.push({kind: 'leaf', key: leafKey(options.scope, path, item.name), path, name: item.name, depth, item});
    const rank = (name: string) => name === options.trailing ? 2 : depth === 0 && options.rootOrder?.includes(name) ? 0 : 1;
    const order = (name: string) => depth === 0 && options.rootOrder ? options.rootOrder.indexOf(name) : 0;
    const folders = [...from.folders.values()].sort((a, b) => rank(a.name) - rank(b.name) || order(a.name) - order(b.name) || a.name.localeCompare(b.name));
    for (const child of folders) {
      const childPath = [...path, child.name], key = folderKey(options.scope, childPath);
      const open = overrides[key] ?? options.defaultOpen(depth);
      // A trailing folder (Archived) counts its own contents; every other folder leaves the trailing one out.
      rows.push({kind: 'folder', key, path: childPath, name: child.name, label: options.label?.(child.name) ?? child.name, depth,
        count: child.name === options.trailing ? total(child) : count(child), open});
      if (open) walk(child, childPath, depth + 1);
    }
  };
  walk(root, [], 0);
  return rows;
}

/** Index of the row a leaf lives on, or -1 while it is hidden. */
export const leafIndex = <T extends TreeItem>(rows: readonly TreeRow<T>[], path: readonly string[], name: string): number =>
  rows.findIndex(row => row.kind === 'leaf' && row.name === name && row.path.join('/') === path.join('/'));
export const folderIndex = <T extends TreeItem>(rows: readonly TreeRow<T>[], path: readonly string[]): number =>
  rows.findIndex(row => row.kind === 'folder' && row.path.join('/') === path.join('/'));
/** Index of the folder a row sits in, or -1 for a row at the root. */
export function parentIndex<T extends TreeItem>(rows: readonly TreeRow<T>[], index: number): number {
  const row = rows[index];
  if (!row || row.depth === 0) return -1;
  for (let at = index - 1; at >= 0; at--) if (rows[at]!.kind === 'folder' && rows[at]!.depth === row.depth - 1) return at;
  return -1;
}
/** Overrides with every folder along `path` open, so the leaf below is visible. */
export function revealed(overrides: Overrides, scope: string, path: readonly string[]): Overrides {
  const next: Record<string, boolean> = {...overrides};
  for (let length = 1; length <= path.length; length++) next[folderKey(scope, path.slice(0, length))] = true;
  return next;
}
export const withOpen = (overrides: Overrides, key: string, open: boolean): Overrides => ({...overrides, [key]: open});

/** The changed overrides after Space (see `foldStep`) and the row the selection lands on. */
export type Fold = {readonly overrides: Overrides; readonly selected: number} | undefined;
/** Space toggles the selected folder; on a leaf it closes the folder holding it and selects that folder. */
export function foldStep<T extends TreeItem>(rows: readonly TreeRow<T>[], index: number, overrides: Overrides): Fold {
  const row = rows[index];
  if (!row) return undefined;
  if (row.kind === 'folder') return {overrides: withOpen(overrides, row.key, !row.open), selected: index};
  const parent = parentIndex(rows, index), folder = rows[parent];
  return folder && folder.kind === 'folder' ? {overrides: withOpen(overrides, folder.key, false), selected: parent} : undefined;
}
