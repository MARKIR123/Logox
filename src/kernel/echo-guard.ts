import type {ModelMessage} from '../runtime/messages.js';
import {UNEXECUTED_CALL_TEXT} from '../runtime/messages.js';
import {AUTOMA_STREAK_NOTE, ECHO_REMINDER, EMPTY_REPLY_REMINDER, SYNOPSIS_CLOSING_TOOL_RESULT, SYNOPSIS_FOLLOW_UP, TEXT_CALL_RECOVERED_NOTE} from '../prompts/runtime/recovery.js';
import {DIRECTOR_INTERRUPTED_TOOL_TEXT, USER_INTERRUPTED_TOOL_TEXT, USER_STEER_NOTICE} from '../prompts/runtime/interruption.js';
import {TOOLS_RESTRICTED_RESULT} from '../prompts/runtime/environment.js';
import {HEADLESS_ANSWER, HEADLESS_DENIAL} from '../prompts/runtime/headless.js';
import {IMAGE_OMITTED_ACTOR_HINT, IMAGE_OMITTED_WORKER_HINT} from '../providers/vision-fallback.js';
import {READ_UNCHANGED_NOTE} from '../tools/ReadTool/prompt.js';

/**
 * Text the runtime itself inserts into model-visible content. A model sometimes repeats such text as its own reply; this module recognises it so the
 * kernel can keep it out of the timeline, the final answer and the reports (`src/kernel/turn-refine.ts`). A marker is recognised by a distinctive
 * fixed prefix or tag (a pattern), by being one of the fixed sentences below (exact text), or because it is the text of a host context message in the
 * request just sent (`requestMarkerTexts`). Normal prose that merely mentions a word such as "Superseded" never matches: every pattern needs its full
 * bracket or tag form.
 */
export interface Marker {
  /** Where the text is produced. */
  readonly source: string;
  /** A cheap literal that must occur in the text before the pattern is tried. */
  readonly hint: string;
  readonly pattern: RegExp;
}

/** The rest of a paragraph: every following line up to the next blank line. */
const REST = '[^\\n]*(?:\\n(?![ \\t]*\\n)[^\\n]*)*';

/** Every literal space of a pattern accepts any run of spaces and tabs, so reflowed echoes still match (the hint keeps only its first word for the same reason). */
const tolerant = (markers: readonly Marker[]): Marker[] =>
  markers.map(marker => ({...marker, hint: marker.hint.split(' ')[0]!, pattern:new RegExp(marker.pattern.source.replace(/ /g, '[ \\t]+'), marker.pattern.flags)}));

export const MARKERS: readonly Marker[] = tolerant([
  {source: 'src/runtime/context-updates.ts:runtimeContextText', hint: '[Application context:',
    pattern: new RegExp('\\[Application context: [a-z-]+; not a human request or new authorization\\]' + REST, 'g')},
  {source: 'src/prompts/compaction.ts:supersededReadText', hint: '[Superseded by a later read',
    pattern: /\[Superseded by a later read of this file \([^)\n]*\); see the newer result\.\]/g},
  {source: 'src/kernel/scratchpad.ts:persistedIndex', hint: '<persisted-output>', pattern: /<persisted-output>[\s\S]*?<\/persisted-output>/g},
  {source: 'src/tools/orchestration/AutomaTool/AutomaTool.ts:resultBlock', hint: '<automa-result', pattern: /<automa-result\b[\s\S]*?<\/automa-result>/g},
  {source: 'src/runtime/messages.ts:normalizeMessages (unpaired tool record)', hint: '[Unpaired tool record',
    pattern: new RegExp('\\[Unpaired tool record, for reference only; does not mean it was re-executed\\]' + REST, 'g')},
  {source: 'src/providers/vision-fallback.ts:imageOmittedText', hint: '[Image omitted:', pattern: /\[Image omitted: [^\]\n]* cannot see images\.\][^\n]*/g},
  {source: 'src/context/images.ts:imageReference', hint: '[image: ', pattern: /\[image: [^\]\n]*\]/g},
  {source: 'src/prompts/runtime/director.ts:RUNTIME_RECORD_LABELS', hint: '[Runtime record of this activity:',
    pattern: new RegExp('\\[Runtime record of this activity: [^\\]\\n]*\\]' + REST, 'g')},
  {source: 'src/prompts/runtime/interruption.ts:USER_INTERRUPT_MARKER, directorStopMarker', hint: '[',
    pattern: new RegExp('\\[(?:Interrupted by user|Stopped by Director)\\]\\n' + REST, 'g')},
  {source: 'src/prompts/runtime/interruption.ts:USER_STEER_NOTICE', hint: '[The user sent this while you were working', pattern: new RegExp(escapeRegex(USER_STEER_NOTICE), 'g')},
  {source: 'src/tools/orchestration/ActorTool/prompt.ts:dispatchedResult', hint: 'Dispatched to ',
    pattern: new RegExp('^Dispatched to [^\\n]* \\(Batch [^)\\n]*\\):' + REST, 'gm')},
  {source: 'src/tools/orchestration/ActorTool/prompt.ts:BRIEF_CHECK_*, briefCheckBlocked', hint: 'Brief check',
    pattern: new RegExp('^Brief check(?::| found gaps;)' + REST, 'gm')},
]);

/** Fixed runtime sentences with no distinctive prefix (left as they are so cached history keeps its bytes); each is matched as exact text. */
export const FIXED_MARKER_TEXTS: readonly {readonly source: string; readonly text: string}[] = [
  {source: 'src/runtime/messages.ts:UNEXECUTED_CALL_TEXT', text: UNEXECUTED_CALL_TEXT},
  {source: 'src/tools/ReadTool/prompt.ts:READ_UNCHANGED_NOTE', text: READ_UNCHANGED_NOTE},
  {source: 'src/prompts/runtime/interruption.ts:USER_INTERRUPTED_TOOL_TEXT', text: USER_INTERRUPTED_TOOL_TEXT},
  {source: 'src/prompts/runtime/interruption.ts:DIRECTOR_INTERRUPTED_TOOL_TEXT', text: DIRECTOR_INTERRUPTED_TOOL_TEXT},
  {source: 'src/prompts/runtime/environment.ts:TOOLS_RESTRICTED_RESULT', text: TOOLS_RESTRICTED_RESULT},
  {source: 'src/prompts/runtime/headless.ts:HEADLESS_DENIAL', text: HEADLESS_DENIAL},
  {source: 'src/prompts/runtime/headless.ts:HEADLESS_ANSWER', text: HEADLESS_ANSWER},
  {source: 'src/prompts/runtime/recovery.ts:EMPTY_REPLY_REMINDER', text: EMPTY_REPLY_REMINDER},
  {source: 'src/prompts/runtime/recovery.ts:SYNOPSIS_CLOSING_TOOL_RESULT', text: SYNOPSIS_CLOSING_TOOL_RESULT},
  {source: 'src/prompts/runtime/recovery.ts:AUTOMA_STREAK_NOTE', text: AUTOMA_STREAK_NOTE},
  {source: 'src/prompts/runtime/recovery.ts:TEXT_CALL_RECOVERED_NOTE', text: TEXT_CALL_RECOVERED_NOTE},
  {source: 'src/prompts/runtime/recovery.ts:ECHO_REMINDER', text: ECHO_REMINDER},
  {source: 'src/prompts/runtime/recovery.ts:SYNOPSIS_FOLLOW_UP', text: SYNOPSIS_FOLLOW_UP},
  {source: 'src/prompts/runtime/ (image hints)', text: IMAGE_OMITTED_WORKER_HINT},
  {source: 'src/prompts/runtime/ (image hints)', text: IMAGE_OMITTED_ACTOR_HINT},
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** A pattern for `text` that tolerates any whitespace differences. */
function flexible(text: string): RegExp {
  return new RegExp(text.trim().split(/\s+/).map(escapeRegex).join('\\s+'), 'g');
}
const FIXED_PATTERNS = FIXED_MARKER_TEXTS.map(item => ({hint: item.text.trim().split(/\s+/)[0]!, pattern: flexible(item.text)}));

/** Host context texts longer than this are kept as known markers (shorter ones would match ordinary words). */
const MIN_KNOWN_LENGTH = 24;
/** At most this many of the latest host context messages of a request count as known markers. */
const KNOWN_CONTEXT_LIMIT = 40;

/** The texts of the host context messages a request carried (reminders, task state, finalizer and the like; the environment baseline is far too large to repeat). */
export function requestMarkerTexts(messages: readonly ModelMessage[]): string[] {
  const texts: string[] = [];
  for (let index = messages.length - 1; index >= 0 && texts.length < KNOWN_CONTEXT_LIMIT; index--) {
    const message = messages[index]!;
    if (message.role === 'context' && message.kind !== 'environment-baseline' && message.text.trim().length >= MIN_KNOWN_LENGTH) texts.push(message.text);
  }
  return texts;
}

/** Longest run of other characters that still lets a reply count as a pure echo. */
export const ECHO_FILLER_LIMIT = 20;

export interface Stripped {
  /** The text without any marker text (blank lines left by a removal are collapsed). */
  readonly text: string;
  /** Marker occurrences removed. */
  readonly matched: number;
  /** Nothing but marker text and at most `ECHO_FILLER_LIMIT` other characters remained. */
  readonly pure: boolean;
}

/** Removes every marker occurrence from `text`. `known` are the host context texts of the request that was just sent (`requestMarkerTexts`). */
export function stripMarkers(text: string, known: readonly string[] = []): Stripped {
  let rest = text, matched = 0;
  const remove = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    rest = rest.replace(pattern, () => {matched++; return '';});
  };
  for (const marker of MARKERS) if (rest.includes(marker.hint)) remove(marker.pattern);
  for (const item of FIXED_PATTERNS) if (rest.includes(item.hint)) remove(item.pattern);
  for (const value of known) {
    const word = value.trim().split(/\s+/)[0]!;
    if (rest.includes(word)) remove(flexible(value));
  }
  if (!matched) return {text, matched: 0, pure: false};
  const cleaned = rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {text: cleaned, matched, pure: cleaned.replace(/\s+/g, '').length <= ECHO_FILLER_LIMIT};
}
