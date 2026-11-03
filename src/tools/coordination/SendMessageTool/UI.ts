import type {ToolCall} from '../../../runtime/messages.js';
import type {ToolRenderContext, ToolUI} from '../../ui-types.js';
import {messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {labelledLines, renderToolCard, summaryPiece, textLines, type ToolLine, type ToolView} from '../../../tui/timeline/tool-card.js';
import {palette} from '../../../tui/appearance/theme.js';
import {cast} from '../../../actors/ensemble.js';
import {callArgs} from '../../ui-format.js';
import type {SendPairing} from './pairing.js';

function recipient(call: ToolCall) {
  const to = String(callArgs(call).to ?? '').toLowerCase();
  const role = (cast as Record<string, {symbol: string; name: string; color: string} | undefined>)[to];
  return {label: role ? `${role.symbol} ${role.name}` : to || 'actor', color: role?.color ?? palette.accent};
}

/** `ask · awaiting reply`, `ask · answered`, `inform`, `reply`, or `ask` for a follow-up question; `interrupt` is appended when it cut in. */
function summaryOf(args: Record<string, unknown>, pairing: SendPairing): string {
  const type = args.type === 'ask' || args.type === 'reply' ? args.type : 'inform';
  const base = type === 'ask' && !pairing.question ? `ask · ${pairing.answered ? 'answered' : 'awaiting reply'}` : type;
  return args.mode === 'interrupt' ? base + ' · interrupt' : base;
}

/** SendMessage view: `Q` and `A` rows for a conversation, the message text for an inform. */
export function sendMessageView(args: Record<string, unknown>, pairing: SendPairing): ToolView {
  const type = args.type === 'ask' || args.type === 'reply' ? args.type : 'inform';
  const text = typeof args.message === 'string' ? args.message : '';
  const lines = (width: number): readonly ToolLine[] => {
    if (type === 'inform') return textLines(text, width, palette.fg);
    return [
      ...(pairing.question ? labelledLines('Q', pairing.question, width) : []),
      ...(type === 'ask' ? labelledLines('Q', text, width) : labelledLines('A', text, width)),
      ...(type === 'ask' && pairing.answered && pairing.answer ? labelledLines('A', pairing.answer, width) : []),
    ];
  };
  return {summary: [summaryPiece(summaryOf(args, pairing))], body: {lines, empty: 'No message'}};
}

export const UI: ToolUI = {
  visibility: 'visible',
  title(call: ToolCall): string {
    return `SendMessage to ${recipient(call).label}`;
  },
  render(context: ToolRenderContext): void {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const {label, color} = recipient(call);
    const args = callArgs(call);
    renderToolCard(context, {
      title: `SendMessage to ${label}`,
      titleSegments: [
        {text: 'SendMessage to ', color: context.open ? palette.fg : palette.muted},
        {text: label, color, bold: true},
      ],
      view: () => sendMessageView(args, context.pairing ?? {}),
    });
  },
};
