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
