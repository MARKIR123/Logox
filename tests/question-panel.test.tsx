import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {render, renderToString} from 'ink';
import {setTimeout as delay} from 'node:timers/promises';
import stringWidth from 'string-width';
import {TerminalScreen} from './terminal-screen.js';
import {QuestionPanel, type PanelQuestion, type QuestionSelection} from '../src/tui/interactions/question-panel.js';
import {PreviewQuestions, QuestionShowcase, sampleQuestions, secretSample} from '../src/tui/previews/question-preview.js';
import {runProviderPreview, type PreviewProviderChange} from '../src/tui/previews/provider-wizard-preview.js';
const plain = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const choices: PanelQuestion = {header: 'Approach', question: 'Choose an approach', options: [
  {label: 'Alpha', description: 'First choice'}, {label: 'Beta', description: 'Second choice'},
]};
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

async function panel(question: PanelQuestion, extra: Partial<Parameters<typeof QuestionPanel>[0]> = {}) {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new Input(), output = new TerminalScreen(), answers: QuestionSelection[] = [];
  let cancelled = 0;
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<QuestionPanel question={question} position={1} total={1} answered={0} width={79} height={20}
    onAnswer={value => {answers.push(value);}} onCancel={() => {cancelled++;}} onToggleFold={() => {}} {...extra}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
  await instance.waitUntilRenderFlush();
  return {input, output, answers, cancelled: () => cancelled, key, screen: () => output.lines.join('\n'),
    async close() {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy(); Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: false});}};
}

test('original interactive demo applies grouped spacing to every question and keeps navigation live', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new Input(), output = new TerminalScreen(); let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<QuestionShowcase clipboard={async () => null}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(15);}); await instance.waitUntilRenderFlush();};
  const screen = () => output.lines.join('\n');
  const grouped = (header: string, position: number, labels: readonly string[]) => {
    const lines = output.lines;
    assert.ok(lines.some(line => line.startsWith('─ ' + header + ' ') && line.includes(`${position}/3`)), 'Category and progress share one header');
    assert.ok(!lines.some(line => line.includes('◈ ')), 'No duplicate category row');
    for (const label of labels) {
      const at = lines.findIndex(line => line.includes(label)); assert.ok(at > 0, label);
      assert.equal(lines[at - 1]?.trim(), '', 'Blank line before option group: ' + label);
    }
    const inputAt = lines.findIndex(line => line.includes('My view:'));
    assert.ok(inputAt > 0); assert.equal(lines[inputAt - 1]?.trim(), '', 'My view is a separate section');
  };
  try {
    await instance.waitUntilRenderFlush();
    grouped('Approach', 1, ['Keep the existing interface', 'Explore an alternative']);
    assert.match(screen(), /Question 1\/3/, 'Header keeps the full question counter');
    assert.doesNotMatch(screen(), /left\b/, 'No redundant remaining-question count');
    await key('\x1b[B'); assert.match(screen(), /❯ \[■\] Explore an alternative/);
    await key('\r');
    grouped('Checks', 2, ['UI tests', 'Keyboard and mouse', 'Narrow terminal']);
    await key('\x1b[B'); assert.match(screen(), /❯ \[ \] Keyboard and mouse/);
    assert.match(screen(), /\[■\] UI tests/);
    await key(' '); await key('\x1b[B'); assert.match(screen(), /❯ \[ \] Narrow terminal/);
    await key('\x1b[A'); assert.match(screen(), /❯ \[■\] Keyboard and mouse/);
    await act(async () => {output.resize(40, 14);}); await instance.waitUntilRenderFlush();
    assert.match(screen(), /❯ \[■\] Keyboard and mouse/); assert.match(screen(), /My view:/);
    await act(async () => {output.resize(80, 24);}); await instance.waitUntilRenderFlush();
    grouped('Checks', 2, ['UI tests', 'Keyboard and mouse', 'Narrow terminal']);
    assert.match(screen(), /Question 2\/3/, 'Answering advances the question number');
    assert.doesNotMatch(screen(), /left\b/, 'No remaining-question count is shown');
    await key('\r'); grouped('Notes', 3, []);
    await key('preserve drafts'); await key('\x1b[H'); await key('\x1b[D');
    assert.match(screen(), /\[■\] UI tests/); assert.match(screen(), /\[■\] Keyboard and mouse/);
    await key('\x1b[C'); assert.match(screen(), /My view: preserve drafts/);
    await key('\r'); assert.ok(output.lines.some(line => line === 'Keep this chat draft'));
  } finally {
    await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: false});
  }
});

test('grouped demo mouse targets and native caret follow the rendered rows after resize', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new Input(), output = new TerminalScreen(); let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<QuestionShowcase clipboard={async () => null}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(15);}); await instance.waitUntilRenderFlush();};
  const click = (row: number) => key(`\x1b[<0;8;${row + 1}M`);
  const screen = () => output.lines.join('\n');
  try {
    await instance.waitUntilRenderFlush(); await key('\r');
    const beta = output.lines.findIndex(line => line.includes('Keyboard and mouse'));
    assert.ok(beta > 0); assert.equal(output.lines[beta - 1]?.trim(), '');
    await click(beta - 1); assert.match(screen(), /❯ \[■\] UI tests/);
    await click(beta + 1); assert.match(screen(), /❯ \[■\] Keyboard and mouse/);
    const header = output.lines.findIndex(line => line.startsWith('─ Checks'));
    await click(header); assert.match(screen(), /Waiting for your answer/);
    await key('\x0b'); assert.match(screen(), /❯ \[■\] Keyboard and mouse/);
    await click(output.lines.findIndex(line => line.includes('My view:')));
    assert.match(screen(), /❯ My view:/); await key('中🙂e');
    for (const [columns, rows] of [[80, 24], [40, 14], [20, 12], [80, 24]]) {
      await act(async () => {output.resize(columns!, rows!);}); await instance.waitUntilRenderFlush();
      const inputRow = output.lines.findIndex(line => line.includes('My view:'));
      assert.ok(inputRow >= 0, `Input visible at ${columns}x${rows}`);
      assert.equal(output.cursorPosition.y, inputRow, 'IME caret stays on the actual input row');
      assert.equal(output.cursorPosition.x, stringWidth(output.lines[inputRow]!), 'Caret follows the visible Unicode text');
      if (columns === 40) {
        await click(output.lines.findIndex(line => line.includes('Keyboard and mouse')));
        assert.match(screen(), /❯ \[ \] Keyboard and mouse/, 'Compact click hits the intended option');
        await click(output.lines.findIndex(line => line.includes('My view:')));
        assert.match(screen(), /❯ My view:/, 'Compact input click uses its new absolute row');
        await click(output.lines.findIndex(line => line.includes('Keyboard and mouse')));
        await click(output.lines.findIndex(line => line.includes('My view:')));
      }
    }
    await click(output.lines.findIndex(line => line.includes('Enter Submit')));
    assert.ok(output.lines.some(line => line.startsWith('─ Notes ') && line.includes('3/3')));
  } finally {
    await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: false});
  }
});

test('question panel preserves option + inline note semantics, including ordinary spaces', async () => {
  const view = await panel(choices);
  try {
    await view.key('hello world');
    assert.match(view.screen(), /My view \(Alpha\): hello world/);
    assert.doesNotMatch(view.screen(), /✎|Custom answer/);
    assert.equal(view.answers.length, 0);
    await view.key('\r');
    assert.deepEqual(view.answers, [{selected: ['Alpha'], custom: 'hello world'}]);
  } finally {await view.close();}
});

test('enhanced keyboard release events never submit or toggle a local question', async () => {
  const empty = await panel({question: 'Optional answer', allowEmpty: true});
  try {
    await empty.key('\x1b[13;1:3u');
    assert.equal(empty.answers.length, 0, 'Enter release alone cannot advance a wizard');
    await empty.key('\x1b[13;1:1u');
    await empty.key('\x1b[13;1:3u');
    assert.equal(empty.answers.length, 1, 'One press and release produce exactly one answer');
  } finally {await empty.close();}
  const multi = await panel({...choices, multiSelect: true});
  try {
    await multi.key('\x1b[32;1:3u');
    assert.doesNotMatch(multi.screen(), /\[■\]/, 'Space release cannot toggle');
    await multi.key('\x1b[32;1:1u');
    await multi.key('\x1b[32;1:3u');
    await multi.key('\r');
    assert.equal(multi.answers.length, 1);
    assert.deepEqual(multi.answers[0]?.selected, ['Alpha']);
  } finally {await multi.close();}
});

test('multi-select uses Space to toggle, Enter submits checked labels and optional text', async () => {
  const view = await panel({...choices, multiSelect: true});
  try {
    await view.key(' \x1b[B'); // same input chunk: focus moves without clearing the checked state.
    assert.match(view.screen(), /\[■\] Alpha/);
    assert.match(view.screen(), /❯ \[ \] Beta/, 'Focus does not check a multi-select item');
    await view.key(' ');
    await view.key('\t'); await view.key('plus note'); await view.key('\r');
    assert.deepEqual(view.answers, [{selected: ['Alpha', 'Beta'], custom: 'plus note'}]);
  } finally {await view.close();}
});

test('pure text answers edit whole code points, and bracketed paste never submits', async () => {
  const view = await panel({question: 'Enter a value', secret: true});
  try {
    await view.key('\x1b[200~ab🙂cd\x1b[201~');
    assert.equal(view.answers.length, 0);
    assert.ok(!view.output.text.includes('ab🙂cd'));
    assert.match(view.screen(), /•••••/);
    await view.key('\x1b[D\x1b[D\x7fZ'); await view.key('\r');
    assert.deepEqual(view.answers, [{selected: [], custom: 'abZcd'}]);
    assert.ok(!view.output.text.includes('abZcd'));
  } finally {await view.close();}
});

test('empty required answer is rejected; optional local input can deliberately submit empty', async () => {
  const required = await panel({question: 'Required'});
  try {await required.key('\r'); assert.equal(required.answers.length, 0); assert.match(required.screen(), /Type an answer/);}
  finally {await required.close();}
  const optional = await panel({question: 'Optional', allowEmpty: true});
  try {await optional.key('\r'); assert.deepEqual(optional.answers, [{selected: [], custom: ''}]);}
  finally {await optional.close();}
});

test('late async clipboard completion after cancellation cannot change or answer the question', async () => {
  let finish!: (text: string) => void;
  const view = await panel({question: 'Key', secret: true}, {readClipboard: () => new Promise(resolve => {finish = resolve;})});
  try {
    await view.key('\x16'); await view.key('\x1b');
    assert.equal(view.cancelled(), 1);
    await act(async () => {finish('late-private-value');});
    assert.equal(view.answers.length, 0);
    assert.ok(!view.output.text.includes('late-private-value'));
  } finally {await view.close();}
});

test('paste limits reject the whole oversized chunk rather than silently truncate', async () => {
  const view = await panel({question: 'Notes'});
  try {
    await view.key('\x1b[200~' + 'x'.repeat(8001) + '\x1b[201~');
    assert.match(view.screen(), /maximum 8000/); assert.equal(view.answers.length, 0);
  } finally {await view.close();}
});

test('short and narrow question view keeps selected option visible with horizontal rules only', () => {
  for (const width of [20, 40, 80]) for (const height of [6, 8, 18]) {
    const output = plain(renderToString(<QuestionPanel question={{question: 'A long question that needs wrapping to fit a narrow terminal',
      options: Array.from({length: 30}, (_, index) => ({label: 'o' + index, description: 'Long explanatory detail'}))}}
      initialDraft={{selected: ['o24']}} position={1} total={3} answered={0} width={width} height={height}
      onAnswer={() => {}} onCancel={() => {}} onToggleFold={() => {}}/>, {columns: width}));
    assert.ok(output.includes('o24'), `Selected option hidden at ${width}x${height}:\n${output}`);
    assert.ok(output.split('\n').length <= height);
    assert.ok(output.split('\n').every(line => stringWidth(line) <= width));
    assert.doesNotMatch(output, /[╭╮╰╯│]/);
    assert.match(output.split('\n').at(-1)!, /^─+$/);
  }
});

test('all shared question shapes keep input and rules inside the actual row budget', () => {
  const shapes: readonly PanelQuestion[] = [...sampleQuestions, secretSample, {...choices, hideCustomInput: true}];
  for (const question of shapes) for (const width of [20, 40, 80]) for (const height of [5, 6, 8, 12, 18, 24]) {
    const output = plain(renderToString(<QuestionPanel question={question} width={width} height={height} position={1} total={3} answered={0}
      onAnswer={() => {}} onCancel={() => {}} onToggleFold={() => {}}/>, {columns: width}));
    const lines = output.split('\n');
    assert.ok(lines.length <= height, `${question.header}: ${width}x${height}\n${output}`);
    assert.ok(lines.every(line => stringWidth(line) <= width));
    assert.match(lines.at(-1)!, /^─+$/);
    if (!question.hideCustomInput || !question.options?.length) {
      const inputAt = lines.findIndex(line => line.includes(question.secret ? 'Input:' : 'My view:'));
      assert.ok(inputAt >= 0, 'Input is never displaced by decorative whitespace');
      if (width === 80 && height === 24) assert.equal(lines[inputAt - 1]?.trim(), '');
    } else assert.doesNotMatch(output, /My view:|Input:/);
  }
});

test('preview batch navigation restores drafts without marking them answered', async () => {
  const session = new PreviewQuestions();
  const result = session.ask([{question: 'First'}, {question: 'Second'}]);
  session.navigate(1, {selected: [], custom: 'draft'});
  assert.equal(session.getSnapshot()?.answered, 0);
  session.navigate(-1, {selected: [], custom: 'other'});
  assert.equal(session.getSnapshot()?.draft?.custom, 'draft');
  session.answer({selected: [], custom: 'first final'});
  assert.equal(session.getSnapshot()?.draft?.custom, 'other');
  session.answer({selected: [], custom: 'second final'});
  assert.deepEqual(await result, [{selected: [], custom: 'first final'}, {selected: [], custom: 'second final'}]);
  assert.equal(session.getSnapshot(), null); session.close();
});

test('editing a committed answer requires re-submission rather than returning stale data', async () => {
  const session = new PreviewQuestions();
  const result = session.ask([{question: 'First'}, {question: 'Second'}]);
  session.answer({selected: [], custom: 'old'});
  session.navigate(-1, {selected: [], custom: 'second draft'});
  session.navigate(1, {selected: [], custom: 'edited'});
  session.answer({selected: [], custom: 'second final'});
  assert.equal(session.getSnapshot()?.position, 1);
  assert.equal(session.getSnapshot()?.draft?.custom, 'edited');
  session.answer({selected: [], custom: 'edited'});
  assert.deepEqual(await result, [{selected: [], custom: 'edited'}, {selected: [], custom: 'second final'}]);
  session.close();
});

test('cancel and back-navigation still work below the minimum editing height', async () => {
  for (const height of [1, 2, 4]) {
    const view = await panel({question: 'Small'}, {height});
    try {await view.key('\x1b'); assert.equal(view.cancelled(), 1);}
    finally {await view.close();}
  }
});

test('provider preview follows custom-add order and writes only after confirmation', async () => {
  const asked: (readonly PanelQuestion[])[] = [], changes: PreviewProviderChange[] = [];
  const script: readonly QuestionSelection[][] = [
    [{selected: ['Add a new provider']}], [{selected: ['Custom API endpoint']}], [{selected: [], custom: 'my-gateway'}],
    [{selected: [], custom: 'private-fixture-key'}], [{selected: [], custom: 'http://127.0.0.1:8045/v1'}, {selected: ['openai-responses']}],
    [{selected: ['demo-model-a'], custom: 'other-a other-b,other-c'}], [{selected: ['Write and enable']}],
  ];
  await runProviderPreview({ask: async questions => {
    assert.equal(changes.length, 0, 'No pre-confirmation commit');
    asked.push(questions); return script[asked.length - 1]!;
  }, commit: value => {changes.push(value);}});
  assert.equal(asked[3]![0]!.secret, true);
  assert.equal(asked[4]!.length, 2, 'URL and protocol belong to one navigable batch');
  assert.equal(asked[4]![1]!.options?.length, 3, 'Responses protocol is present');
  assert.equal(asked[5]![0]!.multiSelect, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.protocol, 'openai-responses');
  assert.deepEqual(changes[0]!.models, ['demo-model-a', 'other-a', 'other-b', 'other-c']);
  assert.ok(!JSON.stringify(changes).includes('private-fixture-key'));
});

test('provider deletion requires its own confirmation and cancellation creates no effects', async () => {
  const answers: QuestionSelection[][] = [
    [{selected: ['Edit an existing provider']}], [{selected: ['local-gateway']}], [{selected: ['Delete provider']}], [{selected: ['Cancel']}],
  ];
  const changes: PreviewProviderChange[] = [];
  await runProviderPreview({ask: async () => answers.shift() ?? null, commit: value => {changes.push(value);}});
  assert.deepEqual(changes, []);
});

test('targeted edit ignores blank and unchanged values', async () => {
  for (const [field, value] of [
    ['API key', {selected: [], custom: ''}], ['Base URL', {selected: [], custom: ''}],
    ['Wire protocol', {selected: ['openai-completions']}], ['Model list', {selected: ['demo-model-a']}], ['Model list', {selected: []}],
  ] satisfies [string, QuestionSelection][]) {
    const answers: QuestionSelection[][] = [[{selected: ['Edit an existing provider']}], [{selected: ['local-gateway']}], [{selected: [field]}], [value]];
    const changes: PreviewProviderChange[] = [];
    await runProviderPreview({ask: async () => answers.shift() ?? null, commit: change => {changes.push(change);}});
    assert.deepEqual(changes, [], field);
  }
});

test('built-in Add permits an unrestricted catalog', async () => {
  const answers: QuestionSelection[][] = [[{selected: ['Add a new provider']}], [{selected: ['Built-in provider']}],
    [{selected: ['deepseek']}], [{selected: [], custom: 'fake-key'}], [{selected: ['Use default endpoint']}],
    [{selected: []}], [{selected: ['Write and enable']}]];
  const changes: PreviewProviderChange[] = [];
  await runProviderPreview({ask: async () => answers.shift() ?? null, commit: change => {changes.push(change);}});
  assert.deepEqual(changes[0]?.models, []);
  const editAnswers: QuestionSelection[][] = [[{selected: ['Edit an existing provider']}], [{selected: ['deepseek']}],
    [{selected: ['Model list']}], [{selected: []}]];
  await runProviderPreview({ask: async questions => {
    if (questions[0]?.multiSelect) assert.equal(questions[0].allowEmpty, true, 'Catalog model edits can restore the whole catalog');
    return editAnswers.shift() ?? null;
  }, commit: change => {changes.push(change);}});
  assert.deepEqual(changes[1]?.models, []);
});

test('login preview shares the panel, masks its key through folding and commits only safe fake metadata', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new Input(), output = new TerminalScreen(); let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<QuestionShowcase mode="login" clipboard={async () => null}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(15);}); await instance.waitUntilRenderFlush();};
  const screen = () => output.lines.join('\n');
  try {
    await instance.waitUntilRenderFlush();
    await key('\r'); await key('\x1b[B'); await key('\r');
    assert.match(screen(), /Enter a route name/);
    await key('my-gateway'); await key('\r');
    assert.match(screen(), /Enter the API key/);
    assert.match(screen(), /Input:/);
    assert.doesNotMatch(screen(), /My view|✎/);
    await key('synthetic-preview-key');
    assert.ok(!output.text.includes('synthetic-preview-key'));
    assert.match(screen(), /••••/);
    await key('\x0b'); assert.match(screen(), /Waiting for your answer/);
    await key('\x0b'); assert.match(screen(), /••••/);
    await key('\r'); assert.match(screen(), /─ Providers .*1\/2/);
    await key('http://127.0.0.1:8045/v1'); await key('\r'); assert.match(screen(), /─ Providers .*2\/2/);
    await key('\x1b[B'); await key('\r');
    await key(' '); await key('\r');
    assert.match(screen(), /Write this provider configuration/);
    assert.ok(!screen().includes('1 simulated provider changes'));
    await key('\r');
    assert.match(screen(), /1 simulated provider changes/);
    assert.ok(output.lines.some(line => line === 'Keep this chat draft'));
    assert.ok(!output.text.includes('synthetic-preview-key'));
  } finally {
    await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: false});
  }
});

test('folded question permits preview chat and restores the exact answer draft on expand', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new Input(), output = new TerminalScreen(); let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<QuestionShowcase clipboard={async () => null}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(15);}); await instance.waitUntilRenderFlush();};
  try {
    await instance.waitUntilRenderFlush();
    await key('answer note'); await key('\x0b'); await key(' CHAT');
    assert.match(output.lines.join('\n'), /Waiting for your answer/);
    assert.match(output.lines.join('\n'), /Keep this chat draft CHAT/);
    await key('\x1b[200~ PASTED\x1b[201~');
    assert.match(output.lines.join('\n'), /Keep this chat draft CHAT PASTED/);
    await key('\x0b');
    assert.match(output.lines.join('\n'), /answer note/);
    assert.ok(!output.lines.join('\n').includes('Keep this chat draft CHAT'), 'Expanded question takes input focus');
    await key('\t');
    assert.match(output.lines.join('\n'), /❯ My view/);
    assert.doesNotMatch(output.lines.join('\n'), /✎|Custom answer|My perspective/);
    await key('\x0b'); assert.match(output.lines.join('\n'), /Keep this chat draft CHAT PASTED/);
    for (const rows of [1, 2, 24]) {
      await act(async () => {output.resize(80, rows);}); await instance.waitUntilRenderFlush();
      assert.ok(!/\x1b\[0;\d+[Hf]/.test(output.text), 'Never emit a negative/zero terminal cursor row');
    }
    assert.match(output.lines.join('\n'), /Keep this chat draft CHAT PASTED/);
  } finally {
    await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: false});
  }
});
