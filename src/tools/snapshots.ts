import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, unlink, readdir, realpath} from 'node:fs/promises';
import {replaceFile} from '../store/replace-file.js';
import {dirname, join, resolve} from 'node:path';
import {z} from 'zod';

const snapshotSchema = z.object({
  id: z.string(), activityId: z.string(), path: z.string(), time: z.number(),
  before: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable(), afterHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Snapshot = z.infer<typeof snapshotSchema>;
export interface RestoreResult {success: boolean; restored: string[]; failed: string[]; error?: string}
function hash(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}
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
  constructor(private readonly directory: string) {}
  async apply(path: string, before: Buffer | null, after: Buffer, activityId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!sameBytes(before, await bytesOrMissing(path))) throw new Error('文件已被其他操作修改，请重新读取后再编辑');
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    const snapshot: Snapshot = {id: randomUUID(), activityId, path, time: this.lastTime,
      before: before?.toString('base64') ?? null, afterHash: hash(after)};
    await mkdir(this.directory, {recursive: true});
    const file = join(this.directory, snapshot.id + '.json');
    await writeFile(file, JSON.stringify(snapshot), {flag: 'wx'});
    try {
      signal.throwIfAborted();
      if (!sameBytes(before, await bytesOrMissing(path))) throw new Error('备份期间文件发生变化，未执行修改');
      await atomicWrite(path, after);
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
  async undo(activities?: readonly string[]): Promise<string[]> {
    const snapshots = (await this.records()).filter(item => !activities || activities.includes(item.entry.activityId));
    const latest = snapshots[0]?.entry.activityId;
    if (!latest) return [];
    const batch = snapshots.filter(item => item.entry.activityId === latest);
    const result = await this.restore([latest]);
    if (!result.success) throw new Error('撤销未完成；已恢复：' + (result.restored.join(', ') || '无') + '；失败：' + result.failed.join(', ') + '；' + result.error);
    for (const {file} of batch) await unlink(file);
    return result.restored;
  }
  async restore(activities: readonly string[]): Promise<RestoreResult> {
    const batch = (await this.records()).filter(item => activities.includes(item.entry.activityId));
    const planned = new Map<string, Buffer | null>();
    const originals = new Map<string, Buffer | null>();
    const expected = new Map<string, string>();
    // 倒序验证快照链，最终目标是区间最早 before；所有路径预检后才改文件。
    try {
      for (const {entry} of batch) {
        if (!expected.has(entry.path)) expected.set(entry.path, entry.afterHash);
        else {
          const next = planned.get(entry.path);
          if (!next || hash(next) !== entry.afterHash) throw new Error('文件快照链不连续：' + entry.path);
        }
        planned.set(entry.path, entry.before === null ? null : Buffer.from(entry.before, 'base64'));
      }
      for (const [path, target] of planned) {
        await this.validatePath(path);
        const current = await bytesOrMissing(path);
        originals.set(path, current);
        if (!sameBytes(current, target) && (current === null || hash(current) !== expected.get(path))) throw new Error('文件已有后续修改：' + path);
      }
    } catch (error) {return {success: false, restored: [], failed: [...planned.keys()], error: error instanceof Error ? error.message : String(error)};}
    const restored: string[] = [], failed: string[] = [];
    let error: string | undefined;
    for (const [path, bytes] of planned) {
      try {
        await this.validatePath(path);
        const current = await bytesOrMissing(path);
        if (!sameBytes(current, originals.get(path)!)) throw new Error('回退期间文件发生变化：' + path);
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
    if (resolve(path) !== path || path.split(/[\\/]/).some(part => ['.logox', '.git', 'legacy'].includes(part.toLowerCase()))) throw new Error('回退路径无效：' + path);
    let candidate = path;
    for (;;) {
      try {
        if ((await realpath(candidate)).toLowerCase() !== candidate.toLowerCase()) throw new Error('回退路径被链接改写：' + path);
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
