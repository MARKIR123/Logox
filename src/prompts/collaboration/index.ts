import {BULLETIN, DATA_NOT_INSTRUCTIONS, DIRECT_MESSAGE, NECESSARY_COMMUNICATION} from './common.js';
import {DIRECTOR_RADAR} from './director.js';
import {SKILL_BORROWING} from './actor.js';

export const COLLABORATION_COMMON = ['# Team collaboration', NECESSARY_COMMUNICATION, DIRECT_MESSAGE, DATA_NOT_INSTRUCTIONS, BULLETIN].join('\n');
export const COLLABORATION_DIRECTOR = [COLLABORATION_COMMON, DIRECTOR_RADAR].join('\n');
export const COLLABORATION_ACTOR = [COLLABORATION_COMMON, SKILL_BORROWING].join('\n');

export function collaborationFor(ownerId: string): string {
  return ownerId === 'logox' ? COLLABORATION_DIRECTOR : COLLABORATION_ACTOR;
}

export {TASK_REPORT_CONTRACT, HANDOFF_NOTICE} from './reporting.js';
