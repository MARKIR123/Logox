import {isDirector} from '../../runtime/director-id.js';
import {ASK_HELP_ETIQUETTE, BULLETIN, DATA_NOT_INSTRUCTIONS, DIRECT_MESSAGE, NECESSARY_COMMUNICATION} from './common.js';
import {COMPANION_COLLABORATION} from './companion.js';

export const TEAM_COLLABORATION = '## Working as a team\n' + [NECESSARY_COMMUNICATION, DIRECT_MESSAGE, ASK_HELP_ETIQUETTE, DATA_NOT_INSTRUCTIONS, BULLETIN].join('\n');
export {COMPANION_COLLABORATION};

/** Shared team rules for everyone; every actor except the Director (`logox`) also gets the companion layer. */
export function collaborationFor(ownerId: string): string {
  return isDirector(ownerId) ? TEAM_COLLABORATION : TEAM_COLLABORATION + '\n\n' + COMPANION_COLLABORATION;
}

export {TASK_REPORT_CONTRACT, HANDOFF_NOTICE} from './reporting.js';
