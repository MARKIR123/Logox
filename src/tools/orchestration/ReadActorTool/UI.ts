import {callLabel, createToolUI, hiddenToolUI} from '../../../tui/timeline/tool-ui.js';

export const UI = hiddenToolUI(createToolUI(['actor', 'ownerId', 'name']), callLabel('ReadActor', ['ownerId', 'actor', 'name']));
