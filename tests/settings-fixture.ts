import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StatusbarPreferences} from '../src/config/statusbar-preferences.js';
import {UiPreferences} from '../src/config/ui-settings.js';
import {settingDefinitions, settingOptions, settingsPages, type SettingsEnv} from '../src/config/settings-definitions.js';
import type {SettingsItem, SettingsPageLink} from '../src/runtime/command-surface.js';

/** A settings environment on a temporary home: real preference files, recorded fakes for the rest. */
export async function settingsFixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-settings-'));
  const state = {
    name: undefined as string | undefined, effort: 'auto', mode: 'default', theme: 'logox-dark',
    appliedThemes: [] as string[], appliedCursors: [] as string[], savedModes: [] as string[], savedEfforts: [] as string[],
  };
  const ui = new UiPreferences(root), statusbar = new StatusbarPreferences(join(root, '.logox', 'statusbar.json'));
  await ui.load(); await statusbar.load();
  const env: SettingsEnv = {
    ui, statusbar,
    themes: () => ['logox-dark', 'claude-warm', 'mist-light'],
    applyTheme: name => {state.theme = name; state.appliedThemes.push(name);},
    applyCursor: name => {state.appliedCursors.push(name);},
    userName: () => state.name,
    saveUserName: async name => {state.name = name; return name;},
    thinking: () => ({effort: state.effort, levels: ['auto', 'off', 'low', 'medium', 'high']}),
    saveEffort: async effort => {state.effort = effort; state.savedEfforts.push(effort);},
    permissionMode: () => state.mode,
    permissionModes: () => ['default', 'auto', 'creative'],
    savePermissionMode: async mode => {state.mode = mode; state.savedModes.push(mode);},
  };
  const items = (): SettingsItem[] => settingDefinitions.map(definition => ({
    key: definition.key, label: definition.label, description: definition.description, group: definition.group, kind: definition.kind,
    options: settingOptions(definition, env), value: definition.read(env),
    ...(definition.labels ? {labels: definition.labels} : {}),
    ...(definition.min !== undefined ? {min: definition.min} : {}), ...(definition.max !== undefined ? {max: definition.max} : {}), ...(definition.step !== undefined ? {step: definition.step} : {}),
  }));
  const pages: SettingsPageLink[] = settingsPages.map(({id, label, description}) => ({id, label, description}));
  return {root, env, state, items, pages, ui, statusbar, close: () => rm(root, {recursive: true, force: true})};
}
