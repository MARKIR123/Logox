import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../../scripts/check-docs.mjs', import.meta.url));

function check(files: Record<string, string>): {status: number; output: string} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'logox-docs-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), {recursive: true});
      writeFileSync(file, content);
    }
    try {
      return {status: 0, output: execFileSync(process.execPath, [checker, root], {encoding: 'utf8', stdio: 'pipe'})};
    } catch (error) {
      if (!(error instanceof Error) || !('status' in error) || !('stderr' in error)) throw error;
      return {status: Number(error.status), output: String(error.stderr)};
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

test('local-only documents do not participate in public documentation checks', () => {
  const result = check({
    'README.md': '# Logox\n',
    'CLAUDE.md': '```\n[private](missing.md)',
    'glossary.md': 'private without a trailing newline',
    'docs/development/designs/private.md': '# Private\n[missing](missing.md)',
    'docs/superpowers/plans/private.md': '# Private',
    'docs/PROJECT-REPORT.md': '# Private',
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 Markdown/);
});

test('public links cannot rely on local-only material even when it exists', () => {
  for (const target of ['CLAUDE.md', 'glossary.md', 'docs/development/private.md', 'docs/superpowers/private.md', 'docs/PROJECT-REPORT.md']) {
    for (const link of [`[private](${target})`, `[private][ref]\n[ref]: ${target}`]) {
      const result = check({'README.md': '# Logox\n' + link + '\n', [target]: '# Private\n'});
      assert.notEqual(result.status, 0, target);
      assert.match(result.output, /local-only material/, target);
    }
  }
});

test('module-relative and encoded links obey the private-document boundary', () => {
  for (const target of ['../development/private.md', '../%64evelopment/private.md', '../../ClAuDe.md']) {
    const result = check({
      'README.md': '# Logox\n[modules](docs/modules/README.md)\n',
      'docs/modules/README.md': '# Modules\n[private](' + target + ')\n',
      'docs/development/private.md': '# Private\n',
      'ClAuDe.md': '# Private\n',
    });
    assert.notEqual(result.status, 0, target);
    assert.match(result.output, /local-only material/, target);
  }
});

test('source signposts are checked without collecting runtime Markdown assets', () => {
  const files = {
    'README.md': '# Logox\n[actors](src/actors/AGENTS.md)\n',
    'src/actors/AGENTS.md': '# Actors\n[persona](profiles/logox/persona.md)\n',
    'src/actors/profiles/logox/persona.md': 'Runtime prompt, not a public guide',
    'src/resources/builtin-skills/public/agent.md': 'Runtime taxonomy, not a public guide',
  };
  const valid = check(files);
  assert.equal(valid.status, 0, valid.output);
  assert.match(valid.output, /2 Markdown/);
  const invalid = check({...files, 'src/actors/AGENTS.md': '# Actors\n[private](../../CLAUDE.md)\n', 'CLAUDE.md': '# Private\n'});
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.output, /local-only material/);
});

test('public modules support Chinese anchors, duplicate headings, spaces and reference links', () => {
  const result = check({
    'README.md': '# LOGOX\n\n[导航](docs/README.md)\n',
    'docs/README.md': '# 导航\n\n[压缩][module]\n[module]: <modules/context guide.md>\n[章节](<modules/context guide.md#中文章节-1>)\n',
    'docs/modules/context guide.md': '# 压缩\n## 中文章节\n## 中文章节\n~~~text\n[代码示例](missing.md)\n~~~\n',
    'docs/legacy/ignored.md': '# 不检查这个目录',
    '.logox/private.md': '# 不读取私人目录',
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /3 Markdown/);
});

test('broken files and anchors identify the source document', () => {
  const result = check({'README.md': '# 项目\n[缺文件](missing.md)\n[缺章节](#不存在)\n'});
  assert.notEqual(result.status, 0);
  assert.match(result.output, /README.md: Missing link target: missing.md/);
  assert.match(result.output, /README.md: Missing heading:#不存在/);
});

test('orphan public pages and working-log headings are rejected', () => {
  const result = check({
    'README.md': '# 项目\n## 2026-10-12 新增内容\n## 更新记录\n',
    'docs/modules/orphan.md': '# 独立模块\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Working-log heading in public documentation: 2026-10-12/);
  assert.match(result.output, /Working-log heading in public documentation: 更新记录/);
  assert.match(result.output, /Document is not linked from navigation/);
});

test('unclosed fences and missing trailing newlines are rejected', () => {
  const result = check({'README.md': '# 项目\n~~~text\n未关闭'});
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Unclosed code fence/);
  assert.match(result.output, /Missing trailing newline/);
});
