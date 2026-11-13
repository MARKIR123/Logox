import {isDirector} from '../runtime/director-id.js';
import {inputKind} from '../runtime/provenance.js';
import type {TaskCheckpoint} from '../store/journal.js';
import type {RoundStatus} from '../context/contracts.js';
import type {TaskOrigin} from './ensemble.js';

/** A checkpoint a restart cut short (a hard exit leaves `interrupted`, a graceful quit `shutdown`); never a user stop. */
export const restartStopped = (task: Pick<TaskCheckpoint, 'status' | 'stopReason'>): boolean =>
  task.status === 'cancelled' && (task.stopReason === 'interrupted' || task.stopReason === 'shutdown');
export interface RestartPlan {
  /** Director dispatches that never started: restored as a paused batch. */
  restore: TaskCheckpoint[];
  /** Human requests that never started: cancelled, and their text comes back as held input. */
  held: TaskCheckpoint[];
  /** Everything else that was in flight (including `held`): cancelled as interrupted. */
  cancel: TaskCheckpoint[];
}
/** Splits the checkpoints that were still live when the previous process ended. */
export function planRestart(tasks: readonly TaskCheckpoint[], isActor: (ownerId: string) => boolean): RestartPlan {
  const plan: RestartPlan = {restore: [], held: [], cancel: []};
  for (const task of tasks) {
    if (!['queued', 'running', 'waiting_input', 'paused'].includes(task.status)) continue;
    const kind = inputKind(task), waiting = task.status === 'queued' || task.status === 'paused';
    if (kind === 'director' && waiting && task.batchId && !isDirector(task.ownerId) && isActor(task.ownerId)) plan.restore.push(task);
    else {
      if (kind === 'human' && task.status === 'queued') plan.held.push(task);
      plan.cancel.push(task);
    }
  }
  return plan;
}
export interface RestartDependencies {
  /** Unfinished blockers a restart interrupted (activity id to owner): restored tasks wait for them until the Director resumes them. */
  interrupted: Map<string, string>;
  /** Blockers that ended badly before the restart: their dependents are cancelled when released, as they would have been live. */
  ended: Map<string, {ownerId: string; status: RoundStatus; title: string; text: string}>;
}
/** Classifies what the restored tasks wait for; `all` holds the checkpoints after the interrupted ones were rewritten. */
export function restartDependencies(restore: readonly TaskCheckpoint[], all: readonly TaskCheckpoint[]): RestartDependencies {
  const byId = new Map(all.map(task => [task.activityId, task])), result: RestartDependencies = {interrupted: new Map(), ended: new Map()};
  for (const id of restore.flatMap(task => task.after ?? [])) {
    const dependency = byId.get(id);
    if (!dependency) continue;
    if (restartStopped(dependency)) result.interrupted.set(id, dependency.ownerId);
    else if (dependency.status === 'failed' || dependency.status === 'cancelled') {
      result.ended.set(id, {ownerId: dependency.ownerId, status: dependency.status, title: dependency.taskTitle ?? '', text: dependency.error ?? ''});
    }
  }
  return result;
}
/** The dispatch origin a checkpoint was written with (everything except its identity, prompt and outcome). */
export function checkpointOrigin(task: TaskCheckpoint): TaskOrigin {
  const {activityId: _id, ownerId: _owner, prompt: _prompt, source: _source, status: _status, time: _time, progress: _progress, handoff: _handoff, error: _error, stopReason: _stop, ...origin} = task;
  return origin;
}
