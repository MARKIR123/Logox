import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractNarration, stripNarration} from '../src/runtime/narration.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {createApplication as productionApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';

test('extractNarration extracts leading ⏵ line and strips it from text', () => {
  const sample = '⏵ 正在检查配置文件\n已经定位到配置文件位于 config.toml。';
  const extracted = extractNarration(sample);
  assert.ok(extracted);
  assert.equal(extracted.narration, '正在检查配置文件');
  assert.equal(extracted.cleanText, '已经定位到配置文件位于 config.toml。');
  assert.equal(stripNarration(sample), '已经定位到配置文件位于 config.toml。');
});

test('extractNarration handles standalone ⏵ line without subsequent text', () => {
  const sample = '⏵ 运行单元测试';
  const extracted = extractNarration(sample);
  assert.ok(extracted);
  assert.equal(extracted.narration, '运行单元测试');
  assert.equal(extracted.cleanText, '');
  assert.equal(stripNarration(sample), '');
});

test('extractNarration returns null for casual chat or text without leading ⏵', () => {
  const greeting = '你好！今天想聊点什么？';
  assert.equal(extractNarration(greeting), null);
  assert.equal(stripNarration(greeting), greeting);

  const mention = '请点击 ⏵ 按钮播放音乐。';
  assert.equal(extractNarration(mention), null);
  assert.equal(stripNarration(mention), mention);
});

test('extractNarration strips trailing punctuation from narration and cleans excess newlines', () => {
  const sample = '  \n  ⏵ 修复登录页样式...！。\n\n\n修复代码已提交。';
  const extracted = extractNarration(sample);
  assert.ok(extracted);
  assert.equal(extracted.narration, '修复登录页样式');
  assert.equal(extracted.cleanText, '修复代码已提交。');
});

test('agent loop extracts ⏵ narration into the activity label and keeps the status line in the stored message while the reply streams', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-narration-test-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const turns: ModelTurn[] = [
    {
      message: {
        role: 'assistant',
        text: '⏵ 正在检索项目结构\n已为您找到核心文件。',
      },
      stop: 'complete',
    },
  ];
  const provider: Provider = {
    async respond(_req, onDelta) {
      const next = turns.shift()!;
      if (next.message.text) onDelta({kind: 'text', text: next.message.text});
      return next;
    },
  };
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 's', config, provider});
  try {
    const task = app.ensemble.dispatch('logox', '检查项目', 'direct');
    await task.done;
    const activity = app.store.getSnapshot().activities.find(a => a.activityId === task.activityId)!;
    assert.equal(activity.status, 'completed');
    assert.deepEqual(activity.progress, {label: '正在检索项目结构'}, 'the label is kept for peers; no stage history is written any more');

    const msg = app.store.getSnapshot().messages.find(m => m.activityId === task.activityId && m.role === 'assistant' && !m.kind);
    assert.ok(msg);
    assert.equal(msg.text, '⏵ 正在检索项目结构\n已为您找到核心文件。', 'the stored message keeps its status line for the card');
    assert.equal(stripNarration(msg.text), '已为您找到核心文件。');
    const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 100, {}, null).map(row => row.displayText ?? row.text);
    assert.ok(rows.some(row => row.includes('已为您找到核心文件。')));
    assert.ok(!rows.some(row => row.includes('⏵')), 'the marker never reaches the screen');
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});


test('extraction: the ⏵ must open the first line; mid-prose and later lines never count', () => {
  assert.equal(extractNarration('Fixing it ⏵ now'), null);
  assert.equal(extractNarration('Intro line\n⏵ Fixing the wheel'), null, 'only the first line of the reply');
  assert.equal(extractNarration('   ⏵ Fixing the wheel')?.narration, 'Fixing the wheel');
  assert.equal(extractNarration('\n\n⏵ Fixing the wheel\nbody')?.cleanText, 'body');
});

test('extraction: the text stops at the line end or the first sentence end and the rest stays in the reply', () => {
  const sentence = extractNarration('⏵ Fixing the wheel alignment in pelican-bike.html. Then I will check the frame\nBody line');
  assert.equal(sentence?.narration, 'Fixing the wheel alignment in pelican-bike.html', 'a dot inside a file name is not a sentence end');
  assert.equal(sentence?.cleanText, 'Then I will check the frame\nBody line');
  const cjk = extractNarration('⏵ 修复车轮对齐。随后检查车架\n正文');
  assert.equal(cjk?.narration, '修复车轮对齐');
  assert.equal(cjk?.cleanText, '随后检查车架\n正文');
  assert.equal(extractNarration('⏵ Reading config!\nBody')?.narration, 'Reading config');
});

test('extraction: the cap counts CJK and emoji as two columns and trailing punctuation is trimmed', async () => {
  const {NARRATION_MAX_WIDTH} = await import('../src/runtime/narration.js');
  const stringWidth = (await import('string-width')).default;
  const long = '修'.repeat(80);
  const cut = extractNarration('⏵ ' + long)!.narration;
  assert.ok(stringWidth(cut) <= NARRATION_MAX_WIDTH && stringWidth(cut) >= NARRATION_MAX_WIDTH - 1, 'width ' + stringWidth(cut));
  assert.equal(cut, '修'.repeat(NARRATION_MAX_WIDTH / 2), 'two columns per character');
  const emoji = extractNarration('⏵ ' + '🚀'.repeat(80))!.narration;
  assert.ok(stringWidth(emoji) <= NARRATION_MAX_WIDTH);
  assert.equal(extractNarration('⏵ Checking, then; ...')?.narration, 'Checking, then');
  assert.equal(extractNarration('⏵ 检查配置、')?.narration, '检查配置');
});

test('extraction: an empty line is no narration and the text stays as written', () => {
  for (const text of ['⏵', '⏵   ', '⏵ ...', '⏵ 。\nbody', '']) {
    assert.equal(extractNarration(text), null, JSON.stringify(text));
    assert.equal(stripNarration(text), text);
  }
});

test('extraction reads assistant text only: a reasoning message never feeds the card', async () => {
  const {liveStatus} = await import('../src/tui/timeline/live-status.js');
  const reasoning = {id: 'r', sessionId: 's', ownerId: 'techne', role: 'assistant' as const, kind: 'thinking' as const, text: '⏵ Planning in thought',
    step: {title: 'Thinking', state: 'running' as const, elapsedMs: 0, runningSince: 1000, groupId: 'g'}};
  const status = liveStatus([reasoning]);
  assert.equal(status?.narration, undefined);
  assert.equal(status?.activity, 'Thinking');
});

test('a reply that is only the ⏵ line keeps its words as visible text; with a tool call the line stays out of the text', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-narration-only-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const provider: Provider = {
    async respond(_req, onDelta) {
      onDelta({kind: 'text', text: '⏵ Wrapping up the review'});
      return {message: {role: 'assistant', text: '⏵ Wrapping up the review'}, stop: 'complete'};
    },
  };
  const app = await productionApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 's', config, provider});
  try {
    const task = app.ensemble.dispatch('logox', 'review', 'direct');
    await task.done;
    const msg = app.store.getSnapshot().messages.find(m => m.activityId === task.activityId && m.role === 'assistant' && !m.kind)!;
    assert.equal(msg.text, 'Wrapping up the review', 'the turn is not rendered empty');
    const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 100, {}, null).map(row => row.displayText ?? row.text);
    assert.ok(rows.some(row => row.includes('Wrapping up the review')));
    assert.ok(!rows.some(row => row.includes('⏵')));
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});

test('request assembly never injects earlier status lines into the history', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-narration-history-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const seen: string[][] = [];
  let calls = 0;
  const provider: Provider = {
    async respond(request, onDelta) {
      seen.push(request.messages.filter(message => message.role === 'assistant').map(message => message.text));
      calls++;
      if (calls === 1) {
        const text = '⏵ Looking at the config\nChecking.';
        onDelta({kind: 'text', text});
        return {message: {role: 'assistant', text, toolCalls: [{id: 'c1', name: 'Glob', arguments: JSON.stringify({pattern: '*.json'})}]}, stop: 'tools'};
      }
      onDelta({kind: 'text', text: 'Done.'});
      return {message: {role: 'assistant', text: 'Done.'}, stop: 'complete'};
    },
  };
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 's', config, provider});
  try {
    const task = app.ensemble.dispatch('logox', 'look', 'direct');
    await task.done;
    assert.ok(seen.length >= 2);
    const history = seen.slice(1).flat().join('\n');
    assert.ok(history.includes('Checking.'), 'the model sees its own text');
    assert.ok(!history.includes('⏵'), 'and no status line: it is not fed back');
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});

test('extraction tolerates a wrapper: backticks, * or ** around the line, or leading whitespace; the wrapper never leaks into the reply text', () => {
  const cases: [string, string, string][] = [
    ['`⏵ Drafting the scene`\nBody line', 'Drafting the scene', 'Body line'],
    ['**⏵ Drafting the scene**\nBody line', 'Drafting the scene', 'Body line'],
    ['*⏵ Drafting the scene*', 'Drafting the scene', ''],
    ['  \t`⏵ Drafting the scene.` Then the body\nMore', 'Drafting the scene', 'Then the body\nMore'],
    ['**⏵ Drafting.** Next sentence', 'Drafting', 'Next sentence'],
    ['` ⏵ Drafting `', 'Drafting', ''],
    ['\n  ⏵ Drafting\nBody', 'Drafting', 'Body'],
  ];
  for (const [text, narration, cleanText] of cases) {
    const extracted = extractNarration(text);
    assert.equal(extracted?.narration, narration, JSON.stringify(text));
    assert.equal(extracted?.cleanText, cleanText, JSON.stringify(text));
    assert.equal(stripNarration(text), cleanText);
  }
  for (const text of ['`code` ⏵ not a line', '**bold** text', 'Intro `⏵ mid`', '`⏵`', '**⏵ **\nbody']) assert.equal(extractNarration(text), null, JSON.stringify(text));
});

test('a written ⏵ line survives a restart as a timeline heading from the ledger stage; a reply without one gets no heading and no stage anywhere', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'logox-stage-restore-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  let call = 0;
  const provider: Provider = {
    async respond(_request, onDelta) {
      call++;
      if (call === 1) {
        const text = '`⏵ Looking at the config`\nChecking.';
        onDelta({kind: 'text', text});
        return {message: {role: 'assistant', text, toolCalls: [{id: 'c1', name: 'Glob', arguments: JSON.stringify({pattern: '*.json'})}]}, stop: 'tools'};
      }
      if (call === 2) return {message: {role: 'assistant', text: '', toolCalls: [{id: 'c2', name: 'Glob', arguments: JSON.stringify({pattern: '*.md'})}]}, stop: 'tools'};
      onDelta({kind: 'text', text: 'Done.'});
      return {message: {role: 'assistant', text: 'Done.'}, stop: 'complete'};
    },
  };
  const options = {cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 's', config, provider};
  const rowsOf = (app: Awaited<ReturnType<typeof createApplication>>) => buildStageRows(app.store.getSnapshot(), 's', 'logox', 100, {}, null).map(row => (row.displayText ?? row.text).replace(/[│]/g, ' ').trim());
  try {
    const first = await createApplication(options);
    try {
      const task = first.ensemble.dispatch('logox', 'look', 'direct');
      await task.done;
      const live = rowsOf(first);
      assert.ok(live.includes('Looking at the config'), 'live heading:\n' + live.join('\n'));
      assert.ok(!live.some(line => /⏵|`/.test(line)), 'neither the marker nor the wrapper is drawn');
      assert.ok(!live.some(line => /^(?:Finding|Using|Searching)\b/.test(line)), 'the fallback label is never a timeline row');
    } finally {await first.close();}
    const ledgers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else if (entry.name === 'director.jsonl') ledgers.push(await readFile(join(dir, entry.name), 'utf8'));
      }
    };
    await walk(cwd);
    const entries = ledgers.join('\n').split('\n').filter(Boolean).map(line => JSON.parse(line) as {message?: {role?: string; text?: string; stage?: string}});
    const staged = entries.filter(entry => entry.message?.role === 'assistant' && entry.message.stage !== undefined);
    assert.deepEqual(staged.map(entry => entry.message!.stage), ['Looking at the config'], 'only the written line is in the ledger stage field');
    assert.ok(!ledgers.join('\n').includes('Finding *.md'), 'no derived label in the ledger');
    const second = await createApplication({...options, resume: true});
    try {
      const restored = rowsOf(second);
      assert.ok(restored.includes('Looking at the config'), 'restored heading:\n' + restored.join('\n'));
      assert.ok(restored.some(line => line.includes('Checking.')), 'the reply text follows it');
      assert.ok(!restored.some(line => /⏵|`/.test(line)));
      assert.equal(restored.filter(line => line === 'Looking at the config').length, 1);
    } finally {await second.close();}
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});
