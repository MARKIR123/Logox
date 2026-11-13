import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Synthetic request-fingerprint files for the report and scorer tests; shapes follow `src/providers/fingerprint.ts:FingerprintRecord`. */
export type SyntheticBlock = [hash: string, tokens: number, label: string];
const FIELDS = {maxTokens: 4096, thinking: 'none:auto', retention: 'short', ttlMs: 300_000, cacheKey: false, stream: true, discovery: 'none'};
export const block = (hash: string, label: string, tokens = 100): SyntheticBlock => [hash, tokens, label];

export function request(id: string, seconds: number, messages: SyntheticBlock[], extra: Record<string, unknown> = {}) {
  const total = 300 + messages.reduce((sum, item) => sum + item[1], 0);
  return {v: 1, kind: 'request', id, time: 1_000_000_000 + seconds * 1000, ownerId: 'techne', activityId: 'act1', purpose: 'task', model: 'claude-test', host: 'api.example',
    protocol: 'anthropic', tools: 'tools0001', system: ['system0001'], messages,
    sizes: {tools: 100, system: 200, user: 0, assistantText: 0, thinking: 0, toolArgs: 0, toolResults: {Read: total - 300}, images: {count: 0, tokens: 0}, context: 0, total},
    fields: {...FIELDS, ...(extra['fields'] as object | undefined)}, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'fields'))};
}
export const result = (id: string, seconds: number, input: number, cacheRead: number) =>
  ({v: 1, kind: 'result', id, time: 1_000_000_000 + seconds * 1000 + 800, ms: 800, usage: {input, output: 20, cacheRead, cacheWrite: 0}});

const A = block('aaaaaaaaaa', 'user'), B = block('bbbbbbbbbb', 'assistant+calls1'), C = block('cccccccccc', 'tool:Read'), D = block('dddddddddd', 'assistant'),
  X = block('xxxxxxxxxx', 'context:reminder'), E = block('eeeeeeeeee', 'tool:Shell'), F = block('ffffffffff', 'assistant+calls2');

/**
 * One actor `techne`: a cold start, a clean hit, then one request of each miss class.
 *   r1 cold            r2 pure append, hit          r3 pure append, same fields, 10 s gap, no cache read -> unexplained
 *   r4 message 1 changed (reminder), no read -> prefix changed
 *   r5 pure append but `thinking` differs, no read -> fields changed
 *   r6 pure append, same fields, 400 s later (lifetime 300 s), no read -> idle
 */
export function techneRequests() {
  const rows = [
    request('r1', 0, [A, B]), result('r1', 0, 5000, 0),
    request('r2', 10, [A, B, C]), result('r2', 10, 5200, 4900),
    request('r3', 20, [A, B, C, D]), result('r3', 20, 5400, 0),
    request('r4', 30, [A, X, C, D, E]), result('r4', 30, 5600, 0),
    request('r5', 40, [A, X, C, D, E, F], {fields: {thinking: 'anthropic-adaptive:high'}}), result('r5', 40, 5800, 0),
    request('r6', 440, [A, X, C, D, E, F, B], {fields: {thinking: 'anthropic-adaptive:high'}}), result('r6', 440, 6000, 0),
  ];
  return rows;
}
export async function writeFingerprints(sessionDir: string, actor: string, rows: unknown[]): Promise<void> {
  await mkdir(join(sessionDir, 'requests'), {recursive: true});
  await writeFile(join(sessionDir, 'requests', actor + '.fingerprints.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
