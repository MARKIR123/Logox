import type {ToolRenderContext, ToolUI} from '../ui-types.js';
import {renderEditDiff, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {formatToolCardTitle} from '../ui-format.js';

export const UI: ToolUI = {
  visibility: 'visible',
  title(call) {
    return formatToolCardTitle(call);
  },
  render(context: ToolRenderContext) {
    const {builder, message, frame, open, accent} = context;
    const call = context.call ?? messageToolCall(message);
    const bodyText = message.text.startsWith('Edit\n') ? message.text.slice('Edit\n'.length) : message.text;
    const fault = message.step?.disposition || message.step?.state === 'failed' || message.step?.state === 'cancelled';
    const isCompleted = message.step?.state === 'completed' && !fault && context.result?.isError !== true;
    const label = call
      ? formatToolCardTitle(call, bodyText, isCompleted, message.step?.title)
      : (message.step?.title ?? 'Edit');
    const reason = bodyText.trim().split('\n')[0] ?? '';
    const title = fault && reason ? label + ' · ' + reason : label;

    builder.pushOrdinaryCard({
      id: message.id,
      ownerId: message.ownerId,
      kind: 'Tool',
      title,
      bodyLines: isCompleted && call ? [] : bodyText.split('\n'),
      ...(message.step ? {step: message.step} : {}),
      open,
      railColor: accent,
      ...(frame ? {parentFrame: frame} : {}),
      renderBody: (inner) => {
        if (isCompleted && call) renderEditDiff(builder, message.id, accent, call, inner);
      },
    });
  },
};
