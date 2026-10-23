import {createHash, randomUUID} from 'node:crypto';
import {lstat, open, readFile, rename, unlink} from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {withFileLock} from '../store/file-lock.js';
import {builtinActors} from './builtins.js';

const shippedFingerprints: Readonly<Record<string, string>> = {
  logox: '5e65c87b967adf91378da790aca880613a39af3d2f86bf303fecb1c7d53af072',
  techne: '87349dd0bf5cb6adfe31ac5de300c75a42318a0f301069168fe0cdc44975f65d',
  aletheia: '8f45ee9fbb46301ff3f576e13bf8d1d93672999cc5743db060b7742fc956b40c',
  kalon: 'ea9d01f86c8e2b8bade39fd71c135efadc8df05005682bdb9c56e2c2baaba118',
};
const fingerprint = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
async function current(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 ? await readFile(path, 'utf8') : undefined;
  } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
}

/** Catalog has checked the profile ancestry; only known unchanged defaults are replaceable. */
export async function refreshShippedCompression(path: string, actorId: string, expectedCurrent: string): Promise<'updated' | 'preserved'> {
  const role = builtinActors.find(actor => actor.id === actorId);
  if (!role || !Object.hasOwn(shippedFingerprints, actorId) || basename(path) !== 'compression.md' || basename(dirname(path)) !== actorId ||
    fingerprint(expectedCurrent) !== shippedFingerprints[actorId] || await current(path) !== expectedCurrent) return 'preserved';
  return withFileLock(path, async () => {
    if (await current(path) !== expectedCurrent) return 'preserved';
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx');
      try {await handle.writeFile(role.compression + '\n', 'utf8'); await handle.sync();} finally {await handle.close();}
      if (await current(path) !== expectedCurrent) return 'preserved';
      await rename(temporary, path);
      return 'updated';
    } finally {await unlink(temporary).catch(() => {});}
  });
}
