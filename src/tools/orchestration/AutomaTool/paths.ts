import {realpathSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';

/**
 * The real spelling of a path: links resolved, Windows 8.3 short names expanded (`ADMINI~1` -> `Administrator`), and the
 * not-yet-existing tail kept as given. Synchronous so planning and worker checks can share it.
 */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || current === parent) return resolve(current, ...missing.reverse());
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

/** The comparison form of a canonical path: forward slashes, no trailing slash, lower case on Windows. */
export function pathKey(canonical: string): string {
  const text = canonical.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** Whether `target` is `root` or below it. Both are canonicalised first, so any spelling of either side compares equal. */
export function within(root: string, target: string): boolean {
  const a = pathKey(canonicalPath(root)), b = pathKey(canonicalPath(target));
  return b === a || b.startsWith(a + '/');
}
