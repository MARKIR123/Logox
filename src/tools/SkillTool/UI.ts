import type {ToolUI} from '../ui-types.js';
import {createToolUI} from '../../tui/timeline/tool-ui.js';
import {callArgs, stageText} from '../ui-format.js';

export const UI: ToolUI = {
  ...createToolUI(['query', 'name']),
  stageLabel: call => {
    const args = callArgs(call);
    return args.action === 'load' ? stageText('Loading skill', args.name) : stageText('Searching skills', args.query);
  },
};
