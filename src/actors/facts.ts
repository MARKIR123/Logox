import {currentTaskProgress, type Activity, type RuntimeSnapshot} from '../runtime/contracts.js';
import type {Delivery} from '../runtime/delivery.js';

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
export function activityFacts(snapshot: RuntimeSnapshot, activity: Activity, now = Date.now()) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(activity.status);
  const label = !terminal ? currentTaskProgress(activity.progress)?.label : undefined;
  const observed = toolFacts(snapshot, activity.activityId, now);
  const {recentTools, recentFiles} = observed;
  return {activityId: activity.activityId, ownerId: activity.ownerId, status: activity.status,
    ...(activity.taskTitle ? {taskTitle: activity.taskTitle} : {}),
    rootActivityId: activity.rootActivityId ?? activity.activityId, parentActivityId: activity.parentActivityId ?? null,
    batchId: activity.batchId ?? null, phase: activity.phase ?? null, evidenceSource: 'runtime',
    ...(label ? {selfReportedLabel: label} : {}),
    ...(terminal ? {recentTools, ...(recentFiles ? {recentFiles} : {})} : observed)};
}
export function activeEnsembleRoster(
  snapshot: RuntimeSnapshot,
  context: {ownerId: string; activityId: string; rootActivityId?: string | undefined},
): string {
  const peers = snapshot.activities.filter(activity =>
    activity.ownerId !== 'logox' &&
    activity.ownerId !== context.ownerId &&
    ['running', 'waiting_input', 'queued'].includes(activity.status)
  );
  if (!peers.length) return '';
  const lines = peers.slice(0, 8).map(peer => {
    const main = (peer.taskTitle ?? peer.title).trim();
    const sub = currentTaskProgress(peer.progress)?.label?.trim();
    const title = main && sub && sub !== main ? `${main} · ${sub}` : (sub || main);
    const observed = toolFacts(snapshot, peer.activityId);
    const files = observed.recentFiles?.join(', ');
    const running = observed.currentTool;
    return `- ${peer.ownerId} (${peer.status}): ${title}` +
      (files ? ` | files: ${files}` : '') +
      (running ? ` | running: ${running}` : '');
  });
  return 'Active ensemble roster (Logox is always reachable as Director; idle roles omitted):\n' + lines.join('\n');
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
