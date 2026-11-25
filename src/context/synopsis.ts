/**
 * The synopsis: the round-memory block a model writes at the very end of its final reply, and the reply text without it.
 * A reply that closes a round without one gets a single follow-up asking only for it (`src/kernel/reply.ts`).
 *
 * ```
 * <synopsis title="Short title">
 * What was concluded or changed, the files involved, what was verified, what remains.
 * </synopsis>
 * ```
 *
 * The ledger keeps the reply exactly as written; every reader splits it here. The timeline folds the block, while the Director's
 * report, the headless final reply and the model's own history drop it (it repeats the round, it adds nothing).
 *
 * The rules are narrow about where a block may stand and lenient about how it is written, because the two failures of the
 * earlier `【轮次摘要】` marker were a missed parse (the user saw the summary) and a false one (a reply that quoted the marker
 * was cut at the quote):
 * - Only the last opening tag counts, and only when it opens a line outside fenced code. A tag quoted mid-sentence, in inline
 *   code or in a fence is reply text.
 * - The block must end the reply: after its closing tag only whitespace may follow. A missing closing tag is tolerated (the
 *   block runs to the end); a closing tag followed by more text means the tag was an example, and nothing is parsed.
 * - The tag name is case-insensitive; the title comes from a `title` attribute or a leading `Title:` / `标题：` line. Caps belong
 *   to round memory, not to this parser.
 * - A block with an empty summary is still removed from the reply; it just carries no memory.
 */

export interface Synopsis {
  readonly title: string;
  readonly summary: string;
}

export interface ParsedReply {
  /** The reply as delivered: everything before the block, trailing whitespace removed (the whole text when there is no block). */
  readonly answer: string;
  /** The block's content, when one ends the reply and its summary is not empty. */
  readonly synopsis?: Synopsis;
}

const OPEN = /^[ \t]*<synopsis\b([^>\n]*)>[ \t]*/iu;
const CLOSE = /<\/synopsis\s*>/iu;
const TITLE_ATTRIBUTE = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;
const TITLE_LINE = /^[ \t]*(?:title|标题)[ \t]*[:：][ \t]*(.*)$/imu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const TAG = '<synopsis';

interface Line {readonly start: number; readonly text: string; readonly fenced: boolean}

/** Every line with its offset and whether it lies inside (or opens or closes) a fenced code block. */
function lines(text: string): Line[] {
  const result: Line[] = [];
  let fence: string | undefined;
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end).replace(/\r$/u, '');
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      result.push({start, text: line, fenced: true});
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
    } else if (marker) {
      fence = marker;
      result.push({start, text: line, fenced: true});
    } else result.push({start, text: line, fenced: false});
    if (newline < 0) break;
    start = newline + 1;
  }
  return result;
}

/** Offset of the last opening tag that starts a line outside fences, with its match. */
function lastOpening(text: string): {readonly at: number; readonly match: RegExpExecArray} | undefined {
  const all = lines(text);
  for (let index = all.length - 1; index >= 0; index--) {
    const line = all[index]!;
    if (line.fenced) continue;
    const match = OPEN.exec(line.text);
    if (match) return {at: line.start, match};
  }
  return undefined;
}

/** The block body after an opening tag, or undefined when a closing tag is followed by more text (the tag was an example). */
function terminalBody(rest: string): string | undefined {
  const close = CLOSE.exec(rest);
  if (!close) return rest;
  if (rest.slice(close.index + close[0].length).trim()) return undefined;
  return rest.slice(0, close.index);
}

export function parseSynopsis(text: string): ParsedReply {
  const opening = lastOpening(text);
  if (!opening) return {answer: text};
  const afterTag = text.slice(opening.at + opening.match[0].length);
  const body = terminalBody(afterTag);
  if (body === undefined) return {answer: text};
  const answer = text.slice(0, opening.at).trimEnd();
  const attribute = TITLE_ATTRIBUTE.exec(opening.match[1] ?? '');
  let title = (attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? '').trim();
  let summary = body.replace(/\r\n/gu, '\n').trim();
  if (!title) {
    const line = TITLE_LINE.exec(summary);
    // Only a title line that opens the block names it; a "Title:" further down is summary text.
    if (line && !summary.slice(0, line.index).trim()) {
      title = line[1]!.trim();
      summary = summary.slice(line.index + line[0].length).trim();
    }
  }
  return summary ? {answer, synopsis: {title, summary}} : {answer};
}

/**
 * What of a reply still being streamed may be shown: everything before a block that would end the reply if the stream stopped
 * here, and never a last line that could still grow into an opening tag. Every result is a prefix of the final `answer` as long
 * as the finished reply ends with a block; a tag that turns out to be an example shows again once text follows its closing tag.
 */
export function visibleWhileStreaming(text: string): string {
  const opening = lastOpening(text);
  if (opening && terminalBody(text.slice(opening.at + opening.match[0].length)) !== undefined) return text.slice(0, opening.at).trimEnd();
  const all = lines(text);
  const last = all.at(-1)!;
  const tail = last.text.trimStart().toLowerCase();
  const growing = !last.fenced && tail && (TAG.startsWith(tail) || tail.startsWith(TAG) && !tail.includes('>'));
  // Trailing blank space is held too: it may turn out to be the gap before a block, which the answer drops.
  return (growing ? text.slice(0, last.start) : text).trimEnd();
}

/** A synopsis written back as the block alone, for the timeline to fold (a closing follow-up's synopsis, live and restored). */
export const synopsisBlock = (synopsis: Synopsis): string =>
  `<synopsis title="${synopsis.title.replace(/"/g, "'")}">\n${synopsis.summary}\n</synopsis>`;
