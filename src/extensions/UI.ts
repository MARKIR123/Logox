import stringWidth from 'string-width';
import type {ToolCall} from '../runtime/messages.js';
import type {ToolUI} from '../tools/ui-types.js';
import {messageToolCall} from '../tui/timeline/tool-ui.js';
import {palette} from '../tui/appearance/theme.js';
import {failureView, keyValueLines, renderToolCard, summaryPiece, type ToolView} from '../tui/timeline/tool-card.js';
import {resultLines} from '../tui/timeline/tool-code.js';
import {browserAction} from '../tui/timeline/tool-groups.js';
import {browserRow} from './browser-ui.js';
import {safeText} from '../tui/terminal/text.js';

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
  const direct = /^mcp__(.+?)__(.+)$/.exec(call.name);
  const parameters = mask(direct ? args : record(args.arguments) ? args.arguments : {}, secrets) as Record<string, unknown>;
  const server = direct ? clip(direct[1]!, 50) : typeof args.server === 'string' ? clip(args.server, 50) : 'mcp';
  const list = !direct && args.action === 'list';
  const tool = list ? 'list' : direct ? clip(direct[2]!, 64) : typeof args.tool === 'string' ? clip(args.tool, 64) : 'call';
  return {server, tool, parameters, secrets, list};
}

/** `mcp · <server> › <tool>`; arguments and results are the body. */
function title(call: ToolCall): string {
  const {server, tool, secrets} = invocation(call);
  return scrub(`mcp · ${server} › ${tool}`, secrets);
}

const IMAGE = /^\[Image: image\/(?:png|jpeg|webp|gif)\]$/;
const MAX_ARGUMENTS = 8;

function argumentRows(parameters: Record<string, unknown>) {
  const entries = Object.entries(parameters).map(([key, value]): [string, string] =>
    [safeText(key), typeof value === 'string' ? value : value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const shown = entries.slice(0, MAX_ARGUMENTS);
  if (entries.length > shown.length) shown.push(['…', `+${entries.length - shown.length} more`]);
  return keyValueLines(shown);
}

function mcpView(parameters: Record<string, unknown>, text: string): ToolView {
  const rows = text.split(/\r?\n/);
  const images = rows.filter(row => IMAGE.test(row.trim())).length;
  const shown = rows.filter(row => !IMAGE.test(row.trim())).join('\n').trim();
  const head = Object.keys(parameters).length ? argumentRows(parameters) : [];
  return {
    ...(images ? {summary: [summaryPiece(`${images} image${images === 1 ? '' : 's'}`)]} : {}),
    body: {...(head.length ? {head} : {}), lines: shown ? width => resultLines(shown, width) : [], ...(images ? {} : {empty: 'No output'})},
  };
}

export const UI: ToolUI = {
  visibility: 'visible',
  title,
  render(context) {
    const {message, open} = context;
    const call = context.call ?? messageToolCall(message);
    if (!call) return;
    const {parameters, secrets, list} = invocation(call);
    const raw = message.text.startsWith(call.name + '\n') ? message.text.slice(call.name.length + 1) : message.text;
    const result = parse(raw);
    const text = scrub(result === undefined ? raw : JSON.stringify(mask(result, secrets), null, 2), secrets);
    const step = message.step;
    const failed = step?.state === 'failed' || step?.state === 'cancelled' || Boolean(step?.disposition);
    const done = step === undefined || step.state === 'completed';
    const failure = () => failureView(text, step?.state === 'cancelled');
    const browser = browserAction(call);
    if (browser && !list) {
      const row = browserRow(browser.action, parameters, done ? text : '', open ? palette.fg : palette.muted);
      renderToolCard(context, {title: row.title, titleSegments: row.segments, handlesFailure: true, view: () => failed ? failure() : row.view});
      return;
    }
    renderToolCard(context, {title: title(call), handlesFailure: true, view: () => failed ? failure() : mcpView(parameters, text)});
  },
};
