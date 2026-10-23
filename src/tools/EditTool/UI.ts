import type {ToolRenderContext, ToolUI} from '../ui-types.js';
import {renderEditDiff, messageToolCall} from '../../tui/tool-ui.js';
import {formatToolCardTitle} from '../ui-format.js';

export const UI: ToolUI = {
  visibility: 'visible',
  title(call) {
    return formatToolCardTitle(call);
  },
  render(context: ToolRenderContext) {
    const {builder, message, frame, open, accent} = context;
    const call = context.call ?? messageToolCall(message);
    const [, ...bodyLines] = message.text.split('\n');
    const bodyText = bodyLines.join('\n');
    const isCompleted = message.step?.state === 'completed';
    const title = call
      ? formatToolCardTitle(call, bodyText, isCompleted, message.step?.title)
      : (message.step?.title ?? 'Edit');

    builder.pushOrdinaryCard({
      id: message.id,
      ownerId: message.ownerId,
      kind: 'Tool',
      title,
      bodyLines: [],
      ...(message.step ? {step: message.step} : {}),
      open,
      railColor: accent,
      ...(frame ? {parentFrame: frame} : {}),
      renderBody: (inner) => {
        if (call) renderEditDiff(builder, message.id, accent, call, inner);
      },
    });
  },
};
