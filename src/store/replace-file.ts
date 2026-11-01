import {rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

/** On transient Windows sharing conflicts, retry only the replace; never delete the old file or redo side-effecting operations. */
export async function replaceFile(from: string, to: string, replace = rename, windows = process.platform === 'win32'): Promise<void> {
  for (let attempt = 0;; attempt++) {
    try {await replace(from, to); return;}
    catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (!windows || attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}
