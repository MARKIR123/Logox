import type {ToolCall} from '../../runtime/messages.js';
import type {Message} from '../../runtime/contracts.js';
import type {ToolRenderContext, ToolUI} from '../../tools/ui-types.js';
import {callArgs, formatToolTitle} from '../../tools/ui-format.js';
import {cardTitle, keyValueLines, renderToolCard, type ToolView} from './tool-card.js';
import {resultLines} from './tool-code.js';

export function messageToolCall(message: Message): ToolCall | undefined {
  if (message.step?.call) return message.step.call;
  if (message.kind !== 'tool') return undefined;
  const [name = '', ...body] = message.text.split('\n');
  return {id: message.step?.callId ?? message.id, name: name.trim(), arguments: body.join('\n')};
}

const MAX_ARGUMENTS = 8;
/** Arguments as aligned `key  value` rows (nested values as compact one-line JSON), then the result rendered; `No output` when empty. */
export function defaultView(call: ToolCall | undefined, result: string): ToolView {
  const entries = Object.entries(callArgs(call)).filter(([key]) => key !== 'description' && key !== 'summary')
    .map(([key, value]): [string, string] => [key, typeof value === 'string' ? value : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const shown = entries.slice(0, MAX_ARGUMENTS);
  if (entries.length > shown.length) shown.push(['…', `+${entries.length - shown.length} more`]);
  const text = result.replace(/\s+$/, '');
  return {body: {...(shown.length ? {head: keyValueLines(shown)} : {}), lines: text.trim() ? width => resultLines(text, width) : [], empty: 'No output'}};
}

/** The default card for tools without a UI of their own: the shared anatomy with arguments and the rendered result. */
export function renderDefaultTool(context: ToolRenderContext): void {
  const call = context.call ?? messageToolCall(context.message);
  renderToolCard(context, {title: call ? cardTitle(context, call) : context.message.step?.title ?? 'Tool', view: result => defaultView(call, result)});
}


export function createToolUI(keys: readonly string[] = []): ToolUI {
  const title = (call: ToolCall) => formatToolTitle(call, keys);
  return {
    visibility: 'visible',
    title,
    render(context) {
      const call = context.call ?? messageToolCall(context.message);
      const message = call && context.message.step?.call
        ? {...context.message, step: {...context.message.step, title: title(call)}}
        : context.message;
      renderDefaultTool({...context, message});
    },
  };
}

/**
 * A tool that draws nothing on success (the work shows up elsewhere, or is internal). A failed call shows one quiet row:
 * red `▮`, the muted label (`Actor(kalon)`), ` · ` and the red reason, with the elapsed time at the right.
 */
export function hiddenToolUI(base: ToolUI, label: (call: ToolCall) => string): ToolUI {
  return {
    ...base,
    visibility: 'hidden',
    render(context) {
      const call = context.call ?? messageToolCall(context.message);
      if (!call) return;
      renderToolCard(context, {title: label(call), quietFailure: true});
    },
  };
}

/** `Name(detail)` from the first non-empty string argument among `keys`, `Name` when there is none. */
export function callLabel(name: string, keys: readonly string[]): (call: ToolCall) => string {
  return call => {
    const args = callArgs(call);
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return `${name}(${value.replace(/\s+/g, ' ').trim().slice(0, 60)})`;
    }
    return name;
  };
}
