import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

let cached: string | undefined;

/**
 * Resolves the ripgrep binary shipped with LOGOX.
 *
 * Priority:
 *   1. LOGOX_RIPGREP_PATH escape hatch.
 *   2. @vscode/ripgrep platform package (installed as a regular dependency).
 *   3. Bundled copy under dist/src/tools/bin for packaged distributions.
 *   4. System PATH (last resort; the JS fallback handles a missing binary).
 */
export function resolveRgPath(): string {
  if (cached) return cached;
  const explicit = process.env.LOGOX_RIPGREP_PATH;
  if (explicit && existsSync(explicit)) return (cached = explicit);
  try {
    const require = createRequire(import.meta.url);
    const candidate = (require('@vscode/ripgrep') as {rgPath?: unknown}).rgPath;
    if (typeof candidate === 'string' && existsSync(candidate)) return (cached = candidate);
  } catch {
    // Package missing in a trimmed distribution; fall through to bundled paths.
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const candidate of [
    join(here, '..', 'bin', name),
    join(here, '..', '..', '..', 'src', 'tools', 'bin', name),
  ]) {
    if (existsSync(candidate)) return (cached = candidate);
  }
  return (cached = 'rg');
}
