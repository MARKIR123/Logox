/**
 * Background Automa jobs: the dispatches an actor started with `mode: "background"`. The tool call returned a receipt at once; this board keeps what
 * is still open for that actor's task (jobs running, waiting or queued, and results nobody has received yet), hands finished results to the
 * dispatcher as one message through the delivery sink it was given, and lets `PeerWait` park the dispatcher with no model requests until the next
 * delivery. It holds no model-visible text of its own beyond the result blocks it is given. In memory only: a restart ends the jobs with the task.
 */

/** Results that finish within this long of the first one waiting go out as one message (one wake). */
export const BACKGROUND_COALESCE_MS = 3000;
/** How soon a delivery that found nobody to receive it is tried again. */
const RETRY_MS = 500;

export interface BackgroundScope {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly activityId: string;
}

/** Where a delivery goes: the dispatcher's running task. Resolves false when it cannot be received now (the board tries again). */
export interface BackgroundSink {
  deliver(text: string, ids: readonly string[]): Promise<boolean> | boolean;
  /** The results of these jobs reached the dispatcher (or were read through `wait`). */
  delivered?(ids: readonly string[]): void;
  /** Overrides `BACKGROUND_COALESCE_MS` (tests). */
  readonly coalesceMs?: number | undefined;
}

export type BackgroundState = 'waiting' | 'queued' | 'running' | 'ended';

export interface BackgroundJob {
  readonly id: string;
  /** The optional handle the dispatcher gave the job; `wait` may name the job by it (case-insensitive). */
  readonly name?: string | undefined;
  readonly title: string;
  state: BackgroundState;
  /** How it ended (`done`, `blocked`, `failed`, `cancelled`, `denied`, `skipped`); set with the block. */
  status?: string;
  /** The runtime's `<automa-result>` block. */
  block?: string;
  delivered: boolean;
  /** A `wait` call is waiting for this job: its result is returned there and never sent as a message. */
  claimed?: boolean;
}

/** One background dispatch. */
export interface BackgroundDispatch {
  readonly scope: BackgroundScope;
  readonly controller: AbortController;
  readonly jobs: ReadonlyMap<string, BackgroundJob>;
}

interface Group extends BackgroundDispatch {
  readonly jobs: Map<string, BackgroundJob>;
  readonly sink: BackgroundSink;
  readonly pending: BackgroundJob[];
  timer: ReturnType<typeof setTimeout> | undefined;
  sending: boolean;
  closed: boolean;
}

export interface Ended {
  readonly id: string;
  readonly status: string;
  readonly block: string;
}

export class BackgroundBoard {
  private readonly groups = new Set<Group>();
  private waiters = new Set<() => void>();

  /** Registers a dispatch whose jobs start as `waiting`, `queued` or `running`. */
  start(scope: BackgroundScope, controller: AbortController, jobs: readonly {id: string; name?: string | undefined; title: string; state: Exclude<BackgroundState, 'ended'>}[], sink: BackgroundSink): BackgroundDispatch {
    const group: Group = {scope, controller, sink, jobs: new Map(jobs.map(job => [job.id, {id: job.id, ...(job.name ? {name: job.name} : {}), title: job.title, state: job.state, delivered: false}])),
      pending: [], timer: undefined, sending: false, closed: false};
    this.groups.add(group);
    this.changed();
    return group;
  }

  /**
   * Jobs of the dispatch ended with their result blocks (a failed job together with the jobs it kept from starting). They go out in one message:
   * at once when one of them is `blocked` or nothing of the dispatch is still open, otherwise when the coalescing window of the first one is over.
   */
  ended(dispatch: BackgroundDispatch, results: readonly Ended[]): void {
    const group = dispatch as Group;
    for (const result of results) {
      const job = group.jobs.get(result.id);
      if (!job || job.state === 'ended') continue;
      job.state = 'ended'; job.status = result.status; job.block = result.block;
      if (!job.delivered && !job.claimed) group.pending.push(job);
    }
    this.changed();
    if (group.closed || !group.pending.length) return;
    const open = [...group.jobs.values()].some(job => job.state !== 'ended');
    if (!open || results.some(result => result.status === 'blocked')) {void this.flushGroup(group); return;}
    group.timer ??= setTimeout(() => {group.timer = undefined; void this.flushGroup(group);}, group.sink.coalesceMs ?? BACKGROUND_COALESCE_MS);
    group.timer.unref?.();
  }

  private async flushGroup(group: Group): Promise<void> {
    if (group.sending || group.closed || !group.pending.length) return;
    if (group.timer) {clearTimeout(group.timer); group.timer = undefined;}
    group.sending = true;
    const batch = group.pending.splice(0);
    let sent = false;
    try {sent = await group.sink.deliver(batch.map(job => job.block ?? '').join('\n\n'), batch.map(job => job.id));} catch {sent = false;}
    finally {group.sending = false;}
    if (group.closed) return;
    if (sent) {
      // A result read through `wait` while this message was on its way counts as delivered either way.
      for (const job of batch) job.delivered = true;
      group.sink.delivered?.(batch.map(job => job.id));
    } else {
      group.pending.unshift(...batch.filter(job => !job.delivered));
      group.timer ??= setTimeout(() => {group.timer = undefined; void this.flushGroup(group);}, RETRY_MS);
      group.timer.unref?.();
    }
    this.changed();
    if (group.pending.length && !group.timer) void this.flushGroup(group);
  }

  /** Delivers what is waiting now (a retry for a delivery that found nobody, and a stalled coalescing window). */
  flush(activityId: string): void {
    for (const group of this.groups) if (group.scope.activityId === activityId && group.pending.length && !group.timer) void this.flushGroup(group);
  }

  /** Jobs of this task whose results the dispatcher has not received: running, waiting, queued, or ended and not yet delivered. */
  outstanding(activityId: string): readonly BackgroundJob[] {
    return [...this.groups].filter(group => group.scope.activityId === activityId && !group.closed)
      .flatMap(group => [...group.jobs.values()].filter(job => !job.delivered));
  }

  /** True while any background job of the session is open (headless runs do not settle before it ends). */
  open(sessionId: string): boolean {
    return [...this.groups].some(group => group.scope.sessionId === sessionId && !group.closed && [...group.jobs.values()].some(job => !job.delivered));
  }

  /** The jobs of this dispatcher's task the call may wait for; ids it does not know come back in `unknown`. */
  find(scope: BackgroundScope, ids: readonly string[]): {readonly found: readonly {group: BackgroundDispatch; job: BackgroundJob}[]; readonly unknown: readonly string[]; readonly known: readonly string[]} {
    const mine = [...this.groups].filter(group => group.scope.sessionId === scope.sessionId && group.scope.ownerId === scope.ownerId && group.scope.activityId === scope.activityId);
    const all = new Map(mine.flatMap(group => [...group.jobs.values()].map(job => [job.id, {group: group as BackgroundDispatch, job}] as const)));
    // An id, or a name (case-insensitive); the same job named twice is returned once.
    const named = new Map([...all.values()].flatMap(item => item.job.name ? [[item.job.name.toLowerCase(), item] as const] : []));
    const lookup = (ref: string) => all.get(ref) ?? all.get(ref.trim().toUpperCase()) ?? named.get(ref.trim().toLowerCase());
    const found = [...new Set(ids.flatMap(id => lookup(id) ?? []))];
    return {found, unknown: ids.filter(id => !lookup(id)), known: [...all.keys()]};
  }

  /** The names of this dispatcher's background jobs of the task that have not ended, as `lower-case name -> id`: a worker that ends is shelved and its name is held there. */
  names(scope: BackgroundScope): Map<string, string> {
    const open = new Map<string, string>();
    for (const group of this.groups) {
      if (group.closed || group.scope.sessionId !== scope.sessionId || group.scope.ownerId !== scope.ownerId || group.scope.activityId !== scope.activityId) continue;
      for (const job of group.jobs.values()) if (job.name && job.state !== 'ended') open.set(job.name.toLowerCase(), job.id);
    }
    return open;
  }

  /** Resolves when every named job has ended; rejects with the signal's reason. Never sends a request. */
  async untilEnded(jobs: readonly BackgroundJob[], signal: AbortSignal): Promise<void> {
    while (jobs.some(job => job.state !== 'ended')) await this.nextChange(60_000, signal);
  }

  /** A `wait` call starts waiting for these jobs: they leave the delivery batch and are not delivered by message, whenever they end. */
  claim(jobs: readonly BackgroundJob[]): void {
    for (const job of jobs) {
      job.claimed = true;
      for (const group of this.groups) {const at = group.pending.indexOf(job); if (at >= 0) group.pending.splice(at, 1);}
    }
  }

  /** The `wait` call ended without taking the jobs (cancelled): results already in are delivered by message after all. */
  unclaim(jobs: readonly {group: BackgroundDispatch; job: BackgroundJob}[]): void {
    for (const {group, job} of jobs) {
      if (!job.claimed) continue;
      job.claimed = false;
      if (job.state === 'ended' && !job.delivered && !(group as Group).closed) {(group as Group).pending.push(job); void this.flushGroup(group as Group);}
    }
  }

  /** The named jobs' results are taken by a `wait` call: they leave the delivery batch and count as delivered. */
  take(jobs: readonly {group: BackgroundDispatch; job: BackgroundJob}[]): void {
    const byGroup = new Map<Group, string[]>();
    for (const {group, job} of jobs) {
      if (job.state !== 'ended' || job.delivered) continue;
      job.delivered = true;
      const owner = group as Group;
      const at = owner.pending.indexOf(job);
      if (at >= 0) owner.pending.splice(at, 1);
      byGroup.set(owner, [...byGroup.get(owner) ?? [], job.id]);
    }
    for (const [group, ids] of byGroup) group.sink.delivered?.(ids);
    this.changed();
  }

  /** The dispatcher's task ended, however it ended: its background jobs are cancelled and nothing is delivered any more. */
  cancelActivity(activityId: string): void {
    for (const group of [...this.groups]) {
      if (group.scope.activityId !== activityId) continue;
      group.closed = true;
      if (group.timer) {clearTimeout(group.timer); group.timer = undefined;}
      group.controller.abort(new Error('The dispatcher\'s task ended.'));
      this.groups.delete(group);
    }
    this.changed();
  }

  /** Cancels every background dispatch of a session (the session closes). */
  cancelSession(sessionId: string): void {
    for (const group of [...this.groups]) if (group.scope.sessionId === sessionId) this.cancelActivity(group.scope.activityId);
  }

  /** Resolves at the next change of any job, or after `ms`; rejects when the signal aborts. */
  nextChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {reject(signal.reason); return;}
      const done = () => {clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.waiters.delete(done); resolve();};
      const onAbort = () => {clearTimeout(timer); this.waiters.delete(done); reject(signal!.reason);};
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  private changed(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }
}
