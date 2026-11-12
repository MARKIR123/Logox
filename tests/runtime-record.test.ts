import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildRuntimeRecord} from '../src/actors/runtime-record.js';
import {ledgerFacts, runtimeRoundSummary} from '../src/context/round-memory.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const cwd = join(tmpdir(), 'proj');
let n = 0;
const step = (name: string, args: Record<string, unknown>, result: string, isError = false): ModelMessage[] => {
  const id = 'c' + n++;
  return [{role: 'assistant', text: '', toolCalls: [{id, name, arguments: JSON.stringify(args)}]}, {role: 'tool', callId: id, name, text: result, isError}];
};
const edit = (file: string) => step('Edit', {file_path: file}, 'Edited ' + file);
const shell = (command: string, exit: number) => step('Shell', {command}, `Exit code: ${exit}\noutput`, exit !== 0);

test('the record lists changed files, the last five commands with exit codes and the acceptance as written', () => {
  const messages = [...edit(join(cwd, 'src', 'a.ts')), ...edit('src/b.ts'), ...edit(join(cwd, 'src', 'a.ts')),
    ...['one', 'two', 'three', 'four', 'five', 'six'].flatMap((name, i) => shell('npm run ' + name, i === 5 ? 1 : 0))];
  const text = buildRuntimeRecord({actor: 'techne', messages, cwd, ownedFiles: ['src/'], acceptance: ['tests pass', 'no lint errors'], roundKnown: true});
  assert.equal(text.split('\n')[0], '[Runtime record of this activity: recorded by the runtime, not written by techne]');
  assert.match(text, /\nChanged: src\/a\.ts, src\/b\.ts\n/);
  assert.doesNotMatch(text, /Outside owns/);
  assert.match(text, /\nCommands: "npm run two" exit 0; "npm run three" exit 0; "npm run four" exit 0; "npm run five" exit 0; "npm run six" exit 1\n/);
  assert.match(text, /\nRound closed by: the model\n/);
  assert.ok(text.endsWith('Acceptance, as you wrote it:\n- tests pass\n- no lint errors'));
  assert.doesNotMatch(text, /Open asks/);
});

test('files outside owns are flagged, an empty ledger reads none, and long lists are capped', () => {
  const outside = buildRuntimeRecord({actor: 'kalon', messages: [...edit('assets/x.svg'), ...edit('src/y.ts')], cwd, ownedFiles: ['assets/']});
  assert.match(outside, /\nChanged: assets\/x\.svg, src\/y\.ts\nOutside owns: src\/y\.ts\nCommands: none$/);
  const empty = buildRuntimeRecord({actor: 'aletheia', messages: [], cwd});
  assert.equal(empty, '[Runtime record of this activity: recorded by the runtime, not written by aletheia]\nChanged: none\nCommands: none');
  const many = buildRuntimeRecord({actor: 'techne', messages: Array.from({length: 23}, (_, i) => edit(`f${i}.ts`)).flat(), cwd});
  assert.match(many, /f19\.ts, \.\.\. 3 more\n/);
  assert.doesNotMatch(many, /f20\.ts/);
});

test('the closing line follows the round marker', () => {
  const base = {actor: 'techne', messages: [], cwd, roundKnown: true};
  assert.match(buildRuntimeRecord({...base, marker: '[runtime]'}), /Round closed by: the runtime \(\[runtime\]\)/);
  assert.match(buildRuntimeRecord({...base, marker: '[failed]'}), /Round closed by: the runtime \(\[failed\]\)/);
  assert.match(buildRuntimeRecord({...base, marker: '[interrupted]'}), /Round closed by: the runtime \(\[interrupted\]\)/);
  assert.doesNotMatch(buildRuntimeRecord({actor: 'techne', messages: [], cwd}), /Round closed by/);
});

test('the round summary and the record share one ledger extraction', () => {
  const messages = [...edit('a.ts'), ...shell('npm test', 0), ...shell('npm run lint', 2)];
  const facts = ledgerFacts(messages);
  assert.deepEqual(facts.files, ['a.ts']);
  assert.deepEqual(facts.commands.map(command => command.exit), ['0', '2']);
  assert.match(runtimeRoundSummary(messages, 'failed'), /Changed a\.ts\. Last command "npm run lint" exit 2\./);
});
