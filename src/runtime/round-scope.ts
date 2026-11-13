import {DIRECTOR_ID, isDirector} from './director-id.js';
import type {Activity} from './contracts.js';
import {inputKind, type InputKind} from './provenance.js';

const OPEN = new Set(['queued', 'running', 'waiting_input', 'paused']);
export const isOpenActivity = (activity: Pick<Activity, 'status'>): boolean => OPEN.has(activity.status);

/** How long the second Esc in the Logox window keeps its second meaning ("stop the dispatched actors"). */
export const ESC_STOP_WINDOW_MS = 2000;

export interface RoundScope {
  /** The running (or queued) Logox round, when there is one. */
  readonly director: Activity | undefined;
  /** Open companion activities that belong to Logox's work, queued ones first. */
  readonly actors: readonly Activity[];
}

/**
 * What Esc in the Logox window can stop: the Logox round, and every open companion activity that Logox's work produced
 * (dispatches, `after`-queued tasks, nested dispatches, wake and collaboration activities). Work the user started in an
 * actor's own window (`inputKind: human`), and anything nested under it, is never included.
 */
export function roundScope(activities: readonly Activity[], sessionId: string): RoundScope {
  const mine = activities.filter(item => item.sessionId === sessionId);
  const byId = new Map(mine.map(item => [item.activityId, item]));
  const director = mine.findLast(item => isDirector(item.ownerId) && isOpenActivity(item) && item.status !== 'paused' && item.status !== 'queued') ??
    mine.findLast(item => isDirector(item.ownerId) && item.status === 'queued');
  const userStarted = (item: Activity): boolean => !isDirector(item.ownerId) &&
    inputKind({ownerId: item.ownerId, ...(item.inputKind ? {inputKind: item.inputKind} : {}), source: item.inputKind ? undefined : DIRECTOR_ID}) === 'human';
  const fromUser = (item: Activity): boolean => {
    const seen = new Set<string>();
    for (let at: Activity | undefined = item; at && !seen.has(at.activityId); at = byId.get(at.parentActivityId ?? '')) {
      seen.add(at.activityId);
      if (userStarted(at)) return true;
    }
    const root = item.rootActivityId ? byId.get(item.rootActivityId) : undefined;
    return root ? userStarted(root) : false;
  };
  const rank = (item: Activity) => item.status === 'running' || item.status === 'waiting_input' ? 1 : 0;
  const actors = mine.filter(item => !isDirector(item.ownerId) && item.kind === 'actor' && isOpenActivity(item) && !fromUser(item));
  return {director, actors: [...actors].sort((a, b) => rank(a) - rank(b))};
}

/** What the end of an activity means for its owner's round: it closes it, leaves it open (a Director whose dispatched work is still open), or is no round at all. */
export type RoundEffect = 'closes' | 'suspends' | 'aside';

/**
 * The Director's round spans everything it does until an activity ends with none of its dispatched work open (paused batches included),
 * so an activity that ends earlier only suspends it. A companion's rounds are Director dispatches and tasks the human started in its
 * own window; an activity a teammate's message started while it was idle is an aside.
 */
export function roundEffect(activities: readonly Activity[], sessionId: string, ownerId: string, kind: InputKind): RoundEffect {
  if (isDirector(ownerId)) return roundScope(activities, sessionId).actors.length ? 'suspends' : 'closes';
  return kind === 'director' || kind === 'human' ? 'closes' : 'aside';
}

/** Distinct display names of the scope's actors, sorted. */
export function workingNames(actors: readonly Activity[], name: (ownerId: string) => string): string[] {
  return [...new Set(actors.map(item => name(item.ownerId)))].sort((a, b) => a.localeCompare(b));
}

const list = (names: readonly string[]) => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);

/** Notice after the first Esc stopped the Logox round; `names` are the actors still working. */
export const logoxStoppedNotice = (names: readonly string[]): string =>
  names.length ? `■ Logox stopped · ${names.join(', ')} still working · press Esc again to stop ${names.length === 1 ? 'it' : 'them'}` : '■ Logox stopped';
/** Notice when Logox is idle but dispatched actors are working. */
export const actorsWorkingNotice = (names: readonly string[]): string =>
  `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} working · press Esc again to stop ${names.length === 1 ? 'it' : 'them'}`;
/** Notice after the second Esc. */
export const actorsStoppedNotice = (names: readonly string[]): string => `■ Stopped ${list(names)}`;
