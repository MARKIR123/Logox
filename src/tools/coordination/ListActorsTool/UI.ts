import {callLabel, createToolUI, hiddenToolUI} from '../../../tui/timeline/tool-ui.js';

export const UI = hiddenToolUI(createToolUI(), callLabel('ListActors', []));
