/** A Director coordination wake that failed only because the provider is temporarily down: the backoff owns it, so it gets no failure card or error event of its own. */
export function isOutageWake(activity: {readonly status: string; readonly coordinationWake?: boolean | undefined; readonly recovery?: {readonly key: string} | undefined}): boolean {
  return activity.status === 'failed' && activity.coordinationWake === true && !!activity.recovery?.key.startsWith('provider:temporary:');
}
