import {randomUUID} from 'node:crypto';
import type {ToolCall, ToolDefinition} from '../runtime/messages.js';
import {canonicalToolName} from '../tools/types.js';

/**
 * Recovers tool calls a model wrote into its reply text instead of the structured tool-call field. One provider-independent step: the caller applies it
 * only to a response with no structured calls, to a request that offered tools, and only to the assistant's visible text (never reasoning, tool results
 * or user messages). Recognised shapes, each parsed here and nowhere else:
 * - JSON `{"name": T, "arguments"|"parameters": {...}}` or `{"tool": T, "input": {...}}`, bare or in a ```json / ``` fence, or an array of those;
 * - `<tool_call>JSON as above</tool_call>` (one or several);
 * - `<invoke name="T"><parameter name="p">value</parameter>...</invoke>`, optionally inside `<function_calls>`.
 * A recovered call must name a tool offered in this request (exact name, or a known alias of an offered tool). Arguments are never validated here: they go
 * through the tool's normal schema check and permissions like any other call. If the text holds anything call-shaped that cannot be used (unknown tool,
 * unparsable tag, unusable arguments), nothing at all is recovered.
 */
export interface RecoveredText {
  /** The reply text with the matched call text removed; prose before and after stays. */
  readonly text: string;
  readonly calls: ToolCall[];
}

/** Text longer than this is not scanned: a reply that long is a document, not a mis-formatted call. */
const MAX_SCANNED = 100_000;
const ARGUMENT_KEYS = {name: ['arguments', 'parameters'], tool: ['input']} as const;

interface Span {readonly start: number; readonly end: number; readonly calls: RawCall[]}
interface RawCall {readonly name: string; readonly args: Record<string, unknown>; readonly repaired: boolean}
type Shape = {kind: 'calls'; calls: RawCall[]} | {kind: 'none'} | {kind: 'bad'};

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function tryParse(text: string): {ok: true; value: unknown} | {ok: false} {
  try {return {ok: true, value: JSON.parse(text)};} catch {return {ok: false};}
}

/** One value of call shape, `none` for any other JSON, `bad` for a call whose arguments are not an object. */
function shapeOf(value: unknown, repaired: boolean): Shape {
  if (Array.isArray(value)) {
    if (!value.length) return {kind: 'none'};
    const calls: RawCall[] = [];
    for (const item of value) {
      const shape = shapeOf(item, repaired);
      if (shape.kind !== 'calls' || Array.isArray(item)) return shape.kind === 'bad' ? shape : {kind: 'none'};
      calls.push(...shape.calls);
    }
    return {kind: 'calls', calls};
  }
  if (!plain(value)) return {kind: 'none'};
  for (const nameKey of ['name', 'tool'] as const) {
    const name = value[nameKey];
    if (typeof name !== 'string') continue;
    const key = ARGUMENT_KEYS[nameKey].find(candidate => candidate in value);
    if (!key) continue;
    let args = value[key];
    if (typeof args === 'string') {const parsed = tryParse(args); args = parsed.ok ? parsed.value : undefined;}
    return plain(args) ? {kind: 'calls', calls: [{name, args, repaired}]} : {kind: 'bad'};
  }
  return {kind: 'none'};
}

/** Closers for the open brackets of an unfinished JSON text, innermost first; `undefined` when the cut is inside a string (never closed: that would guess content). */
function closers(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') stack.pop();
  }
  return inString ? undefined : stack.reverse().join('');
}

/**
 * Parses JSON that may have been cut off. A cut text is closed with the shortest prefix of its closer list that parses, and only when the cut fell
 * right after a complete value or a comma (a cut number or literal such as `"limit": 2` could be a shorter number, so it is never closed).
 */
function parseLenient(text: string): {value: unknown; repaired: boolean} | undefined {
  const whole = tryParse(text);
  if (whole.ok) return {value: whole.value, repaired: false};
  let body = text.trimEnd();
  if (body.endsWith(',')) body = body.slice(0, -1).trimEnd();
  if (!/[}\]"]$/.test(body)) return undefined;
  const closing = closers(body);
  if (!closing) return undefined;
  for (let length = 1; length <= closing.length; length++) {
    const parsed = tryParse(body + closing.slice(0, length));
    if (parsed.ok) return {value: parsed.value, repaired: true};
  }
  return undefined;
}

/** End (exclusive) of the balanced JSON value starting at `start`, or `undefined` when it runs to the end of the text unclosed. */
function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return index + 1;
  }
  return undefined;
}

const xmlValue = (raw: string): unknown => {
  const parsed = tryParse(raw.trim());
  return parsed.ok && (typeof parsed.value === 'number' || typeof parsed.value === 'boolean' || (parsed.value !== null && typeof parsed.value === 'object')) ? parsed.value : raw;
};

/** `<invoke name="T"><parameter name="p">v</parameter></invoke>` blocks, with an enclosing `<function_calls>` wrapper folded into the span. A block with no end tag is unusable. */
function xmlSpans(text: string): {spans: Span[]; bad: boolean} {
  const spans: Span[] = [];
  const open = /<invoke\s+name\s*=\s*"([^"]*)"\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(text))) {
    const close = text.indexOf('</invoke>', open.lastIndex);
    if (close < 0) return {spans, bad: true};
    const args: Record<string, unknown> = {};
    for (const parameter of text.slice(open.lastIndex, close).matchAll(/<parameter\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/parameter>/g)) args[parameter[1]!] = xmlValue(parameter[2]!);
    let start = match.index, end = close + '</invoke>'.length;
    const before = /<function_calls>\s*$/.exec(text.slice(0, start)), after = /^\s*<\/function_calls>/.exec(text.slice(end));
    if (before) start -= before[0].length;
    if (after) end += after[0].length;
    spans.push({start, end, calls: [{name: match[1]!, args, repaired: false}]});
    open.lastIndex = close + '</invoke>'.length;
  }
  return {spans, bad: false};
}

/** `<tool_call>` tags. The last one may be unterminated (cut off at the end of the reply). */
function tagSpans(text: string): {spans: Span[]; bad: boolean} {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf('<tool_call>', from);
    if (open < 0) return {spans, bad: false};
    const bodyStart = open + '<tool_call>'.length, close = text.indexOf('</tool_call>', bodyStart);
    const body = text.slice(bodyStart, close < 0 ? text.length : close);
    const parsed = close < 0 ? parseLenient(body.trim()) : (() => {const whole = tryParse(body.trim()); return whole.ok ? {value: whole.value, repaired: false} : undefined;})();
    const shape = parsed ? shapeOf(parsed.value, parsed.repaired) : undefined;
    if (shape?.kind !== 'calls') return {spans, bad: true};
    spans.push({start: open, end: close < 0 ? text.length : close + '</tool_call>'.length, calls: shape.calls});
    if (close < 0) return {spans, bad: false};
    from = close + '</tool_call>'.length;
  }
}

/** Bare or fenced JSON. Prose that merely contains braces is skipped; a value that parses but is no call is skipped whole. */
function jsonSpans(text: string, taken: readonly Span[]): {spans: Span[]; bad: boolean} {
  const spans: Span[] = [];
  const inside = (index: number) => taken.some(span => index >= span.start && index < span.end);
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if ((char !== '{' && char !== '[') || inside(index)) continue;
    const end = balancedEnd(text, index);
    const parsed = parseLenient(end === undefined ? text.slice(index) : text.slice(index, end));
    if (!parsed || (end === undefined && !parsed.repaired)) continue;
    const shape = shapeOf(parsed.value, parsed.repaired);
    if (shape.kind === 'bad') return {spans, bad: true};
    const stop = end ?? text.length;
    if (shape.kind === 'calls') {
      let start = index, last = stop;
      // A fence around the whole value goes with it.
      const opening = /```[A-Za-z]*[ \t]*\r?\n?[ \t]*$/.exec(text.slice(0, start)), closing = /^\s*```/.exec(text.slice(stop));
      if (opening && closing) {start -= opening[0].length; last += closing[0].length;}
      spans.push({start, end: last, calls: shape.calls});
    }
    index = stop - 1;
  }
  return {spans, bad: false};
}

/** The offered tool a written name stands for: its exact name, else a known alias of an offered tool. */
function offeredTool(name: string, offered: readonly ToolDefinition[]): ToolDefinition | undefined {
  const exact = offered.find(tool => tool.name === name);
  if (exact) return exact;
  const canonical = canonicalToolName(name);
  return canonical ? offered.find(tool => tool.name === canonical || canonicalToolName(tool.name) === canonical) : undefined;
}

const requiredOf = (tool: ToolDefinition): readonly string[] => Array.isArray(tool.parameters.required) ? tool.parameters.required.filter((item): item is string => typeof item === 'string') : [];

/** The calls written as text in `text`, or `undefined` when there are none or any call-shaped text cannot be used. */
export function recoverTextCalls(text: string, offered: readonly ToolDefinition[]): RecoveredText | undefined {
  if (!offered.length || !text.trim() || text.length > MAX_SCANNED) return undefined;
  if (!/"name"|"tool"|<invoke|<tool_call>/.test(text)) return undefined;
  const xml = xmlSpans(text), tags = tagSpans(text);
  if (xml.bad || tags.bad) return undefined;
  const json = jsonSpans(text, [...xml.spans, ...tags.spans]);
  if (json.bad) return undefined;
  const spans = [...xml.spans, ...tags.spans, ...json.spans].sort((a, b) => a.start - b.start);
  if (!spans.length) return undefined;
  const calls: ToolCall[] = [];
  for (const span of spans) for (const raw of span.calls) {
    const tool = offeredTool(raw.name, offered);
    if (!tool) return undefined;
    // A call closed by the runtime must carry every field the schema requires; a complete call is left to normal validation.
    if (raw.repaired && requiredOf(tool).some(field => raw.args[field] === undefined)) return undefined;
    calls.push({id: randomUUID(), name: tool.name, arguments: JSON.stringify(raw.args)});
  }
  let rest = text;
  for (const span of [...spans].reverse()) rest = rest.slice(0, span.start) + rest.slice(span.end);
  return {text: rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), calls};
}
