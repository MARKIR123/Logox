import {commandCatalog, type CommandContext} from '../commands.js';
import {graphemes, type Draft} from './editor.js';

export interface CommandSuggestion {
  readonly label: string;
  readonly description: string;
  readonly replacement: string;
  readonly start: number;
  readonly end: number;
  readonly kind: 'command' | 'argument';
  readonly execute: boolean;
}

export function commandSuggestions(draft: Draft, context: CommandContext): readonly CommandSuggestion[] {
  if (!draft.text.startsWith('/') || /[\r\n]/.test(draft.text)) return [];
  const before = graphemes(draft.text).slice(0, draft.cursor).join('');
  const commandPrefix = /^\/([a-z-]*)$/i.exec(before);
  if (commandPrefix) {
    const end = /^\/[^\s]*/.exec(draft.text)?.[0].length ?? before.length;
    return commandCatalog.filter(command => command.name.startsWith(commandPrefix[1]!.toLowerCase())).map(command => {
      const required = ['provider', 'model', 'text'].includes(command.argument);
      return {label: '/' + command.name, description: command.description, replacement: '/' + command.name + (required ? ' ' : ''),
        start: 0, end, kind: 'command', execute: command.argument !== 'text'};
    });
  }
  const argument = /^\/([a-z-]+)[ \t]+([^\s]*)$/i.exec(before);
  if (!argument) return [];
  const command = commandCatalog.find(item => item.name === argument[1]!.toLowerCase());
  const candidates = command?.argument === 'provider' ? context.providers
    : command?.argument === 'loginProvider' ? context.loginProviders
      : command?.argument === 'model' ? context.models : [];
  const prefix = argument[2]!, start = before.length - prefix.length;
  const suffix = /^[^\s]*/.exec(draft.text.slice(before.length))?.[0] ?? '';
  return [...new Set(candidates)].filter(name => name.toLowerCase().startsWith(prefix.toLowerCase())).map(name => ({
    label: name, description: command?.argument === 'model' ? '模型' : '提供商', replacement: name,
    start, end: before.length + suffix.length, kind: 'argument', execute: false,
  }));
}

export function applyCommandSuggestion(draft: Draft, suggestion: CommandSuggestion): Draft {
  const suffix = draft.text.slice(suggestion.end);
  const replacement = suggestion.replacement.endsWith(' ') && /^\s/.test(suffix)
    ? suggestion.replacement.trimEnd() : suggestion.replacement;
  const prefix = draft.text.slice(0, suggestion.start) + replacement;
  return {text: prefix + suffix, cursor: graphemes(prefix).length};
}
export function completionQuery(draft: Draft, view: string): string {
  return JSON.stringify([view, draft.text, draft.cursor]);
}
