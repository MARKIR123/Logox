import {callLabel, createToolUI, hiddenToolUI} from '../../../tui/timeline/tool-ui.js';

export const UI = hiddenToolUI(createToolUI(['label']), callLabel('UpdateTaskProgress', []));
