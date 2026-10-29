import {cp, rm, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative, isAbsolute} from 'node:path';

// tsc 不复制 Markdown；内置角色正文随构建产物发布。
const output = new URL('../dist/src/actors/profiles/', import.meta.url);
const within = relative(fileURLToPath(new URL('../dist/', import.meta.url)), fileURLToPath(output));
if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('角色产物目录必须位于 dist 内');
await rm(output, {recursive: true, force: true});
await cp(new URL('../src/actors/profiles/', import.meta.url), output, {recursive: true});

// Remove retired browser CLI artifacts from existing build trees.
await rm(new URL('../dist/src/tools/bin/', import.meta.url), {recursive: true, force: true});
await rm(new URL('../dist/src/tools/BrowserShot/', import.meta.url), {recursive: true, force: true});

// 复制内置标准技能库 (builtin-skills)
const skillsOutput = new URL('../dist/src/resources/builtin-skills/', import.meta.url);
await rm(skillsOutput, {recursive: true, force: true});
await cp(new URL('../src/resources/builtin-skills/', import.meta.url), skillsOutput, {recursive: true});

// Ship the shared navigation/category signpost and remove the retired singular filename.
await rm(new URL('../dist/src/tools/AGENT.md', import.meta.url), {force: true});
await cp(new URL('../src/tools/AGENTS.md', import.meta.url), new URL('../dist/src/tools/AGENTS.md', import.meta.url));

// Theme palettes are user-editable data files; tsc never copies JSON.
const themesOutput = new URL('../dist/src/config/themes/', import.meta.url);
const themesSource = new URL('../src/config/themes/', import.meta.url);
await rm(themesOutput, {recursive: true, force: true});
if (existsSync(themesSource)) await cp(themesSource, themesOutput, {recursive: true});

await cp(new URL('../src/config/statusbar-palettes.json', import.meta.url), new URL('../dist/src/config/statusbar-palettes.json', import.meta.url));

// Remove generated UI modules whose source moved or was independently replaced.
// Keep the retained root entrypoints and only prune known compiler artifact extensions.
const uiSource = new URL('../src/tui/', import.meta.url);
const uiOutput = new URL('../dist/src/tui/', import.meta.url);
async function pruneUiArtifacts(directory, parts = '') {
  if (!existsSync(directory)) return;
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const target = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    const local = parts + entry.name;
    if (entry.isDirectory()) {await pruneUiArtifacts(target, local + '/'); continue;}
    const stem = local.replace(/(?:\.js\.map|\.d\.ts\.map|\.d\.ts|\.js)$/, '');
    if (stem === local || existsSync(new URL(stem + '.ts', uiSource)) || existsSync(new URL(stem + '.tsx', uiSource))) continue;
    const checked = relative(fileURLToPath(uiOutput), fileURLToPath(target));
    if (!checked || checked.startsWith('..') || isAbsolute(checked)) throw new Error('UI artifact must stay within dist/src/tui');
    await rm(target, {force: true});
  }
}
await pruneUiArtifacts(uiOutput);

// Preserve third-party notices independently of business module names.
const noticeSource = new URL('../src/tui/THIRD-PARTY-LICENSES.txt', import.meta.url);
const noticeOutput = new URL('../dist/src/tui/THIRD-PARTY-LICENSES.txt', import.meta.url);
if (existsSync(noticeSource)) await cp(noticeSource, noticeOutput);
else await rm(noticeOutput, {force: true});

// Retire the former source/vendor-named layout and renamed tests from dirty builds.
const retired = ['src/tui/dsh/', ...['dsh-command-suggestions', 'dsh-question-panel'].flatMap(name =>
  ['.js', '.js.map', '.d.ts'].map(extension => 'tests/' + name + '.test' + extension))];
const distRoot = new URL('../dist/', import.meta.url);
for (const path of retired) {
  const target = new URL(path, distRoot);
  if (relative(fileURLToPath(distRoot), fileURLToPath(target)).replaceAll('\\', '/') !== path.replace(/\/$/, ''))
    throw new Error('Retired artifact must stay within its expected dist path: ' + path);
  await rm(target, {recursive: path.endsWith('/'), force: true});
}
