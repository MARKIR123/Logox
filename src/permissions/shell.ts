import {relative, resolve} from 'node:path';
import {pathDanger, runtimePath} from './paths.js';
/** 词元用于权限规则匹配；不把无法解析的语法当成危险本身。 */
export function shellWords(command: string): {words: string[]; compound: boolean; dynamic: boolean} {
  const words: string[] = [];
  let word = '', quote = '', compound = false, dynamic = false;
  const flush = () => {if (word) words.push(word); word = '';};
  for (const ch of command) {
    if (ch === '`' || ch === '\\' && process.platform !== 'win32') {dynamic = true; word += ch; continue;}
    if (ch === '$' && quote !== "'") dynamic = true;
    if (quote) {if (ch === quote) quote = ''; else word += ch;}
    else if (ch === '"' || ch === "'") quote = ch;
    else if (';|&><\n\r'.includes(ch)) {flush(); compound = true;}
    else if ('(){}@'.includes(ch)) {dynamic = true; word += ch;}
    else if (/\s/.test(ch)) flush(); else word += ch;
  }
  flush();
  return {words, compound, dynamic: dynamic || !!quote || !words.length};
}

export interface ShellImpact {kind: 'safe' | 'unknown' | 'danger' | 'forbidden'; reason: string}
export function shellCommands(command: string): string[] {
  const commands: string[] = [];
  let current = '', quote = '', escaped = false;
  for (const ch of command) {
    if (escaped) {current += ch; escaped = false; continue;}
    if (ch === '`' || ch === '\\' && process.platform !== 'win32') {escaped = true; current += ch; continue;}
    if (quote) {current += ch; if (ch === quote) quote = ''; continue;}
    if (ch === '"' || ch === "'") {quote = ch; current += ch; continue;}
    if (';|&\n\r'.includes(ch)) {if (current.trim()) commands.push(current); current = '';}
    else current += ch;
  }
  if (current.trim()) commands.push(current);
  return commands;
}
export function shellImpact(command: string, depth = 0, root?: string): ShellImpact {
  const parsed = shellWords(command), words = parsed.words.map(word => word.toLowerCase().replaceAll('\\', '/'));
  const executable = (word: string) => word.split('/').at(-1)?.replace(/\.exe$/, '') ?? '';
  if (words.some(word => word.split('/').includes('legacy'))) return {kind: 'forbidden', reason: '项目约定禁止 legacy 操作'};
  const removers = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'clear-content']);
  for (const segment of shellCommands(command)) {
    const original = shellWords(segment).words, lower = original.map(word => word.toLowerCase().replaceAll('\\', '/'));
    const name = executable(lower[0] ?? '');
    const args = lower.slice(1);
    if (['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'clear-content', 'set-content', 'add-content', 'out-file', 'sc', 'ac', 'tee', 'mv', 'move-item', 'rename-item', 'copy-item', 'cp', 'chmod', 'chown'].includes(name) && args.some(runtimePath)) {
      return {kind: 'danger', reason: '修改或删除运行状态与历史记录'};
    }
    if (/[>]/.test(segment) && args.some(runtimePath)) return {kind: 'danger', reason: '重定向写入运行状态或历史记录'};
    if (/^(bcdedit|format|mkfs(?:\..*)?|shutdown)$/.test(name)) return {kind: 'forbidden', reason: '禁止系统自毁命令'};
    if (depth < 3 && ['powershell', 'pwsh', 'cmd', 'bash', 'sh'].includes(name)) {
      const at = lower.findIndex(word => ['-command', '-c', '/c'].includes(word));
      if (at >= 0) {
        const nested = shellImpact(original.slice(at + 1).join(' '), depth + 1, root);
        if (nested.kind === 'danger' || nested.kind === 'forbidden') return nested;
      }
    }
    if (removers.has(name)) {
      if (args.some(arg => /^(?:[a-z]:\/?|\/|\/\*|~\/?|\*|\$(?:home|env:userprofile|env:systemroot))$/.test(arg))) return {kind: 'forbidden', reason: '禁止删除系统、用户根目录或全部文件'};
      if (args.some(arg => {
        const target = root && !arg.startsWith('-') && !arg.startsWith('$') ? relative(root, resolve(root, arg)).replaceAll('\\', '/').toLowerCase() || '.' : arg;
        return /^(?:\.\/?|\.\.\/?|\.\/\*)$/.test(target) || /^(?:\.\/)?(?:src|source|docs|tests|\.git)(?:\/|$)/.test(target);
      })) return {kind: 'danger', reason: '删除项目工作或版本记录'};
    }
    const verb = args.find(arg => ['reset', 'clean', 'push', 'branch'].includes(arg));
    if (name === 'git' && (verb === 'reset' && args.includes('--hard') || verb === 'clean' && args.some(arg => /^-[a-z]*f/.test(arg)) ||
      verb === 'push' && args.some(arg => /^(?:--force(?:-with-lease)?(?:=.*)?|-f)$/.test(arg)) || verb === 'branch' && original.includes('-D'))) {
      return {kind: 'danger', reason: '可能丢弃已有工作或改写远端历史'};
    }
  }
  if (words.some(word => pathDanger(word, 'read'))) return {kind: 'danger', reason: '涉及凭据或敏感资料'};
  if (/\b(?:curl|wget|iwr|irm|invoke-webrequest)\b[\s\S]*\|[\s\S]*\b(?:sh|bash|iex|invoke-expression)\b/i.test(command)) return {kind: 'danger', reason: '下载内容后直接执行'};
  if (/\b(?:kubectl\s+(?:delete|apply)|terraform\s+(?:destroy|apply)|npm\s+publish)\b/i.test(command)) return {kind: 'danger', reason: '修改基础设施或发布外部内容'};
  // 只为可识别的单条只读操作提供快路；脚本、管道与替换交模式继续裁决。
  const name = executable(words[0] ?? '');
  const readOnly = new Set(['pwd', 'get-location', 'ls', 'dir', 'get-childitem', 'cat', 'get-content', 'head', 'tail', 'wc', 'rg', 'grep', 'findstr', 'type']);
  const unsafeOption = words.some(word => /^(?:--output|--pre|--ext-diff|--textconv|--exec)/.test(word));
  const safeGit = name === 'git' && ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(words[1] ?? '');
  if (!parsed.compound && !parsed.dynamic && !unsafeOption && (readOnly.has(name) || safeGit)) return {kind: 'safe', reason: '可确定的只读命令'};
  return {kind: 'unknown', reason: '命令的实际影响需要进一步判断'};
}
