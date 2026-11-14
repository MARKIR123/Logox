import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {block, request, result, techneRequests, writeFingerprints} from './fingerprint-fixture.js';

interface Pair {id: string; kept: number; total: number; pure: boolean; firstDiff: {index: number; label: string} | null; tokensAfter: number; miss: boolean; class: string | null; detail: string | null}
interface Summary {requests: number; task: number; keepalive: number; pairs: number; pureAppend: number; pureAppendShare: number | null; cacheReadShare: number | null;
  misses: Record<string, number>; missCount: number; sizeAverage: Record<string, number>; largest: {id: string} | null}
type Analysis = Record<string, {summary: Summary; pairs: Pair[]}>;
const analysis = await import(new URL('../../scripts/cache-analysis.mjs', import.meta.url).href) as {
  analyzeSession(dir: string): Analysis | null; renderReport(analysis: Analysis, options?: {all?: boolean; dir?: string}): string;
};
const report = await import(new URL('../../scripts/cache-report.mjs', import.meta.url).href) as {main(argv: string[]): number};

async function withSession<T>(rows: unknown[], run: (dir: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'logox-cache-report-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', 's1');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'director.jsonl'), '');
    await writeFingerprints(dir, 'techne', rows);
    return await run(dir, root);
  } finally {await rm(root, {recursive: true, force: true});}
}
const capture = (action: () => number): {code: number; text: string} => {
  const logged: string[] = [], log = console.log;
  console.log = (text: string) => {logged.push(text);};
  try {const code = action(); return {code, text: logged.join('\n')};} finally {console.log = log;}
};

test('the report classifies each miss as prefix changed, fields changed, idle or unexplained and leaves hits and the cold start alone', async () => {
  await withSession(techneRequests(), async dir => {
    const techne = analysis.analyzeSession(dir)!['techne']!;
    const byId = Object.fromEntries(techne.pairs.map(pair => [pair.id, pair]));
    assert.deepEqual(techne.pairs.map(pair => pair.id), ['r2', 'r3', 'r4', 'r5', 'r6'], 'the cold first request has no pair');
    assert.equal(byId['r2']!.miss, false);
    assert.equal(byId['r2']!.class, null);
    assert.equal(byId['r3']!.class, 'unexplained');
    assert.equal(byId['r4']!.class, 'prefix changed');
    assert.equal(byId['r5']!.class, 'fields changed');
    assert.equal(byId['r5']!.detail, 'thinking');
    assert.equal(byId['r6']!.class, 'idle');
    assert.deepEqual(techne.summary.misses, {'prefix changed': 1, 'fields changed': 1, idle: 1, unexplained: 1});
    assert.equal(techne.summary.missCount, 4);
    assert.equal(techne.summary.requests, 6);
    assert.equal(techne.summary.pairs, 5);
    assert.equal(techne.summary.pureAppend, 4);
    assert.equal(techne.summary.pureAppendShare, 0.8);
    assert.ok(techne.summary.cacheReadShare! > 0 && techne.summary.cacheReadShare! < 0.2);
    assert.equal(techne.summary.largest?.id, 'r6');
    assert.ok(techne.summary.sizeAverage['total']! > 0);
  });
});

test('a changed block is named with its index and label, and the tokens after it are the cost of the break', async () => {
  await withSession(techneRequests(), async dir => {
    const pair = analysis.analyzeSession(dir)!['techne']!.pairs.find(item => item.id === 'r4')!;
    assert.equal(pair.pure, false);
    // tools, system, then messages A B C D -> A X C D E: message 1 (assistant with a call) became a reminder; blocks 0..2 (tools, system, A) are kept.
    assert.deepEqual([pair.kept, pair.total], [3, 6]);
    assert.deepEqual(pair.firstDiff, {index: 3, label: 'msg#1 assistant+calls1 -> msg#1 context:reminder'});
    assert.equal(pair.tokensAfter, 400, 'four message blocks of 100 estimated tokens lie after the break');
    const pure = analysis.analyzeSession(dir)!['techne']!.pairs.find(item => item.id === 'r3')!;
    assert.deepEqual([pure.pure, pure.kept, pure.total, pure.firstDiff, pure.tokensAfter], [true, 5, 5, null, 100]);
  });
});

test('a changed tool list or system block breaks the prefix at the very start', async () => {
  const rows = [
    request('a', 0, [block('h1', 'user')]), result('a', 0, 4000, 0),
    request('b', 5, [block('h1', 'user'), block('h2', 'assistant')], {tools: 'tools0002'}), result('b', 5, 4100, 0),
    request('c', 10, [block('h1', 'user'), block('h2', 'assistant'), block('h3', 'user')], {tools: 'tools0002', system: ['system0002']}), result('c', 10, 4200, 0),
  ];
  await withSession(rows, async dir => {
    const pairs = analysis.analyzeSession(dir)!['techne']!.pairs;
    assert.deepEqual(pairs[0]!.firstDiff, {index: 0, label: 'tools'});
    assert.deepEqual(pairs[1]!.firstDiff, {index: 1, label: 'system'});
    assert.deepEqual(pairs.map(pair => pair.class), ['prefix changed', 'prefix changed']);
  });
});

test('a break near the tail does not explain a near-zero read: the miss is classified as if the prefix had been kept', async () => {
  const big = (hash: string, label: string) => block(hash, label, 3000);
  const rows = [
    request('a', 0, [big('h1', 'user'), big('h2', 'assistant'), big('h3', 'tool:Read')]), result('a', 0, 9400, 9000),
    // the last block of the previous request changed; only 100 tokens follow it, yet the provider read nothing
    request('b', 10, [big('h1', 'user'), big('h2', 'assistant'), big('h3x', 'context:snapshot'), block('h4', 'assistant')]), result('b', 10, 9500, 0),
    // the break sits at the very front: most of the prompt lies after it
    request('c', 20, [big('h1y', 'user'), big('h2', 'assistant'), big('h3x', 'context:snapshot'), block('h4', 'assistant'), block('h5', 'user')]), result('c', 20, 9600, 0),
  ];
  await withSession(rows, async dir => {
    const pairs = analysis.analyzeSession(dir)!['techne']!.pairs;
    const [tail, head] = pairs;
    assert.equal(tail!.pure, false);
    assert.deepEqual(tail!.firstDiff, {index: 4, label: 'msg#2 tool:Read -> msg#2 context:snapshot'}, 'the break is still reported');
    assert.equal(tail!.class, 'unexplained');
    assert.equal(head!.class, 'prefix changed');
    const text = analysis.renderReport(analysis.analyzeSession(dir)!, {all: true});
    assert.match(text, /block 4 msg#2 tool:Read -> msg#2 context:snapshot\s+\d+\s+0%\s+unexplained/);
  });
});

test('a non-zero read far below the kept prefix is annotated, in the table and in --json', async () => {
  const big = (hash: string, label: string) => block(hash, label, 3000);
  const rows = [
    request('a', 0, [big('h1', 'user')]), result('a', 0, 3500, 0),
    request('b', 10, [big('h1', 'user'), big('h2', 'assistant'), big('h3', 'tool:Read')]), result('b', 10, 9500, 1000),
    request('c', 20, [big('h1', 'user'), big('h2', 'assistant'), big('h3', 'tool:Read'), big('h4', 'assistant')]), result('c', 20, 12600, 9000),
  ];
  await withSession(rows, async (dir, root) => {
    const pairs = analysis.analyzeSession(dir)!['techne']!.pairs;
    assert.equal((pairs[0] as Pair & {readStopsAt: number | null}).readStopsAt, 1000);
    assert.equal((pairs[1] as Pair & {readStopsAt: number | null}).readStopsAt, null, 'a read close to the kept prefix is not annotated');
    const text = capture(() => report.main([dir]));
    assert.match(text.text, /read stops at ~1000 tok/);
    assert.ok(!/read stops at ~9000/.test(text.text));
    const json = JSON.parse(capture(() => report.main([join(root, 'proj', '.logox'), '--json'])).text) as {actors: Record<string, {pairs: {readStopsAt: number | null; keptTokens: number}[]}>};
    assert.equal(json.actors['techne']!.pairs[0]!.readStopsAt, 1000);
    assert.equal(json.actors['techne']!.pairs[0]!.keptTokens, 3300, 'tools 100 + system 200 + one 3000-token block');
  });
});

test('small prompts, failed requests, keep-alives and missing usage are never counted as misses', async () => {
  const rows = [
    request('a', 0, [block('h1', 'user')]), result('a', 0, 600, 0),
    request('b', 5, [block('h1', 'user'), block('h2', 'assistant')]), result('b', 5, 600, 0),
    request('k', 20, [block('h1', 'user'), block('h2', 'assistant')], {purpose: 'keepalive'}), result('k', 20, 5000, 4900),
    request('c', 30, [block('h1', 'user'), block('h2', 'assistant'), block('h3', 'user')]), {v: 1, kind: 'result', id: 'c', time: 31_000, ms: 10, error: 'temporary'},
    request('d', 40, [block('h1', 'user'), block('h2', 'assistant'), block('h3', 'user'), block('h4', 'assistant')]),
  ];
  await withSession(rows, async dir => {
    const techne = analysis.analyzeSession(dir)!['techne']!;
    assert.equal(techne.summary.missCount, 0);
    assert.equal(techne.summary.keepalive, 1);
    assert.deepEqual(techne.pairs.map(pair => pair.id), ['b', 'd'], 'the failed request is skipped, the keep-alive is not a task pair');
  });
});

test('cache-report prints a readable table and --json machine data, and refuses sessions without fingerprints', async () => {
  await withSession(techneRequests(), async (dir, root) => {
    const text = capture(() => report.main([dir]));
    assert.equal(text.code, 0);
    assert.match(text.text, /\[techne\] 6 requests \(task 6, keepalive 0\)/);
    assert.match(text.text, /pure append 80% \(4\/5 pairs\)/);
    assert.match(text.text, /misses 4: prefix changed 1, idle 1, fields changed 1, unexplained 1/);
    assert.match(text.text, /block 3 msg#1 assistant\+calls1 -> msg#1 context:reminder\s+400\s+0%\s+prefix changed/);
    assert.match(text.text, /idle \(400s gap, lifetime 300s\)/);
    const rowCount = (output: string) => output.split('\n').filter(line => /^ {2}\d\d:\d\d:\d\d /.test(line)).length;
    assert.equal(rowCount(text.text), 4, 'the clean hit is listed only with --all');
    assert.equal(rowCount(capture(() => report.main([dir, '--all'])).text), 5);
    const projectDir = capture(() => report.main([join(root, 'proj')]));
    assert.match(projectDir.text, /\[techne\]/, 'a project directory resolves to its newest session');
    const json = JSON.parse(capture(() => report.main([join(root, 'proj', '.logox'), '--json'])).text) as {actors: Analysis};
    assert.equal(json.actors['techne']!.summary.missCount, 4);
    assert.equal(json.actors['techne']!.pairs.length, 5);
    await rm(join(dir, 'requests'), {recursive: true});
    const errors: string[] = [], error = console.error;
    console.error = (message: string) => {errors.push(message);};
    try {assert.equal(report.main([dir]), 1);} finally {console.error = error;}
    assert.match(errors.join(''), /No request fingerprints/);
  });
});
