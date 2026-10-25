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

const actorDescriptions: Record<string, string> = {
  logox: 'Director',
  techne: 'Builder',
  kalon: 'Polisher',
  aletheia: 'Scout',
};

function resolveActorTitle(id: string, context: CommandContext): string {
  const lower = id.toLowerCase();
  if (lower === 'automa') return 'Stateless Worker';
  const custom = context.actorDetails?.find(a => a.id.toLowerCase() === lower);
  return actorDescriptions[lower] ?? custom?.title ?? 'Actor role';
}

export function commandSuggestions(draft: Draft, context: CommandContext): readonly CommandSuggestion[] {
  if (/[\r\n]/.test(draft.text)) return [];
  const before = graphemes(draft.text).slice(0, draft.cursor).join('');

  const mentionMatch = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(before);
  if (mentionMatch) {
    const atIndex = before.lastIndexOf('@');
    const prefix = mentionMatch[1]!.toLowerCase();
    const suffix = /^[^\s]*/.exec(draft.text.slice(before.length))?.[0] ?? '';
    const end = before.length + suffix.length;
    const actorList = context.actors && context.actors.length > 0
      ? context.actors
      : ['logox', 'techne', 'kalon', 'aletheia'];
    return actorList
      .filter(id => id.toLowerCase().startsWith(prefix))
      .map(id => {
        const desc = resolveActorTitle(id, context);
        return {
          label: '@' + id,
          description: desc,
          replacement: '@' + id + ' ',
          start: atIndex,
          end,
          kind: 'argument' as const,
          execute: false,
        };
      });
  }

  if (!draft.text.startsWith('/')) return [];
  const commandPrefix = /^\/([a-z0-9_-]*)$/i.exec(before);
  if (commandPrefix) {
    const end = /^\/[^\s]*/.exec(draft.text)?.[0].length ?? before.length;
    const catalog = [...commandCatalog, ...(context.customCommands ?? []).map(command => ({...command, argument: 'text'}))];
    return catalog.filter(command => command.name.startsWith(commandPrefix[1]!.toLowerCase())).map(command => {
      const required = ['provider', 'model', 'text'].includes(command.argument);
      return {label: '/' + command.name, description: command.description, replacement: '/' + command.name + (required ? ' ' : ''),
        start: 0, end, kind: 'command', execute: command.argument !== 'text'};
    });
  }
  const tokens = before.slice(1).split(/[ \t]+/);
  const commandName = tokens[0]?.toLowerCase() ?? '';
  const command = commandCatalog.find(item => item.name.toLowerCase() === commandName);
  if (!command) return [];

  const argIndex = tokens.length - 1;
  const currentPrefix = tokens[argIndex] ?? '';
  const start = before.length - currentPrefix.length;
  const suffix = /^[^\s]*/.exec(draft.text.slice(before.length))?.[0] ?? '';
  const end = before.length + suffix.length;

  if (command.name === 'model') {
    if (argIndex === 1) {
      const actorList = [
        ...(context.actors ?? ['logox', 'techne', 'kalon', 'aletheia']).map(a => ({
          name: a,
          description: resolveActorTitle(a, context),
        })),
        {
          name: 'automa',
          description: 'Stateless Worker',
        },
      ];
      return actorList
        .filter(item => item.name.toLowerCase().startsWith(currentPrefix.toLowerCase()))
        .map(item => ({
          label: item.name,
          description: item.description,
          replacement: item.name,
          start,
          end,
          kind: 'argument' as const,
          execute: true,
        }));
    }
    return [];
  }

  if (argIndex === 1) {
    const candidates = command.argument === 'provider' ? context.providers
      : command.argument === 'loginProvider' ? context.loginProviders
        : [];
    return [...new Set(candidates)].filter(name => name.toLowerCase().startsWith(currentPrefix.toLowerCase())).map(name => ({
      label: name, description: command.argument === 'provider' ? 'Provider' : 'Login provider', replacement: name,
      start, end, kind: 'argument', execute: false,
    }));
  }

  return [];
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
