import stringWidth from 'string-width';
/**
 * Extraction of the leading `⏵` status line a model may write at the start of a reply.
 *
 * The line is a courtesy, never a requirement: the card shows what is happening from runtime events and
 * adds this text only when the reply carried it. Rules (each one a fix the `dsh-working-activity` plugin learned the hard way):
 * - Only the first line of the visible reply counts, and the `⏵` must open it (leading blank space is ignored).
 *   Never mid-prose, never from reasoning deltas (callers pass assistant text only).
 * - The text stops at the end of that line or at the first sentence end; what follows a sentence end on the same line stays in the reply.
 * - It is capped by display width (CJK and emoji count two columns) and loses trailing punctuation.
 * - An empty result is no narration.
 */

export interface ExtractedNarration {
  readonly narration: string;
  readonly cleanText: string;
}

/** The marker that opens a status line. */
export const NARRATION_MARK = '⏵';
/** Display columns a status line keeps (about the 20 words the prompt asks for). */
export const NARRATION_MAX_WIDTH = 100;

const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const LEADING = /^\s*⏵[ \t]*/u;
const TRAILING_PUNCTUATION = /[\s.,;:!?、，。．；：！？…·\-–—]+$/u;
/** A sentence end: CJK terminators anywhere, ASCII ones only before whitespace or the end of the line (`pelican-bike.html` is one word). */
const SENTENCE_END = /[。．！？]|[.!?](?=\s|$)/u;

function capWidth(text: string, columns: number): string {
  if (stringWidth(text) <= columns) return text;
  let kept = '', used = 0;
  for (const {segment} of graphemes.segment(text)) {
    const cells = stringWidth(segment);
    if (used + cells > columns) break;
    kept += segment; used += cells;
  }
  return kept;
}

export function extractNarration(text: string): ExtractedNarration | null {
  if (!text) return null;
  const lead = LEADING.exec(text);
  if (!lead) return null;
  const afterMark = text.slice(lead[0].length);
  const lineEnd = afterMark.search(/\r?\n/u);
  const line = lineEnd < 0 ? afterMark : afterMark.slice(0, lineEnd);
  const rest = lineEnd < 0 ? '' : afterMark.slice(lineEnd).replace(/^\r?\n/u, '');
  const end = SENTENCE_END.exec(line);
  const sentence = end ? line.slice(0, end.index) : line;
  const remainder = end ? line.slice(end.index).replace(/^[\s。．！？.!?…]+/u, '').trim() : '';
  const narration = capWidth(sentence.trim(), NARRATION_MAX_WIDTH).replace(TRAILING_PUNCTUATION, '').trim();
  if (!narration) return null;
  const tail = rest.replace(/^(?:[ \t]*\r?\n)+/u, '');
  return {narration, cleanText: remainder ? (tail ? remainder + '\n' + tail : remainder) : tail};
}

/** The reply without its status line. */
export function stripNarration(text: string): string {
  const extracted = extractNarration(text);
  return extracted ? extracted.cleanText : text;
}
