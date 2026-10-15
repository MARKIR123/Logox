import {cp, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {relative, isAbsolute} from 'node:path';

// tsc 不复制 Markdown；内置角色正文随构建产物发布。
const output = new URL('../dist/src/actors/profiles/', import.meta.url);
const within = relative(fileURLToPath(new URL('../dist/', import.meta.url)), fileURLToPath(output));
if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('角色产物目录必须位于 dist 内');
await rm(output, {recursive: true, force: true});
await cp(new URL('../src/actors/profiles/', import.meta.url), output, {recursive: true});
