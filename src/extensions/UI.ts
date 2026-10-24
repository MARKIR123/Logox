import stringWidth from 'string-width';
import type {ToolCall} from '../runtime/messages.js';
import type {ToolUI} from '../tools/ui-types.js';
import {formatByteSize} from '../tools/ui-format.js';
import {messageToolCall} from '../tui/tool-ui.js';
import {palette, safeText} from '../tui/cards.js';
import {stepStatus} from '../tui/row-presentation.js';

const sensitive = /password|passwd|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key/i;
const redacted = '[redacted]';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function clip(text: string, width: number): string {
  text = safeText(text).replace(/\s+/g, ' ').trim();
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(result + char) > width - 1) break;
    result += char;
  }
  return width > 0 ? result + '…' : '';
}

function parse(text: string): unknown {
  try {return JSON.parse(text);} catch {return undefined;}
}

function scrubUrl(text: string, secrets?: Set<string>): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, value => {
    try {
      const url = new URL(value);
      const remember = (value: string) => {
        if (!value) return;
        secrets?.add(value);
        try {secrets?.add(decodeURIComponent(value));} catch {}
      };
      if (url.username || url.password) {
        remember(url.username); remember(url.password);
        url.username = 'redacted'; url.password = 'redacted';
      }
      for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) {
        remember(url.searchParams.get(key) ?? '');
        url.searchParams.set(key, redacted);
      }
      return url.toString();
    } catch {return value;}
  });
}

function mask(value: unknown, secrets: Set<string>, key = '', depth = 0): unknown {
  if (sensitive.test(key)) {
    const collect = (item: unknown): void => {
      if (typeof item === 'string' && item) secrets.add(item);
      else if (item && typeof item === 'object') Object.values(item).forEach(collect);
    };
    collect(value);
    return redacted;
  }
  if (depth > 12) return '[nested value]';
  if (typeof value === 'string') return scrubUrl(safeText(value), secrets);
  if (Array.isArray(value)) return value.map(item => mask(item, secrets, '', depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [safeText(name), mask(item, secrets, name, depth + 1)]));
  return value;
}

function scrub(text: string, secrets: Set<string>): string {
  text = scrubUrl(safeText(text), secrets);
  let start = -1, depth = 0, quoted = false, escaped = false, output = '', copied = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      if (char !== '{' && char !== '[') continue;
      start = index; depth = 1; quoted = false; escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    if (depth !== 0) continue;
    const value = parse(text.slice(start, index + 1));
    if (value !== undefined) {
      output += text.slice(copied, start) + JSON.stringify(mask(value, secrets));
      copied = index + 1;
    }
    start = -1;
  }
  text = output + text.slice(copied);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, redacted);
  return text;
}

function invocation(call: ToolCall) {
  const input = parse(call.arguments);
  const args = record(input) ? input : {};
  const secrets = new Set<string>();
  const parameters = mask(record(args.arguments) ? args.arguments : {}, secrets) as Record<string, unknown>;
  const server = typeof args.server === 'string' ? clip(args.server, 50) : 'mcp';
  const action = args.action === 'list' ? 'list' : typeof args.tool === 'string' ? clip(args.tool, 64) : 'call';
  return {name: `${server}.${action}`, parameters, secrets, list: args.action === 'list'};
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value.length > 200 || value.includes('\n')
    ? `[${value.length} chars]` : JSON.stringify(clip(value, 36));
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (record(value)) return `{${Object.keys(value).length} fields}`;
  return String(value);
}

function title(call: ToolCall): string {
  const {name, parameters, secrets} = invocation(call);
  const entries = Object.entries(parameters);
  const ordered = [...entries.filter(([, value]) => !value || typeof value !== 'object'), ...entries.filter(([, value]) => value && typeof value === 'object')];
  const values = ordered.slice(0, 3).map(([key, value]) => `${clip(key, 24)}=${preview(value)}`);
  if (ordered.length > 3) values.push(`… +${ordered.length - 3}`);
  return scrub(`${name}(${values.join(', ')})`, secrets);
}

function firstContent(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line && !/^(#{1,6}\s|```|~~~|[-*_]{3,}$)/.test(line))?.replace(/^[-*]\s+/, '') ?? '';
}

function outcome(text: string, list: boolean): string {
  const images = text.match(/^\[Image: image\/(?:png|jpeg|webp|gif)\]$/gm)?.length ?? 0;
  if (images) return `${images} image${images === 1 ? '' : 's'}`;
  const value = parse(text);
  if (Array.isArray(value)) return `${value.length} ${list ? 'tools' : 'items'}`;
  if (record(value)) return `${Object.keys(value).length} fields`;
  if (text.length > 160) return formatByteSize(Buffer.byteLength(text));
  return clip(firstContent(text), 64) || 'Done';
}

function body(text: string, maxLines: number): string[] {
  const lines = text.split(/\r?\n/);
  return [...lines.slice(0, maxLines).map(line => line.length > 160 ? line.slice(0, 159) + '…' : line),
    ...(lines.length > maxLines ? [`… (${lines.length - maxLines} more lines omitted)`] : [])];
}

export const UI: ToolUI = {
  visibility: 'visible',
  title,
  render(context) {
    const {builder, message, frame, open, accent} = context;
    const call = context.call ?? messageToolCall(message);
    if (!call) return;
    const {parameters, secrets, list} = invocation(call);
    const raw = message.text.startsWith(call.name + '\n') ? message.text.slice(call.name.length + 1) : message.text;
    const result = parse(raw);
    const text = scrub(result === undefined ? raw : JSON.stringify(mask(result, secrets), null, 2), secrets);
    const step = message.step;
    const terminal = step && ['completed', 'failed', 'cancelled'].includes(step.state);
    const fault = step?.disposition === 'denied' ? 'Denied' : step?.disposition === 'error' || step?.state === 'failed' ? 'Error' : step?.state === 'cancelled' ? 'Cancelled' : '';
    const reason = firstContent(text).replace(/^(?:Error|Denied|Cancelled):\s*/i, '');
    const summary = fault ? fault + (reason ? ': ' + reason : '') : terminal ? outcome(text, list) : '';
    const width = Math.max(1, (frame?.innerWidth ?? builder.contentWidth) - 2);
    const timingWidth = step ? Math.max(10, stringWidth(stepStatus(step, Date.now()))) + 3 : 0;
    const summaryText = summary ? clip(summary, Math.max(0, Math.min(64, Math.floor((width - timingWidth) / 2)))) : '';
    const titleWidth = Math.max(0, width - timingWidth - (summaryText ? stringWidth(summaryText) + 3 : 0));
    const fullTitle = title(call);
    const label = stringWidth(fullTitle) <= titleWidth ? fullTitle : clip(fullTitle.slice(0, -1), Math.max(0, titleWidth - 1)) + (titleWidth ? ')' : '');
    builder.pushOrdinaryCard({
      id: message.id, ownerId: message.ownerId, kind: 'Tool', title: label,
      titleSegments: [
        {text: label, color: palette.muted, selectionKey: message.id + ':title', selectionOffset: 0},
        ...(summaryText ? [{text: ' · ' + summaryText, color: fault ? palette.error : palette.muted, selectionKey: message.id + ':outcome', selectionOffset: 0}] : []),
      ],
      bodyLines: open ? ['Arguments', ...body(scrub(JSON.stringify(parameters, null, 2), secrets), 12), 'Result', ...body(text || '(no content)', 20)] : [],
      ...(step ? {step} : {}), faultLabel: '', open, railColor: accent, ...(frame ? {parentFrame: frame} : {}),
    });
  },
};
