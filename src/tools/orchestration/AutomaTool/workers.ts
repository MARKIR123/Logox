import {existsSync} from 'node:fs';
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ModelMessage} from '../../../runtime/messages.js';
import {replaceFile} from '../../../store/replace-file.js';
import type {ResolvedAutomaModel} from './AutomaTool.js';
import type {JobGrant} from './grant.js';

/** A finished worker whose context reached this many input tokens is parked at once: re-sending it costs more than a fresh brief. */
export const AUTOMA_RETAINED_INPUT_LIMIT = 64_000;
/** An idle worker that nobody continued for this long is parked. */
export const AUTOMA_IDLE_PARK_MS = 10 * 60_000;

/** A worker that finished and waits for a next brief, in memory or parked on disk. */
export interface IdleWorker {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly activityId: string;
  readonly workerId: string;
  readonly grant: JobGrant;
  readonly system: string;
  /** The model name the dispatch asked for (style or role), so a worker revived after a restart resolves its model the same way. */
  readonly preferred: string | undefined;
  readonly vision: boolean;
  /** What the worker's definition was when its last job ran (`runtime/definition-fingerprint.ts`); a continue compares it with the current one. Absent for workers parked by older versions. */
  readonly fingerprint?: string | undefined;
  /** Undefined after a restart, until the next continue resolves it again. */
  resolved: ResolvedAutomaModel | undefined;
  /** Undefined while parked. */
  messages: ModelMessage[] | undefined;
  lastInput: number;
  idleSince: number;
  /** True while a continued job is running: the sweep leaves it alone. */
  busy: boolean;
}

export interface ShelfSettings {
  now(): number;
  idleParkMs: number;
  /** The directory that holds parked workers of a session: `<dir>/<activityId>/<id>.json`. */
  dir(sessionId: string): string;
  inputLimit: number;
}

interface ParkedFile {
  readonly id: string; readonly sessionId: string; readonly ownerId: string; readonly activityId: string; readonly workerId: string;
  readonly grant: JobGrant; readonly system: string; readonly preferred?: string; readonly vision: boolean; readonly fingerprint?: string; readonly lastInput: number;
  readonly messages: ModelMessage[];
}

const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');

/** The readable id's letter: the dispatcher's first letter in upper case; `A` when the owner has none. */
export function workerLetter(ownerId: string): string {
  const first = ownerId.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : 'A';
}

/**
 * The idle and parked workers of every dispatcher in this process. A worker that finished stays here with its history (the dispatcher continues it
 * by id); it moves to disk when its history is large or it has been idle a while, and ends with the dispatcher's task. The shelf holds no
 * dispatch state: `AutomaTool.ts:executeAutomaDispatch()` takes a worker off it for a continued job and puts it back.
 */
export class WorkerShelf {
  private settings: ShelfSettings = {now: Date.now, idleParkMs: AUTOMA_IDLE_PARK_MS, inputLimit: AUTOMA_RETAINED_INPUT_LIMIT,
    dir: sessionId => this.fallbackDir(sessionId)};
  /** Without a configured directory (no session state folder) parked workers go to a temp folder private to this process. */
  private readonly token = randomUUID().slice(0, 8);
  private fallbackDir(sessionId: string): string {return join(tmpdir(), 'logox-automa-parked', this.token, safeSegment(sessionId));}
  private readonly entries = new Map<string, IdleWorker>();
  private readonly counters = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Called by the idle timer; the owner decides which activities have settled. */
  onTick: (() => Promise<void>) | undefined;

  configure(settings: {readonly [K in keyof ShelfSettings]?: ShelfSettings[K] | undefined}): void {
    const defaults: ShelfSettings = {now: Date.now, idleParkMs: AUTOMA_IDLE_PARK_MS, inputLimit: AUTOMA_RETAINED_INPUT_LIMIT, dir: sessionId => this.fallbackDir(sessionId)};
    this.settings = {...defaults, ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))} as ShelfSettings;
  }

  get size(): number {return this.entries.size;}
  /** Workers whose messages are on disk. */
  parkedCount(): number {return [...this.entries.values()].filter(entry => !entry.messages).length;}

  private key(sessionId: string, id: string): string {return sessionId + '\0' + id;}
  private file(sessionId: string, activityId: string, id: string): string {return join(this.settings.dir(sessionId), safeSegment(activityId), safeSegment(id) + '.json');}

  /** `count` fresh ids for a dispatcher: its letter and a counter that never repeats within the session, nor an id still on the shelf or on disk. */
  async allocate(sessionId: string, ownerId: string, count: number): Promise<string[]> {
    const letter = workerLetter(ownerId), counterKey = sessionId + '\0' + letter;
    if (!this.counters.has(counterKey)) this.counters.set(counterKey, await this.highestOnDisk(sessionId, letter));
    const ids: string[] = [];
    while (ids.length < count) {
      const next = this.counters.get(counterKey)! + 1;
      this.counters.set(counterKey, next);
      const id = letter + next;
      if (!this.entries.has(this.key(sessionId, id))) ids.push(id);
    }
    return ids;
  }

  /** After a restart the counter starts above every id a parked file of an open task still carries. */
  private async highestOnDisk(sessionId: string, letter: string): Promise<number> {
    let highest = 0;
    try {
      for (const activity of await readdir(this.settings.dir(sessionId))) {
        for (const name of await readdir(join(this.settings.dir(sessionId), activity)).catch(() => [])) {
          const match = new RegExp('^' + letter + '(\\d+)\\.json$').exec(name);
          if (match) highest = Math.max(highest, Number(match[1]));
        }
      }
    } catch {}
    return highest;
  }

  /** The worker of this dispatcher's current task with this id, read from disk when this process does not hold it (a restart); undefined when closed or unknown. */
  async find(sessionId: string, ownerId: string, activityId: string, id: string): Promise<IdleWorker | undefined> {
    const held = this.entries.get(this.key(sessionId, id));
    if (held) return held.ownerId === ownerId && held.activityId === activityId ? held : undefined;
    const path = this.file(sessionId, activityId, id);
    if (!existsSync(path)) return undefined;
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as ParkedFile;
      if (data.id !== id || data.ownerId !== ownerId || data.sessionId !== sessionId) return undefined;
      const entry: IdleWorker = {id, sessionId, ownerId, activityId, workerId: data.workerId, grant: data.grant, system: data.system, preferred: data.preferred,
        vision: data.vision, ...(data.fingerprint ? {fingerprint: data.fingerprint} : {}), resolved: undefined, messages: undefined, lastInput: data.lastInput, idleSince: this.settings.now(), busy: false};
      this.entries.set(this.key(sessionId, id), entry);
      this.arm();
      return entry;
    } catch {return undefined;}
  }

  /** The history of a worker, read from its file when parked. The caller copies it; the shelf's own array is never extended in place. */
  async messages(entry: IdleWorker): Promise<ModelMessage[]> {
    if (entry.messages) return entry.messages;
    const data = JSON.parse(await readFile(this.file(entry.sessionId, entry.activityId, entry.id), 'utf8')) as ParkedFile;
    entry.messages = data.messages;
    return entry.messages;
  }

  /** Marks a worker as running its continued job, so a sweep never parks or closes it underneath. */
  hold(entry: IdleWorker): void {entry.busy = true;}
  /** The continued job ended without a usable new history (cancelled, failed): the worker stays as it was. */
  unhold(entry: IdleWorker): void {entry.busy = false; entry.idleSince = this.settings.now();}

  /** Puts a finished worker on the shelf; a history over the limit goes straight to disk. */
  async retain(entry: IdleWorker): Promise<void> {
    entry.busy = false;
    entry.idleSince = this.settings.now();
    this.entries.set(this.key(entry.sessionId, entry.id), entry);
    this.arm();
    if (entry.lastInput >= this.settings.inputLimit) await this.park(entry);
  }

  /** Writes the history to disk atomically, then drops it from memory. */
  async park(entry: IdleWorker): Promise<void> {
    if (!entry.messages) return;
    const path = this.file(entry.sessionId, entry.activityId, entry.id);
    const data: ParkedFile = {id: entry.id, sessionId: entry.sessionId, ownerId: entry.ownerId, activityId: entry.activityId, workerId: entry.workerId,
      grant: entry.grant, system: entry.system, ...(entry.preferred !== undefined ? {preferred: entry.preferred} : {}), vision: entry.vision, ...(entry.fingerprint ? {fingerprint: entry.fingerprint} : {}),
      lastInput: entry.lastInput, messages: entry.messages};
    await mkdir(join(path, '..'), {recursive: true});
    const temporary = path + '.' + randomUUID().slice(0, 8) + '.tmp';
    await writeFile(temporary, JSON.stringify(data));
    await replaceFile(temporary, path);
    entry.messages = undefined;
  }

  /** Ends one worker now; its file goes with it. */
  async close(sessionId: string, id: string): Promise<void> {
    const entry = this.entries.get(this.key(sessionId, id));
    this.entries.delete(this.key(sessionId, id));
    if (entry) await rm(this.file(sessionId, entry.activityId, id), {force: true}).catch(() => {});
    this.disarm();
  }

  /** Ends every idle or parked worker of one session, and removes that session's parked directory; other sessions keep theirs. */
  async closeSession(sessionId: string): Promise<void> {
    for (const [key, entry] of this.entries) if (entry.sessionId === sessionId && !entry.busy) this.entries.delete(key);
    await rm(this.settings.dir(sessionId), {recursive: true, force: true}).catch(() => {});
    this.disarm();
  }

  /** Ends every idle or parked worker of a task, and removes its directory. */
  async closeActivity(sessionId: string, activityId: string): Promise<void> {
    for (const [key, entry] of this.entries) if (entry.sessionId === sessionId && entry.activityId === activityId && !entry.busy) this.entries.delete(key);
    await rm(join(this.settings.dir(sessionId), safeSegment(activityId)), {recursive: true, force: true}).catch(() => {});
    this.disarm();
  }

  /** A dispatcher's workers of any task but the current one end here: a worker never outlives its task, settled event or not. */
  async closeStale(sessionId: string, ownerId: string, currentActivityId: string): Promise<void> {
    const stale = new Set<string>();
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId && entry.ownerId === ownerId && entry.activityId !== currentActivityId && !entry.busy) stale.add(entry.activityId);
    for (const activityId of stale) await this.closeActivity(sessionId, activityId);
  }

  /** Closes the workers of settled tasks and parks those idle for too long. */
  async sweep(settled: (sessionId: string, activityId: string) => boolean): Promise<void> {
    const done = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.busy) continue;
      if (settled(entry.sessionId, entry.activityId)) done.add(JSON.stringify([entry.sessionId, entry.activityId]));
    }
    for (const item of done) {const [sessionId, activityId] = JSON.parse(item) as [string, string]; await this.closeActivity(sessionId, activityId);}
    const now = this.settings.now();
    for (const entry of [...this.entries.values()]) {
      if (!entry.busy && entry.messages && now - entry.idleSince >= this.settings.idleParkMs) await this.park(entry).catch(() => {});
    }
    this.disarm();
  }

  /** One unref'd interval while anything waits on the shelf: it parks idle workers without a dispatch having to arrive. */
  private arm(): void {
    if (this.timer || !this.onTick) return;
    this.timer = setInterval(() => {void this.onTick?.().catch(() => {});}, 30_000);
    this.timer.unref();
  }
  private disarm(): void {
    if (this.entries.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
