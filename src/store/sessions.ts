import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {hostname} from 'node:os';
import {mkdir, readFile, readdir, realpath, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {z} from 'zod';
import {atomicWrite} from '../tools/snapshots.js';
import {withFileLock} from './file-lock.js';
import {Journal} from './journal.js';
import {SessionTrash, type SessionRemoval} from './session-trash.js';

const metadataSchema = z.strictObject({version: z.literal(1), id: z.string().min(1), project: z.string(),
  created: z.number(), updated: z.number(), title: z.string()});
const lockSchema = z.strictObject({pid: z.number().int().positive(), host: z.string(), token: z.string()});
const indexEntrySchema = z.object({version: z.literal(1), sessionId: z.string(), ownerId: z.string(),
  role: z.enum(['user', 'assistant', 'tool']), text: z.string(), time: z.number().optional()});
type IndexedJournal = {sessionId: string; ownerId: string; created: number; updated: number; title?: string; submitted: boolean; uncertain: boolean};
export type SessionInfo = z.infer<typeof metadataSchema>;
export interface SessionLease {release(): Promise<void>}
function key(id: string): string {return createHash('sha256').update(id).digest('hex');}
async function readOptional(path: string): Promise<string | undefined> {
  try {return await readFile(path, 'utf8');}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
}
export class SessionManager {
  private constructor(readonly directory: string, readonly project: string) {}
  static async open(cwd: string): Promise<SessionManager> {
    const project = await realpath(cwd);
    return new SessionManager(join(project, '.logox', 'state'), project);
  }
  private get trash(): SessionTrash {return new SessionTrash(this.directory, this.project);}
  private metadataPath(id: string): string {return join(this.directory, 'catalog', key(id) + '.json');}
  async info(id: string): Promise<SessionInfo | undefined> {
    await this.trash.assertAvailable(id);
    const raw = await readOptional(this.metadataPath(id));
    if (raw === undefined) return undefined;
    const info = metadataSchema.parse(JSON.parse(raw));
    if (info.id !== id || info.project !== this.project) throw new Error('Session metadata project or ID mismatch');
    return info;
  }
  async list(): Promise<{sessions: SessionInfo[]; issues: string[]}> {
    let files: string[] = [];
    try {files = await readdir(join(this.directory, 'catalog'));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const sessions: SessionInfo[] = [], issues: string[] = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      try {
        const info = metadataSchema.parse(JSON.parse(await readFile(join(this.directory, 'catalog', file), 'utf8')));
        if (info.project !== this.project || file !== key(info.id) + '.json') throw new Error('Project or ID mismatch');
        if (!await this.trash.isDeleted(info.id)) sessions.push(info);
      } catch {issues.push('Session index corrupt: ' + file);}
    }
    const records = await this.journals(issues);
    for (const record of records) {
      if (await this.trash.isDeleted(record.sessionId)) continue;
      const existing = sessions.find(session => session.id === record.sessionId);
      if (existing) {
        existing.updated = Math.max(existing.updated, record.updated);
        if (existing.title === 'New session' && record.title) existing.title = record.title;
        continue;
      }
      if (record.submitted || record.uncertain) sessions.push({version: 1, id: record.sessionId, project: this.project,
        created: record.created, updated: record.updated, title: record.title ?? 'Previous session'});
    }
    const visible: SessionInfo[] = [];
    for (const info of sessions) {
      if (await this.submitted(info.id, records, issues)) visible.push(info);
      else {
        // A process doing its first commit may have registered metadata but not yet written a checkpoint; clean up only unheld blank indexes.
        const lock = join(this.directory, 'locks', key(info.id) + '.lock');
        await withFileLock(lock + '.claim', async () => {
          if (await readOptional(lock) !== undefined) return;
          try {await unlink(this.metadataPath(info.id));}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        });
      }
    }
    visible.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    return {sessions: visible, issues};
  }
  private async journals(issues: string[] = []): Promise<IndexedJournal[]> {
    const directory = join(this.directory, 'sessions');
    let files: string[] = [];
    try {files = await readdir(directory);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const records: IndexedJournal[] = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.jsonl$/.test(file))) {
      const path = join(directory, file);
      let stream: ReturnType<typeof createReadStream> | undefined, lines: ReturnType<typeof createInterface> | undefined;
      let record: IndexedJournal | undefined;
      try {
        const info = await stat(path);
        stream = createReadStream(path, {encoding: 'utf8'});
        lines = createInterface({input: stream, crlfDelay: Infinity});
        // Subscribe immediately after creating readline so line/close are not missed during other awaits.
        for await (const line of lines) {
          const entry = indexEntrySchema.parse(JSON.parse(line));
          if (file !== createHash('sha256').update(JSON.stringify([entry.sessionId, entry.ownerId])).digest('hex') + '.jsonl') throw new Error('Ledger identity mismatch');
          record ??= {sessionId: entry.sessionId, ownerId: entry.ownerId, created: entry.time ?? info.birthtimeMs,
            updated: info.mtimeMs, submitted: false, uncertain: false};
          if (entry.role === 'user') {
            record.submitted = true; record.title = entry.text.replace(/\s+/g, ' ').slice(0, 100); break;
          }
        }
      } catch {if (record) record.uncertain = true; issues.push('Session ledger could not be fully indexed: ' + file);}
      finally {lines?.close(); stream?.destroy();}
      if (record) records.push(record);
    }
    return records;
  }
  private async submitted(id: string, records: readonly IndexedJournal[], issues: string[] = []): Promise<boolean> {
    if (records.some(record => record.sessionId === id && (record.submitted || record.uncertain))) return true;
    const journal = new Journal(join(this.directory, 'sessions'));
    try {if ((await journal.tasks(id)).length) return true;}
    catch {issues.push('Session task record corrupt: ' + id); return true;}
    // Keep the index when a corrupt record cannot be confirmed blank, so recovery can report why.
    for (const owner of ['logox', 'aletheia', 'techne', 'kalon']) {
      const file = journal.path(id, owner);
      if (!records.some(record => record.sessionId === id && record.ownerId === owner)) {
        try {if ((await stat(file)).size > 0) return true;}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      }
    }
    return false;
  }
  async hasContent(id: string): Promise<boolean> {if (await this.trash.isDeleted(id)) return false; return this.submitted(id, await this.journals());}
  async recent(): Promise<string | undefined> {
    const id = (await readOptional(join(this.directory, 'last-session')))?.trim();
    const {sessions} = await this.list();
    if (id && !await this.trash.isDeleted(id)) {
      try {await this.info(id);} catch {return id;}
      if (sessions.some(info => info.id === id) || await this.hasContent(id)) return id;
    }
    return sessions[0]?.id;
  }
  async remember(id: string): Promise<void> {await atomicWrite(join(this.directory, 'last-session'), Buffer.from(id));}
  async touch(id: string, title?: string): Promise<void> {
    const previous = await this.info(id), now = Date.now();
    const summary = title?.replace(/\s+/g, ' ').slice(0, 100);
    await atomicWrite(this.metadataPath(id), Buffer.from(JSON.stringify({version: 1, id, project: this.project,
      created: previous?.created ?? now, updated: now, title: previous?.title && (previous.title !== 'New session' || !summary) ? previous.title : summary || 'New session'})));
  }
  /** A lease guards all backup/commit/cleanup steps; active sessions cannot be deleted. */
  async remove(id: string, ownerHints: readonly string[] = []): Promise<SessionRemoval> {
    const lease = await this.acquire(id);
    try {
      const info = await this.info(id);
      if (!info && !await this.hasContent(id)) throw new Error('No session for this project: ' + id);
      const records = await this.journals(), journal = new Journal(join(this.directory, 'sessions'));
      const tasks = await journal.tasks(id).catch(() => []);
      const owners = new Set(['logox', 'aletheia', 'techne', 'kalon', '$session', '$system', '$collaboration', ...ownerHints,
        ...records.filter(record => record.sessionId === id).map(record => record.ownerId), ...tasks.map(task => task.ownerId)]);
      const stems = [...owners].map(owner => createHash('sha256').update(JSON.stringify([id, owner])).digest('hex'));
      let journals: string[] = [];
      try {journals = await readdir(join(this.directory, 'sessions'));} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      const files = [join('catalog', key(id) + '.json'),
        ...journals.filter(file => stems.some(stem => file === stem + '.jsonl' || file.startsWith(stem + '.jsonl.'))).map(file => join('sessions', file)),
        ...stems.map(stem => join('usage', stem + '.json')),
        join('task-models', key(id) + '.task-models.jsonl'), join('actor-coordination', key(id) + '.json')];
      return await this.trash.remove(id, files);
    } finally {await lease.release();}
  }
  async acquire(id: string): Promise<SessionLease> {
    if (!id.trim()) throw new Error('Session ID must not be empty');
    const directory = join(this.directory, 'locks');
    await mkdir(directory, {recursive: true});
    const file = join(directory, key(id) + '.lock'), token = randomUUID();
    const record = {pid: process.pid, host: hostname(), token};
    const claim = file + '.claim';
    await withFileLock(claim, async () => {
      await this.trash.assertAvailable(id);
      const raw = await readOptional(file);
      if (raw !== undefined) {
        let lock: z.infer<typeof lockSchema>;
        try {lock = lockSchema.parse(JSON.parse(raw));} catch {throw new Error('Session lock corrupt; check the lock owner and recover manually: ' + file);}
        let dead = false;
        if (lock.host === hostname()) {
          try {process.kill(lock.pid, 0);} catch (failure) {dead = (failure as NodeJS.ErrnoException).code === 'ESRCH';}
        }
        if (!dead) throw new Error('Session is in use by another process: ' + id);
      }
      await atomicWrite(file, Buffer.from(JSON.stringify(record)));
    });
    let released = false;
    return {async release() {
      await withFileLock(claim, async () => {
        if (released) return;
        if (await readOptional(file) !== JSON.stringify(record)) throw new Error("Session lock owner changed; not releasing another process's lock");
        await unlink(file); released = true;
      });
    }};
  }
}
