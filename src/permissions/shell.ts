import {relative, resolve} from 'node:path';
import {pathDanger, runtimePath} from './paths.js';
/** Tokens are used for permission rule matching; unparseable syntax is not treated as dangerous by itself. */
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
  if (words.some(word => word.split('/').includes('legacy'))) return {kind: 'forbidden', reason: 'Project convention forbids legacy operations'};
  const removers = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'clear-content']);
  for (const segment of shellCommands(command)) {
    const original = shellWords(segment).words, lower = original.map(word => word.toLowerCase().replaceAll('\\', '/'));
    const name = executable(lower[0] ?? '');
    const args = lower.slice(1);
    if (['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'clear-content', 'set-content', 'add-content', 'out-file', 'sc', 'ac', 'tee', 'mv', 'move-item', 'rename-item', 'copy-item', 'cp', 'chmod', 'chown'].includes(name) && args.some(runtimePath)) {
      return {kind: 'danger', reason: 'Modifies or deletes runtime state and history records'};
    }
    if (/[>]/.test(segment) && args.some(runtimePath)) return {kind: 'danger', reason: 'Redirect writes to runtime state or history records'};
    if (/^(bcdedit|format|mkfs(?:\..*)?|shutdown)$/.test(name)) return {kind: 'forbidden', reason: 'Self-destructing system commands are forbidden'};
    if (depth < 3 && ['powershell', 'pwsh', 'cmd', 'bash', 'sh'].includes(name)) {
      const at = lower.findIndex(word => ['-command', '-c', '/c'].includes(word));
      if (at >= 0) {
        const nested = shellImpact(original.slice(at + 1).join(' '), depth + 1, root);
        if (nested.kind === 'danger' || nested.kind === 'forbidden') return nested;
      }
    }
    if (removers.has(name)) {
      if (args.some(arg => /^(?:[a-z]:\/?|\/|\/\*|~\/?|\*|\$(?:home|env:userprofile|env:systemroot))$/.test(arg))) return {kind: 'forbidden', reason: 'Deleting system or user root directories or all files is forbidden'};
      if (args.some(arg => {
        const target = root && !arg.startsWith('-') && !arg.startsWith('$') ? relative(root, resolve(root, arg)).replaceAll('\\', '/').toLowerCase() || '.' : arg;
        return /^(?:\.\/?|\.\.\/?|\.\/\*)$/.test(target) || /^(?:\.\/)?(?:src|source|docs|tests|\.git)(?:\/|$)/.test(target);
      })) return {kind: 'danger', reason: 'Deletes project work or version history'};
    }
    const verb = args.find(arg => ['reset', 'clean', 'push', 'branch'].includes(arg));
    if (name === 'git' && (verb === 'reset' && args.includes('--hard') || verb === 'clean' && args.some(arg => /^-[a-z]*f/.test(arg)) ||
      verb === 'push' && args.some(arg => /^(?:--force(?:-with-lease)?(?:=.*)?|-f)$/.test(arg)) || verb === 'branch' && original.includes('-D'))) {
      return {kind: 'danger', reason: 'May discard existing work or rewrite remote history'};
    }
  }
  if (words.some(word => pathDanger(word, 'read'))) return {kind: 'danger', reason: 'Involves credentials or sensitive data'};
  if (/\b(?:curl|wget|iwr|irm|invoke-webrequest)\b[\s\S]*\|[\s\S]*\b(?:sh|bash|iex|invoke-expression)\b/i.test(command)) return {kind: 'danger', reason: 'Executes downloaded content directly'};
  if (/\b(?:kubectl\s+(?:delete|apply)|terraform\s+(?:destroy|apply)|npm\s+publish)\b/i.test(command)) return {kind: 'danger', reason: 'Modifies infrastructure or publishes external content'};
  // Fast path only for recognizable single read-only operations; scripts, pipes and substitutions go on to mode adjudication.
  const name = executable(words[0] ?? '');
  const readOnly = new Set(['pwd', 'get-location', 'ls', 'dir', 'get-childitem', 'cat', 'get-content', 'head', 'tail', 'wc', 'rg', 'grep', 'findstr', 'type']);
  const unsafeOption = words.some(word => /^(?:--output|--pre|--ext-diff|--textconv|--exec)/.test(word));
  const safeGit = name === 'git' && ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(words[1] ?? '');
  if (!parsed.compound && !parsed.dynamic && !unsafeOption && (readOnly.has(name) || safeGit)) return {kind: 'safe', reason: 'Verifiably read-only command'};
  return {kind: 'unknown', reason: "The command's actual impact needs further assessment"};
}

const execName = (word: string) => word.split('/').at(-1)?.replace(/\.(?:exe|cmd|bat|ps1)$/, '') ?? '';
const flagged = (args: readonly string[], blocked: RegExp) => args.some(arg => blocked.test(arg));
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add', 'uninstall', 'remove', 'rm', 'update', 'up', 'upgrade', 'run', 'run-script', 'test', 't', 'start', 'ls', 'list',
  'outdated', 'audit', 'why', 'view', 'info', 'explain', 'dedupe', 'rebuild', 'prune', 'fund']);
const PACKAGE_DENIED = new Set(['publish', 'login', 'logout', 'adduser', 'token', 'owner', 'access', 'config', 'set', 'link', 'unlink', 'exec', 'dlx', 'create', 'x', 'init', 'deprecate', 'unpublish', 'dist-tag', 'team', 'org']);
const PACKAGE_UNSAFE_FLAG = /^(?:-g|--global|--global-dir(?:=.*)?|--location(?:=.*)?|--prefix(?:=.*)?|--registry(?:=.*)?|--userconfig(?:=.*)?|-c|--dir(?:=.*)?)$/;
const TOOL_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string> | '*'>> = {
  cargo: new Set(['build', 'b', 'test', 't', 'check', 'c', 'clippy', 'fmt', 'run', 'r', 'doc', 'bench', 'clean', 'tree', 'metadata', 'add', 'remove', 'update', 'fetch']),
  go: new Set(['build', 'test', 'vet', 'fmt', 'run', 'mod', 'get', 'list', 'clean', 'env', 'version']),
  dotnet: new Set(['build', 'test', 'restore', 'run', 'format', 'clean', 'pack', 'publish', '--version', '--info']),
  mvn: '*', mvnw: '*', gradle: '*', gradlew: '*', make: '*', cmake: '*', ninja: '*', msbuild: '*',
  tsc: '*', eslint: '*', prettier: '*', vitest: '*', jest: '*', mocha: '*', ava: '*', vite: '*', webpack: '*', rollup: '*', esbuild: '*', biome: '*', stylelint: '*',
  ruff: '*', mypy: '*', pytest: '*', black: '*', flake8: '*', isort: '*', pyright: '*', tsx: '*', 'ts-node': '*', playwright: '*',
};
const GIT_ROUTINE = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'ls-files', 'rev-parse', 'blame', 'branch', 'stash', 'remote']);
const UTILITIES = new Set(['pwd', 'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'findstr', 'type', 'echo', 'mkdir', 'touch', 'cd', 'sl', 'set-location',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'select-string', 'sls', 'sort', 'uniq', 'cut', 'which', 'where', 'date', 'true', 'false', 'tee', 'new-item',
  'select-object', 'sort-object', 'measure-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'write-host', 'write-output', 'test-path', 'resolve-path', 'get-item', 'get-command', 'gcm', 'get-date', 'get-process']);
/** One ordinary development command; anything not positively recognised is not routine. */
function routineSegment(segment: string): boolean {
  const lower = shellWords(segment).words.map(word => word.toLowerCase().replaceAll('\\', '/')), name = execName(lower[0] ?? ''), args = lower.slice(1);
  const positional = args.filter(arg => !arg.startsWith('-'));
  if (!name) return false;
  if (PACKAGE_MANAGERS.has(name)) {
    if (flagged(args, PACKAGE_UNSAFE_FLAG)) return false;
    const sub = args[0] ?? '';
    if (!sub) return name !== 'npm';
    if (sub.startsWith('-')) return args.every(arg => /^--?(?:version|v|help|h)$/.test(arg));
    return name === 'npm' ? NPM_SUBCOMMANDS.has(sub) : !PACKAGE_DENIED.has(sub);
  }
  const table = TOOL_SUBCOMMANDS[name];
  if (table === '*') return !(name === 'make' && flagged(args, /^(?:-c|--directory(?:=.*)?|-f|--file(?:=.*)?)$/));
  if (table) return args.length > 0 && table.has(args.find(arg => !arg.startsWith('-')) ?? args[0]!);
  if (name === 'git') return GIT_ROUTINE.has(lower[1] ?? '') && (lower[1] !== 'stash' || ['list', 'show'].includes(lower[2] ?? '')) && (lower[1] !== 'remote' || lower.length === 2 || lower[2] === '-v');
  if (name === 'node') {
    if (flagged(args, /^(?:-e|--eval|-p|--print|-|-r|--require|--import|--loader|--experimental-loader)(?:=.*)?$/)) return false;
    return positional.length === 0 ? args.some(arg => /^(?:-v|--version)$/.test(arg)) : /\.(?:[cm]?js|ts)$|\*/.test(positional[0]!);
  }
  if (['python', 'python3', 'py'].includes(name)) {
    if (args[0] === '-m') return ['pytest', 'unittest', 'compileall'].includes(args[1] ?? '');
    return positional.length > 0 && !args.some(arg => /^-[a-z]*[cm]/.test(arg)) && /\.py$/.test(positional[0]!);
  }
  return UTILITIES.has(name);
}
/** Ordinary workspace development: build, test, lint, project package-manager installs, routine git and project scripts. Dynamic syntax never qualifies. */
export function routineShell(command: string): boolean {
  if (shellWords(command).dynamic) return false;
  const segments = shellCommands(command);
  return segments.length > 0 && segments.every(routineSegment);
}
