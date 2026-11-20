import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

/**
 * Parses standard check.mjs CLI arguments: `node check.mjs <workDir> <headlessJsonPath> [artifactDir]`.
 */
export async function parseCheckArgs(argv = process.argv.slice(2)) {
  const [workDirArg, headlessArg, artifactArg] = argv;
  if (!workDirArg || !headlessArg) {
    throw new Error('Usage: node check.mjs <workDir> <headlessJsonPath> [artifactDir]');
  }
  const workDir = resolve(workDirArg);
  const headlessPath = resolve(headlessArg);
  const raw = await readFile(headlessPath, 'utf8').catch(() => '');
  let headless = {};
  if (raw.trim()) {
    try {
      headless = JSON.parse(raw);
    } catch {
      headless = {};
    }
  }
  const artifactDir = artifactArg
    ? resolve(artifactArg)
    : process.env.EVAL_RESULT_DIR
      ? resolve(process.env.EVAL_RESULT_DIR)
      : dirname(headlessPath);
  return {workDir, headlessPath, headless, artifactDir};
}

/**
 * Prints the check result JSON to stdout and exits 0.
 */
export function emitCheckResult(checks) {
  const pass = checks.length > 0 && checks.every(item => item.pass === true);
  process.stdout.write(JSON.stringify({pass, checks}, null, 2) + '\n');
}
