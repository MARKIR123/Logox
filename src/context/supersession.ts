import {resolve} from 'node:path';
import type {ModelMessage, ToolCall} from '../runtime/messages.js';
import {canonicalToolName} from '../tools/types.js';

/** Last line `Read` appends when it returned fewer lines than the file has (`ReadTool.ts:executeRead`). */
const READ_OMITTED = '(Remaining lines omitted)';
const READ_DEFAULT_LIMIT = 2000;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;

/** Path as the Read tool resolves it, compared the way the platform compares file names. */
export function readPathKey(cwd: string, path: string): string {
  const full = resolve(cwd, path).replaceAll('\\', '/');
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** One `Read` result of a ledger: the lines it actually returned (`to` is infinite when it reached the end of the file). */
interface ReadSpan {
  readonly callId: string;
  readonly index: number;
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly failed: boolean;
  /** The selector as the model wrote it (path, offset, limit); a failed read is replaced by a later success of the same selector. */
  readonly selector: string;
}

function spanLabel(span: Pick<ReadSpan, 'from' | 'to'>): string {
  if (span.from === 1 && span.to === Infinity) return 'whole file';
  return span.to === Infinity ? 'from line ' + span.from : 'lines ' + span.from + '-' + span.to;
}

function parseRead(call: ToolCall, result: Extract<ModelMessage, {role: 'tool'}>, index: number, cwd: string): ReadSpan | undefined {
  let args: unknown;
  try {args = JSON.parse(call.arguments);} catch {return undefined;}
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>, path = record.file_path ?? record.path;
  if (typeof path !== 'string' || !path) return undefined;
  const offset = record.offset, limit = record.limit;
  if (offset !== undefined && (!Number.isInteger(offset) || (offset as number) < 1)) return undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) return undefined;
  const key = readPathKey(cwd, path), selector = JSON.stringify([key, offset ?? null, limit ?? null]);
  const image = IMAGE_FILE.test(path);
  const from = image ? 1 : (offset as number | undefined) ?? 1;
  // A read the tool truncated covers only what it returned; one that reached the end of the file covers everything after its start.
  const to = image || !result.text.endsWith(READ_OMITTED) ? Infinity : from + ((limit as number | undefined) ?? READ_DEFAULT_LIMIT) - 1;
  return {callId: call.id, index, key, from, to, failed: result.isError, selector};
}

/**
 * The `Read` results of one actor's ledger that a later successful read of the same file makes redundant, as call id to the range of
 * the read that replaces it. Pure: it depends only on the ledger prefix, and a result's replacing read is the nearest later one that
 * contains it, so appending messages never changes an earlier answer. Edits and writes never supersede a read.
 */
export function supersededReads(messages: readonly ModelMessage[], cwd: string): Map<string, string> {
  const calls = new Map<string, ToolCall>();
  const spans: ReadSpan[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && !message.contextExcluded && !message.toolsExcluded) for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool' || message.unexecuted) return;
    const call = calls.get(message.callId);
    if (!call || canonicalToolName(call.name) !== 'Read') return;
    const span = parseRead(call, message, index, cwd);
    if (span) spans.push(span);
  });
  const result = new Map<string, string>();
  spans.forEach((older, position) => {
    for (const newer of spans.slice(position + 1)) {
      if (newer.failed || newer.key !== older.key) continue;
      const covers = older.failed ? newer.selector === older.selector : newer.from <= older.from && newer.to >= older.to;
      if (covers) {result.set(older.callId, spanLabel(newer)); break;}
    }
  });
  return result;
}
