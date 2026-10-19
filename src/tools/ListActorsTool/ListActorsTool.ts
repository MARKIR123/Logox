import {z} from 'zod';
import type {ToolResult} from '../types.js';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';

export const listActorsSchema = z.strictObject({});
export type ListActorsArgs = z.infer<typeof listActorsSchema>;

export interface ActorStatusReport {
  id: string;
  name: string;
  status: 'busy' | 'idle';
  stage?: string;
  activityId?: string;
  currentTool?: string;
  tool_id?: string;
  toolElapsed?: string;
}

const DEFAULT_NAMES: Record<string, string> = {
  logox: 'Logox',
  techne: 'Techne',
  aletheia: 'Aletheia',
  kalon: 'Kalon',
};

function calculateStepElapsed(step: {runningSince?: number | undefined; elapsedMs: number}, now: number): number {
  return step.elapsedMs + (step.runningSince !== undefined ? Math.max(0, now - step.runningSince) : 0);
}

export function executeListActors(
  _args: ListActorsArgs,
  context: {
    caller: string;
    getSnapshot: () => RuntimeSnapshot;
    roles?: Record<string, {name: string; title?: string}>;
  },
): ToolResult {
  const isDirector = context.caller === 'logox' || context.caller === 'director';
  const snapshot = context.getSnapshot();

  const actorIds = ['techne', 'aletheia', 'kalon'];
  if (!isDirector) {
    actorIds.unshift('logox');
  }

  const reports: ActorStatusReport[] = [];
  const now = Date.now();

  for (const id of actorIds) {
    const roleName = context.roles?.[id]?.name ?? DEFAULT_NAMES[id] ?? id;
    const activities = snapshot.activities.filter(a => a.ownerId === id);
    const runningActivity = activities.find(a => a.status === 'running');

    if (!runningActivity) {
      reports.push({
        id,
        name: roleName,
        status: 'idle',
        stage: 'idle',
      });
      continue;
    }

    if (!isDirector) {
      // Sanitized view for companion actors (prevents cross-actor unauthorized process kills)
      reports.push({
        id,
        name: roleName,
        status: 'busy',
        stage: runningActivity.stage || 'busy',
      });
      continue;
    }

    // Detailed execution view for Director
    let currentTool: string | undefined;
    let toolId: string | undefined;
    let toolElapsed: string | undefined;

    const messages = snapshot.messages.filter(m => m.activityId === runningActivity.activityId);
    const activeMsg = messages.find(m => m.step?.state === 'running');
    if (activeMsg?.step) {
      currentTool = activeMsg.step.title;
      toolId = activeMsg.step.callId;
      const elapsedSec = Math.round(calculateStepElapsed(activeMsg.step, now) / 1000);
      toolElapsed = `${elapsedSec}s`;
    }

    reports.push({
      id,
      name: roleName,
      status: 'busy',
      stage: runningActivity.stage,
      activityId: runningActivity.activityId,
      ...(currentTool ? {currentTool} : {}),
      ...(toolId ? {tool_id: toolId} : {}),
      ...(toolElapsed ? {toolElapsed} : {}),
    });
  }

  return {
    text: JSON.stringify({actors: reports}, null, 2),
    isError: false,
  };
}
