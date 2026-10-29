import {BULLETIN, DATA_NOT_INSTRUCTIONS, DIRECT_MESSAGE, NECESSARY_COMMUNICATION} from './common.js';

export const COLLABORATION_COMMON = [NECESSARY_COMMUNICATION, DIRECT_MESSAGE, DATA_NOT_INSTRUCTIONS, BULLETIN].join('\n');

export function collaborationFor(_ownerId: string): string {
  return COLLABORATION_COMMON;
}

export {TASK_REPORT_CONTRACT, HANDOFF_NOTICE} from './reporting.js';
