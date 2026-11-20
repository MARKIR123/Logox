import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {runCommand} from './exec.mjs';

/**
 * Initializes a git repository and commits the baseline files so diffs and status can be inspected later.
 */
export async function initBaselineRepo(dir) {
  const steps = [
    ['init'],
    ['config', 'user.name', 'Logox Eval'],
    ['config', 'user.email', 'eval@logox.local'],
    ['add', '-A'],
    ['commit', '-m', 'baseline'],
  ];
  for (const args of steps) {
    const res = await runCommand('git', args, {cwd: dir});
    if (res.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${dir}: ${res.stderr || res.stdout}`);
    }
  }
}

/**
 * Returns parsed `git status --porcelain -uall` entries as `{ status, path }`.
 */
export async function gitStatusEntries(dir) {
  const res = await runCommand('git', ['status', '--porcelain', '-uall'], {cwd: dir});
  if (res.code !== 0) {
    throw new Error(`git status failed in ${dir}: ${res.stderr || res.stdout}`);
  }
  const entries = [];
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const status = rawLine.slice(0, 2);
    let filePath = rawLine.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop().trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    entries.push({status, path: filePath.replaceAll('\\', '/')});
  }
  return entries;
}

/**
 * Computes SHA-256 hex digest of a file (with normalized LF line endings for cross-platform safety).
 */
export async function sha256File(filePath, normalizeCrlf = false) {
  const buf = await readFile(filePath);
  const data = normalizeCrlf ? Buffer.from(buf.toString('utf8').replaceAll('\r\n', '\n'), 'utf8') : buf;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Recursively collects `{ relativePath: sha256 }` for all files under a directory.
 */
export async function hashDirectory(dir, base = dir) {
  const hashes = {};
  const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await hashDirectory(full, base));
    } else if (entry.isFile()) {
      const rel = relative(base, full).replaceAll('\\', '/');
      hashes[rel] = await sha256File(full, true);
    }
  }
  return hashes;
}
