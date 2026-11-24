/** A Director coordination wake that failed only because the provider is temporarily down: the backoff owns it, so it gets no failure card or error event of its own. */
export function isOutageWake(activity: {readonly status: string; readonly coordinationWake?: boolean | undefined; readonly recovery?: {readonly key: string} | undefined}): boolean {
  return activity.status === 'failed' && activity.coordinationWake === true && !!activity.recovery?.key.startsWith('provider:temporary:');
}
/** Text of the silent, unpersisted marker that closes an outage wait (the wake recovered, a person wrote or the Director was stopped). */
export const OUTAGE_ENDED_TEXT = '[Network] Outage wait ended';
const OUTAGE_WAITING = /^\[Network\] Waiting for /;
/**
 * Ids of the `[Network] Waiting for <provider> · retry in …` lines the timeline must not draw: a wait notice is live only until its outage ends, so one is hidden once a later
 * end marker exists, and every one restored from `events.json` (a replayed or resumed session is not waiting). The ledger keeps them all.
 */
export function hiddenOutageNotices(messages: readonly {readonly id: string; readonly role: string; readonly text: string; readonly systemReplay?: boolean | undefined}[]): ReadonlySet<string> {
  const hidden = new Set<string>(), waiting: string[] = [];
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (message.text === OUTAGE_ENDED_TEXT) {for (const id of waiting) hidden.add(id); waiting.length = 0;}
    else if (OUTAGE_WAITING.test(message.text)) {if (message.systemReplay) hidden.add(message.id); else waiting.push(message.id);}
  }
  return hidden;
}
