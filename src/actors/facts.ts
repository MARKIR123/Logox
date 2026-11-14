import {isDirector} from '../runtime/director-id.js';
import {currentTaskProgress, type Activity, type RuntimeSnapshot} from '../runtime/contracts.js';
import type {Delivery} from '../runtime/delivery.js';
import {ENSEMBLE_RECORD_HEADER, reportProgress, TEAMMATES_FOOTER, TEAMMATES_HEADER} from '../prompts/runtime/director.js';

function extractRecentFiles(snapshot: RuntimeSnapshot, activityId: string): string[] {
  const tools = snapshot.messages.filter(message => message.activityId === activityId && message.step?.call);
  const edits: string[] = [];
  const reads: string[] = [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const call = tools[i]!.step?.call;
    if (!call) continue;
    const name = call.name.toLowerCase();
    if (!['edit', 'write', 'read'].includes(name)) continue;
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      if (!parsed || typeof parsed !== 'object') continue;
      const rawPath = (parsed as Record<string, unknown>).file_path ?? (parsed as Record<string, unknown>).path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
      const cleanPath = rawPath.trim().replaceAll('\\', '/');
      const entry = `${cleanPath} (${name === 'read' ? 'read' : 'edit'})`;
      if (name === 'read') {
        if (!reads.includes(entry) && !edits.some(item => item.startsWith(cleanPath + ' '))) reads.push(entry);
      } else if (!edits.includes(entry)) {
        edits.push(entry);
      }
    } catch {}
  }
  return [...edits, ...reads].slice(0, 3);
}

export function toolFacts(snapshot: RuntimeSnapshot, activityId: string, now = Date.now()) {
  const tools = snapshot.messages.filter(message => message.activityId === activityId && message.step &&
    (message.kind === 'tool' || message.step.callId));
  const current = tools.findLast(message => message.step && ['running', 'waiting'].includes(message.step.state));
  const step = current?.step;
  const recentFiles = extractRecentFiles(snapshot, activityId);
  return {
    ...(step ? {currentTool: step.title.slice(0, 160), ...(step.callId ? {tool_id: step.callId} : {}),
      toolElapsed: Math.round((step.elapsedMs + (step.runningSince === undefined ? 0 : Math.max(0, now - step.runningSince))) / 1000) + 's'} : {}),
    ...(recentFiles.length ? {recentFiles} : {}),
    recentTools: tools.filter(message => ['completed', 'failed', 'cancelled'].includes(message.step!.state)).slice(-3).map(message => ({
      tool: message.step!.title.slice(0, 160), callId: message.step!.callId ?? null, state: message.step!.state,
      elapsedMs: message.step!.elapsedMs, observedAt: message.time ?? null,
      ...(message.step!.disposition ? {disposition: message.step!.disposition} : {}),
    })),
  };
}
/** One task of the ensemble record: who holds it and in what status. Live detail (subtitle, running tool) lives in ListActors, what an actor did in ReadActor. */
export function activityFacts(activity: Activity) {
  return {activityId: activity.activityId, ownerId: activity.ownerId, status: activity.status,
    ...(activity.taskTitle ? {taskTitle: activity.taskTitle} : {}),
    ...(activity.ownedFiles?.length ? {owns: activity.ownedFiles.slice(0, 4)} : {}),
    ...(activity.status === 'paused' && activity.batchId ? {batchId: activity.batchId} : {})};
}
/** The record of a companion's active teammates, stored once after a fold or a restart: who, status, task title and owned files. */
export function activeEnsembleRoster(
  snapshot: RuntimeSnapshot,
  context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
): string {
  const peers = snapshot.activities.filter(activity =>
    !isDirector(activity.ownerId) &&
    activity.ownerId !== context.ownerId &&
    ['running', 'waiting_input', 'queued'].includes(activity.status)
  );
  if (!peers.length) return '';
  const lines = peers.slice(0, 8).map(peer => {
    const title = (peer.taskTitle ?? peer.title).trim();
    const owns = peer.ownedFiles?.slice(0, 4).join(', ');
    return `- ${peer.ownerId} (${peer.status}): ${title}` + (owns ? ` | owns: ${owns}${peer.ownedFiles!.length > 4 ? ', ...' : ''}` : '');
  });
  return ENSEMBLE_RECORD_HEADER + '\n' + lines.join('\n');
}
/**
 * The teammates block that ends a Director assignment: the other owners of the same dispatch plus companions still active on the same root task.
 * Empty without teammates. `finished` names owners this task runs `after`: they have ended when it starts, so they are no teammates.
 * It is delivered once with the assignment; teammates dispatched later are not announced.
 */
export function teammatesBlock(owner: string, batch: readonly {ownerId: string; title: string; owns: readonly string[]}[],
  snapshot: RuntimeSnapshot | undefined, root: string, finished: ReadonlySet<string> = new Set()): string {
  const mates = new Map<string, {title: string; owns: readonly string[]}>();
  for (const task of batch) if (task.ownerId !== owner && !finished.has(task.ownerId)) mates.set(task.ownerId, {title: task.title, owns: task.owns});
  for (const activity of snapshot?.activities ?? []) {
    if (isDirector(activity.ownerId) || activity.ownerId === owner || mates.has(activity.ownerId) || finished.has(activity.ownerId) || activity.activityId === root ||
      (activity.rootActivityId ?? activity.activityId) !== root || !['queued', 'running', 'waiting_input'].includes(activity.status)) continue;
    mates.set(activity.ownerId, {title: (activity.taskTitle ?? activity.title).trim(), owns: activity.ownedFiles ?? []});
  }
  if (!mates.size) return '';
  const lines = [...mates].slice(0, 8).map(([id, mate]) => `- ${id}: ${mate.title}` +
    (mate.owns.length ? ` | owns: ${mate.owns.slice(0, 4).join(', ')}${mate.owns.length > 4 ? ', ...' : ''}` : ''));
  return TEAMMATES_HEADER + '\n' + lines.join('\n') + '\n' + TEAMMATES_FOOTER;
}
export function directorFacts(snapshot: RuntimeSnapshot, context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
  deliveries: readonly Delivery[] = []) {
  if (!isDirector(context.ownerId)) return undefined;
  const root = context.rootActivityId ?? context.activityId;
  const related = new Set(deliveries.filter(item => isDirector(item.ownerId) &&
    (item.status === 'pending' || item.recipientActivityId === context.activityId)).flatMap(item => item.sourceActivityId ? [item.sourceActivityId] : []));
  const tasks = snapshot.activities.filter(activity => !isDirector(activity.ownerId) && activity.inputKind === 'director' &&
    (!['completed', 'failed', 'cancelled'].includes(activity.status) || activity.rootActivityId === root || related.has(activity.activityId)));
  if (!tasks.length && !deliveries.some(item => isDirector(item.ownerId) && item.status === 'pending' && !item.targetActivityId)) return undefined;
  const rank = (activity: Activity) => ['running', 'waiting_input'].includes(activity.status) ? 0 : ['queued', 'paused'].includes(activity.status) ? 1 : 2;
  tasks.sort((a, b) => rank(a) - rank(b));
  const progress = heldProgress(snapshot, deliveries);
  return {tasks: tasks.slice(0, 8).map(activityFacts), additionalTasks: Math.max(0, tasks.length - 8), ...(progress ? {progress} : {})};
}
const titleCase = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
/** One line per root whose reports are held back: who has reported and who is still working. Absent when nothing is held. */
export function heldProgress(snapshot: RuntimeSnapshot, deliveries: readonly Delivery[]): string | undefined {
  const held = deliveries.filter(item => isDirector(item.ownerId) && item.status === 'pending' && item.hold);
  const lines = [...new Set(held.map(item => item.rootActivityId ?? ''))].map(root => {
    const work = openWork(snapshot, root, deliveries);
    const reported = held.filter(item => (item.rootActivityId ?? '') === root);
    const waiting = new Set(work.deferred.map(item => item.sourceActivityId ?? item.id));
    const total = reported.length + work.activities.length + waiting.size;
    return reportProgress([...new Set(reported.map(item => titleCase(item.source)))], [...new Set(work.activities.map(activity => titleCase(activity.ownerId)))], total, waiting.size > 0);
  });
  return lines.length ? lines.join(' | ') : undefined;
}

/**
 * What still keeps the reports of a root from being delivered: companion activities of that root that are queued, running or waiting for input
 * (`paused` ones are not open: a pause follows a failure or stop), and pending Logox deliveries of the root that wait for the next human input
 * (the user stopped something and has not spoken yet). Logox's own activities never count, and `exclude` leaves out the activities that are
 * reporting or settling now, so the result does not depend on whether its status is already terminal.
 */
export function openWork(snapshot: RuntimeSnapshot, root: string, deliveries: readonly Delivery[] = [], exclude: string | ReadonlySet<string> = ''): {activities: Activity[]; deferred: Delivery[]} {
  return {
    activities: snapshot.activities.filter(activity => !isDirector(activity.ownerId) && activity.activityId !== root && !(typeof exclude === 'string' ? exclude === activity.activityId : exclude.has(activity.activityId)) &&
      (activity.rootActivityId ?? activity.activityId) === root && ['queued', 'running', 'waiting_input'].includes(activity.status)),
    deferred: deliveries.filter(item => isDirector(item.ownerId) && item.status === 'pending' && item.deferredUntilHuman && item.rootActivityId === root),
  };
}
export const hasOpenWork = (work: ReturnType<typeof openWork>): boolean => work.activities.length > 0 || work.deferred.length > 0;
/**
 * True while the Director is certain to wake without human input: some companion activity of the root is queued or running, and no
 * delivery of the root waits for the human. Activities waiting for input may be waiting for the human, so they never count.
 */
export const certainToWake = (work: ReturnType<typeof openWork>): boolean =>
  work.deferred.length === 0 && work.activities.some(activity => activity.status !== 'waiting_input');
