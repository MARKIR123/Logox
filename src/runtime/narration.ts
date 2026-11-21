import stringWidth from 'string-width';
/**
 * Extraction of the leading `⏵` status line a model may write at the start of a reply.
 *
 * The line is a courtesy, never a requirement: the card shows what is happening from runtime events and
 * adds this text only when the reply carried it. Rules (each one a fix the `dsh-working-activity` plugin learned the hard way):
 * - Only the first line of the visible reply counts, and the `⏵` must open it (leading blank space is ignored; a wrapper of backticks or `*`/`**` around the line is tolerated and removed).
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
/** The `⏵`, optionally preceded by whitespace and wrapped in backticks or `*`/`**` (`` `⏵ Drafting` ``, `**⏵ Drafting**`). */
const LEADING = /^\s*([`*]*)[ \t]*⏵[ \t]*/u;
const TRAILING_PUNCTUATION = /[\s.,;:!?、，。．；：！？…·\-–—]+$/u;
const TRAILING_WRAPPED = /[\s.,;:!?、，。．；：！？…·\-–—`*]+$/u;
/** The closing half of a wrapper: backticks or asterisks that end the line or are followed by whitespace. */
const CLOSING_WRAP = /[`*]+(?=\s|$)/u;
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
  let line = lineEnd < 0 ? afterMark : afterMark.slice(0, lineEnd);
  const rest = lineEnd < 0 ? '' : afterMark.slice(lineEnd).replace(/^\r?\n/u, '');
  let after = '';
  if (lead[1]) {
    // A wrapped line ends where its wrapper closes; whatever follows the closing marks is reply text.
    const close = CLOSING_WRAP.exec(line);
    if (close) {after = line.slice(close.index + close[0].length).trim(); line = line.slice(0, close.index);}
  }
  const end = SENTENCE_END.exec(line);
  const sentence = end ? line.slice(0, end.index) : line;
  const afterSentence = end ? line.slice(end.index).replace(/^[\s。．！？.!?…]+/u, '').trim() : '';
  const remainder = [afterSentence, after].filter(Boolean).join(' ');
  const narration = capWidth(sentence.trim(), NARRATION_MAX_WIDTH).replace(lead[1] ? TRAILING_WRAPPED : TRAILING_PUNCTUATION, '').trim();
  if (!narration) return null;
  const tail = rest.replace(/^(?:[ \t]*\r?\n)+/u, '');
  return {narration, cleanText: remainder ? (tail ? remainder + '\n' + tail : remainder) : tail};
}

/** The reply without its status line. */
export function stripNarration(text: string): string {
  const extracted = extractNarration(text);
  return extracted ? extracted.cleanText : text;
}
