#!/usr/bin/env node
// npm postinstall: distribute shipped actor profiles into the user directory.
// Missing-only; never overwrites an existing profile. Safe to run repeatedly.
import {cp, mkdir, stat} from 'node:fs/promises';
import {statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = [join(root, 'dist', 'src', 'actors', 'profiles'), join(root, 'src', 'actors', 'profiles')]
  .find(path => {try {return statSync(path).isDirectory();} catch {return false;}});
const ids = ['logox', 'techne', 'kalon', 'aletheia'];
if (!source) {
  console.warn('[logox] actor profile source not found; run `logox --install-profiles` after building.');
  process.exit(0);
}
const target = join(homedir(), '.logox', 'actors');
const installed = [];
try {
  for (const id of ids) {
    const from = join(source, id), to = join(target, id);
    let exists = false;
    try {exists = (await stat(to)).isDirectory();} catch {}
    if (exists) continue;
    await mkdir(target, {recursive: true});
    await cp(from, to, {recursive: true});
    installed.push(id);
  }
  if (installed.length) console.log('[logox] installed actor profiles: ' + installed.join(', '));
} catch (error) {
  console.warn('[logox] could not install actor profiles: ' + (error instanceof Error ? error.message : String(error)) +
    '; run `logox --install-profiles` later.');
}
