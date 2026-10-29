import type {ToolCall} from '../../../runtime/messages.js';
import type {ToolRenderContext, ToolUI} from '../../ui-types.js';
import {messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {palette} from '../../../tui/appearance/theme.js';
import {cast} from '../../../actors/ensemble.js';
import type {SceneSegment} from '../../../tui/timeline/scene.js';

function parseSendMessage(call: ToolCall, bodyText = '') {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch {}
  const target = String(args.to ?? '').toLowerCase();
  const desc = typeof args.description === 'string' && args.description.trim()
    ? args.description.trim()
    : typeof args.summary === 'string' && args.summary.trim()
      ? args.summary.trim()
      : '';
  const cleanResult = bodyText.toLowerCase();
  const mode = (args.mode === 'interrupt' || cleanResult.includes('interrupt')) ? 'interrupt' : 'queued';
  const targetColor = (cast as any)[target]?.color ?? palette.accent;
  const descStr = desc ? ` · ${desc}` : '';
  const title = `SendMessage to ${target}${descStr} · ${mode}`;
  return {args, target, desc, mode, targetColor, descStr, title};
}

export const UI: ToolUI = {
  visibility: 'visible',
  title(call: ToolCall): string {
    const {title} = parseSendMessage(call);
    return title;
  },
  render(context: ToolRenderContext): void {
    const {builder, message, frame, open, accent} = context;
    const call = context.call ?? messageToolCall(message);
    if (!call) return;

    const [, ...bodyLines] = message.text.split('\n');
    const bodyText = bodyLines.join('\n');
    const {args, target, desc, mode, targetColor, title} = parseSendMessage(call, bodyText);

    const titleSegments: SceneSegment[] = [
      {text: 'SendMessage to ', color: palette.muted, selectionKey: message.id + ':title', selectionOffset: 0},
      {text: target, color: targetColor, bold: true, selectionKey: message.id + ':title_target'},
      ...(desc ? [{text: ` · ${desc}`, color: palette.muted, selectionKey: message.id + ':title_desc'}] : []),
      {text: ` · ${mode}`, color: palette.muted, selectionKey: message.id + ':title_mode'},
    ];

    let formattedBody: string[] = [];
    if (open) {
      const msg = typeof args.message === 'string' ? args.message : bodyText;
      const lines = msg.split(/\r?\n/);
      formattedBody = lines.length > 20 ? [...lines.slice(0, 20), `... (${lines.length - 20} more lines omitted)`] : lines;
    }

    builder.pushOrdinaryCard({
      id: message.id,
      ownerId: message.ownerId,
      kind: 'Tool',
      title,
      titleSegments,
      bodyLines: formattedBody,
      ...(message.step ? {step: message.step} : {}),
      open,
      railColor: accent,
      ...(frame ? {parentFrame: frame} : {}),
    });
  },
};
