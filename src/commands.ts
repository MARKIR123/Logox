export type CommandArgumentKind = 'none' | 'loginProvider' | 'provider' | 'model' | 'text';
export interface CommandDefinition {
  name: string;
  usage: string;
  description: string;
  argument: CommandArgumentKind;
}

export const commandCatalog: readonly CommandDefinition[] = [
  {name: 'help', usage: '/help', description: 'View available commands and keybindings', argument: 'none'},
  {name: 'login', usage: '/login [provider]', description: 'Log in, save provider API keys, and manage custom providers', argument: 'loginProvider'},
  {name: 'providers', usage: '/providers', description: 'Inspect connected providers, models, test latency, and refresh', argument: 'none'},
  {name: 'model', usage: '/model [actor]', description: 'Open model picker grouped by provider (defaults to active window, or specify an actor)', argument: 'model'},
  {name: 'status', usage: '/status', description: 'View model, usage, permissions, and session status', argument: 'none'},
  {name: 'statusbar', usage: '/statusbar', description: 'Customize statusbar modules, order, style, and colors', argument: 'none'},
  {name: 'settings', usage: '/settings', description: 'Customize theme, cursor, animations, and statusbar', argument: 'none'},
  {name: 'config', usage: '/config', description: 'Inspect effective model and execution configuration (read-only)', argument: 'none'},
  {name: 'cast', usage: '/cast task', description: 'Dispatch task across actor ensemble', argument: 'text'},
  {name: 'actors', usage: '/actors [model actor]', description: 'View actor responsibilities, compaction settings, and default models', argument: 'none'},
  {name: 'compact', usage: '/compact', description: 'Compact current role context while preserving ledgers', argument: 'none'},
  {name: 'new', usage: '/new', description: 'Create and switch to a new session', argument: 'none'},
  {name: 'resume', usage: '/resume [session-id]', description: 'Select or resume a session from history', argument: 'none'},
  {name: 'clear', usage: '/clear', description: 'Clear conversation screen while preserving model context and files', argument: 'none'},
  {name: 'rewind', usage: '/rewind', description: 'Select turn to rewind conversation and file edits', argument: 'none'},
  {name: 'undo', usage: '/undo', description: 'Undo file changes made in the latest turn', argument: 'none'},
  {name: 'permissions', usage: '/permissions', description: 'Open permissions page to view and toggle mode or manage rules', argument: 'none'},
  {name: 'reload', usage: '/reload', description: 'Reload personas, guidelines, skills, and template commands', argument: 'none'},
  {name: 'skills', usage: '/skills', description: 'View available skill names, descriptions, and file paths', argument: 'none'},
  {name: 'ensemble', usage: '/ensemble', description: 'View and inspect ensemble actor roster and personas', argument: 'none'},
] as const;

/** Public names only; TUI does not read auth or make remote requests during typing. */
export interface CommandContext {
  readonly providers: readonly string[];
  readonly loginProviders: readonly string[];
  readonly models: readonly string[];
  readonly actors?: readonly string[];
  readonly actorDetails?: readonly {id: string; name: string; title: string}[];
  readonly customCommands?: readonly {name: string; description: string}[];
}
export const emptyCommandContext: CommandContext = {providers: [], loginProviders: [], models: []};
export function commandHelp(): string {
  return commandCatalog.map(command => command.usage + ': ' + command.description).join('\n');
}
