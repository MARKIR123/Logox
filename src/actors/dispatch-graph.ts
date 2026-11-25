/**
 * The task graph of one `Actor` call. Every task is its own activity (one actor may have several tasks in a call, in waves), and `after`
 * names tasks, never actors: a task `id` of the same call (or `#n`, its 1-based position) or the activity id of an earlier task. Everything
 * is checked here, before anything is enqueued, so a refused call starts nothing.
 */

export interface GraphTask {
  readonly id?: string | undefined;
  readonly ownerId: string;
  readonly after?: readonly string[] | undefined;
}

/** What an `after` reference outside the call resolves to. */
export type ExternalRef = 'open' | 'ended' | undefined;

export interface DispatchGraph<T extends GraphTask> {
  /** Tasks in an order where every task comes after the tasks of the call it waits for (otherwise as listed). */
  readonly ordered: readonly {readonly key: string; readonly task: T; readonly inCall: readonly string[]; readonly external: readonly string[]}[];
  /** The keys of every task of the call `key` waits for, directly or through other tasks. */
  ancestors(key: string): ReadonlySet<string>;
  /** Whether two tasks of the call are ordered (one waits for the other, directly or not). */
  related(a: string, b: string): boolean;
}

/** A task's key in its call: its `id`, else `#<position>`. */
export const taskKey = (task: GraphTask, index: number): string => task.id ?? '#' + (index + 1);

/**
 * Builds and checks the graph. `external` says whether a reference is an activity id (still open, or ended: then it is already satisfied);
 * `isActor` recognises actor ids, which `after` no longer accepts.
 */
export function dispatchGraph<T extends GraphTask>(tasks: readonly T[], external: (ref: string) => ExternalRef, isActor: (ref: string) => boolean): DispatchGraph<T> {
  const keys = tasks.map(taskKey);
  const byKey = new Map<string, number>();
  for (const [index, task] of tasks.entries()) {
    const key = keys[index]!;
    if (task.id !== undefined && isActor(task.id)) throw new Error(`Task id "${task.id}" is an actor id; choose another id.`);
    if (byKey.has(key)) throw new Error(`Two tasks use the id "${key}"; give each task its own id.`);
    byKey.set(key, index);
    // `#n` always names the n-th task, also when that task has its own id.
    if (task.id !== undefined) byKey.set('#' + (index + 1), index);
  }
  const edges = tasks.map((task, index) => {
    const inCall: string[] = [], outside: string[] = [];
    for (const ref of task.after ?? []) {
      const target = byKey.get(ref);
      if (target === index) throw new Error('A task cannot run after itself: ' + ref);
      if (target !== undefined) {if (!inCall.includes(keys[target]!)) inCall.push(keys[target]!); continue;}
      const state = external(ref);
      if (state === 'open') {if (!outside.includes(ref)) outside.push(ref); continue;}
      if (state === 'ended') continue;
      if (isActor(ref)) throw new Error(`\`after\` takes task ids, not actor names: "${ref}". Give the task to wait for an \`id\` and name that id, or use the activity id from an earlier receipt.`);
      throw new Error('Unknown `after` reference (not a task id of this call or an activity id): ' + ref);
    }
    return {inCall, outside};
  });
  const ordered: {key: string; task: T; inCall: string[]; external: string[]}[] = [];
  const visiting = new Set<number>(), done = new Set<number>();
  const visit = (index: number) => {
    if (done.has(index)) return;
    if (visiting.has(index)) throw new Error('Circular `after` dependency involving ' + keys[index]);
    visiting.add(index);
    for (const key of edges[index]!.inCall) visit(byKey.get(key)!);
    visiting.delete(index); done.add(index);
    ordered.push({key: keys[index]!, task: tasks[index]!, inCall: edges[index]!.inCall, external: edges[index]!.outside});
  };
  for (const index of tasks.keys()) visit(index);
  const memo = new Map<string, Set<string>>();
  const ancestors = (key: string): Set<string> => {
    const known = memo.get(key);
    if (known) return known;
    const found = new Set<string>();
    for (const parent of edges[byKey.get(key)!]!.inCall) {found.add(parent); for (const above of ancestors(parent)) found.add(above);}
    memo.set(key, found);
    return found;
  };
  return {ordered, ancestors, related: (a, b) => ancestors(a).has(b) || ancestors(b).has(a)};
}
