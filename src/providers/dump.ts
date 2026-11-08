import {mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const sequences = new Map<string, number>();
/**
 * Debug aid behind `LOGOX_DUMP_REQUESTS=1`: writes the serialized request body exactly as sent to `<dir>/<seq>-<time>.json`
 * (`-keepalive` marks cache warm-ups). Only the body is written; headers and credentials never reach this function.
 * Failures are swallowed so a full disk can never break a model request.
 */
export function dumpRequestBody(dir: string, body: string, purpose?: 'keepalive'): void {
  try {
    mkdirSync(dir, {recursive: true});
    let next = sequences.get(dir);
    if (next === undefined) next = readdirSync(dir).filter(name => /^\d+-/.test(name)).length + 1;
    sequences.set(dir, next + 1);
    writeFileSync(join(dir, String(next).padStart(6, '0') + '-' + Date.now() + (purpose === 'keepalive' ? '-keepalive' : '') + '.json'), body);
  } catch {}
}
