import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {z} from 'zod';

const snapshotSchema = z.object({
  id: z.string(), activityId: z.string(), path: z.string(), time: z.number(),
  before: z.string().nullable(), afterHash: z.string(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
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
  try {await writeFile(temporary, bytes, {flag: 'wx'}); await rename(temporary, path);}
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
  async undo(): Promise<string[]> {
    let files: string[];
    try {files = (await readdir(this.directory)).filter(file => file.endsWith('.json'));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    const snapshots = await Promise.all(files.map(async file => ({
      file: join(this.directory, file), entry: snapshotSchema.parse(JSON.parse(await readFile(join(this.directory, file), 'utf8'))),
    })));
    snapshots.sort((a, b) => b.entry.time - a.entry.time);
    const latest = snapshots[0]?.entry.activityId;
    if (!latest) return [];
    const batch = snapshots.filter(item => item.entry.activityId === latest);
    // 同一文件可能在一轮中多次修改，先模拟倒序恢复，整批核对后才写盘。
    const planned = new Map<string, Buffer | null>();
    const originals = new Map<string, Buffer | null>();
    for (const {entry} of batch) {
      const current = planned.has(entry.path) ? planned.get(entry.path)! : await bytesOrMissing(entry.path);
      if (!originals.has(entry.path)) originals.set(entry.path, current);
      if (current === null || hash(current) !== entry.afterHash) throw new Error('撤销停止：文件已有后续修改 ' + entry.path);
      planned.set(entry.path, entry.before === null ? null : Buffer.from(entry.before, 'base64'));
    }
    for (const [path, bytes] of planned) {
      if (!sameBytes(await bytesOrMissing(path), originals.get(path)!)) throw new Error('撤销期间文件发生变化：' + path);
      if (bytes === null) await unlink(path); else await atomicWrite(path, bytes);
    }
    for (const {file} of batch) await unlink(file);
    return [...planned.keys()];
  }
}
