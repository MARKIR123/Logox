import {createHash} from 'node:crypto';
import {AUTOMA_STREAK_NOTE} from '../prompts/runtime/recovery.js';
import type {ToolCall} from '../runtime/messages.js';
import {canonicalToolName} from '../tools/types.js';
import type {ToolResult} from '../tools/tools.js';
import {canonicalJson} from './execution-recovery.js';

/** Identical observations allowed in one run, while teammates work, before the caller's tools are withdrawn. */
export const REPEAT_LIMIT = 3;
/** Consecutive read-only calls before the single Automa reminder of a run. */
export const AUTOMA_STREAK = 6;

const OBSERVATIONS = new Set(['read', 'glob', 'grep']);

/**
 * Watches one agent run's tool calls. Prompts alone did not stop a waiting Director from re-checking the disk,
 * and a model that never thinks of Automa gets one reminder at the moment it would help.
 */
export class ToolPacing {
  private readonly seen = new Set<string>();
  private repeats = 0;
  private streak = 0;
  private reminded = false;

  /** The caller has repeated itself enough: the next request offers only the round closer. */
  get withdrawn(): boolean { return this.repeats >= REPEAT_LIMIT; }

  /** New input arrived or a hook fired, so the caller has something fresh to act on. */
  reset(): void { this.seen.clear(); this.repeats = 0; }

  /** Returns a note to append to the result the model sees, if any. */
  observe(call: ToolCall, result: ToolResult, state: {readonly waiting: 'director' | 'companion' | undefined; readonly automaOffered: boolean}): string | undefined {
    const name = (canonicalToolName(call.name) ?? call.name).toLowerCase();
    if (!OBSERVATIONS.has(name)) { this.streak = 0; return; }
    if (result.isError) return;
    if (state.waiting) {
      const key = fingerprint(name, call.arguments, result.text);
      if (this.seen.has(key)) {
        this.repeats++;
        return;
      }
      this.seen.add(key);
      if (state.waiting === 'director') return;
    }
    if (++this.streak < AUTOMA_STREAK || this.reminded || !state.automaOffered) return;
    this.reminded = true;
    return AUTOMA_STREAK_NOTE;
  }
}

function fingerprint(name: string, args: string, text: string): string {
  let parsed: unknown = args;
  try { parsed = canonicalJson(JSON.parse(args)); } catch {}
  return createHash('sha256').update(JSON.stringify([name, parsed, text])).digest('hex');
}
