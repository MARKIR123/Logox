import {defaultGaugeCells, gaugeCellChoices, type StatusbarAppearance, type StatusbarPreferences} from './statusbar-preferences.js';
import {sanitizeUserName} from './user-profile.js';
import {
  defaultUiSettings, diffLayoutChoices, emblemChoices, enterKeyChoices, notifyChoices, taglineChoices, thinkingDisplayChoices, toolTintChoices,
  type UiPreferences, type UiPreferencesData,
} from './ui-settings.js';

/** `/settings` is data-driven: every row of the page is one definition below, and `tests/settings-definitions.test.ts` checks each has a group, a description, a default and a working persistence path. */
export type SettingValue = string | number | boolean;
export type SettingKind = 'boolean' | 'select' | 'number' | 'text';
export type SettingGroupId = 'appearance' | 'splash' | 'conversation' | 'pages';
export const settingGroups: readonly {readonly id: SettingGroupId; readonly label: string}[] = [
  {id: 'appearance', label: 'Appearance'}, {id: 'splash', label: 'Splash'}, {id: 'conversation', label: 'Conversation'}, {id: 'pages', label: 'Pages'},
];
export const cursorChoices = ['Block █', 'Underline _', 'Bar |'] as const;

/** What the definitions read and write; the application supplies the real stores, tests supply temporary ones. */
export interface SettingsEnv {
  readonly ui: UiPreferences;
  readonly statusbar: Pick<StatusbarPreferences, 'getSnapshot' | 'save' | 'saveMotion'>;
  themes(): readonly string[];
  /** Applies a theme to the live palette without saving it (preview and revert use this too). */
  applyTheme(name: string): void;
  applyCursor(name: string): void;
  userName(): string | undefined;
  saveUserName(name: string | undefined): Promise<string | undefined>;
  thinking(): {readonly effort: string; readonly levels: readonly string[]};
  saveEffort(effort: string): Promise<void>;
  permissionMode(): string;
  permissionModes(): readonly string[];
  savePermissionMode(mode: string): Promise<void>;
}

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  /** One sentence shown under the list while the row is selected. */
  readonly description: string;
  readonly group: Exclude<SettingGroupId, 'pages'>;
  readonly kind: SettingKind;
  /** Select choices (stored values); a function when they depend on the running model or session. */
  readonly options?: readonly string[] | ((env: SettingsEnv) => readonly string[]);
  /** Display text for stored select values when it differs from the value. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly min?: number; readonly max?: number; readonly step?: number;
  readonly default: SettingValue;
  read(env: SettingsEnv): SettingValue;
  /** Persists the value (atomically through the owning store) and makes it live. */
  write(env: SettingsEnv, value: SettingValue): Promise<void>;
  /** Live preview while the value is only a draft; `revert` undoes it on discard. */
  preview?(env: SettingsEnv, value: SettingValue): void;
  revert?(env: SettingsEnv): void;
}
export interface SettingsPageDefinition {readonly id: 'statusbar' | 'permissions' | 'models' | 'shortcuts'; readonly label: string; readonly description: string}
export const settingsPages: readonly SettingsPageDefinition[] = [
  {id: 'statusbar', label: 'Status bar', description: 'Choose, order and style the status line modules and the context gauge.'},
  {id: 'permissions', label: 'Permissions', description: 'Permission mode, saved rules and this run\'s approval statistics.'},
  {id: 'models', label: 'Models & pricing', description: 'Configured models with window, output limit, prices and how confidently each was matched.'},
  {id: 'shortcuts', label: 'Shortcuts', description: 'Every key binding and mouse gesture, grouped. Rebinding is not available yet.'},
];

export function settingOptions(definition: SettingDefinition, env: SettingsEnv): readonly string[] {
  const options = definition.options;
  return typeof options === 'function' ? options(env) : options ?? [];
}
export function settingText(definition: SettingDefinition, value: SettingValue): string {
  if (typeof value === 'boolean') return value ? '[✓]' : '[ ]';
  return definition.labels?.[String(value)] ?? String(value);
}

const uiBacked = <K extends keyof UiPreferencesData>(key: K) => ({
  read: (env: SettingsEnv) => env.ui.get()[key] as SettingValue,
  write: (env: SettingsEnv, value: SettingValue) => env.ui.save({[key]: value} as Partial<UiPreferencesData>),
});
const gauge = (env: SettingsEnv): StatusbarAppearance => {
  const snapshot = env.statusbar.getSnapshot();
  return {style: snapshot.style, colorScheme: snapshot.colorScheme, gaugeCells: snapshot.gaugeCells};
};

export const settingDefinitions: readonly SettingDefinition[] = [
  {key: 'theme', label: 'Theme', group: 'appearance', kind: 'select', default: 'logox-dark', options: env => env.themes(),
    description: 'Colour theme; the page previews it live and puts the old one back when you discard.',
    read: env => env.ui.get().theme,
    write: async (env, value) => {await env.ui.save({theme: String(value)}); env.applyTheme(String(value));},
    preview: (env, value) => env.applyTheme(String(value)),
    revert: env => env.applyTheme(env.ui.get().theme)},
  {key: 'cursor', label: 'Cursor', group: 'appearance', kind: 'select', default: 'Block █', options: cursorChoices,
    description: 'Shape of the terminal cursor while Logox runs.',
    read: env => env.ui.get().cursor,
    write: async (env, value) => {await env.ui.save({cursor: String(value)}); env.applyCursor(String(value));}},
  {key: 'animations', label: 'Animations', group: 'appearance', kind: 'boolean', default: true,
    description: 'Motion waves and animated glyphs; off keeps the interface static and never changes task state.',
    read: env => env.statusbar.getSnapshot().motion,
    write: (env, value) => env.statusbar.saveMotion(value === true)},
  {key: 'toolTint', label: 'Tool card tint', group: 'appearance', kind: 'select', default: defaultUiSettings.toolTint, options: toolTintChoices,
    description: 'Background tint of an expanded card: none, subtle (half strength) or standard.',
    ...uiBacked('toolTint')},
  {key: 'contextBar', label: 'Context bar', group: 'appearance', kind: 'boolean', default: true,
    description: 'Show the context gauge in the status line (the same switch as the Status bar page).',
    read: env => env.statusbar.getSnapshot().modules.some(module => module.id === 'context' && module.enabled),
    write: (env, value) => env.statusbar.save(env.statusbar.getSnapshot().modules.map(module => module.id === 'context' ? {...module, enabled: value === true} : module))},
  {key: 'contextBarWidth', label: 'Context bar width', group: 'appearance', kind: 'number', default: defaultGaugeCells, min: gaugeCellChoices[0], max: gaugeCellChoices.at(-1)!, step: 4,
    description: 'Cells of the context gauge; the status line may still shrink it on a narrow terminal.',
    read: env => env.statusbar.getSnapshot().gaugeCells,
    write: (env, value) => env.statusbar.save(env.statusbar.getSnapshot().modules, {...gauge(env), gaugeCells: Number(value)})},
  {key: 'startPage', label: 'Start page', group: 'splash', kind: 'boolean', default: true,
    description: 'Welcome splash with the emblem on an empty session; off shows plain text.',
    ...uiBacked('startPage')},
  {key: 'emblem', label: 'Emblem size', group: 'splash', kind: 'select', default: 'auto', options: emblemChoices, labels: {small: 'small 26', large: 'large 52'},
    description: 'Auto picks the largest emblem that fits; small never draws the 52-pixel master, large prefers it.',
    ...uiBacked('emblem')},
  {key: 'tagline', label: 'Tagline', group: 'splash', kind: 'select', default: 'fixed', options: taglineChoices, labels: {rotate: 'rotate daily'},
    description: 'The line under the emblem: always the same, or a different one each calendar day.',
    ...uiBacked('tagline')},
  {key: 'userName', label: 'Your name', group: 'conversation', kind: 'text', default: '',
    description: 'What Logox calls you and the label on your messages; the same as /name. Empty shows You.',
    read: env => env.userName() ?? '',
    write: async (env, value) => {await env.saveUserName(sanitizeUserName(String(value)) || undefined);}},
  {key: 'thinkingDisplay', label: 'Thinking display', group: 'conversation', kind: 'select', default: 'folded', options: thinkingDisplayChoices,
    description: 'How finished thinking appears: folded (one row), preview (2-3 lines) or full. A click still toggles one card.',
    ...uiBacked('thinkingDisplay')},
  {key: 'diffLayout', label: 'Diff layout', group: 'conversation', kind: 'select', default: 'auto', options: diffLayoutChoices, labels: {auto: 'auto (by width)'},
    description: 'Edit diffs: unified with line numbers, compact without them, or auto (compact on narrow cards).',
    ...uiBacked('diffLayout')},
  {key: 'notify', label: 'Notify when done', group: 'conversation', kind: 'select', default: 'off', options: notifyChoices, labels: {unfocused: 'when unfocused'},
    description: 'Terminal bell or notification when work that ran over 30 seconds finishes. Without focus reporting the terminal counts as unfocused.',
    ...uiBacked('notify')},
  {key: 'enterKey', label: 'Enter key', group: 'conversation', kind: 'select', default: 'send', options: enterKeyChoices,
    labels: {send: 'send', newline: 'newline'},
    description: 'send: Enter sends, Shift+Enter or Ctrl+J adds a line. newline: Enter adds a line, Ctrl+Enter or Ctrl+S sends.',
    ...uiBacked('enterKey')},
  {key: 'defaultThinking', label: 'Default thinking', group: 'conversation', kind: 'select', default: 'auto', options: env => env.thinking().levels,
    description: 'Thinking effort of the current model, saved as its default (the same as /effort).',
    read: env => env.thinking().effort,
    write: (env, value) => env.saveEffort(String(value))},
  {key: 'defaultMode', label: 'Default mode', group: 'conversation', kind: 'select', default: 'default', options: env => env.permissionModes(),
    description: 'Permission mode for tool calls (the same as /permissions): default asks, auto reviews, creative allows after danger filtering.',
    read: env => env.permissionMode(),
    write: (env, value) => env.savePermissionMode(String(value))},
];
const byKey = new Map(settingDefinitions.map(definition => [definition.key, definition]));
export function settingDefinition(key: string): SettingDefinition | undefined {return byKey.get(key);}

/** The saved value of every setting, by key. */
export function readSettings(env: SettingsEnv): Record<string, SettingValue> {
  return Object.fromEntries(settingDefinitions.map(definition => [definition.key, definition.read(env)]));
}
/** Normalises a draft to what the definition accepts (an unknown select value is rejected, numbers are clamped to their step grid). */
export function coerceSetting(definition: SettingDefinition, value: SettingValue, env: SettingsEnv): SettingValue {
  if (definition.kind === 'boolean') return value === true;
  if (definition.kind === 'number') {
    const min = definition.min ?? 0, max = definition.max ?? min, step = definition.step ?? 1;
    return Math.min(max, Math.max(min, min + Math.round((Number(value) - min) / step) * step));
  }
  if (definition.kind === 'select') {
    const options = settingOptions(definition, env), text = String(value);
    if (options.length && !options.includes(text)) throw new Error(definition.label + ': "' + text + '" is not one of ' + options.join(', '));
    return text;
  }
  return String(value);
}
/** Saves the drafts that differ from the saved values, in page order; stops at the first failure and reports what was saved. */
export async function saveSettings(env: SettingsEnv, changes: Readonly<Record<string, SettingValue>>): Promise<{saved: Record<string, SettingValue>; error?: string}> {
  const saved: Record<string, SettingValue> = {};
  for (const definition of settingDefinitions) {
    if (!Object.hasOwn(changes, definition.key)) continue;
    try {
      const value = coerceSetting(definition, changes[definition.key]!, env);
      await definition.write(env, value);
      saved[definition.key] = definition.read(env);
    } catch (error) {
      return {saved, error: definition.label + ' was not saved: ' + (error instanceof Error ? error.message : String(error))};
    }
  }
  return {saved};
}
