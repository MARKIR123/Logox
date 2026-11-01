import {mkdir, readFile, readdir, rename, rmdir, unlink, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';

const ownerSchema = z.strictObject({pid: z.number().int().positive(), token: z.string().uuid()});
type Owner = z.infer<typeof ownerSchema>;
function marker(owner: Owner): string {return 'owner-' + owner.pid + '-' + owner.token + '.json';}
function code(error: unknown): string | undefined {return (error as NodeJS.ErrnoException).code;}
function dead(pid: number): boolean {
  try {process.kill(pid, 0); return false;}
  catch (error) {return code(error) === 'ESRCH';}
}
async function removeOwner(directory: string, owner: Owner): Promise<void> {
  // Windows can briefly deny unlink while a contender reads the marker; retry
  // so a live owner never leaves its identity behind.
  for (let attempt = 0; ; attempt++) {
    try {await unlink(join(directory, marker(owner))); break;}
    catch (error) {
      const failure = code(error);
      if (failure === 'ENOENT') break;
      if (!['EPERM', 'EACCES'].includes(failure ?? '') || attempt >= 20) throw error;
      await delay(10);
    }
  }
  // A replacement owner has a different filename and makes rmdir fail safely.
  // EPERM/EACCES means a contender holds the now-empty directory open; reclaim
  // removes empty directories later, so release still succeeds.
  try {await rmdir(directory);}
  catch (error) {if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;}
}
async function reclaim(directory: string): Promise<void> {
  let entries: string[];
  try {entries = await readdir(directory);}
  catch (error) {if (code(error) === 'ENOENT') return; throw error;}
  if (!entries.length) {
    // Only fully prepared, nonempty directories are published by this protocol.
    try {await rmdir(directory);}
    catch (error) {
      // Windows may report EPERM when another contender has just occupied or
      // opened this directory. Acquisition retries without touching its owner.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
    }
    return;
  }
  if (entries.length !== 1) throw new Error('Invalid state lock identity; lock preserved: ' + directory);
  let owner: Owner;
  try {owner = ownerSchema.parse(JSON.parse(await readFile(join(directory, entries[0]!), 'utf8')));}
  catch (error) {
    if (code(error) === 'ENOENT') return;
    throw new Error('State lock identity unreadable; lock preserved: ' + directory);
  }
  if (entries[0] !== marker(owner)) throw new Error('State lock identity mismatch; lock preserved: ' + directory);
  if (dead(owner.pid)) {
    try {await removeOwner(directory, owner);}
    catch (error) {
      // Windows can briefly deny unlink while another contender reads the marker.
      // Retry acquisition without deleting or claiming the occupied directory.
      if (!['EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
    }
  }
}
/** Publish the full identity atomically; reclaim only when the owner is confirmed dead, and release only your own identity. */
export async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), {recursive: true});
  try {
    await readdir(path + '.lock');
    throw new Error('Legacy state lock has no owner identity; confirm the old process has stopped, then remove: ' + path + '.lock');
  } catch (error) {if (code(error) !== 'ENOENT') throw error;}
  const directory = path + '.lock-v2', owner = {pid: process.pid, token: randomUUID()};
  const candidate = directory + '.' + owner.token;
  await mkdir(candidate);
  try {
    await writeFile(join(candidate, marker(owner)), JSON.stringify(owner), {flag: 'wx'});
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        await rename(candidate, directory);
        return () => removeOwner(directory, owner);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
        await reclaim(directory);
        await delay(25);
      }
    }
    throw new Error('Another process is saving state; retry shortly');
  } finally {
    await removeOwner(candidate, owner);
  }
}

export async function withFileLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  const release = await acquireFileLock(path);
  try {return await operation();}
  finally {await release();}
}
