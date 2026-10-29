import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {ActorCatalog} from '../src/actors/catalog.js';
import {ActorManagement} from '../src/actors/management.js';
import {builtinActors} from '../src/actors/builtins.js';
import {parseActor, parseActorProfile, serializeActor} from '../src/actors/definitions.js';
import {Resources} from '../src/resources/manager.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-actors-')), home = join(root, 'home'), cwd = join(root, 'project');
  await mkdir(home); await mkdir(cwd);
  const catalog = new ActorCatalog(cwd, {home});
  const put = async (path: string, text: string) => {await mkdir(dirname(path), {recursive: true}); await writeFile(path, text);};
  return {root, home, cwd, catalog, put, close: () => rm(root, {recursive: true, force: true})};
}
const draft = () => ({...builtinActors[1]!, id: 'scout', name: '新侦察者'});
test('内置身份、颜色、参数和嵌套快照不可变', () => {
  const catalog = new ActorCatalog('.');
  assert.deepEqual(catalog.list().map(role => [role.id, role.context.keep_recent_rounds, role.context.keep_recent_tools]),
    [['logox', 2, 2], ['aletheia', 0, 2], ['techne', 0, 2], ['kalon', 0, 0]]);
  assert.equal(catalog.find('techne')?.symbol, '⊞');
  assert.equal(Reflect.set(catalog.find('kalon')!.context, 'keep_recent_tools', 99), false);
  for (const actor of catalog.list()) assert.deepEqual(parseActor(serializeActor(actor)), actor);
});
test('严格拒绝重复、未知字段、别名、安全 ID、错误压缩参数和空正文', () => {
  const valid = serializeActor(draft());
  for (const value of [valid.replace('id: scout', 'id: ../scout'), valid.replace('id: scout', 'id: con'),
    valid.replace('id: scout', 'id: scout\nid: other'), valid.replace('id: scout', 'id: scout\nextra: true'),
    valid.replace('keep_recent_rounds: 0', 'keep_recent_rounds: -1'), valid.replace('keep_recent_rounds: 0', 'typo: 0'),
    valid.replace('id: scout', 'id: &x scout\nname: *x'), valid.slice(0, valid.lastIndexOf('---') + 4)]) assert.throws(() => parseActor(value));
});
test('用户与项目覆盖、删除回落，错误重载保留完整有效目录', async () => {
  const f = await fixture(); try {
    await f.put(join(f.home, '.logox', 'actors', 'scout.md'), serializeActor(draft()));
    await f.put(f.catalog.projectPath('scout'), serializeActor({...draft(), name: '项目角色'}));
    assert.equal((await f.catalog.load()).issues.length, 0); assert.equal(f.catalog.find('scout')?.name, '项目角色');
    const before = f.catalog.list();
    await f.put(f.catalog.projectPath('scout'), '坏定义');
    const failed = await f.catalog.reload(); assert.equal(failed.issues.length, 1); assert.equal(failed.definitions, before);
    await rm(f.catalog.projectPath('scout')); await f.catalog.reload(); assert.equal(f.catalog.find('scout')?.name, '新侦察者');
  } finally {await f.close();}
});
test('角色路径拒绝链接、legacy、文件名不一致和超大文件', async () => {
  const f = await fixture(); try {
    await f.put(join(f.root, 'outside', 'scout.md'), serializeActor(draft()));
    await mkdir(join(f.cwd, '.logox'), {recursive: true});
    await symlink(join(f.root, 'outside'), dirname(f.catalog.projectPath('scout')), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await f.catalog.reload()).issues.length, 1);
    await rm(dirname(f.catalog.projectPath('scout')));
    await f.put(f.catalog.projectPath('scout'), serializeActor({...draft(), id: 'different'}));
    assert.equal((await f.catalog.reload()).issues.length, 1);
    await f.put(f.catalog.projectPath('scout'), 'x'.repeat(65537)); assert.equal((await f.catalog.reload()).issues.length, 1);
    const legacy = new ActorCatalog(join(f.root, 'legacy'), {home: f.home}); assert.ok((await legacy.reload()).issues.length);
  } finally {await f.close();}
});
test('塑造拒绝和取消不写，审批原文明确，审批间修改受保护', async () => {
  const f = await fixture(); try {
    const management = new ActorManagement(f.catalog, {modelCatalog: async () => ({models: [], issues: []})});
    const content = serializeActor(draft()), signal = new AbortController().signal;
    assert.equal((await management.craftActor(content, async review => {assert.equal(review.path, f.catalog.projectPath('scout')); assert.equal(review.content, content); return false;}, signal)).status, 'denied');
    await assert.rejects(readFile(f.catalog.projectPath('scout')));
    const abort = new AbortController();
    await assert.rejects(management.craftActor(content, async () => {abort.abort(); return true;}, abort.signal));
    assert.equal((await management.craftActor(content, async () => true, signal)).status, 'saved');
    assert.ok(f.catalog.find('scout'));
    await assert.rejects(management.craftActor(content, async () => {await writeFile(f.catalog.projectPath('scout'), '用户编辑'); return true;}, signal), /改变/);
    assert.equal(await readFile(f.catalog.projectPath('scout'), 'utf8'), '用户编辑');
  } finally {await f.close();}
});
test('模型只使用注入目录，取消 picker 不写，确认只保存角色且保留用户修改', async () => {
  const f = await fixture(); try {
    let calls = 0;
    const management = new ActorManagement(f.catalog, {modelCatalog: async () => {calls++; return {models: [{provider: 'a', id: 'same'}, {provider: 'b', id: 'same'}], issues: []};}});
    const surfaces = new CommandSurfaces(() => {});
    await management.openDefaultModel('kalon', surfaces); surfaces.cancel();
    await assert.rejects(readFile(f.catalog.projectPath('kalon')));
    await f.put(f.catalog.projectPath('kalon'), serializeActor({...f.catalog.find('kalon')!, prompt: '用户修改的人设'}));
    await management.openDefaultModel('kalon', surfaces); const state = surfaces.getSnapshot()!;
    assert.equal(state.kind, 'picker');
    await surfaces.choose(state.id, JSON.stringify({provider: 'b', model: 'same'}));
    assert.deepEqual(f.catalog.find('kalon')?.defaultModel, {provider: 'b', model: 'same'});
    assert.match(f.catalog.find('kalon')!.prompt, /用户修改的人设/);
    assert.ok(f.catalog.find('kalon')!.prompt.includes(builtinActors.find(actor => actor.id === 'kalon')!.prompt));
    assert.equal(f.catalog.find('techne')?.defaultModel, undefined);
    await assert.rejects(management.saveDefaultModel('kalon', {provider: 'missing', model: 'same'}, new AbortController().signal));
    await management.saveDefaultModel('kalon', undefined, new AbortController().signal);
    assert.equal(f.catalog.find('kalon')?.defaultModel, undefined); assert.ok(calls >= 3);
  } finally {await f.close();}
});
test('两个目录实例同时保存只能有一个覆盖审批原文', async () => {
  const f = await fixture(); try {
    const first = serializeActor(draft()); await f.catalog.writeProject('scout', first);
    const second = new ActorCatalog(f.cwd, {home: f.home});
    const results = await Promise.allSettled([
      f.catalog.writeProject('scout', serializeActor({...draft(), name: '甲'}), first),
      second.writeProject('scout', serializeActor({...draft(), name: '乙'}), first),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.ok(['甲', '乙'].includes(parseActor(await readFile(f.catalog.projectPath('scout'), 'utf8')).name));
  } finally {await f.close();}
});
test('技能双向声明、显式分配与一次任务借阅不永久扩权', async () => {
  const f = await fixture(); try {
    const path = (name: string) => join(f.cwd, '.logox', 'skills', name, 'SKILL.md');
    await f.put(path('general'), '通用技能');
    await f.put(path('design'), '---\nactors: [kalon]\n---\n设计技能');
    await f.put(path('hidden'), '---\nactors: []\n---\n隐藏技能');
    await f.put(path('bad'), '---\nactors: [../bad]\n---\n坏技能');
    const resources = new Resources(f.cwd, {home: f.home, boundary: f.root});
    assert.equal((await resources.reload()).issues.length, 1);
    const names = (id: string) => resources.skillsFor({actorId: id}).map(skill => skill.name);
    assert.deepEqual(names('logox'), ['general']); assert.deepEqual(names('kalon'), ['design']); assert.deepEqual(names('techne'), []);
    assert.deepEqual(resources.skillsFor({actorId: 'techne', skills: ['design']}).map(skill => skill.name), ['design']);
    assert.equal(resources.skillsFor({actorId: 'techne', borrowed: ['general']}).length, 1); assert.deepEqual(names('techne'), []);
    resources.assignSkill('general', 'techne'); assert.deepEqual(names('techne'), ['general']);
    resources.assignSkill('general', 'techne', false); assert.deepEqual(names('techne'), []);
    assert.ok(!resources.prompt({actorId: 'techne'}).context.includes('设计技能'));
  } finally {await f.close();}
});

test('三文件角色档案（config.yaml/persona.md/compression.md）正确解析，并从 ~/.logox-ts/actors 加载', async () => {
  const f = await fixture(); try {
    const actorDir = join(f.home, '.logox-ts', 'actors', 'custom');
    await f.put(join(actorDir, 'config.yaml'), `id: custom
name: 自定义角色
title: 自定义专家
description: 测试自定义三文件角色
color: "#123456"
symbol: ✦
context:
  keep_recent_rounds: 1
  keep_recent_tools: 1
  reserve_tokens: 16384
skills: []
`);
    await f.put(join(actorDir, 'persona.md'), '你是自定义专家。专注于测试验证。');
    await f.put(join(actorDir, 'compression.md'), '收尾整理简报。');

    const snapshot = await f.catalog.reload();
    assert.equal(snapshot.issues.length, 0);
    const custom = f.catalog.find('custom');
    assert.ok(custom);
    assert.equal(custom.name, '自定义角色');
    assert.equal(custom.prompt, '你是自定义专家。专注于测试验证。');
    assert.equal(custom.compression, '收尾整理简报。');
    assert.equal(custom.symbol, '✦');
    assert.equal(custom.context.keep_recent_rounds, 1);
  } finally {await f.close();}
});

test('parseActorProfile 严格校验字段、大小上限与提示词位置', () => {
  const valid = {
    config: 'id: test\nname: 测试\ntitle: 专家\ndescription: 描述\ncolor: "#112233"\nsymbol: ◈\nskills: []\n',
    persona: '人设提示词正文',
    compression: '压缩正文',
  };
  const parsed = parseActorProfile(valid);
  assert.equal(parsed.id, 'test');
  assert.equal(parsed.prompt, '人设提示词正文');
  assert.equal(parsed.compression, '压缩正文');
  assert.throws(() => parseActorProfile({...valid, config: valid.config + 'prompt: 不允许\n'}), /persona\.md/);
  assert.throws(() => parseActorProfile({...valid, config: valid.config + 'unknown: 字段\n'}));
  assert.throws(() => parseActorProfile({...valid, persona: ''}));
});

test('角色配置解耦：支持自定义 card_closed 与 card_open，未指定时自动推导；用户配置目录 theme 生效', async () => {
  const {ownerSurface} = await import('../src/tui/appearance/actor-style.js');
  const {palette, applyTheme} = await import('../src/tui/appearance/theme.js');
  const {loadConfig} = await import('../src/config/config.js');

  // 1. 测试从 Actor 文档解析 card_closed 与 card_open
  const docWithCards = `---
id: custom
name: 自定义工匠
title: 独立架构师
description: 负责架构设计
color: "#ffaa00"
symbol: "✦"
card_closed: "#332200"
card_open: "#553300"
compression: 保留关键决策
skills: []
---
你是一名架构师。
`;
  const parsedCustom = parseActor(docWithCards);
  assert.equal(parsedCustom.cardClosed, '#332200');
  assert.equal(parsedCustom.cardOpen, '#553300');

  // 2. 测试 ownerSurface 直接使用角色文档配置的卡片底色
  const roles = {
    custom: {
      symbol: parsedCustom.symbol,
      name: parsedCustom.name,
      title: parsedCustom.title,
      color: parsedCustom.color,
      cardClosed: parsedCustom.cardClosed,
      cardOpen: parsedCustom.cardOpen,
    },
  };
  assert.equal(ownerSurface('custom', false, roles), '#332200', '折叠态直接使用配置文档的 card_closed');
  assert.equal(ownerSurface('custom', true, roles), '#553300', '展开态直接使用配置文档的 card_open');

  // 3. 测试未配置 card_closed/card_open 时自动推导
  const docWithoutCards = `---
id: auto
name: 自动角色
title: 自动配色
description: 自动
color: "#804020"
symbol: "✦"
compression: 关键总结
skills: []
---
自动配色人设。
`;
  const parsedAuto = parseActor(docWithoutCards);
  const autoRoles = {
    auto: {
      symbol: parsedAuto.symbol,
      name: parsedAuto.name,
      title: parsedAuto.title,
      color: parsedAuto.color,
    },
  };
  const closedAuto = ownerSurface('auto', false, autoRoles);
  const openAuto = ownerSurface('auto', true, autoRoles);
  assert.ok(closedAuto && closedAuto.startsWith('#'), '自动推导折叠底色');
  assert.ok(openAuto && openAuto.startsWith('#'), '自动推导展开底色');
  assert.notEqual(closedAuto, openAuto, '展开底色明于折叠底色');

  // 4. 测试 [theme] 在用户配置中解析与 applyTheme 生效
  const f = await fixture();
  try {
    const toml = `
[theme]
user = "#112233"
accent = "#445566"
dream_collapsed = "#778899"
dream_expanded = "#aabbcc"
`;
    await f.put(join(f.home, '.logox', 'config.toml'), toml);
    const config = await loadConfig(f.cwd, {}, process.env, f.home);
    assert.equal(config.theme.user, '#112233');
    assert.equal(config.theme.accent, '#445566');
    assert.equal(config.theme.dream_collapsed, '#778899');
    assert.equal(config.theme.dream_expanded, '#aabbcc');

    applyTheme(config.theme);
    assert.equal(palette.user, '#112233');
    assert.equal(palette.accent, '#445566');
    assert.equal(palette.dreamCollapsed, '#778899');
    assert.equal(palette.dreamExpanded, '#aabbcc');

    // 恢复默认配置
    applyTheme();
  } finally {
    await f.close();
  }
});
