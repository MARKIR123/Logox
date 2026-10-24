import {currentTaskProgress, type Activity, type RuntimeSnapshot} from '../runtime/contracts.js';
import type {Delivery} from '../runtime/delivery.js';

export function toolFacts(snapshot: RuntimeSnapshot, activityId: string, now = Date.now()) {
  const tools = snapshot.messages.filter(message => message.activityId === activityId && message.step &&
    (message.kind === 'tool' || message.step.callId));
  const current = tools.findLast(message => message.step && ['running', 'waiting'].includes(message.step.state));
  const step = current?.step;
  return {
    ...(step ? {currentTool: step.title.slice(0, 160), ...(step.callId ? {tool_id: step.callId} : {}),
      toolElapsed: Math.round((step.elapsedMs + (step.runningSince === undefined ? 0 : Math.max(0, now - step.runningSince))) / 1000) + 's'} : {}),
    recentTools: tools.filter(message => ['completed', 'failed', 'cancelled'].includes(message.step!.state)).slice(-3).map(message => ({
      tool: message.step!.title.slice(0, 160), callId: message.step!.callId ?? null, state: message.step!.state,
      elapsedMs: message.step!.elapsedMs, observedAt: message.time ?? null,
      ...(message.step!.disposition ? {disposition: message.step!.disposition} : {}),
    })),
  };
}
export function activityFacts(snapshot: RuntimeSnapshot, activity: Activity, now = Date.now()) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(activity.status);
  const label = !terminal ? currentTaskProgress(activity.progress)?.label : undefined;
  const observed = toolFacts(snapshot, activity.activityId, now);
  const {recentTools} = observed;
  return {activityId: activity.activityId, ownerId: activity.ownerId, status: activity.status,
    rootActivityId: activity.rootActivityId ?? activity.activityId, parentActivityId: activity.parentActivityId ?? null,
    batchId: activity.batchId ?? null, phase: activity.phase ?? null, evidenceSource: 'runtime',
    ...(label ? {selfReportedLabel: label} : {}), ...(terminal ? {recentTools} : observed)};
}
export function directorFacts(snapshot: RuntimeSnapshot, context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
  deliveries: readonly Delivery[] = [], now = Date.now()) {
  if (context.ownerId !== 'logox') return undefined;
  const root = context.rootActivityId ?? context.activityId;
  const related = new Set(deliveries.filter(item => item.ownerId === 'logox' &&
    (item.status === 'pending' || item.recipientActivityId === context.activityId)).flatMap(item => item.sourceActivityId ? [item.sourceActivityId] : []));
  const tasks = snapshot.activities.filter(activity => activity.ownerId !== 'logox' && activity.inputKind === 'director' &&
    (!['completed', 'failed', 'cancelled'].includes(activity.status) || activity.rootActivityId === root || related.has(activity.activityId)));
  if (!tasks.length && !deliveries.some(item => item.ownerId === 'logox' && item.status === 'pending' && !item.targetActivityId)) return undefined;
  const rank = (activity: Activity) => ['running', 'waiting_input'].includes(activity.status) ? 0 : ['queued', 'paused'].includes(activity.status) ? 1 : 2;
  tasks.sort((a, b) => rank(a) - rank(b));
  return {observedAt: now, revision: snapshot.revision, tasks: tasks.slice(0, 8).map(task => activityFacts(snapshot, task, now)),
    additionalTasks: Math.max(0, tasks.length - 8)};
}
