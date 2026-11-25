import {patternHolder, patternsOverlap} from '../../ownership.js';
import {liveOwnsNote, missingAcceptanceNote, missingOwnsNote} from './prompt.js';
import type {TaskSpec} from './ActorTool.js';
import type {Activity} from '../../../runtime/contracts.js';

type NoteTask = Pick<TaskSpec, 'ownerId' | 'owns' | 'acceptance' | 'after' | 'resumeTask'>;

/** The new tasks of one call per owner: what they own and which owners of the same call they run after. */
function owners(tasks: readonly NoteTask[]): Map<string, {owns: Set<string>; acceptance: number; after: Set<string>}> {
  const grouped = new Map<string, {owns: Set<string>; acceptance: number; after: Set<string>}>();
  for (const task of tasks) {
    if (task.resumeTask) continue;
    const entry = grouped.get(task.ownerId) ?? {owns: new Set<string>(), acceptance: 0, after: new Set<string>()};
    for (const path of task.owns ?? []) entry.owns.add(path);
    entry.acceptance += task.acceptance?.length ?? 0;
    for (const ref of task.after ?? []) entry.after.add(ref);
    grouped.set(task.ownerId, entry);
  }
  return grouped;
}

/**
 * The deterministic gate of a dispatch, run before any brief check and never skipped: pairs of owners of one call that may run at the same
 * time (neither reaches the other through `after`, directly or through other owners of the call) and both own a path that could name the
 * same file. Any pair refuses the whole call.
 */
export function ownsConflicts(tasks: readonly NoteTask[], cwd: string): {a: string; b: string; path: string}[] {
  const grouped = owners(tasks);
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return [...grouped.get(from)?.after ?? []].some(ref => ref === to || grouped.has(ref) && reaches(ref, to, seen));
  };
  const ids = [...grouped.keys()], conflicts: {a: string; b: string; path: string}[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      if (reaches(a, b) || reaches(b, a)) continue;
      const path = [...grouped.get(a)!.owns].find(left => [...grouped.get(b)!.owns].some(right => patternsOverlap(left, right, cwd)));
      if (path) conflicts.push({a, b, path});
    }
  }
  return conflicts;
}

/** A new task that owns what another actor's active task already owns, unless it runs after that task (by activity id or owner). */
export function liveOwnsNotes(tasks: readonly NoteTask[], activities: readonly Activity[], cwd: string): string[] {
  const notes: string[] = [];
  for (const task of tasks) {
    if (task.resumeTask) continue;
    for (const path of task.owns ?? []) {
      const holder = patternHolder(activities.filter(activity => !task.after?.includes(activity.activityId) && !task.after?.includes(activity.ownerId)), task.ownerId, path, cwd);
      if (holder) notes.push(liveOwnsNote(task.ownerId, path, holder.ownerId, holder.taskTitle ?? holder.title, holder.activityId));
    }
  }
  return notes;
}

/**
 * Advisory notes for a dispatch that already succeeded; nothing here rejects (owns conflicts within the call are refused before, by `ownsConflicts`).
 * Computed over the new (non-resume) tasks of one call, grouped per owner: an owner without `owns` beside other owners, and an owner with `owns` but no `acceptance`.
 */
export function dispatchNotes(tasks: readonly NoteTask[], _cwd: string): string[] {
  const grouped = owners(tasks), ids = [...grouped.keys()], notes: string[] = [];
  if (ids.length >= 2) for (const id of ids) if (!grouped.get(id)!.owns.size) notes.push(missingOwnsNote(id));
  for (const id of ids) {const entry = grouped.get(id)!; if (entry.owns.size && !entry.acceptance) notes.push(missingAcceptanceNote(id));}
  return notes;
}
