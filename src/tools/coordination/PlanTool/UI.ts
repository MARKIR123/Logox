import type {ToolUI} from '../../ui-types.js';
import {createToolUI, messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, type ToolView} from '../../../tui/timeline/tool-card.js';

/** Plan card: the call names the op, the body is the runtime's answer line by line (the outline for a read). */
export function planView(result: string): ToolView {
  const lines = result.split('\n').filter(line => line.trim());
  return lines.length ? {body: {lines: lines.map(prose => ({prose}))}} : {body: {lines: [], empty: 'No plan'}};
}

export const UI: ToolUI = {
  ...createToolUI(['op', 'title', 'id']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    renderToolCard(context, {title: cardTitle(context, call), view: planView});
  },
};
