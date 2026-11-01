import {shellCommands, shellWords} from '../../permissions/shell.js';

export type ShellCategory = 'search' | 'read' | 'list' | 'command';

const searchTools = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'where', 'select-string', 'sls', 'findstr']);
const readTools = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'jq', 'awk', 'cut', 'sort', 'uniq', 'tr', 'type', 'get-content', 'gc']);
const listTools = new Set(['ls', 'tree', 'du', 'dir', 'get-childitem', 'gci', 'pwd']);
const neutralTools = new Set(['echo', 'printf', 'true', 'false', ':', 'write-output', 'cd', 'set-location']);
const discardTargets = new Set(['/dev/null', '$null', 'nul']);

/** Executable basename, lowercased, without `.exe`. */
export function shellExecutable(word: string): string {
  return (word.replaceAll('\\', '/').split('/').at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
}

/**
 * Removes harmless redirects (`2>&1`, `>/dev/null`, `2>$null`, `&>nul`). Returns undefined when any
 * other unquoted output redirect remains, because that command writes a file.
 */
function stripSafeRedirects(command: string): string | undefined {
  let out = '', quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {out += ch; if (ch === quote) quote = ''; continue;}
    if (ch === '"' || ch === "'") {quote = ch; out += ch; continue;}
    const ampersandRedirect = ch === '&' && command[i + 1] === '>';
    if (ch !== '>' && !ampersandRedirect) {out += ch; continue;}
    // Drop an fd prefix such as `2` or PowerShell `*` that belongs to this redirect.
    out = out.replace(/(^|\s)(?:\d+|\*)$/, '$1');
    let j = i + (ampersandRedirect ? 2 : 1);
    if (command[j] === '>' || command[j] === '|') j++;
    if (!ampersandRedirect && command[j] === '&' && /^(?:\d+|-)/.test(command.slice(j + 1))) {
      j++;
      while (j < command.length && /[\d-]/.test(command[j]!)) j++;
      i = j - 1;
      continue;
    }
    while (j < command.length && /[ \t]/.test(command[j]!)) j++;
    let end = j;
    while (end < command.length && !/[\s;|&]/.test(command[end]!)) end++;
    if (!discardTargets.has(command.slice(j, end).toLowerCase())) return undefined;
    i = end - 1;
  }
  return out;
}

function segmentCategory(segment: string): ShellCategory | 'neutral' {
  const words = [...shellWords(segment).words];
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0]!)) words.shift();
  const first = words[0];
  if (!first) return 'neutral';
  if (first.startsWith('#')) return 'neutral';
  const name = shellExecutable(first);
  if (neutralTools.has(name)) return 'neutral';
  const args = words.slice(1).map(word => word.toLowerCase());
  if (searchTools.has(name)) {
    if (name === 'find' && args.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(arg))) return 'command';
    return 'search';
  }
  if (readTools.has(name)) {
    if (name === 'sort' && args.some(arg => arg === '-o' || arg.startsWith('--output'))) return 'command';
    if (name === 'awk' && /system\s*\(|>|\|/.test(segment.slice(segment.indexOf(first) + first.length))) return 'command';
    return 'read';
  }
  if (listTools.has(name)) return 'list';
  return 'command';
}

/** Classifies a shell command as pure search, read or list work, or as a general command. */
export function classifyShellCommand(command: string): ShellCategory {
  if (!command.trim() || command.includes('`') || command.includes('$(')) return 'command';
  const cleaned = stripSafeRedirects(command);
  if (cleaned === undefined) return 'command';
  const found = new Set<ShellCategory>();
  for (const segment of shellCommands(cleaned)) {
    const category = segmentCategory(segment);
    if (category === 'neutral') continue;
    if (category === 'command') return 'command';
    found.add(category);
  }
  if (found.has('search')) return 'search';
  if (found.has('read')) return 'read';
  if (found.has('list')) return 'list';
  return 'command';
}
