import type {ModelMessage} from './messages.js';
/**
 * Utility for extracting and stripping leading `⏵` self-narration lines.
 *
 * Contract:
 * - A narration line begins with `⏵` at the start of the text (after optional leading whitespace).
 * - Only the first line is extracted as narration.
 * - Narration is capped at 120 display characters, stripped of trailing punctuation.
 * - The remaining text after the narration line (and subsequent empty newlines) is returned as `cleanText`.
 */

export interface ExtractedNarration {
  readonly narration: string;
  readonly cleanText: string;
}

export function extractNarration(text: string): ExtractedNarration | null {
  if (!text) return null;
  const match = /^\s*⏵[ \t]*([^\r\n]+)(?:\r?\n|$)/u.exec(text);
  if (!match) return null;
  const raw = match[1]!.trim();
  if (!raw) return null;
  const narration = raw.replace(/[。．.!！,，、;；]+$/, '').slice(0, 120).trim();
  if (!narration) return null;
  const cleanText = text.slice(match[0].length).replace(/^\r?\n+/, '');
  return {narration, cleanText};
}

export function stripNarration(text: string): string {
  const extracted = extractNarration(text);
  return extracted ? extracted.cleanText : text;
}

/** How a declared stage appears in model-facing history: the same `⏵ <phase>` first line the prompts ask models to write. */
export const STAGE_HISTORY_PREFIX = '⏵ ';

/**
 * Model-facing history: an assistant message that changed the stage opens with `⏵ <text>`. Pure and order-only
 * (a message renders from itself and the messages before it), so the same prefix of history always yields the same bytes.
 * A legacy ledger text that still opens with `⏵` is read as the stage it declared and rendered the same way.
 */
export function withStageLines(messages: readonly ModelMessage[]): ModelMessage[] {
  let current: string | undefined;
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    let stage = message.stage, text = message.text;
    const legacy = extractNarration(text);
    if (legacy) {stage ??= legacy.narration; text = legacy.cleanText;}
    const changed = stage !== undefined && stage !== current;
    if (stage !== undefined) current = stage;
    if (!changed && !legacy) return message;
    return {...message, text: changed ? STAGE_HISTORY_PREFIX + stage + (text ? '\n' + text : '') : text};
  });
}
