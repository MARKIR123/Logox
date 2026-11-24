import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import type {ModelMessage, ToolCall} from '../runtime/messages.js';
import {executeRead} from '../tools/ReadTool/ReadTool.js';
import {READ_STUB_UNAVAILABLE, READ_UNCHANGED_STUB} from '../prompts/runtime/file-changes.js';
import {canonicalToolName} from '../tools/types.js';
import {readPathKey} from '../context/supersession.js';

/** A result shorter than this is returned again rather than pointed at. */
export const READ_REUSE_MIN_CHARS = 400;
const READ_DEFAULT_LIMIT = 2000;

function selector(call: ToolCall, cwd: string): string | undefined {
  if (canonicalToolName(call.name) !== 'Read') return undefined;
  let args: unknown;
  try {args = JSON.parse(call.arguments);} catch {return undefined;}
  if (!args || typeof args !== 'object') return undefined;
  const {file_path, path, offset, limit} = args as Record<string, unknown>, target = file_path ?? path;
  if (typeof target !== 'string' || !target) return undefined;
  return JSON.stringify([readPathKey(cwd, target), typeof offset === 'number' ? offset : 1, typeof limit === 'number' ? limit : READ_DEFAULT_LIMIT]);
}

/**
 * The call id of an earlier `Read` of the same file range whose result is still in the request the model last saw, word for word.
 * Text equality is the whole proof: a folded, archived, offloaded or superseded result is missing from that request or reads differently,
 * and a file that changed inside the range returns different text. Anything uncertain answers undefined, so the content is returned again.
 */
export function earlierIdenticalRead(history: readonly ModelMessage[], call: ToolCall, text: string, cwd: string): string | undefined {
  if (text.length < READ_REUSE_MIN_CHARS) return undefined;
  const wanted = selector(call, cwd);
  if (!wanted) return undefined;
  const calls = new Map<string, ToolCall>();
  let found: string | undefined;
  for (const message of history) {
    if (message.role === 'assistant') for (const earlier of message.toolCalls ?? []) calls.set(earlier.id, earlier);
    else if (message.role === 'tool' && !message.isError && !message.unexecuted && !message.images?.length && message.text === text) {
      const earlier = calls.get(message.callId);
      if (earlier && selector(earlier, cwd) === wanted) found = message.callId;
    }
  }
  return found;
}

/** Fingerprint of a read result, carried by its stub. */
export function readDigest(text: string): string {return createHash('sha256').update(text).digest('hex').slice(0, 12);}

/** The call id and result digest a stub carries (`prompts/runtime/file-changes.ts:readUnchangedStub()`), or null for any other text. */
function parseStub(text: string): string[] | null {
  if (!text.startsWith(READ_UNCHANGED_STUB) || !text.endsWith(').')) return null;
  const [id, digest, ...rest] = text.slice(READ_UNCHANGED_STUB.length, -2).split(', result ');
  return id && digest && /^[0-9a-f]{12}$/.test(digest) && !rest.length ? [id, digest] : null;
}

/**
 * After folding, a stub whose earlier result is no longer in the request word for word (checked by digest) must not point at nothing:
 * for this request only, it is replaced by the current content of the same range, read again like a normal Read. The ledger keeps the stub.
 */
export async function restoreBrokenReadStubs(messages: readonly ModelMessage[], cwd: string, read: typeof executeRead = executeRead): Promise<readonly ModelMessage[]> {
  if (!messages.some(message => message.role === 'tool' && message.text.startsWith(READ_UNCHANGED_STUB))) return messages;
  const calls = new Map<string, ToolCall>(), present = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    else if (message.role === 'tool' && !message.isError && !message.text.startsWith(READ_UNCHANGED_STUB)) present.add(message.callId + ':' + readDigest(message.text));
  }
  const output: ModelMessage[] = [];
  for (const message of messages) {
    const match = message.role === 'tool' ? parseStub(message.text) : null;
    if (message.role !== 'tool' || !match || present.has(match[0] + ':' + match[1])) {output.push(message); continue;}
    let text = READ_STUB_UNAVAILABLE;
    try {
      const args = JSON.parse(calls.get(message.callId)?.arguments ?? '') as {file_path?: string; path?: string; offset?: number; limit?: number};
      const target = args.file_path ?? args.path;
      if (typeof target === 'string' && target) {
        const result = await read({file_path: target, ...(args.offset ? {offset: args.offset} : {}), ...(args.limit ? {limit: args.limit} : {})}, resolve(cwd, target));
        if (!result.isError) text = result.text;
      }
    } catch {/* keeps the unavailable text */}
    output.push({...message, text});
  }
  return output;
}
