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

test('文档检查支持中文章节、重复标题、空格路径、引用链接与按主题记录的验收', () => {
  const result = check({
    'README.md': '# LOGOX\n\n日期：2026-10-12\n[导航](docs/README.md)\n',
    'docs/README.md': '# 导航\n\n[压缩][design]\n[design]: <development/designs/context design.md>\n[章节](<development/designs/context design.md#中文章节-1>)\n',
    'docs/development/designs/context design.md': '# 压缩\n状态：已确认待实现\n## 中文章节\n## 中文章节\n## 2026-10-12 验收\n~~~text\n[代码示例](missing.md)\n~~~\n',
    'docs/legacy/ignored.md': '# 不检查这个目录',
    '.logox/private.md': '# 不读取私人目录',
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /3 份 Markdown/);
});

test('文档检查拒绝失效文件与章节，并准确定位所属文档', () => {
  const result = check({'README.md': '# 项目\n[缺文件](missing.md)\n[缺章节](#不存在)\n'});
  assert.notEqual(result.status, 0);
  assert.match(result.output, /README.md: 链接不存在：missing.md/);
  assert.match(result.output, /README.md: 章节不存在：#不存在/);
});

test('文档检查拒绝无导航专题、缺少设计状态和当前说明中的流水账标题', () => {
  const result = check({
    'README.md': '# 项目\n## 2026-10-12 新增内容\n## 更新记录\n',
    'docs/development/designs/orphan.md': '# 独立设计\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /当前说明含流水账标题：2026-10-12/);
  assert.match(result.output, /当前说明含流水账标题：更新记录/);
  assert.match(result.output, /专题设计缺少状态/);
  assert.match(result.output, /文档未接入导航/);
});

test('文档检查拒绝未关闭围栏和缺少末尾换行', () => {
  const result = check({'README.md': '# 项目\n~~~text\n未关闭'});
  assert.notEqual(result.status, 0);
  assert.match(result.output, /代码围栏未关闭/);
  assert.match(result.output, /缺少末尾换行/);
});
