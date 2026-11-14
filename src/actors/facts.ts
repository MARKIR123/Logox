import {isDirector} from '../runtime/director-id.js';
import {currentTaskProgress, type Activity, type RuntimeSnapshot} from '../runtime/contracts.js';
import type {Delivery} from '../runtime/delivery.js';
import {reportProgress} from '../prompts/runtime/director.js';

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
/**
 * One line of the ensemble snapshot. Detail lives in ListActors, and what an actor actually did in ReadActor.
 * `stable` is the form that is stored in the ledger (and so must not change on every step): the live subtitle is left out.
 */
export function activityFacts(activity: Activity, stable = false) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(activity.status);
  const subtitle = terminal || stable ? undefined : currentTaskProgress(activity.progress)?.label?.trim();
  return {activityId: activity.activityId, ownerId: activity.ownerId, status: activity.status,
    ...(activity.taskTitle ? {taskTitle: activity.taskTitle} : {}),
    ...(subtitle ? {subtitle} : {})};
}
export function activeEnsembleRoster(
  snapshot: RuntimeSnapshot,
  context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
  stable = false,
): string {
  const peers = snapshot.activities.filter(activity =>
    !isDirector(activity.ownerId) &&
    activity.ownerId !== context.ownerId &&
    ['running', 'waiting_input', 'queued'].includes(activity.status)
  );
  if (!peers.length) return '';
  const lines = peers.slice(0, 8).map(peer => {
    const main = (peer.taskTitle ?? peer.title).trim();
    // The stable (stored) form keeps who, status, task title and owned files; the subtitle, recent files and running tool change every step.
    const sub = stable ? undefined : currentTaskProgress(peer.progress)?.label?.trim();
    const title = main && sub && sub !== main ? `${main} · ${sub}` : (sub || main);
    const observed = stable ? undefined : toolFacts(snapshot, peer.activityId);
    const files = observed?.recentFiles?.join(', ');
    const running = observed?.currentTool;
    const owns = peer.ownedFiles?.slice(0, 4).join(', ');
    return `- ${peer.ownerId} (${peer.status}): ${title}` +
      (owns ? ` | owns: ${owns}${peer.ownedFiles!.length > 4 ? ', ...' : ''}` : '') +
      (files ? ` | files: ${files}` : '') +
      (running ? ` | running: ${running}` : '');
  });
  return 'Active ensemble roster (Logox is always reachable as Director; idle roles omitted):\n' + lines.join('\n');
}
export function directorFacts(snapshot: RuntimeSnapshot, context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
  deliveries: readonly Delivery[] = [], stable = false) {
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
  return {tasks: tasks.slice(0, 8).map(task => activityFacts(task, stable)), additionalTasks: Math.max(0, tasks.length - 8), ...(progress ? {progress} : {})};
}
const titleCase = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
/** One line per root whose reports are held back: who has reported and who is still working. Absent when nothing is held. */
function heldProgress(snapshot: RuntimeSnapshot, deliveries: readonly Delivery[]): string | undefined {
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
