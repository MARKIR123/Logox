// The right-docked actor pills: which owners are live, how long a failed actor keeps its pill, who is asking the human, and the
// activation order that decides which pills survive a narrow footer. Effects keep their original order: failed-pill timer first.
import {useEffect, useMemo, useRef, useState} from 'react';
import {isDirector} from '../../runtime/director-id.js';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import type {ActorStyles} from '../appearance/actor-style.js';
import {computeActivePills, FAILED_PILL_MS} from './actor-pills.js';

export function useActivePills({snapshot, sessionId, roles, width, themeVersion}: {snapshot: RuntimeSnapshot; sessionId: string; roles: ActorStyles; width: number; themeVersion: number}) {
  const activeOwners = useMemo(() => {
    const live = snapshot.activities.filter(a => a.sessionId === sessionId && ['running', 'waiting_input', 'paused', 'queued'].includes(a.status) && a.ownerId && !isDirector(a.ownerId) && a.kind !== 'anamnesis');
    return new Set(live.map(a => a.ownerId));
  }, [snapshot.activities, sessionId]);
  // A failed actor keeps its pill briefly; existing failures at mount or session change never count as new.
  const failedSeen = useRef<{sessionId: string; since: Map<string, number>} | null>(null);
  const [pillTick, setPillTick] = useState(0);
  const failedSince = useMemo(() => {
    const failed = snapshot.activities.filter(a => a.sessionId === sessionId && a.status === 'failed' && !isDirector(a.ownerId) && a.kind !== 'anamnesis');
    if (failedSeen.current?.sessionId !== sessionId) failedSeen.current = {sessionId, since: new Map(failed.map(a => [a.activityId, 0] as const))};
    for (const a of failed) if (!failedSeen.current.since.has(a.activityId)) failedSeen.current.since.set(a.activityId, Date.now());
    return failedSeen.current.since;
  }, [snapshot.activities, sessionId]);
  useEffect(() => {
    const live = [...failedSince.values()].filter(since => since > 0 && Date.now() - since < FAILED_PILL_MS);
    if (!live.length) return;
    const timer = setTimeout(() => setPillTick(value => value + 1), Math.min(...live) + FAILED_PILL_MS - Date.now() + 20);
    return () => clearTimeout(timer);
  }, [failedSince, pillTick]);
  const askingOwners = useMemo(() => new Map(snapshot.interactions.filter(item => item.sessionId === sessionId && item.status === 'pending')
    .map(item => [item.ownerId, item.kind === 'permission' ? 'permission' as const : 'question' as const] as const)), [snapshot.interactions, sessionId]);

  const activationOrderRef = useRef<string[]>([]);
  useEffect(() => {
    const current = activationOrderRef.current.filter(id => activeOwners.has(id));
    for (const id of activeOwners) {
      if (!current.includes(id)) current.push(id);
    }
    activationOrderRef.current = current;
  }, [activeOwners]);

  const activePills = useMemo(() => computeActivePills(
    snapshot.activities,
    sessionId,
    roles,
    0,
    width,
    activationOrderRef.current,
    {asking: askingOwners, failedSince, maxWidth: Math.max(0, width - Math.min(width, 14))}
  ), [themeVersion, snapshot.activities, sessionId, roles, width, askingOwners, failedSince, pillTick]);
  return {activePills};
}
