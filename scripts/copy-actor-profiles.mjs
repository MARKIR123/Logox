import {cp, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {relative, isAbsolute, join} from 'node:path';
import {homedir} from 'node:os';

// tsc 不复制 Markdown；内置角色正文随构建产物发布。
const output = new URL('../dist/src/actors/profiles/', import.meta.url);
const within = relative(fileURLToPath(new URL('../dist/', import.meta.url)), fileURLToPath(output));
if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('角色产物目录必须位于 dist 内');
await rm(output, {recursive: true, force: true});
await cp(new URL('../src/actors/profiles/', import.meta.url), output, {recursive: true});

// 复制 CLI 工具包 (browser-shot 等)
const binOutput = new URL('../dist/src/tools/bin/', import.meta.url);
await rm(binOutput, {recursive: true, force: true});
await cp(new URL('../src/tools/bin/', import.meta.url), binOutput, {recursive: true});

// 复制内置标准技能库 (builtin-skills)
const skillsOutput = new URL('../dist/src/resources/builtin-skills/', import.meta.url);
await rm(skillsOutput, {recursive: true, force: true});
await cp(new URL('../src/resources/builtin-skills/', import.meta.url), skillsOutput, {recursive: true});

// 同步到用户配置目录 ~/.logox-ts/skills，保证随身可用
try {
  const userSkillsDir = join(homedir(), '.logox-ts', 'skills');
  await cp(new URL('../src/resources/builtin-skills/', import.meta.url), userSkillsDir, {recursive: true});
} catch {}

// 同步到用户配置目录 ~/.logox-ts/actors，保证始终一致
try {
  const userActorsDir = join(homedir(), '.logox-ts', 'actors');
  const info = await stat(userActorsDir);
  if (info.isDirectory()) {
    for (const actor of ['logox', 'techne', 'kalon', 'aletheia']) {
      await cp(new URL(`../src/actors/profiles/${actor}/`, import.meta.url), join(userActorsDir, actor), {recursive: true});
    }
  }
} catch {}
