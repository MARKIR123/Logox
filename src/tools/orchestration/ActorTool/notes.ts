import {patternHolder, patternsOverlap} from '../../ownership.js';
import {liveOwnsNote, missingAcceptanceNote, missingOwnsNote} from './prompt.js';
import type {TaskSpec} from './ActorTool.js';
import type {Activity} from '../../../runtime/contracts.js';
import {dispatchGraph, taskKey, type DispatchGraph} from '../../../actors/dispatch-graph.js';

type NoteTask = Pick<TaskSpec, 'ownerId' | 'owns' | 'acceptance' | 'after' | 'resumeTask'> & {readonly id?: string | undefined; readonly title?: string | undefined};

/** How a task is named in a note: its owner, with its id or position when the owner has more than one task in the call. */
function labels(tasks: readonly NoteTask[]): string[] {
  return tasks.map((task, index) => {
    const several = tasks.filter(other => other.ownerId === task.ownerId).length > 1;
    return task.id ? `${task.ownerId} (${task.id})` : several ? `${task.ownerId} (${taskKey(task, index)})` : task.ownerId;
  });
}

/**
 * The deterministic gate of a dispatch, run before any brief check and never skipped: pairs of new tasks of different owners that may run at the
 * same time (neither waits for the other, directly or through other tasks of the call: `graph`) and both own a path that could name the same file.
 * Tasks of one owner never run at the same time. Any pair refuses the whole call.
 */
export function ownsConflicts(tasks: readonly NoteTask[], cwd: string, graph: Pick<DispatchGraph<NoteTask>, 'related'> = dispatchGraph(tasks, () => 'ended', () => false)): {a: string; b: string; path: string}[] {
  const names = labels(tasks), conflicts: {a: string; b: string; path: string}[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [x, y] = [tasks[i]!, tasks[j]!];
      if (x.resumeTask || y.resumeTask || x.ownerId === y.ownerId || graph.related(taskKey(x, i), taskKey(y, j))) continue;
      const path = (x.owns ?? []).find(left => (y.owns ?? []).some(right => patternsOverlap(left, right, cwd)));
      if (path) conflicts.push({a: names[i]!, b: names[j]!, path});
    }
  }
  return conflicts;
}

/** A new task that owns what another actor's active task already owns, unless it runs after that task. */
export function liveOwnsNotes(tasks: readonly NoteTask[], activities: readonly Activity[], cwd: string): string[] {
  const names = labels(tasks), notes: string[] = [];
  for (const [index, task] of tasks.entries()) {
    if (task.resumeTask) continue;
    for (const path of task.owns ?? []) {
      const holder = patternHolder(activities.filter(activity => !task.after?.includes(activity.activityId)), task.ownerId, path, cwd);
      if (holder) notes.push(liveOwnsNote(names[index]!, path, holder.ownerId, holder.taskTitle ?? holder.title, holder.activityId));
    }
  }
  return notes;
}

/**
 * Advisory notes for a dispatch that already succeeded; nothing here rejects (owns conflicts are refused before, by `ownsConflicts`).
 * Per new task: no `owns` while other actors have tasks in the call, and `owns` without `acceptance`.
 */
export function dispatchNotes(tasks: readonly NoteTask[], _cwd: string): string[] {
  const names = labels(tasks), notes: string[] = [];
  const fresh = tasks.map((task, index) => ({task, name: names[index]!})).filter(({task}) => !task.resumeTask);
  const owners = new Set(fresh.map(({task}) => task.ownerId));
  if (owners.size >= 2) for (const {task, name} of fresh) if (!task.owns?.length) notes.push(missingOwnsNote(name));
  for (const {task, name} of fresh) if (task.owns?.length && !task.acceptance?.length) notes.push(missingAcceptanceNote(name));
  return notes;
}
