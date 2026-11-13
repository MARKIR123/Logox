import type {Message, Step} from '../../runtime/contracts.js';
import {extractNarration} from '../../runtime/narration.js';
import {isVisibleToolMessage} from '../../tools/ui-registry.js';
import {messageToolCall} from './tool-ui.js';
import {messageCardTitle} from './tool-card.js';

/**
 * What an actor's card says it is doing right now, from facts the runtime already has. Two layers:
 * 1. always: the running tool (its own card title, plus a count when a batch runs several) or the thinking state, with a live clock;
 * 2. when the model offered it: the `⏵` line of its CURRENT reply (the reply that began after the latest request started).
 * A reply that wrote none leaves layer 1 alone; nothing here ever reminds or enforces. Reasoning text never feeds it.
 */
export interface LiveStatus {
  /** The current reply's own `⏵` line, when it wrote one. */
  readonly narration?: string;
  /** Layer 1: the running tool (`Read(a.ts) +2` for a batch) or, with no narration, the thinking or drafting state. */
  readonly activity?: string;
  /** When the clocked work started; the card draws `now - clockStart` live. Absent when there is nothing to time. */
  readonly clockStart?: number;
}

/** `Writing Edit(file.svg) · 14.2k chars`: what a request is doing while a tool call's arguments stream in. */
export function draftingLabel(drafting: NonNullable<Step['drafting']>): string {
  const file = drafting.target?.split(/[\\/]/).filter(Boolean).at(-1);
  const chars = drafting.chars < 1000 ? String(drafting.chars) : (drafting.chars / 1000).toFixed(drafting.chars < 100_000 ? 1 : 0) + 'k';
  return `Writing ${drafting.tool}${file ? '(' + file + ')' : ''} · ${chars} chars`;
}

const running = (step: Step | undefined): step is Step => step?.state === 'running';
const startOf = (step: Step): number | undefined => step.runningSince === undefined ? undefined : step.runningSince - step.elapsedMs;
/** A request's own thinking step: the boundary that opens a reply (a draft step has no group). */
const opensReply = (message: Message): boolean => message.kind === 'thinking' && message.step?.groupId !== undefined;

/** `messages` are the activity's messages in order (narration-only ones included). Undefined when nothing is happening yet. */
export function liveStatus(messages: readonly Message[]): LiveStatus | undefined {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (opensReply(messages[index]!)) {boundary = index; break;}
  const reply = messages.slice(boundary + 1);
  // The narration belongs to the reply that wrote it: a newer request has already opened (the boundary), so older text is not looked at.
  const narration = reply.findLast(message => message.role === 'assistant' && !message.kind && extractNarration(message.text))?.text;
  const line = narration ? extractNarration(narration)?.narration : undefined;
  const tools = messages.filter(message => message.kind === 'tool' && running(message.step) && isVisibleToolMessage(message));
  const first = tools[0];
  const call = first ? messageToolCall(first) : undefined;
  if (first && call) {
    const text = messageCardTitle(first, call).replace(/\s+/g, ' ').trim() + (tools.length > 1 ? ` +${tools.length - 1}` : '');
    const start = startOf(first.step!);
    return {...(line ? {narration: line} : {}), activity: text, ...(start !== undefined ? {clockStart: start} : {})};
  }
  if (line) return {narration: line};
  // No tool runs: the model is generating. A streaming tool call shows what it is writing, otherwise the thinking state.
  const drafting = messages.slice(Math.max(0, boundary)).findLast(message => message.kind === 'thinking' && running(message.step) && message.step.drafting);
  const thinking = boundary >= 0 && running(messages[boundary]!.step) ? messages[boundary]! : drafting;
  const step = drafting?.step ?? thinking?.step;
  if (!step || !running(step)) {
    const last = reply.at(-1);
    return last?.role === 'assistant' && !last.kind && last.text.trim() ? {activity: 'Replying'} : undefined;
  }
  const start = startOf(step);
  return {activity: step.drafting ? draftingLabel(step.drafting) : 'Thinking', ...(start !== undefined ? {clockStart: start} : {})};
}

/** The status as one plain line (`narration · activity`), for places without a clock such as the pill hover detail. */
export function liveStatusLine(status: LiveStatus | undefined): string | undefined {
  if (!status) return undefined;
  return [status.narration, status.activity].filter(Boolean).join(' · ') || undefined;
}
