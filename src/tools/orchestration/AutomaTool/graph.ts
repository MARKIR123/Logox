/**
 * The order of one Automa dispatch: what each job's `after` names, checked as a whole. Pure: it reads titles, ids and the shelf's worker ids,
 * and either returns the graph (indices of the jobs in the call, ids of shelved workers) or the one refusal with its exact fix.
 */
import {refKey} from './names.js';

export interface GraphJob {
  readonly id: string;
  readonly title: string;
  /** The job's optional name (`scout`); `after` may name it, case-insensitively. */
  readonly name?: string | undefined;
  readonly after?: readonly string[] | undefined;
}

export interface GraphShelf {
  /** Ids of this dispatcher's finished workers of the current task. */
  readonly live: ReadonlySet<string>;
  /** Lower-case name (or id) to the id of a finished worker of this dispatcher, for an `after` entry that names one by its name. */
  readonly aliases?: ReadonlyMap<string, string> | undefined;
  /** Ids of workers that belong to someone else, with their owner. */
  readonly foreign?: ReadonlyMap<string, string> | undefined;
}

export interface JobGraph {
  /** Per job: the jobs of this call it follows. */
  readonly needs: readonly (readonly number[])[];
  /** Per job: shelved workers it follows (their result is already known). */
  readonly workers: readonly (readonly string[])[];
  /** True when a path of `after` joins the two jobs in either direction, so they can never run at the same time. */
  ordered(a: number, b: number): boolean;
}

const display = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Resolves every `after` entry of the call; refuses an unknown reference, another dispatcher's worker, an ambiguous title and a cycle. */
export function resolveAfter(jobs: readonly GraphJob[], shelf: GraphShelf): {ok: true; graph: JobGraph} | {ok: false; error: string} {
  const names = jobs.map(job => job.id);
  const byId = new Map(names.map((id, index) => [id, index] as const));
  const byName = new Map(jobs.flatMap((job, index) => job.name ? [[refKey(job.name), index] as const] : []));
  const needs: number[][] = jobs.map(() => []);
  const workers: string[][] = jobs.map(() => []);
  const label = (index: number) => `"${jobs[index]!.title}"`;
  const known = () => `this call has ${names.map((id, index) => `${id} (#${index + 1})`).join(', ')}${shelf.live.size ? `; your finished workers are ${[...shelf.live].join(', ')}` : ''}`;
  for (const [index, job] of jobs.entries()) {
    for (const raw of job.after ?? []) {
      const entry = raw.trim();
      let target: number | undefined;
      const position = /^#(\d+)$/.exec(entry);
      if (position) {
        target = Number(position[1]) - 1;
        if (target < 0 || target >= jobs.length) return {ok: false, error: `Job ${label(index)} lists after "${entry}", but ${known()}. Fix: use "#1" to "#${jobs.length}", an id, or the exact title of another job of this call.`};
      } else if (byId.has(entry)) target = byId.get(entry)!;
      else if (byName.has(refKey(entry))) target = byName.get(refKey(entry))!;
      else {
        const titled = jobs.flatMap((other, at) => other.title === entry ? [at] : []);
        if (titled.length > 1) return {ok: false, error: `Job ${label(index)} lists after "${entry}", which is the title of ${titled.length} jobs (${titled.map(at => names[at]).join(', ')}). Fix: name the one you mean by its id or "#n".`};
        if (titled.length === 1) target = titled[0]!;
      }
      if (target === undefined) {
        const worker = shelf.live.has(entry) ? entry : shelf.aliases?.get(refKey(entry));
        if (worker && shelf.live.has(worker)) {if (!workers[index]!.includes(worker)) workers[index]!.push(worker); continue;}
        const owner = shelf.foreign?.get(entry) ?? shelf.foreign?.get(shelf.aliases?.get(refKey(entry)) ?? '');
        if (owner) return {ok: false, error: `Job ${label(index)} lists after "${entry}", which is a worker of ${display(owner)}, not yours. Fix: follow only jobs of this call or your own finished workers; ask ${display(owner)} for what you need instead.`};
        return {ok: false, error: `Job ${label(index)} lists after "${entry}", which is not a job of this call or a live worker of yours; ${known()}. Fix: name a job by its id, "#n" or exact title, or a finished worker by the id its result gave, or remove the entry.`};
      }
      if (!needs[index]!.includes(target)) needs[index]!.push(target);
    }
  }
  // A cycle names its jobs in order, closing on the first.
  const state = new Array<0 | 1 | 2>(jobs.length).fill(0);
  const path: number[] = [];
  const visit = (index: number): number[] | undefined => {
    state[index] = 1; path.push(index);
    for (const next of needs[index]!) {
      if (state[next] === 1) return [...path.slice(path.indexOf(next)), next];
      if (state[next] === 0) {const found = visit(next); if (found) return found;}
    }
    state[index] = 2; path.pop();
    return undefined;
  };
  for (let index = 0; index < jobs.length; index++) {
    if (state[index] !== 0) continue;
    const cycle = visit(index);
    if (cycle) return {ok: false, error: `The jobs of this call wait on each other: ${cycle.map(at => names[at]).join(' → ')}. Fix: remove one \`after\` entry in that cycle so the order has a first job.`};
  }
  // Reachability both ways: two jobs are ordered when one is a (transitive) prerequisite of the other.
  const before = jobs.map(() => new Set<number>());
  const reach = (index: number): Set<number> => {
    if (before[index]!.size || !needs[index]!.length) return before[index]!;
    for (const need of needs[index]!) {before[index]!.add(need); for (const further of reach(need)) before[index]!.add(further);}
    return before[index]!;
  };
  for (let index = 0; index < jobs.length; index++) reach(index);
  return {ok: true, graph: {needs, workers, ordered: (a, b) => before[a]!.has(b) || before[b]!.has(a)}};
}
