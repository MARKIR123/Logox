import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tools, validateToolCall, canonicalToolName, toolDefinitions} from '../src/tools/tools.js';
import {htmlToMarkdown, executeWebFetch} from '../src/tools/WebFetchTool/WebFetchTool.js';
import type {ActorContext} from '../src/actors/ensemble.js';

function mockContext(cwd: string, sessionId = 'test-session'): ActorContext {
  return {
    sessionId,
    activityId: 'test-activity',
    ownerId: 'techne',
    history: [],
    signal: new AbortController().signal,
    report: () => {},
    say: () => {},
    record: async () => {},
    ask: async q => ({status: 'answered', response: {sessionId, activityId: 'test-activity', ownerId: 'techne', requestId: 'q-1', kind: 'question', answers: {}}}),
    permission: async () => true,
  };
}

test('工具规范对齐 Claude Code：全部采用 PascalCase 大驼峰命名，且支持大小写向后兼容', () => {
  const names = toolDefinitions.map(t => t.name);
  assert.ok(names.includes('Read'));
  assert.ok(names.includes('Write'));
  assert.ok(names.includes('Edit'));
  assert.ok(names.includes('Glob'));
  assert.ok(names.includes('Grep'));
  assert.ok(names.includes('Shell'));
  assert.ok(names.includes('AskUserQuestion'));
  assert.ok(names.includes('WebFetch'));

  // 验证别名映射
  assert.equal(canonicalToolName('read'), 'Read');
  assert.equal(canonicalToolName('Read'), 'Read');
  assert.equal(canonicalToolName('write'), 'Write');
  assert.equal(canonicalToolName('Write'), 'Write');
  assert.equal(canonicalToolName('shell'), 'Shell');
  assert.equal(canonicalToolName('bash'), 'Shell');
  assert.equal(canonicalToolName('ask_user'), 'AskUserQuestion');
  assert.equal(canonicalToolName('AskUserQuestion'), 'AskUserQuestion');
  assert.equal(canonicalToolName('web_fetch'), 'WebFetch');
  assert.equal(canonicalToolName('WebFetch'), 'WebFetch');

  // 验证小写和大驼峰调用均通过参数校验
  assert.equal(validateToolCall({id: '1', name: 'Read', arguments: '{"file_path":"file.txt"}'}).valid, true);
  assert.equal(validateToolCall({id: '2', name: 'read', arguments: '{"file_path":"file.txt"}'}).valid, true);
  assert.equal(validateToolCall({id: '3', name: 'Write', arguments: '{"file_path":"file.txt","content":"hello"}'}).valid, true);
  assert.equal(validateToolCall({id: '4', name: 'write', arguments: '{"file_path":"file.txt","content":"hello"}'}).valid, true);
  assert.equal(validateToolCall({id: '5', name: 'Shell', arguments: '{"command":"echo 1"}'}).valid, true);
  assert.equal(validateToolCall({id: '6', name: 'shell', arguments: '{"command":"echo 1"}'}).valid, true);
  assert.equal(validateToolCall({id: '7', name: 'WebFetch', arguments: '{"url":"https://example.com"}'}).valid, true);
});

test('WebFetch：网页清洗为纯净语义 Markdown，过滤脚本、样式与广告', () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
        <script>alert("malicious");</script>
        <style>body { color: red; }</style>
      </head>
      <body>
        <nav><a href="/home">Home</a></nav>
        <h1>Documentation Title</h1>
        <p>This is a paragraph with <b>bold text</b> and <a href="https://example.com/api">API Reference</a>.</p>
        <pre><code>const a = 1;</code></pre>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
        <p>Copyright &copy; 2026</p>
        <footer>Footer to be removed</footer>
      </body>
    </html>
  `;

  const md = htmlToMarkdown(sampleHtml);
  assert.ok(!md.includes('alert("malicious")'), '必须过滤 script');
  assert.ok(!md.includes('body { color: red; }'), '必须过滤 style');
  assert.ok(!md.includes('<nav>'), '必须过滤 nav');
  assert.ok(!md.includes('<footer>'), '必须过滤 footer');
  assert.ok(md.includes('# Documentation Title'), '必须转换为一级标题');
  assert.ok(md.includes('**bold text**'), '必须转换为 Markdown 加粗');
  assert.ok(md.includes('[API Reference](https://example.com/api)'), '必须转换为 Markdown 链接');
  assert.ok(md.includes('```\nconst a = 1;\n```'), '必须转换为 Markdown 代码块');
  assert.ok(md.includes('- Item 1'), '必须转换为 Markdown 列表');
  assert.ok(md.includes('©'), '必须转义 HTML 实体');
});

test('WebFetch 实际 HTTP 获取与执行', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><h2>React 19 Hooks</h2><p>Use Action Hooks for transitions.</p></body></html>');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/docs`;

  try {
    const cwd = await mkdtemp(join(tmpdir(), 'logox-tools-test-'));
    const tools = new Tools(cwd);
    const context = mockContext(cwd);

    const result = await tools.execute({
      id: 'fetch-1',
      name: 'WebFetch',
      arguments: JSON.stringify({url, prompt: 'Check Action Hooks'}),
    }, context);

    assert.equal(result.isError, false);
    assert.match(result.text, /## React 19 Hooks/);
    assert.match(result.text, /Use Action Hooks for transitions/);
    assert.match(result.text, /Context goal: Check Action Hooks/);

    await rm(cwd, {recursive: true, force: true});
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('大驼峰 Read/Write/Edit/Shell 工具端到端执行', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-tools-exec-'));
  try {
    const tools = new Tools(cwd);
    const context = mockContext(cwd);

    // 1. Write
    const writeResult = await tools.execute({
      id: 'w-1',
      name: 'Write',
      arguments: JSON.stringify({file_path: 'demo.txt', content: 'Initial Line 1\nLine 2'}),
    }, context);
    assert.equal(writeResult.isError, false);

    // 2. Read
    const readResult = await tools.execute({
      id: 'r-1',
      name: 'Read',
      arguments: JSON.stringify({file_path: 'demo.txt'}),
    }, context);
    assert.equal(readResult.isError, false);
    assert.match(readResult.text, /1: Initial Line 1/);
    assert.match(readResult.text, /2: Line 2/);

    // 3. Edit
    const editResult = await tools.execute({
      id: 'e-1',
      name: 'Edit',
      arguments: JSON.stringify({file_path: 'demo.txt', old_string: 'Initial Line 1', new_string: 'Updated Line 1'}),
    }, context);
    assert.equal(editResult.isError, false);

    // 4. Read again
    const readAfter = await tools.execute({
      id: 'r-2',
      name: 'Read',
      arguments: JSON.stringify({file_path: 'demo.txt'}),
    }, context);
    assert.match(readAfter.text, /1: Updated Line 1/);

    // 5. Shell
    const shellResult = await tools.execute({
      id: 's-1',
      name: 'Shell',
      arguments: JSON.stringify({command: 'node -e "console.log(12345)"'}),
    }, context);
    assert.equal(shellResult.isError, false);
    assert.match(shellResult.text, /12345/);
    assert.match(shellResult.text, /Exit code: 0/);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

import {Collaboration} from '../src/actors/collaboration.js';
import {Journal} from '../src/store/journal.js';

test('SendMessage：Subagent 向 Logox 或同伴发送中途即时反馈与阻碍消息', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-sendmessage-'));
  try {
    const journal = new Journal(directory);
    const dispatched: Array<{owner: string; prompt: string}> = [];
    const collaboration = new Collaboration({
      sessionId: 's',
      journal,
      member: id => ['logox', 'techne', 'kalon', 'aletheia'].includes(id),
      enqueue: (ownerId, prompt) => {
        dispatched.push({owner: ownerId, prompt});
        return {activityId: 'a-1', done: Promise.resolve(), cancel: () => {}};
      },
    });

    const context = mockContext(directory, 's');
    // 1. Techne 向 Logox 发送即时反馈（如约束冲突、关键进展）
    const feedback = await collaboration.execute({
      id: 'send-1',
      name: 'SendMessage',
      arguments: JSON.stringify({
        to: 'logox',
        message: '发现约束冲突：曲柄下死点超出 viewBox 底部 25px，请确认是否允许微调。',
        summary: '约束冲突汇报',
      }),
    }, context);

    assert.equal(feedback.isError, false);
    assert.match(feedback.text, /Delivered message to logox/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.owner, 'logox');
    assert.match(dispatched[0]!.prompt, /Message from techne · 约束冲突汇报/);
    assert.match(dispatched[0]!.prompt, /发现约束冲突：曲柄下死点超出 viewBox 底部 25px/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

import {toolTitle} from '../src/runtime/steps.js';

test('toolTitle：有 description 时优先展示单步意图，无 description 时回退参数细节', () => {
  // 1. 带意图描述的 Shell 调用
  const shellCall = {
    id: 'c1',
    name: 'Shell',
    arguments: JSON.stringify({
      command: 'node -e "console.log(1)"',
      description: '计算铁轨与河流交点坐标',
    }),
  };
  assert.equal(toolTitle(shellCall), 'Shell · 计算铁轨与河流交点坐标 (node -e "console.log(1)")');

  // 2. 带 summary 的 SendMessage 调用
  const sendCall = {
    id: 'c2',
    name: 'SendMessage',
    arguments: JSON.stringify({
      to: 'logox',
      message: '约束冲突',
      summary: '约束冲突汇报',
    }),
  };
  assert.equal(toolTitle(sendCall), 'SendMessage · 约束冲突汇报 (logox)');

  // 3. 文件类工具无意图描述，直接以文件路径自解释（100% 对齐 Claude Code）
  const readCall = {
    id: 'c3',
    name: 'Read',
    arguments: JSON.stringify({
      path: 'src/style/palette.js',
    }),
  };
  assert.equal(toolTitle(readCall), 'Read src/style/palette.js');

  // 3. 无意图描述的传统调用（100% 保持旧格式向后兼容）
  const legacyCall = {
    id: 'c3',
    name: 'Write',
    arguments: JSON.stringify({
      path: 'pelican.html',
      content: '<svg></svg>',
    }),
  };
  assert.equal(toolTitle(legacyCall), 'Write pelican.html');
});

test('Read 工具默认读取全文且参数完全可选（对齐 Claude Code）', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-read-defaults-'));
  try {
    const testFile = join(cwd, 'sample.txt');
    const content = Array.from({length: 150}, (_, i) => `Line ${i + 1}: code block`).join('\n');
    await writeFile(testFile, content);

    const tools = new Tools(cwd);
    const context = mockContext(cwd);

    // 仅传 path，不传 offset 与 limit，必须默认一次性读完
    const res = await tools.execute({
      id: 'read-full',
      name: 'Read',
      arguments: JSON.stringify({file_path: 'sample.txt'}),
    }, context);

    assert.equal(res.isError, false);
    assert.match(res.text, /^1: Line 1: code block/);
    assert.match(res.text, /150: Line 150: code block$/);
    assert.ok(!res.text.includes('(Remaining lines omitted)'));
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('Grep 工具使用内置 ripgrep，默认返回匹配文件并支持 content 模式', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-grep-bundled-'));
  try {
    const file1 = join(cwd, 'skyline.js');
    await writeFile(file1, 'function drawSkyline() {\n  var buildingCount = 12;\n  return buildingCount;\n}');
    const file2 = join(cwd, 'palette.js');
    await writeFile(file2, 'var THEMES = { NIGHT: "#000" };');

    const tools = new Tools(cwd);
    const context = mockContext(cwd);

    // Default output_mode is files_with_matches (Claude Code default).
    const files = await tools.execute({
      id: 'grep-files',
      name: 'Grep',
      arguments: JSON.stringify({pattern: 'buildingCount'}),
    }, context);
    assert.equal(files.isError, false);
    assert.match(files.text, /skyline\.js/);
    assert.doesNotMatch(files.text, /palette\.js/);

    const content = await tools.execute({
      id: 'grep-content',
      name: 'Grep',
      arguments: JSON.stringify({pattern: 'buildingCount', output_mode: 'content'}),
    }, context);
    assert.equal(content.isError, false);
    assert.match(content.text, /skyline\.js:2:.*var buildingCount = 12;/);
    assert.match(content.text, /skyline\.js:3:.*return buildingCount;/);
    assert.doesNotMatch(content.text, /palette\.js/);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});


