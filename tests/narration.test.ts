import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractNarration, stripNarration} from '../src/runtime/narration.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';

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

test('agent loop extracts ⏵ narration into activity progress and preserves clean text in message store', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-narration-test-'));
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
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
    assert.deepEqual(activity.progress, {label: '正在检索项目结构'});

    const msg = app.store.getSnapshot().messages.find(m => m.activityId === task.activityId && m.role === 'assistant' && !m.kind);
    assert.ok(msg);
    assert.equal(msg.text, '已为您找到核心文件。');
    assert.doesNotMatch(msg.text, /⏵/);
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});

