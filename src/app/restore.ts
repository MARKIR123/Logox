/**
 * Session restore at startup, in two steps that the application container runs at different points of its wiring.
 * `recoverCheckpoints` loads the saved task checkpoints, recovers actor services and per-task model records, and restores
 * persisted usage. `replaySession` then replays the raw ledgers into the runtime store (nothing re-executes: open steps
 * are closed as interrupted), applies the restart plan (paused Director batches, held human messages, interrupted work),
 * and keeps the held-message list saved from then on. It owns the held-message save chain.
 */
import {steeredText} from '../prompts/runtime/interruption.js';
import {TEXT_TOOL_CALL_NOTE} from '../prompts/runtime/recovery.js';
import type {DynamicEnsemble} from '../actors/ensemble.js';
import type {ActorCatalog} from '../actors/catalog.js';
import {planRestart, restartDependencies, restartStopped} from '../actors/restart.js';
import type {ActorServices} from '../actors/services.js';
import type {TaskModelLedger, TaskModels} from '../actors/task-models.js';
import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import {settleStep} from '../runtime/contracts.js';
import {inputKind} from '../runtime/provenance.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {Journal} from '../store/journal.js';
import type {Notice} from './state.js';

export interface RecoverDeps {
  session: string; journal: Journal; actors: ActorCatalog; actorServices: ActorServices;
  taskModels: TaskModels; taskModelLedger: TaskModelLedger; configureMeter(ownerId: string): Promise<void>;
}
export interface RecoveredSession {
  /** Every active task checkpoint of the session ledger, before the restart plan changes them. */
  checkpoints: Awaited<ReturnType<Journal['activeTasks']>>;
  /** Actors of the catalog plus every owner a checkpoint names. */
  owners: string[];
  savedModels: Awaited<ReturnType<TaskModelLedger['load']>>;
}

export async function recoverCheckpoints(deps: RecoverDeps): Promise<RecoveredSession> {
  const {session, journal, actors, actorServices, taskModels, taskModelLedger, configureMeter} = deps;
  const checkpoints = await journal.activeTasks(session);
  await actorServices.recover(new Set(checkpoints.map(task => task.activityId)));
  const owners = [...new Set([...actors.list().map(actor => actor.id), ...checkpoints.map(task => task.ownerId)])];
  const savedModels = (await taskModelLedger.load(session, new Set(checkpoints.map(task => task.activityId))))
    .map(model => ['started', 'confirming', 'ready'].includes(model.phase) ? {...model, phase: 'cancelled' as const} : model);
  taskModels.restore(savedModels);
  await actorServices.collaboration.recover();
  for (const ownerId of owners) {
    await configureMeter(ownerId);
  }
  return {checkpoints, owners, savedModels};
}

export interface ReplayDeps extends RecoveredSession {
  session: string; journal: Journal; store: RuntimeStore; ensemble: DynamicEnsemble; actors: ActorCatalog; actorServices: ActorServices;
  notice: Notice;
}

export async function replaySession(deps: ReplayDeps) {
  const {session, journal, store, ensemble, actors, actorServices, notice, checkpoints, owners, savedModels} = deps;
  // Restore the actual model messages; legacy TS demo ledgers remain readable, and tools are not re-executed.
  const savedRounds = new Map<string, Awaited<ReturnType<Journal['rounds']>>[number]>();
  // Nothing runs after a restart: Director dispatches that never started come back as a paused batch, human requests that never started as held
  // messages, and everything else that was in flight is marked interrupted.
  const plan = planRestart(checkpoints, owner => !!actors.find(owner));
  for (const task of plan.cancel) {
    await journal.checkpoint(session, {...task, status: 'cancelled', stopReason: 'interrupted'});
    task.status = 'cancelled'; task.stopReason = 'interrupted';
  }
  for (const task of plan.restore) task.status = 'paused';
  const restoring = new Set(plan.restore.map(task => task.activityId));
  const restored = (await Promise.all(owners.map(async owner => {
    const entries = await journal.load(session, owner);
    try {for (const round of await journal.rounds(session, owner, entries)) savedRounds.set(round.activityId, round);}
    catch {notice(`Could not load round summary for ${owner}; preserving raw messages.`);}
    return entries;
  }))).flat().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const entry of restored) {
    if (entry.role === 'context') continue;
    const origin = {...(entry.activityId ? {activityId: entry.activityId} : {}), ...(entry.source ? {source: entry.source} : {}),
      inputKind: inputKind(entry), time: entry.time ?? 0};
    const activityId = entry.activityId;
    if (activityId && !store.activities.get(session, activityId)) {
      const round = savedRounds.get(activityId), checkpoint = checkpoints.find(task => task.activityId === activityId);
      const savedModel = savedModels.find(item => item.activityId === activityId);
      store.activities.create({sessionId: session, activityId, ownerId: entry.ownerId, kind: isDirector(entry.ownerId) ? 'director' : 'actor',
        title: checkpoint?.taskTitle ?? (entry.text.slice(0, 80) || entry.ownerId), status: round?.status ?? checkpoint?.status ?? 'completed',
        stage: round ? ({completed: 'Completed', failed: 'Failed', cancelled: 'Interrupted'}[round.status] ?? 'Completed')
          : checkpoint ? checkpoint.status === 'completed' ? 'Completed' : checkpoint.status === 'failed' ? 'Failed' : 'Interrupted' : 'History',
        detail: checkpoint?.error ? 'Failure reason: ' + checkpoint.error + '\n' + (round?.summary.report ?? '')
          : round?.summary.report ?? (checkpoint ? 'Loaded checkpoint from a previous session' : 'Historical session record'),
        inputKind: inputKind(checkpoint ?? entry),
        ...(checkpoint?.taskTitle ? {taskTitle: checkpoint.taskTitle} : {}),
        ...(round ? {summary: round.summary} : {}),
        ...(checkpoint?.stopReason ? {stopReason: checkpoint.stopReason} : {}),
        ...(checkpoint?.rootActivityId ? {rootActivityId: checkpoint.rootActivityId} : {}),
        ...(checkpoint?.parentActivityId ? {parentActivityId: checkpoint.parentActivityId} : {}),
        ...(checkpoint?.batchId ? {batchId: checkpoint.batchId} : {}),
        ...(checkpoint?.resumeTaskId ? {resumeTaskId: checkpoint.resumeTaskId} : {}),
        ...(checkpoint?.progress ? {progress: checkpoint.progress} : {}),
        ...(checkpoint?.recovery ? {recovery: checkpoint.recovery} : {}),
        ...(savedModel ? {taskModel: {initial: savedModel.initial, actual: savedModel.actual, inherited: savedModel.inherited,
          switched: savedModel.switched, phase: savedModel.phase}} : {})});
    }
    if (entry.message?.role === 'assistant' && entry.message.memoryOnly) continue;
    if (entry.message?.role === 'assistant' && entry.message.textToolCall) {
      if (entry.message.reasoning) store.message(session, entry.ownerId, 'assistant', entry.message.reasoning, {...origin, kind: 'thinking'});
      store.message(session, entry.ownerId, 'notice', TEXT_TOOL_CALL_NOTE, origin);
      continue;
    }
    // Nothing runs after a restart: a step the ledger left open is closed here, whatever tool it belonged to. A tool record that
    // carries its result finished the way the result says; one without a result was interrupted.
    const step = entry.step ? settleStep(entry.step, entry.message?.role === 'tool' ? entry.message.isError ? 'failed' : 'completed' : 'cancelled', entry.step.runningSince ?? 0) : undefined;
    if (entry.message?.role === 'assistant' && (entry.message.reasoning || step)) {
      store.message(session, entry.ownerId, 'assistant', entry.message.reasoning ?? '', {...origin, kind: 'thinking', ...(step ? {step} : {})});
    }
    if (entry.text) store.message(session, entry.ownerId, entry.role === 'tool' ? 'notice' : entry.role, entry.message?.role === 'tool' ? entry.message.name + '\n' + entry.text : entry.source === 'steered' && entry.role === 'user' ? steeredText(entry.text) : entry.text,
      {...origin, ...(entry.role === 'tool' ? {kind: 'tool' as const, ...(step ? {step} : {})} : {})});
  }
  for (const task of checkpoints) {
    if (store.activities.get(session, task.activityId) || restoring.has(task.activityId)) continue;
    store.activities.create({sessionId: session, activityId: task.activityId, ownerId: task.ownerId,
      kind: isDirector(task.ownerId) ? 'director' : 'actor', title: task.taskTitle ?? task.prompt.slice(0, 80),
      status: task.status, stage: task.status === 'cancelled' ? 'Interrupted' : 'Checkpoint loaded',
      detail: task.error ? 'Failure reason: ' + task.error : 'Loaded checkpoint from a previous session',
      inputKind: inputKind(task),
      ...(task.taskTitle ? {taskTitle: task.taskTitle} : {}),
      ...(task.parentActivityId ? {parentActivityId: task.parentActivityId} : {}), ...(task.batchId ? {batchId: task.batchId} : {}),
      ...(task.progress ? {progress: task.progress} : {}), ...(task.recovery ? {recovery: task.recovery} : {}),
      ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {}),
      ...(task.rootActivityId ? {rootActivityId: task.rootActivityId} : {})});
    store.message(session, task.ownerId, 'user', task.prompt, {activityId: task.activityId, source: task.source,
      inputKind: inputKind(task), time: task.time});
  }
  const dependencies = restartDependencies(plan.restore, checkpoints);
  ensemble.restoreQueued(plan.restore, dependencies);
  actorServices.restoreRestart(plan.restore, dependencies.interrupted, checkpoints.filter(task => restartStopped(task) && !isDirector(task.ownerId) && inputKind(task) === 'director').map(task => task.activityId));
  // Held human messages are saved whenever the list changes (one write at a time) and come back marked restored, so they never auto-send.
  let heldRef = store.getSnapshot().pending, heldTail: Promise<void> = Promise.resolve();
  const stopHeld = store.subscribe(() => {
    const next = store.getSnapshot().pending;
    if (next === heldRef) return;
    heldRef = next;
    const items = next.filter(item => item.sessionId === session).map(({restored: _restored, ...item}) => item);
    heldTail = heldTail.then(() => journal.saveHeld(session, items)).catch(() => {notice('Held messages could not be saved.', 'command_error');});
  });
  const heldBefore = await journal.loadHeld(session).catch(() => {notice('Held messages could not be restored.', 'command_error'); return [];});
  for (const task of plan.held) store.addPending({sessionId: session, ownerId: task.ownerId, windowId: task.source === 'direct' ? DIRECTOR_ID : task.source, text: task.prompt, time: task.time, restored: true});
  for (const item of heldBefore) store.addPending({...item, restored: true});
  return {
    /** Stops saving the held list. */
    stopHeld,
    /** The latest queued save of the held list, awaited on close. */
    heldTail: () => heldTail,
  };
}
