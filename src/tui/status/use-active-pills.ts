// The right-docked actor pills: which owners are live, how long a failed actor keeps its pill, who is asking the human, and the
// activation order that decides which pills survive a narrow footer. Effects keep their original order: failed-pill timer first.
import {useEffect, useMemo, useRef, useState} from 'react';
import {isDirector} from '../../runtime/director-id.js';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import type {ActorStyles} from '../appearance/actor-style.js';
import type {ShellJobView} from '../../app/shell-jobs.js';
import {computeActivePills, FAILED_PILL_MS} from './actor-pills.js';
import {useFooterClock} from './use-footer-clock.js';

/** What the jobs pill and its hover detail need of the session's background Shell jobs (the views come from `src/app/shell-jobs.ts`). */
export interface ShellJobsSource {list(): readonly ShellJobView[]; subscribe(listener: () => void): () => void}
/**
 * The session's background Shell jobs, refreshed when one starts, ends or is forgotten and once per second while one runs (the run time in the pill).
 * `running` is what the pill shows: the count and the age of the oldest running job.
 */
export function useShellJobs(source: ShellJobsSource | undefined) {
  const [jobs, setJobs] = useState<readonly ShellJobView[]>(() => source?.list() ?? []);
  useEffect(() => {
    if (!source) {setJobs([]); return;}
    const refresh = () => setJobs(source.list());
    refresh();
    return source.subscribe(refresh);
  }, [source]);
  const running = useMemo(() => jobs.filter(job => job.state === 'running'), [jobs]);
  const [now, setNow] = useState(() => Date.now());
  useFooterClock(running.length > 0, setNow);
  const oldest = running.length ? Math.min(...running.map(job => job.startedAt)) : now;
  return {jobs, running: running.length, pill: running.length ? {count: running.length, oldestMs: Math.max(0, now - oldest)} : undefined};
}

export function useActivePills({snapshot, sessionId, roles, width, themeVersion, jobs}: {snapshot: RuntimeSnapshot; sessionId: string; roles: ActorStyles; width: number; themeVersion: number; jobs?: {readonly count: number; readonly oldestMs: number} | undefined}) {
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
    {asking: askingOwners, failedSince, maxWidth: Math.max(0, width - Math.min(width, 14)), ...(jobs ? {jobs} : {})}
  ), [themeVersion, snapshot.activities, sessionId, roles, width, askingOwners, failedSince, pillTick, jobs?.count, jobs ? Math.floor(jobs.oldestMs / 1000) : 0]);
  return {activePills};
}
