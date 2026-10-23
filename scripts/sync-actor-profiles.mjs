#!/usr/bin/env node
// Development-only sync: overwrite shipped actor profiles in the user directory.
// Use while polishing the master profiles in src/actors/profiles.
// After prompts are frozen, users edit ~/.logox/actors directly.
import {cp, mkdir, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const actorIndex = args.indexOf('--actor');
const only = actorIndex >= 0 ? args[actorIndex + 1] : undefined;
const ids = only ? [only] : ['logox', 'techne', 'kalon', 'aletheia'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'actors', 'profiles');
const target = join(homedir(), '.logox', 'actors');

for (const id of ids) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid actor id: ' + id);
  const from = join(source, id), to = join(target, id);
  if (dryRun) {console.log('[dry-run] ' + from + ' -> ' + to); continue;}
  await mkdir(target, {recursive: true});
  await rm(to, {recursive: true, force: true});
  await cp(from, to, {recursive: true});
  console.log('[sync] ' + id + ' -> ' + to);
}
