import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, unlink, readdir, realpath} from 'node:fs/promises';
import {replaceFile} from '../store/replace-file.js';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';

const snapshotSchema = z.object({
  id: z.string(), activityId: z.string(), path: z.string(), time: z.number(),
  /** The session whose writer produced this record; absent on records written before sessions were isolated. */
  sessionId: z.string().optional(),
  before: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable(), afterHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Snapshot = z.infer<typeof snapshotSchema>;
export interface RestoreResult {success: boolean; restored: string[]; failed: string[]; error?: string}
function hash(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}
/** Observer and writer identity is `(sessionId, ownerId)`; an absent session is the legacy default. */
function identity(sessionId: string | undefined, ownerId: string): string {return (sessionId ?? '') + '\0' + ownerId;}
export async function bytesOrMissing(path: string): Promise<Buffer | null> {
  try {return await readFile(path);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
}
export function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
export async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const temporary = join(dirname(path), '.' + randomUUID() + '.logox-tmp');
  try {await writeFile(temporary, bytes, {flag: 'wx'}); await replaceFile(temporary, path);}
  finally {await unlink(temporary).catch(() => {});}
}
export class Snapshots {
  private lastTime = 0;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly observations = new Map<string, Map<string, string>>();
  private readonly writers = new Map<string, {sessionId?: string; ownerId: string; activityId: string; afterHash: string; time: number}>();
  private readonly writeListeners = new Map<string, (file: {path: string; before: Buffer | null; after: Buffer}) => void>();
  constructor(private readonly directory: string) {}
  private belongs(recordSessionId: string | undefined, sessionId: string | undefined): boolean {
    // A caller without a session is the legacy single-session adapter: it owns one session and sees its records.
    if (sessionId === undefined) return true;
    // Records written before session identity existed remain visible to that scoped session as well.
    return recordSessionId === sessionId || recordSessionId === undefined;
  }
  /** Reports each write made under `(sessionId, ownerId)`, measured here at the write itself rather than taken from the writer's account. */
  trackWrites(ownerId: string, listener: (file: {path: string; before: Buffer | null; after: Buffer}) => void, sessionId?: string): () => void {
    const key = identity(sessionId, ownerId);
    this.writeListeners.set(key, listener);
    return () => {if (this.writeListeners.get(key) === listener) this.writeListeners.delete(key);};
  }
  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const tail = prior.then(() => gate, () => gate);
    this.locks.set(path, tail);
    await prior.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(path) === tail) this.locks.delete(path);
    }
  }
  observe(path: string, bytes: Uint8Array | null, ownerId?: string, sessionId?: string): void {
    if (!ownerId || !bytes) return;
    let byOwner = this.observations.get(path);
    if (!byOwner) {byOwner = new Map(); this.observations.set(path, byOwner);}
    byOwner.set(identity(sessionId, ownerId), hash(bytes));
  }
  stalePeerWriter(path: string, currentBytes: Uint8Array | null, ownerId?: string, sessionId?: string): string | undefined {
    if (!ownerId || !currentBytes) return undefined;
    const writer = this.writers.get(path);
    if (!writer || writer.ownerId === ownerId && writer.sessionId === sessionId) return undefined;
    if (writer.sessionId !== sessionId) return undefined;
    const currentHash = hash(currentBytes);
    if (writer.afterHash !== currentHash) return undefined;
    const observedHash = this.observations.get(path)?.get(identity(sessionId, ownerId));
    return observedHash === currentHash ? undefined : writer.ownerId;
  }
  async apply(path: string, before: Buffer | null, after: Buffer, activityId: string, signal: AbortSignal, ownerId?: string, sessionId?: string): Promise<void> {
    signal.throwIfAborted();
    if (!sameBytes(before, await bytesOrMissing(path))) throw new Error('The file was modified by another operation; re-read it before editing');
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    const afterHash = hash(after);
    const snapshot: Snapshot = {id: randomUUID(), activityId, path, time: this.lastTime, ...(sessionId ? {sessionId} : {}),
      before: before?.toString('base64') ?? null, afterHash};
    await mkdir(this.directory, {recursive: true});
    const file = join(this.directory, snapshot.id + '.json');
    await writeFile(file, JSON.stringify(snapshot), {flag: 'wx'});
    try {
      signal.throwIfAborted();
      if (!sameBytes(before, await bytesOrMissing(path))) throw new Error('The file changed during backup; modification not performed');
      await atomicWrite(path, after);
      if (ownerId) {
        this.writers.set(path, {ownerId, activityId, afterHash, time: this.lastTime, ...(sessionId ? {sessionId} : {})});
        this.observe(path, after, ownerId, sessionId);
        this.writeListeners.get(identity(sessionId, ownerId))?.({path, before, after});
      }
    } catch (error) {await unlink(file).catch(() => {}); throw error;}
  }
  private async records() {
    let files: string[];
    try {files = (await readdir(this.directory)).filter(file => file.endsWith('.json'));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    const snapshots = await Promise.all(files.map(async file => ({
      file: join(this.directory, file), entry: snapshotSchema.parse(JSON.parse(await readFile(join(this.directory, file), 'utf8'))),
    })));
    snapshots.sort((a, b) => b.entry.time - a.entry.time);
    return snapshots;
  }
  /** Absolute paths that Write or Edit changed under the given activities (Automa workers write under their dispatcher's activity); deleted-on-undo snapshots are gone. */
  async changedPaths(activities: readonly string[], sessionId?: string): Promise<string[]> {
    const wanted = new Set(activities);
    return [...new Set((await this.records()).filter(item => wanted.has(item.entry.activityId) && this.belongs(item.entry.sessionId, sessionId)).map(item => item.entry.path))].sort();
  }
  /** Undoes the latest activity of this session (or of the legacy default when no session is named), never another session's writes. */
  async undo(activities?: readonly string[], sessionId?: string): Promise<string[]> {
    const snapshots = (await this.records()).filter(item => (!activities || activities.includes(item.entry.activityId)) &&
      this.belongs(item.entry.sessionId, sessionId));
    const latest = snapshots[0]?.entry.activityId;
    if (!latest) return [];
    const batch = snapshots.filter(item => item.entry.activityId === latest);
    const result = await this.restore([latest], sessionId);
    if (!result.success) throw new Error('Undo incomplete; restored: ' + (result.restored.join(', ') || 'none') + '; failed: ' + result.failed.join(', ') + '; ' + result.error);
    for (const {file} of batch) await unlink(file);
    return result.restored;
  }
  async restore(activities: readonly string[], sessionId?: string): Promise<RestoreResult> {
    const batch = (await this.records()).filter(item => activities.includes(item.entry.activityId) &&
      this.belongs(item.entry.sessionId, sessionId));
    const planned = new Map<string, Buffer | null>();
    const originals = new Map<string, Buffer | null>();
    const expected = new Map<string, string>();
    // Verify the snapshot chain in reverse; the final target is the earliest before-state in the range; files change only after all paths pass pre-checks.
    try {
      for (const {entry} of batch) {
        if (!expected.has(entry.path)) expected.set(entry.path, entry.afterHash);
        else {
          const next = planned.get(entry.path);
          if (!next || hash(next) !== entry.afterHash) throw new Error('File snapshot chain is not contiguous: ' + entry.path);
        }
        planned.set(entry.path, entry.before === null ? null : Buffer.from(entry.before, 'base64'));
      }
      for (const [path, target] of planned) {
        await this.validatePath(path);
        const current = await bytesOrMissing(path);
        originals.set(path, current);
        if (!sameBytes(current, target) && (current === null || hash(current) !== expected.get(path))) throw new Error('File has later modifications: ' + path);
      }
    } catch (error) {return {success: false, restored: [], failed: [...planned.keys()], error: error instanceof Error ? error.message : String(error)};}
    const restored: string[] = [], failed: string[] = [];
    let error: string | undefined;
    for (const [path, bytes] of planned) {
      try {
        await this.validatePath(path);
        const current = await bytesOrMissing(path);
        if (!sameBytes(current, originals.get(path)!)) throw new Error('File changed during rewind: ' + path);
        if (!sameBytes(current, bytes)) await this.writeRestored(path, bytes);
        restored.push(path);
      } catch (failure) {failed.push(path); error = failure instanceof Error ? failure.message : String(failure);}
    }
    return {success: failed.length === 0, restored, failed, ...(error ? {error} : {})};
  }
  protected async writeRestored(path: string, bytes: Buffer | null): Promise<void> {
    if (bytes === null) await unlink(path); else await atomicWrite(path, bytes);
  }
  private async validatePath(path: string): Promise<void> {
    if (resolve(path) !== path || path.split(/[\\/]/).some(part => ['.logox', '.git', 'legacy'].includes(part.toLowerCase()))) throw new Error('Invalid rewind path: ' + path);
    let candidate = path;
    for (;;) {
      try {
        if ((await realpath(candidate)).toLowerCase() !== candidate.toLowerCase()) throw new Error('Rewind path was rewritten by a link: ' + path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = dirname(candidate);
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
  }
}
