import {patternsOverlap} from '../../ownership.js';
import {missingAcceptanceNote, missingOwnsNote, overlapNote} from './prompt.js';
import type {TaskSpec} from './ActorTool.js';

type NoteTask = Pick<TaskSpec, 'ownerId' | 'owns' | 'acceptance' | 'after' | 'resumeTask'>;

/**
 * Advisory notes for a dispatch that already succeeded; nothing here rejects. Computed over the new (non-resume) tasks of one call, grouped per owner:
 * parallel owners that share a path, an owner without `owns` beside other owners, and an owner with `owns` but no `acceptance`.
 */
export function dispatchNotes(tasks: readonly NoteTask[], cwd: string): string[] {
  const owners = new Map<string, {owns: Set<string>; acceptance: number; after: Set<string>}>();
  for (const task of tasks) {
    if (task.resumeTask) continue;
    const entry = owners.get(task.ownerId) ?? {owns: new Set<string>(), acceptance: 0, after: new Set<string>()};
    for (const path of task.owns ?? []) entry.owns.add(path);
    entry.acceptance += task.acceptance?.length ?? 0;
    for (const ref of task.after ?? []) entry.after.add(ref);
    owners.set(task.ownerId, entry);
  }
  const ids = [...owners.keys()], notes: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      if (owners.get(a)!.after.has(b) || owners.get(b)!.after.has(a)) continue;
      const shared = [...owners.get(a)!.owns].flatMap(left => [...owners.get(b)!.owns].filter(right => patternsOverlap(left, right, cwd)).map(() => left))[0];
      if (shared) notes.push(overlapNote(a, b, shared));
    }
  }
  if (ids.length >= 2) for (const id of ids) if (!owners.get(id)!.owns.size) notes.push(missingOwnsNote(id));
  for (const id of ids) {const entry = owners.get(id)!; if (entry.owns.size && !entry.acceptance) notes.push(missingAcceptanceNote(id));}
  return notes;
}
