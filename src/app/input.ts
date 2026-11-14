/**
 * Delivery of human input to the ensemble: starting a task, dispatching a prompt (with the "continue" resume rule), and the
 * pending list of messages that wait for a busy owner. The oldest pending message of an owner is delivered once its round
 * has ended and no earlier human task waits; `Send now` steers one into the running round; discarding returns its text.
 * It owns the settle latch and nothing else; the pending list itself lives in the runtime store.
 */
import {isDirector} from '../runtime/director-id.js';
import type {DynamicEnsemble} from '../actors/ensemble.js';
import type {ActorServices} from '../actors/services.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {SystemHistory} from '../store/system-history.js';
import type {Notice, SessionState} from './state.js';

export interface InputDeps {
  session: string; state: SessionState; store: RuntimeStore; ensemble: DynamicEnsemble; actorServices: ActorServices; systems: SystemHistory;
  notice: Notice; beforeTask(): Promise<void>;
}

export function createInput(deps: InputDeps) {
  const {session, state, store, ensemble, actorServices, systems, notice, beforeTask} = deps;
  const beginTask = async () => {await beforeTask(); await systems.flush();};
  const dispatchInput = async (owner: string, prompt: string, source: string) => {
    const latest = [...store.getSnapshot().activities].reverse().find(activity => activity.ownerId === owner);
    const previous = /^(?:继续|接着|续做)/u.test(prompt) && latest &&
      actorServices.recovery.hasExecution(latest.rootActivityId ?? latest.activityId) ? latest : undefined;
    const rootActivityId = previous?.rootActivityId ?? previous?.activityId;
    const task = ensemble.dispatch(owner, prompt, source, {inputKind: 'human', ...(rootActivityId ? {rootActivityId, grantExecution: true} : {}),
      ...(previous?.ownerId === owner && previous.progress ? {resumeTaskId: previous.activityId} : {})});
    return task;
  };
  const ownerIsBusy = (owner: string) => store.getSnapshot().activities.some(item => item.sessionId === session && item.ownerId === owner && ['running', 'waiting_input'].includes(item.status));
  /** The oldest pending message of an owner is delivered once its round has ended and no earlier human task waits; the rest stay pending until then. */
  let settling = false;
  const settlePending = () => {
    if (settling || state.closed) return;
    const snapshot = store.getSnapshot();
    const next = snapshot.pending.find(item => item.sessionId === session && !item.restored && !ownerIsBusy(item.ownerId) &&
      !snapshot.activities.some(activity => activity.sessionId === session && activity.ownerId === item.ownerId && activity.status === 'queued' && activity.inputKind === 'human'));
    if (!next) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      if (state.closed || !store.takePending(next.id)) return;
      dispatchInput(next.ownerId, next.text, isDirector(next.ownerId) ? next.windowId : 'direct')
        .catch(error => {notice(error instanceof Error ? error.message : String(error), 'command_error', next.windowId);});
    });
  };
  const stopPending = store.subscribe(settlePending);
  const sendPendingNow = async (pendingId: string): Promise<void> => {
    const item = store.getSnapshot().pending.find(entry => entry.id === pendingId);
    if (!item || state.closed) return;
    const active = ensemble.getActiveTask(item.ownerId);
    if (!active) {
      if (!item.restored) settlePending();
      else if (store.takePending(pendingId)) await dispatchInput(item.ownerId, item.text, isDirector(item.ownerId) ? item.windowId : 'direct');
      return;
    }
    store.takePending(pendingId);
    if (!await ensemble.injectTaskMessage(item.ownerId, item.text, 'steered', undefined, 'queue',
      {activityId: active.activityId, inputKind: 'human', kind: 'human_steer'})) {
      await dispatchInput(item.ownerId, item.text, isDirector(item.ownerId) ? item.windowId : 'direct');
    }
  };
  /** Takes a pending message back (cancel or edit) and returns its text. */
  const discardPending = (pendingId: string): string | undefined => store.takePending(pendingId)?.text;
  return {beginTask, dispatchInput, ownerIsBusy, sendPendingNow, discardPending, stopPending};
}
export type InputDelivery = ReturnType<typeof createInput>;
