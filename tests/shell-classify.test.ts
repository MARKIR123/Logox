import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyShellCommand} from '../src/tools/ShellTool/classify.js';

const cases: Array<[string, ReturnType<typeof classifyShellCommand>]> = [
  ['rg foo src', 'search'],
  ['grep -rn "a;b" .', 'search'],
  ['find . -name "*.ts"', 'search'],
  ['Select-String -Path x.txt -Pattern foo', 'search'],
  ['cat package.json', 'read'],
  ['C:\\tools\\Head.EXE -n 5 file', 'read'],
  ['Get-Content a.txt | Select-Object -First 3', 'command'],
  ['Get-Content a.txt', 'read'],
  ['gc a.txt', 'read'],
  ['ls -la', 'list'],
  ['Get-ChildItem -Recurse', 'list'],
  ['pwd', 'list'],
  ['git status', 'command'],
  ['npm test', 'command'],
  ['', 'command'],
  ['   ', 'command'],
];
for (const [command, expected] of cases) {
  test(`classify ${JSON.stringify(command)} -> ${expected}`, () => assert.equal(classifyShellCommand(command), expected));
}

test('compounds need every non-neutral segment whitelisted', () => {
  assert.equal(classifyShellCommand('cd src && rg foo'), 'search');
  assert.equal(classifyShellCommand('echo start; ls; echo done'), 'list');
  assert.equal(classifyShellCommand('rg foo | head -5'), 'search');
  assert.equal(classifyShellCommand('ls && cat a.txt'), 'read');
  assert.equal(classifyShellCommand('ls; cat a; rg b'), 'search');
  assert.equal(classifyShellCommand('rg foo && npm test'), 'command');
  assert.equal(classifyShellCommand('echo hi'), 'command');
  assert.equal(classifyShellCommand('cd src'), 'command');
});

test('leading comments and env assignments are ignored', () => {
  assert.equal(classifyShellCommand('# find usages\nrg foo'), 'search');
  assert.equal(classifyShellCommand('LC_ALL=C grep foo x'), 'search');
});

test('output redirects make a command', () => {
  assert.equal(classifyShellCommand('cat a > b'), 'command');
  assert.equal(classifyShellCommand('ls >> log.txt'), 'command');
  assert.equal(classifyShellCommand('rg foo 2> err.txt'), 'command');
  assert.equal(classifyShellCommand('rg foo | tee out.txt'), 'command');
  assert.equal(classifyShellCommand('Get-Content a | Out-File b'), 'command');
  assert.equal(classifyShellCommand('Get-Content a | Set-Content b'), 'command');
  assert.equal(classifyShellCommand('cat a >/dev/null > b'), 'command');
});

test('discarding redirects stay read-only', () => {
  assert.equal(classifyShellCommand('rg foo 2>/dev/null'), 'search');
  assert.equal(classifyShellCommand('rg foo > /dev/null 2>&1'), 'search');
  assert.equal(classifyShellCommand('ls &>/dev/null'), 'list');
  assert.equal(classifyShellCommand('Get-Content a 2>$null'), 'read');
  assert.equal(classifyShellCommand('cat a 2>&1'), 'read');
});

test('quoted angle brackets are not redirects', () => {
  assert.equal(classifyShellCommand('grep "a > b" file'), 'search');
});

test('dynamic syntax is a command', () => {
  assert.equal(classifyShellCommand('cat $(ls)'), 'command');
  assert.equal(classifyShellCommand('cat `ls`'), 'command');
});

test('mutating options of whitelisted tools are commands', () => {
  assert.equal(classifyShellCommand('find . -name x -delete'), 'command');
  assert.equal(classifyShellCommand('find . -exec rm {} ;'), 'command');
  assert.equal(classifyShellCommand('sort -o out.txt in.txt'), 'command');
  assert.equal(classifyShellCommand("awk '{print $1}' f"), 'read');
  assert.equal(classifyShellCommand("awk '{print > \"x\"}' f"), 'command');
});
