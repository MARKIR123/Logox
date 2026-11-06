import {shellCommands, shellWords} from './shell.js';
import type {PermissionTarget} from './engine.js';

/** The rule an approval card offers to create: a static prefix, never an editable scope. */
export interface RuleSuggestion {readonly tool: string; readonly pattern: string; readonly label: string}
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const title = (tool: string) => tool.charAt(0).toUpperCase() + tool.slice(1);
const plain = (word: string | undefined) => word !== undefined && /^[a-z][a-z0-9:_-]*$/i.test(word);

/** Leading words of a single static command: the program, its subcommand and, for script runners, the script name. */
export function shellPrefix(command: string): string | undefined {
  const parsed = shellWords(command);
  if (parsed.compound || parsed.dynamic || shellCommands(command).length !== 1) return undefined;
  const [program, sub, third] = parsed.words;
  if (!program) return undefined;
  const words = [program];
  if (plain(sub)) {
    words.push(sub!);
    if (SCRIPT_RUNNERS.has(program.toLowerCase()) && ['run', 'run-script', 'exec'].includes(sub!.toLowerCase()) && plain(third)) words.push(third!);
  }
  return words.join(' ');
}

/** Suggests a rule that would actually match the pending call, or nothing when no rule could (compound or dynamic shell, danger classes). */
export function suggestRule(target: PermissionTarget, danger: string | undefined): RuleSuggestion | undefined {
  if (danger) return undefined;
  if (target.command !== undefined) {
    const prefix = shellPrefix(target.command);
    return prefix ? {tool: target.tool, pattern: prefix, label: prefix + ' *'} : undefined;
  }
  const first = target.paths[0];
  if (target.paths.length && first) {
    const normal = first.replaceAll('\\', '/');
    if (/^(?:[a-z]:)?\//i.test(normal) || normal.startsWith('../')) return undefined;
    const slash = normal.lastIndexOf('/');
    const pattern = slash > 0 ? normal.slice(0, slash) + '/**' : normal;
    return {tool: target.tool, pattern, label: title(target.tool) + ' in ' + (slash > 0 ? normal.slice(0, slash) + '/' : normal)};
  }
  return {tool: target.tool, pattern: '*', label: title(target.tool)};
}
