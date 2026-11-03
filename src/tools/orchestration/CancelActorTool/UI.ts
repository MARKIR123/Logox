import type {ToolUI} from '../../ui-types.js';
import {cast} from '../../../actors/ensemble.js';
import {palette} from '../../../tui/appearance/theme.js';
import {createToolUI, messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {renderToolCard} from '../../../tui/timeline/tool-card.js';
import {callArgs} from '../../ui-format.js';

/** CancelActor: a fixed one-row `■ Stopped <symbol> <Name>` in the actor's color (a failed call uses the shared failure card). */
export const UI: ToolUI = {
  ...createToolUI(['actor', 'ownerId']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const args = callArgs(call);
    const id = String(args.actor ?? args.ownerId ?? '').toLowerCase();
    const role = (cast as Record<string, {symbol: string; name: string; color: string} | undefined>)[id];
    const target = role ? `${role.symbol} ${role.name}` : id || 'actor';
    const step = context.message.step;
    if (step && (step.state === 'failed' || step.state === 'cancelled' || step.disposition)) {
      renderToolCard(context, {title: `CancelActor(${id || 'actor'})`});
      return;
    }
    const color = role?.color ?? palette.accent;
    const { message, builder, frame, accent } = context;
    builder.pushOrdinaryCard({
      id: message.id, ownerId: message.ownerId, kind: 'Tool', title: `Stopped ${target}`, bodyLines: [], open: false, railColor: accent,
      expandable: true, fixed: true,
      titleSegments: [
        {text: '■ Stopped ', color, selectionKey: message.id + ':title', selectionOffset: 0},
        {text: target, color, bold: true, selectionKey: message.id + ':title_target', selectionOffset: 0},
      ],
      ...(args.scope === 'tool' ? {summarySegments: [{text: 'tool only', color: palette.muted}]} : {}),
      ...(frame ? {parentFrame: frame} : {}),
    });
  },
};
