import {createHash, randomUUID} from 'node:crypto';
import {cp, lstat, mkdir, readFile, readdir, realpath, rename, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {z} from 'zod';
import {atomicWrite} from '../tools/snapshots.js';

const key = (id: string) => createHash('sha256').update(id).digest('hex');
const deletedSchema = z.strictObject({version: z.literal(1), id: z.string(), project: z.string(), time: z.number(),
  archive: z.string().regex(/^[a-f0-9]{64}-[a-f0-9-]{36}$/)});
export interface SessionRemoval {archive: string; remaining: readonly string[]}

/** Prepare a full copy first; the deleted marker is the deletion commit point, so a failed cleanup of the originals never loses the recoverable copy. */
export class SessionTrash {
  constructor(private readonly directory: string, private readonly project: string) {}
  private marker(id: string): string {return join(this.directory, 'deleted', key(id) + '.json');}
  async isDeleted(id: string): Promise<boolean> {
    let raw: string;
    try {raw = await readFile(this.marker(id), 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error;}
    const record = deletedSchema.parse(JSON.parse(raw));
    if (record.id !== id || record.project !== this.project || !record.archive.startsWith(key(id) + '-')) throw new Error('Deleted session identity mismatch; original record preserved');
    return true;
  }
  async assertAvailable(id: string): Promise<void> {if (await this.isDeleted(id)) throw new Error('This session was deleted; the recoverable copy is in .logox/state/trash: ' + id);}
  protected async publishRemoval(id: string, archive: string): Promise<void> {
    await this.safe(this.marker(id));
    await atomicWrite(this.marker(id), Buffer.from(JSON.stringify({version: 1, id, project: this.project, time: Date.now(), archive})));
  }
  private async safe(path: string): Promise<void> {
    const root = resolve(this.directory), target = resolve(path), rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Session trash path escapes the state directory');
    // Do not follow links inside the state directory or in parent directories that point outside it.
    const canonicalRoot = await realpath(root);
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(canonicalRoot) !== normalize(root)) throw new Error('State directory links cannot be used for trash');
    let current = target;
    for (;;) {
      try {if ((await lstat(current)).isSymbolicLink()) throw new Error('Session trash does not accept symbolic links: ' + current);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      if (current === root) break;
      current = dirname(current);
    }
  }
  private async fingerprint(path: string): Promise<string> {
    const hash = createHash('sha256');
    const visit = async (target: string, name: string): Promise<void> => {
      await this.safe(target);
      const info = await lstat(target);
      hash.update(JSON.stringify([name, info.isDirectory() ? 'directory' : 'file']));
      if (info.isDirectory()) for (const child of (await readdir(target)).sort()) await visit(join(target, child), name + '/' + child);
      else if (info.isFile()) {const bytes = await readFile(target); hash.update(String(bytes.length) + ':'); hash.update(bytes);}
      else throw new Error('Session trash supports only regular files and directories');
    };
    await visit(path, ''); return hash.digest('hex');
  }
  async remove(id: string, paths: readonly string[]): Promise<SessionRemoval> {
    await this.assertAvailable(id);
    const name = key(id) + '-' + randomUUID(), archive = join(this.directory, 'trash', name), preparing = archive + '.preparing';
    await this.safe(preparing); await mkdir(join(preparing, 'files'), {recursive: true});
    const files: Array<{path: string; hash: string}> = [];
    for (const path of [...new Set(paths)]) {
      const source = join(this.directory, path), destination = join(preparing, 'files', path);
      await this.safe(source); await this.safe(destination);
      try {await lstat(source);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error;}
      const hash = await this.fingerprint(source);
      await mkdir(dirname(destination), {recursive: true});
      await cp(source, destination, {recursive: true, errorOnExist: true, force: false});
      if (hash !== await this.fingerprint(source) || hash !== await this.fingerprint(destination)) throw new Error('Session record changed during backup; not deleted: ' + path);
      files.push({path, hash});
    }
    await atomicWrite(join(preparing, 'manifest.json'), Buffer.from(JSON.stringify({version: 1, id, project: this.project, time: Date.now(), files}, null, 2) + '\n'));
    await this.safe(archive); await rename(preparing, archive);
    await this.publishRemoval(id, name);
    const remaining: string[] = [];
    for (const file of files) {
      const source = join(this.directory, file.path);
      try {
        // Clean up only originals that still match the full copy; externally changed content is preserved.
        if (await this.fingerprint(source) !== file.hash) {remaining.push(file.path); continue;}
        await this.safe(source); await rm(source, {recursive: true});
      } catch {remaining.push(file.path);}
    }
    return {archive, remaining};
  }
}
