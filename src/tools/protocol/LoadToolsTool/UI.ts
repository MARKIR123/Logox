import {callLabel, hiddenToolUI} from '../../../tui/timeline/tool-ui.js';

export const UI = hiddenToolUI({visibility: 'hidden', title: () => ''}, callLabel('LoadTools', []));
