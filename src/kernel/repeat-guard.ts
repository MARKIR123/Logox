import {createHash} from 'node:crypto';
import type {ToolCall} from '../runtime/messages.js';
import {canonicalToolName} from '../tools/types.js';
import {READ_UNCHANGED_NOTE} from '../tools/ReadTool/prompt.js';
import {repeatedCallNote} from '../prompts/runtime/recovery.js';
import {readPathKey} from '../context/supersession.js';
import {canonicalJson} from './execution-recovery.js';

/** Identical calls with an unchanged result in a row before the single loop reminder of that streak. */
export const LOOP_STREAK = 3;
/** Read selectors remembered per activity; the least recently read is forgotten first. */
export const READ_MEMORY_LIMIT = 64;
/**
 * Tools whose identical repetition is legitimate and never counts as a loop: polling a background job, a teammate or the roster, and
 * the coordination and protocol tools. External MCP tools (`mcp`, `mcp__<server>__<tool>`) are exempt as well: a page or service
 * they observe changes outside the model's view (see `exempt()`).
 */
export const LOOP_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['ShellJob', 'ReadActor', 'ListActors', 'SendMessage', 'AskUserQuestion', 'LoadTools', '_FinishRound']);
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write']);

function exempt(call: ToolCall): boolean {
  const canonical = canonicalToolName(call.name);
  return canonical ? LOOP_EXEMPT_TOOLS.has(canonical) : call.name.toLowerCase() === 'mcp' || call.name.toLowerCase().startsWith('mcp__');
}

/**
 * Per-activity watcher of the model's own repetition. It adds facts to a result (a read that returned exactly what the previous read of
 * the same range returned) and detects one loop (the same call, 3 times in a row, with the same result) so the loop can name itself once.
 * Every call must be observed in model order.
 */
export class RepeatGuard {
  private readonly reads = new Map<string, {key: string; text: string}>();
  private streak = {signature: '', count: 0, reminded: false};

  constructor(private readonly cwd: string) {}

  /** The note to append to a successful text `Read` result that equals the previous result of the same selector, with no Edit or Write of that file in between. */
  readNote(call: ToolCall, result: {readonly text: string; readonly isError: boolean; readonly images?: readonly unknown[] | undefined}): string | undefined {
    const canonical = canonicalToolName(call.name);
    let args: Record<string, unknown>;
    try {args = JSON.parse(call.arguments) as Record<string, unknown>;} catch {return undefined;}
    const path = args && typeof args === 'object' ? args.file_path ?? args.path : undefined;
    if (typeof path !== 'string' || !path) return undefined;
    const key = readPathKey(this.cwd, path);
    if (canonical && WRITE_TOOLS.has(canonical)) {
      for (const [selector, entry] of this.reads) if (entry.key === key) this.reads.delete(selector);
      return undefined;
    }
    if (canonical !== 'Read' || result.isError || result.images?.length) return undefined;
    const selector = JSON.stringify([key, args.offset ?? null, args.limit ?? null]);
    const previous = this.reads.get(selector);
    this.reads.delete(selector);
    this.reads.set(selector, {key, text: result.text});
    if (this.reads.size > READ_MEMORY_LIMIT) this.reads.delete(this.reads.keys().next().value!);
    return previous?.text === result.text ? READ_UNCHANGED_NOTE : undefined;
  }

  /** The reminder for a call that completes a streak of identical calls with unchanged results; once per streak. A waiting Director is left alone, as with the Automa note. */
  loopNote(call: ToolCall, result: {readonly text: string; readonly isError: boolean}, directorWaiting: boolean): string | undefined {
    if (directorWaiting || exempt(call)) {this.streak = {signature: '', count: 0, reminded: false}; return undefined;}
    let args: unknown;
    try {args = canonicalJson(JSON.parse(call.arguments));} catch {args = call.arguments;}
    const signature = createHash('sha256').update(JSON.stringify([canonicalToolName(call.name) ?? call.name, args, result.isError, result.text])).digest('hex');
    this.streak = signature === this.streak.signature ? {...this.streak, count: this.streak.count + 1} : {signature, count: 1, reminded: false};
    if (this.streak.count < LOOP_STREAK || this.streak.reminded) return undefined;
    this.streak.reminded = true;
    return repeatedCallNote(canonicalToolName(call.name) ?? call.name, this.streak.count);
  }
}
