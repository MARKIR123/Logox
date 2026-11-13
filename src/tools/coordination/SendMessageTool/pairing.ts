import {isDirector} from '../../../runtime/director-id.js';
import type {Activity, Message} from '../../../runtime/contracts.js';
import {messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {callArgs} from '../../ui-format.js';

/** What a SendMessage card knows about the conversation it belongs to. */
export interface SendPairing {
  /** The question this message answers or follows up (shown as `Q` before the message itself). */
  readonly question?: string;
  /** For an ask: the reply that closed it. */
  readonly answer?: string;
  readonly answered?: boolean;
  /** For an unanswered ask: its sender's activity is over and the recipient has nothing running, so no reply is coming. */
  readonly ended?: boolean;
}

export interface SendFacts {
  readonly sender: string;
  readonly to: string;
  readonly type: 'inform' | 'ask' | 'reply';
  readonly text: string;
}

const isSend = (message: Message): boolean => message.kind === 'tool' && message.step?.call?.name.toLowerCase() === 'sendmessage';
const failed = (message: Message): boolean => message.step?.state === 'failed' || message.step?.state === 'cancelled' || Boolean(message.step?.disposition);

export function sendFacts(message: Message): SendFacts | undefined {
  const call = messageToolCall(message);
  if (!call || call.name.toLowerCase() !== 'sendmessage') return undefined;
  const args = callArgs(call);
  const type = args.type === 'ask' || args.type === 'reply' ? args.type : 'inform';
  return {sender: message.ownerId, to: String(args.to ?? '').toLowerCase(), type, text: typeof args.message === 'string' ? args.message : ''};
}

/**
 * Actor-to-actor conversations stay out of the Director's timeline: only messages the Director sends or receives are shown there.
 * (Every actor's own window still shows what that actor sent.)
 */
export function hiddenFromView(message: Message, view: string): boolean {
  if (!isDirector(view) || !isSend(message)) return false;
  const facts = sendFacts(message);
  return Boolean(facts) && !isDirector(facts!.sender) && !isDirector(facts!.to);
}

/**
 * Pairs asks with their replies the way the runtime does (`AskBoard.answer`): a reply from B to A closes every open ask
 * from A to B. Replies and follow-up asks carry the question they respond to, so an answer is never shown without it.
 */
export function pairSendMessages(messages: readonly Message[], activities: readonly Pick<Activity, 'sessionId' | 'activityId' | 'ownerId' | 'status'>[] = []): ReadonlyMap<string, SendPairing> {
  const pairs = new Map<string, SendPairing>();
  const open: {id: string; from: string; to: string; text: string}[] = [];
  for (const message of messages) {
    if (!isSend(message) || failed(message)) continue;
    const facts = sendFacts(message);
    if (!facts) continue;
    const owed = open.filter(ask => ask.from === facts.to && ask.to === facts.sender);
    if (facts.type === 'reply') {
      if (owed.length) {
        pairs.set(message.id, {question: owed.at(-1)!.text});
        for (const ask of owed) {
          pairs.set(ask.id, {...pairs.get(ask.id), answered: true, answer: facts.text});
          open.splice(open.indexOf(ask), 1);
        }
      }
      continue;
    }
    if (facts.type === 'ask') {
      open.push({id: message.id, from: facts.sender, to: facts.to, text: facts.text});
      pairs.set(message.id, {answered: false, ...(owed.length ? {question: owed.at(-1)!.text} : {})});
    }
  }
  // An ask nobody answered is "ended" once the asker's activity is over and the recipient has no live work left to answer it.
  const done = (status: string) => status === 'completed' || status === 'failed' || status === 'cancelled';
  const byId = new Map(messages.map(message => [message.id, message]));
  for (const ask of open) {
    const message = byId.get(ask.id), asker = activities.find(item => item.activityId === message?.activityId && item.sessionId === message?.sessionId);
    if (!asker || !done(asker.status)) continue;
    if (activities.some(item => item.sessionId === asker.sessionId && item.ownerId === ask.to && !done(item.status))) continue;
    pairs.set(ask.id, {...pairs.get(ask.id), ended: true});
  }
  return pairs;
}
