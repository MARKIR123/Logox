import {rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

/** Windows 临时共享冲突只重试替换；不删除旧文件，也不重做产生副作用的操作。 */
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
