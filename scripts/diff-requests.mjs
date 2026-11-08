#!/usr/bin/env node
// Compares consecutive request dumps (LOGOX_DUMP_REQUESTS=1) and prints where each pair first differs.
// Usage: node scripts/diff-requests.mjs <dir> [--context N] [--keepalive]
//   <dir>  a requests directory (<session>/requests) holding one folder per actor, or a single actor folder.
// Cache warm-ups (`-keepalive` files) are skipped unless --keepalive is given.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** First differing offset of two strings, or -1 when equal. Offsets count UTF-16 code units, as `String.slice` does. */
export function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : limit;
}

export function compareConsecutive(files, context = 200) {
  const results = [];
  for (let i = 1; i < files.length; i++) {
    const before = readFileSync(files[i - 1].path, 'utf8'), after = readFileSync(files[i].path, 'utf8');
    const offset = firstDifference(before, after);
    results.push({from: files[i - 1].name, to: files[i].name, offset, sizeBefore: before.length, sizeAfter: after.length,
      before: offset < 0 ? '' : before.slice(Math.max(0, offset - context), offset + context),
      after: offset < 0 ? '' : after.slice(Math.max(0, offset - context), offset + context)});
  }
  return results;
}

function requestFiles(dir, keepalive) {
  return readdirSync(dir).filter(name => /^\d+-.*\.json$/.test(name) && (keepalive || !name.endsWith('-keepalive.json'))).sort()
    .map(name => ({name, path: join(dir, name)}));
}

export function main(argv) {
  const args = argv.filter(arg => !arg.startsWith('--')), flags = argv.filter(arg => arg.startsWith('--'));
  const contextIndex = argv.indexOf('--context');
  const context = contextIndex >= 0 ? Number(argv[contextIndex + 1]) || 200 : 200;
  const dir = args.find(arg => arg !== String(context));
  if (!dir) {console.error('Usage: node scripts/diff-requests.mjs <requests dir> [--context N] [--keepalive]'); return 2;}
  const keepalive = flags.includes('--keepalive');
  const own = requestFiles(dir, keepalive);
  const groups = own.length ? [[dir, own]] : readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory())
    .map(name => [name, requestFiles(join(dir, name), keepalive)]);
  if (!groups.length) {console.error('No request dumps found in ' + dir); return 1;}
  for (const [actor, files] of groups) {
    console.log('== ' + actor + ' (' + files.length + ' requests)');
    for (const item of compareConsecutive(files, context)) {
      console.log(item.from + ' -> ' + item.to + ': ' + (item.offset < 0 ? 'identical' : 'first difference at offset ' + item.offset +
        ' (' + item.sizeBefore + ' vs ' + item.sizeAfter + ' chars)'));
      if (item.offset >= 0) {console.log('  before: ' + JSON.stringify(item.before)); console.log('  after:  ' + JSON.stringify(item.after));}
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
