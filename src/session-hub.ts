/**
 * Multi-session kernel for GUI adapters. One hub owns the project services (through `ProjectHost`) and runs any number of
 * sessions side by side; a handle exposes only what the GUI may read, and every action names its session explicitly.
 *
 * The selected tab, selected id and layout belong to the adapter. Opening or closing B never pauses, closes or cancels A,
 * and an action without a valid target fails with a code instead of falling back to another session.
 */
import {randomUUID} from 'node:crypto';
import {DIRECTOR_ID} from './runtime/director-id.js';
import {InputRejected} from './runtime/input-rejected.js';
import type {RuntimeSnapshot} from './runtime/contracts.js';
import type {InteractionResponse} from './runtime/contracts.js';
import type {SubmitDelivery} from './runtime/delivery.js';
import {ProjectHost, type SessionApplication} from './project-host.js';
import type {ApplicationOptions} from './application.js';
import {createSessionApplication} from './application.js';
import type {SessionLease} from './store/sessions.js';
import {PLAN_USER, type DerivedPlan, type PlanOp} from './runtime/plan.js';
import type {PlanApply} from './store/plans.js';

export type SessionHubErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_CLOSING' | 'SESSION_IN_USE' | 'SESSION_FAILED' | 'HUB_CLOSED';
export class SessionHubError extends Error {
  constructor(readonly code: SessionHubErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionHubError';
  }
}

/** Lifecycle of one id in the merged list: disk-only entries are `available`. */
export type SessionListState = 'available' | 'opening' | 'open' | 'closing' | 'failed';

/** JSON-serializable, immutable summary; the GUI renders tabs and badges from this alone. */
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly created: number;
  readonly updated: number;
  readonly persistent: boolean;
  readonly state: SessionListState;
  readonly active: number;
  readonly queued: number;
  readonly pendingApprovals: number;
  readonly pendingQuestions: number;
  readonly busy: boolean;
  readonly waiting: boolean;
  readonly error?: string;
}

export interface SessionHubSnapshot {
  readonly revision: number;
  readonly sessions: readonly SessionSummary[];
  readonly issues: readonly string[];
  /**
   * Changes whenever any open session's plans change: their content (a person's edit, an op) or their derived progress (a node turning running, done or failed).
   * An adapter that shows plans re-reads `plans(id)` when this moves; it never moves for anything else.
   */
  readonly plansRevision: number;
}

/** The only mutable-state-free view of a session given to the GUI. */
export interface SessionHandle {
  readonly id: string;
  getSnapshot(): RuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  /** The legacy session-status revision; changes when meters, subscriptions or model state change. */
  getStatusSnapshot(): string;
  subscribeStatus(listener: () => void): () => void;
}

export interface SessionHub {
  create(): Promise<SessionHandle>;
  open(id: string): Promise<SessionHandle>;
  getSession(id: string): SessionHandle | undefined;
  getSnapshot(): SessionHubSnapshot;
  /** Catalog changes (new history entries, disk edits) are picked up here; live counts need no refresh. */
  refresh(): Promise<SessionHubSnapshot>;
  subscribe(listener: () => void): () => void;
  rename(id: string, title: string): Promise<void>;
  submit(id: string, text: string, source?: string, delivery?: SubmitDelivery): Promise<void>;
  respond(id: string, response: InteractionResponse): {ok: true} | {ok: false; reason: string};
  /** Cancels one activity of that session; false when the id is not an activity of it. */
  cancel(id: string, activityId: string): boolean;
  cancelTool(id: string, callId: string): boolean;
  sendPendingNow(id: string, pendingId: string): Promise<boolean>;
  discardPending(id: string, pendingId: string): string | undefined;
  /** The plans of an open session with statuses derived from the work linked to their nodes (JSON-serializable). */
  plans(id: string): readonly DerivedPlan[];
  /** One plan edit made by the person (actor `user`, who may do anything the Director may); refused ops answer with the fix, nothing throws for them. */
  planOp(id: string, op: PlanOp): Promise<PlanApply>;
  noteDraft(id: string): void;
  close(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

interface CatalogEntry {title: string; created: number; updated: number}
interface Persistence {saved: boolean; save(): Promise<void>}
interface Live {
  readonly id: string;
  state: SessionListState;
  app: SessionApplication | undefined;
  lease: SessionLease | undefined;
  persistence: Persistence;
  title: string | undefined;
  error: string | undefined;
  created: number;
  updated: number;
  opening: Promise<void> | undefined;
  closing: Promise<void> | undefined;
  stopData: (() => void) | undefined;
  stopStatus: (() => void) | undefined;
  stopPlans: (() => void) | undefined;
}

const EMPTY_SNAPSHOT: RuntimeSnapshot = Object.freeze({revision: 0, pending: [], activities: [], interactions: [], messages: []});
const SWITCH_COMMANDS = /^\/(new|resume|rewind|clear)(?:\s|$)/;
const TTY_COMMANDS = /^\/(login|setup)(?:\s|$)/;

function inUse(error: unknown): boolean {
  return /in use|lock owner|another process/i.test(error instanceof Error ? error.message : String(error));
}

export async function createSessionHub(options: ApplicationOptions): Promise<SessionHub> {
  // The hub serves real concurrent sessions: rule buckets are strict, so no session ever reads another's grants.
  const host = await ProjectHost.open(options, createSessionApplication);
  host.permissions.isolateSessions();
  const {manager, journal, tools, permissions, extensions} = host;
  const live = new Map<string, Live>(), handles = new Map<string, SessionHandle>();
  const catalog = new Map<string, CatalogEntry>();
  const listeners = new Set<() => void>();
  let issues: readonly string[] = [];
  let closed = false, signature = '', revision = 0, plansSignature = '', plansRevision = 0;
  let snapshot: SessionHubSnapshot | undefined;
  let closeAll: Promise<void> | undefined;

  try {
    const listed = await manager.list();
    for (const info of listed.sessions) catalog.set(info.id, {title: info.title, created: info.created, updated: info.updated});
    issues = listed.issues;
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }

  const publish = (): void => {
    const merged = new Map<string, CatalogEntry>();
    for (const [id, entry] of catalog) merged.set(id, entry);
    const sessions: SessionSummary[] = [];
    for (const entry of live.values()) {
      const base = merged.get(entry.id);
      if (base === undefined) merged.set(entry.id, {title: entry.title ?? 'New session', created: entry.created, updated: entry.updated});
      else if (entry.title !== undefined) base.title = entry.title;
    }
    for (const [id, entry] of merged) {
      const running = live.get(id);
      const app = running?.app;
      let active = 0, queued = 0, approvals = 0, questions = 0, busy = false, retrying = false;
      if (app) {
        try {
          const state = app.store.getSnapshot();
          active = state.activities.filter(activity => activity.status === 'running' || activity.status === 'waiting_input').length;
          queued = state.activities.filter(activity => activity.status === 'queued').length + state.pending.length;
          approvals = state.interactions.filter(item => item.status === 'pending' && item.kind === 'permission').length;
          questions = state.interactions.filter(item => item.status === 'pending' && item.kind === 'question').length;
          retrying = state.activities.some(activity => activity.phase === 'retry' && ['running', 'waiting_input'].includes(activity.status));
          busy = app.isBusy();
        } catch {}
      }
      sessions.push(Object.freeze({id, title: running?.title ?? (app ? entry.title : entry.title), created: entry.created, updated: running?.updated ?? entry.updated,
        persistent: running ? Boolean(app?.isPersistent()) : true, state: running?.state ?? 'available', active, queued,
        pendingApprovals: approvals, pendingQuestions: questions, busy: busy || active + queued + approvals + questions > 0,
        waiting: queued + approvals + questions > 0 || retrying || (busy && active === 0), ...(running?.error ? {error: running.error} : {})}));
    }
    sessions.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    // Plans are part of the picture only for open sessions that have any: the signature is empty otherwise, so a session without a plan costs nothing here.
    const plansNow = JSON.stringify([...live.values()].flatMap(entry => {
      if (!entry.app) return [];
      try {const plans = entry.app.plans.signature(); return plans === '[]' ? [] : [[entry.id, plans]];} catch {return [];}
    }));
    if (plansNow !== plansSignature) {plansSignature = plansNow; plansRevision += 1;}
    const next = JSON.stringify([issues, sessions, plansRevision]);
    if (next === signature) return;
    signature = next;
    revision += 1;
    snapshot = Object.freeze({revision, sessions: Object.freeze(sessions), issues, plansRevision});
    for (const listener of listeners) listener();
  };

  const handleFor = (entry: Live): SessionHandle => {
    const existing = handles.get(entry.id);
    if (existing) return existing;
    const handle: SessionHandle = {
      id: entry.id,
      getSnapshot: () => entry.app?.store.getSnapshot() ?? EMPTY_SNAPSHOT,
      subscribe: listener => entry.app?.store.subscribe(listener) ?? (() => {}),
      getStatusSnapshot: () => entry.app?.getStatusSnapshot() ?? '0',
      subscribeStatus: listener => entry.app?.subscribeStatus(listener) ?? (() => {}),
    };
    Object.freeze(handle);
    handles.set(entry.id, handle);
    return handle;
  };

  const persistenceFor = async (id: string, title: () => string | undefined): Promise<Persistence> => {
    let saving: Promise<void> | undefined;
    const state: Persistence = {saved: await manager.hasContent(id), async save() {
      if (state.saved) return;
      saving ??= (async () => {
        // A title chosen while the session was blank is not a reason to persist the session, but the first real task keeps it.
        await manager.touch(id, title());
        await manager.remember(id);
        state.saved = true;
      })();
      try {await saving;} finally {saving = undefined;}
    }};
    return state;
  };

  const rememberInfo = async (entry: Live): Promise<void> => {
    const info = await manager.info(entry.id);
    if (!info) return;
    entry.title = info.title;
    entry.updated = info.updated;
    entry.created = info.created;
    catalog.set(entry.id, {title: info.title, created: info.created, updated: info.updated});
  };

  const fail = (entry: Live, error: unknown, code: SessionHubErrorCode = 'SESSION_FAILED'): SessionHubError => {
    entry.state = 'failed';
    entry.error = error instanceof Error ? error.message : String(error);
    publish();
    return error instanceof SessionHubError ? error : new SessionHubError(code, entry.error, {cause: error});
  };

  const load = async (entry: Live): Promise<void> => {
    let lease: SessionLease | undefined, app: SessionApplication | undefined;
    try {
      lease = await manager.acquire(entry.id);
      entry.lease = lease;
      app = await host.createSession({sessionId: entry.id, sessionCommand: switchCommand, beforeTask: () => entry.persistence.save(),
        isPersistent: () => entry.persistence.saved, interactive: false});
      entry.app = app;
      entry.stopData = app.store.subscribe(() => publish());
      entry.stopStatus = app.subscribeStatus(() => publish());
      entry.stopPlans = app.plans.subscribe(() => publish());
      if (entry.persistence.saved) {await manager.touch(entry.id); await manager.remember(entry.id); await rememberInfo(entry);}
      app.activate();
      entry.state = 'open';
      publish();
      try {if (await journal.pending(entry.id)) app.systemNotice('This session has an unfinished rewind. Use /rewind to retry the same target; no new model tasks start until it completes.');}
      catch {}
    } catch (error) {
      try {await app?.close();} catch (closeError) {
        // The writer did not confirm it stopped: keep the lease so a second writer cannot start on half-released state.
        fail(entry, closeError);
        throw fail(entry, error);
      }
      // The writer confirmed it stopped: only now release the half-built session's registrations and lease.
      try {await tools.releaseSession(entry.id);} catch {}
      try {await extensions.mcp.releaseSession(entry.id);} catch {}
      permissions.clearSession(entry.id);
      try {await lease?.release();} catch {}
      entry.lease = undefined;
      throw fail(entry, error, inUse(error) ? 'SESSION_IN_USE' : 'SESSION_FAILED');
    }
  };

  const beginOpen = (id: string): Live => {
    const existing = live.get(id);
    if (existing) return existing;
    const now = Date.now();
    const entry: Live = {id, state: 'opening', persistence: {saved: false, async save() {}}, created: now, updated: now,
      app: undefined, lease: undefined, title: undefined, error: undefined, opening: undefined, closing: undefined, stopData: undefined, stopStatus: undefined, stopPlans: undefined};
    live.set(id, entry);
    return entry;
  };

  const start = (entry: Live): Promise<void> => {
    // Concurrent opens of one id share the acquisition and session build; only the first caller starts it.
    if (entry.opening) return entry.opening;
    entry.state = 'opening';
    entry.error = undefined;
    // The persistence closure is created before the session can start a task; a blank session stays blank until then.
    const opening = (async () => {
      entry.persistence = await persistenceFor(entry.id, () => entry.title);
      await load(entry);
    })();
    entry.opening = opening;
    opening.catch(() => {entry.opening = undefined;});
    return opening;
  };

  const ready = async (id: string): Promise<Live> => {
    if (closed) throw new SessionHubError('HUB_CLOSED', 'The session hub is closed');
    const entry = live.get(id);
    if (!entry) throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown session: ' + id);
    if (entry.state === 'opening') await entry.opening?.catch(() => {});
    if (entry.state === 'closing') throw new SessionHubError('SESSION_CLOSING', 'The session is closing: ' + id);
    if (entry.state === 'failed') throw new SessionHubError('SESSION_FAILED', entry.error ?? 'The session failed to open: ' + id);
    if (entry.state !== 'open' || !entry.app) throw new SessionHubError('SESSION_CLOSING', 'The session is not open: ' + id);
    return entry;
  };

  function switchCommand(text: string): Promise<boolean> {
    throw new InputRejected('Session switching is managed by the GUI adapter: ' + text);
  }

  const closeLive = (entry: Live): Promise<void> => {
    if (entry.closing) return entry.closing;
    entry.state = 'closing';
    publish();
    const task = (async () => {
      const failures: unknown[] = [];
      let appClosed = entry.app === undefined;
      if (entry.app) {
        try {await entry.app.close(); appClosed = true;} catch (error) {failures.push(error);}
      }
      if (appClosed) {
        // The session runtime confirmed it stopped; only then release its scoped registrations and writer lease.
        try {await tools.releaseSession(entry.id);} catch (error) {failures.push(error);}
        try {await extensions.mcp.releaseSession(entry.id);} catch (error) {failures.push(error);}
        permissions.clearSession(entry.id);
        if (entry.lease) try {await entry.lease.release(); entry.lease = undefined;} catch (error) {failures.push(error);}
        entry.stopData?.(); entry.stopStatus?.(); entry.stopPlans?.();
        entry.stopData = undefined; entry.stopStatus = undefined; entry.stopPlans = undefined;
        live.delete(entry.id);
        handles.delete(entry.id);
        if (entry.persistence.saved) {
          const info = await manager.info(entry.id).catch(() => undefined);
          if (info) catalog.set(entry.id, {title: info.title, created: info.created, updated: info.updated});
        }
      } else {
        // The writer did not confirm it stopped: keep the lease, registrations and subscriptions for a close retry.
        entry.state = 'failed';
        entry.error = failures[0] instanceof Error ? failures[0].message : String(failures[0] ?? 'Session close did not complete');
      }
      publish();
      if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Session close did not complete');
    })();
    entry.closing = task;
    task.catch(() => {entry.closing = undefined;}).finally(() => {if (entry.closing === task) entry.closing = undefined;});
    return task;
  };

  const hub: SessionHub = {
    async create() {
      if (closed) throw new SessionHubError('HUB_CLOSED', 'The session hub is closed');
      const entry = beginOpen(randomUUID());
      entry.created = entry.updated = Date.now();
      await start(entry);
      publish();
      return handleFor(entry);
    },
    async open(id: string) {
      if (closed) throw new SessionHubError('HUB_CLOSED', 'The session hub is closed');
      const existing = live.get(id);
      if (existing) {
        if (existing.state === 'open') return handleFor(existing);
        if (existing.state === 'closing') throw new SessionHubError('SESSION_CLOSING', 'The session is closing: ' + id);
        if (existing.state === 'opening') {
          await existing.opening?.catch(() => {});
          return handleFor(await ready(id));
        }
        if (existing.state === 'failed') {
          if (existing.app) throw new SessionHubError('SESSION_FAILED', existing.error ?? 'The session did not close; close it before opening again: ' + id);
          await start(existing);
          return handleFor(await ready(id));
        }
      }
      let known = false;
      try {known = await host.hasHistory(id);} catch (error) {
        throw new SessionHubError('SESSION_FAILED', error instanceof Error ? error.message : String(error), {cause: error});
      }
      if (!known) throw new SessionHubError('SESSION_NOT_FOUND', 'No session for this project: ' + id);
      const entry = beginOpen(id);
      await start(entry);
      return handleFor(entry);
    },
    getSession(id) {
      const entry = live.get(id);
      return entry?.state === 'open' ? handleFor(entry) : undefined;
    },
    getSnapshot() {
      if (!snapshot) publish();
      return snapshot ?? Object.freeze({revision, sessions: Object.freeze([]), issues, plansRevision});
    },
    async refresh() {
      if (closed) throw new SessionHubError('HUB_CLOSED', 'The session hub is closed');
      const listed = await manager.list();
      catalog.clear();
      for (const info of listed.sessions) catalog.set(info.id, {title: info.title, created: info.created, updated: info.updated});
      issues = listed.issues;
      publish();
      return hub.getSnapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {listeners.delete(listener);};
    },
    async rename(id, title) {
      const trimmed = title.trim();
      if (!trimmed) throw new InputRejected('A session title must not be empty');
      if (trimmed.length > 100) throw new InputRejected('A session title is limited to 100 characters');
      const entry = live.get(id);
      if (entry?.state === 'closing') throw new SessionHubError('SESSION_CLOSING', 'The session is closing: ' + id);
      if (entry?.state === 'opening') await entry.opening?.catch(() => {});
      const info = await manager.info(id).catch(() => undefined);
      if (!entry && !info) throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown session: ' + id);
      if (entry && !entry.persistence.saved) {
        // Renaming a blank, unsaved session must not turn it into a history entry; keep the title for this live tab.
        entry.title = trimmed; entry.updated = Date.now(); publish(); return;
      }
      // Rename is explicit catalog metadata: unlike the first-task title, it overrides an existing generated title.
      await manager.rename(id, trimmed);
      const saved = await manager.info(id);
      if (entry && saved) {entry.title = saved.title; entry.updated = saved.updated; entry.created = saved.created;}
      if (saved) catalog.set(id, {title: saved.title, created: saved.created, updated: saved.updated});
      publish();
    },
    async submit(id, text, source = DIRECTOR_ID, delivery: SubmitDelivery = {mode: 'queue'}) {
      const entry = await ready(id);
      const raw = text.trim();
      if (SWITCH_COMMANDS.test(raw)) throw new InputRejected('Session switching and rewinding are managed by the GUI adapter; this session was not changed.');
      if (TTY_COMMANDS.test(raw)) throw new InputRejected('This command needs the terminal interface and is not available to an embedded adapter.');
      const app = entry.app!;
      try {await app.submit(raw, source, delivery);}
      catch (error) {await app.recordError(error, source); throw error;}
      if (delivery.mode === 'queue' && entry.state === 'open' && raw && !raw.startsWith('/') && entry.persistence.saved) {
        try {await manager.touch(id, raw); await rememberInfo(entry); publish();}
        catch (error) {await app.recordError(error, source);}
      }
      publish();
    },
    respond(id, response) {
      if (closed) return {ok: false, reason: 'The session hub is closed'};
      const entry = live.get(id);
      if (!entry) return {ok: false, reason: 'Unknown session'};
      if (entry.state === 'closing') return {ok: false, reason: 'The session is closing'};
      if (!entry.app) return {ok: false, reason: 'The session is not open'};
      if (response.sessionId !== id) return {ok: false, reason: 'Answer does not match the session'};
      return entry.app.store.interactions.respond(response);
    },
    cancel(id, activityId) {
      const entry = live.get(id);
      if (!entry?.app) throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown open session: ' + id);
      if (entry.state === 'closing') throw new SessionHubError('SESSION_CLOSING', 'The session is closing: ' + id);
      if (!entry.app.store.getSnapshot().activities.some(activity => activity.activityId === activityId)) return false;
      entry.app.cancel(activityId);
      return true;
    },
    cancelTool(id, callId) {
      const entry = live.get(id);
      if (!entry?.app) throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown open session: ' + id);
      if (entry.state === 'closing') throw new SessionHubError('SESSION_CLOSING', 'The session is closing: ' + id);
      return entry.app.cancelTool(callId);
    },
    async sendPendingNow(id, pendingId) {
      const entry = await ready(id);
      if (!entry.app!.store.getSnapshot().pending.some(item => item.id === pendingId && item.sessionId === id)) return false;
      await entry.app!.sendPendingNow(pendingId);
      return true;
    },
    discardPending(id, pendingId) {
      const entry = live.get(id);
      if (!entry?.app || entry.state !== 'open') throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown open session: ' + id);
      if (!entry.app.store.getSnapshot().pending.some(item => item.id === pendingId && item.sessionId === id)) return undefined;
      return entry.app.discardPending(pendingId);
    },
    plans(id) {
      const entry = live.get(id);
      if (!entry?.app || entry.state !== 'open') throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown open session: ' + id);
      return entry.app.plans.plans();
    },
    async planOp(id, op) {
      const entry = await ready(id);
      const result = await entry.app!.plans.apply([op], PLAN_USER);
      publish();
      return result;
    },
    noteDraft(id) {
      const entry = live.get(id);
      if (!entry?.app || entry.state !== 'open') throw new SessionHubError('SESSION_NOT_FOUND', 'Unknown open session: ' + id);
      entry.app.noteDraft();
    },
    close(id) {
      const entry = live.get(id);
      // Closing is idempotent: an id with nothing open is already closed.
      if (!entry) return Promise.resolve();
      return closeLive(entry);
    },
    shutdown() {
      closeAll ??= (async () => {
        closed = true;
        const failures: unknown[] = [];
        for (const entry of [...live.values()]) {
          try {await closeLive(entry);} catch (error) {failures.push(error);}
        }
        try {await host.close();} catch (error) {failures.push(error);}
        catalog.clear();
        publish();
        if (failures.length) throw new AggregateError(failures, 'Some sessions or project services did not close');
      })();
      return closeAll;
    },
  };
  publish();
  return hub;
}
