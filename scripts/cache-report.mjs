#!/usr/bin/env node
// Explains prompt-cache behavior of a LOGOX session from its request fingerprints (always on; `kernel.request_fingerprints`).
//
//   node scripts/cache-report.mjs <path> [--json] [--all]
//
// <path> is a session directory (state/sessions/<id>/), a project `.logox` directory (newest session) or a project directory,
// resolved like scripts/score-session.mjs. Per actor, each consecutive pair of `task` requests is compared block by block
// (tools, system, messages): kept prefix, pure append or the first differing block, and every request whose usage shows an almost
// empty cache read is classified (prefix changed / idle / fields changed / unexplained). Definitions: scripts/cache-analysis.mjs.
// Default output lists only pairs that broke the prefix or missed; --all lists every pair; --json prints machine-readable data.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeSession, renderReport} from './cache-analysis.mjs';
import {resolveSession} from './score-session.mjs';

export function main(argv) {
  const paths = argv.filter(arg => !arg.startsWith('--'));
  if (!paths.length || argv.includes('--help')) {
    console.error('Usage: node scripts/cache-report.mjs <path> [--json] [--all]\n  <path>: a session directory, a project .logox directory (newest session) or a project directory.');
    return paths.length ? 0 : 2;
  }
  const {dir, others} = resolveSession(paths[0]);
  const analysis = analyzeSession(dir);
  if (!analysis) {
    console.error('No request fingerprints in ' + dir + ' (sessions recorded before fingerprints, or kernel.request_fingerprints = false).');
    return 1;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({session: dir, otherSessions: others.map(item => item.id), actors: analysis}, null, 2));
  else console.log(renderReport(analysis, {all: argv.includes('--all'), dir}) + (others.length ? '\n\nother sessions: ' + others.map(item => item.id).join(', ') : ''));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {process.exitCode = main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
