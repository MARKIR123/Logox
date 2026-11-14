/**
 * Tabbed pages, `/settings` and `/ensemble` of one session: the save and action handlers shared by every tabbed page, the
 * environment `/settings` reads and writes, its sub-pages, the ensemble page, and the live refresh of whichever page is
 * open. The slash command behind the open tabbed page (`activeCommandPage`) lives in the shared session state; the page
 * content itself comes from `createCommandTabsFor` and the command-context builder, never from here.
 */
import {z} from 'zod';
import type {ActorCatalog} from '../actors/catalog.js';
import type {ActorServices} from '../actors/services.js';
import {createCommandTabsFor, type ApplicationCommandContext} from '../application-commands.js';
import type {SessionState} from '../app/state.js';
import type {SessionStatus} from '../app/status.js';
import {themeSchema, type Config} from '../config/config.js';
import {effortSchema} from '../config/model-preferences.js';
import {settingDefinition, settingDefinitions, settingOptions, settingsPages, saveSettings, type SettingsEnv} from '../config/settings-definitions.js';
import type {StatusbarPreferences} from '../config/statusbar-preferences.js';
import {applyThemePreset, applyCursorStyle, DEFAULT_THEME, listThemes, loadThemePresets, resolveTheme, type CursorStyleName} from '../config/theme-presets.js';
import {UiPreferences} from '../config/ui-settings.js';
import {saveUserName, setUserLabel} from '../config/user-profile.js';
import {mcpRegistrations, type ProjectExtensions} from '../extensions/runtime.js';
import type {PermissionEngine} from '../permissions/engine.js';
import {permissionDecisionSchema, permissionModeSchema, permissionScopeSchema} from '../permissions/engine.js';
import {validateRuleInput} from '../permissions/rule-input.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {SettingsItem} from '../runtime/command-surface.js';
import {isDirector} from '../runtime/director-id.js';
import {permissionModes} from '../runtime/permission-mode.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {ToolRegistry} from '../tools/registry.js';
import {buildEnsemble} from './ensemble-model.js';
import {openInEditor} from './editor.js';
import type {ModelSelection} from './model-selection.js';
import {modelsRows} from './models-page.js';
import type {ProvidersPage} from './providers-page.js';
import {shortcutRows} from './shortcuts.js';
import {tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

/**
 * Loads the theme presets and the saved UI preferences (theme, cursor style) in the background and returns the preferences.
 * A `[theme]` table that differs from stock wins over the default theme file; an untouched table lets the shipped default take over.
 */
export function loadUiPreferences(homeDir: string, config: Config | undefined): UiPreferences {
  // Themes are data: shipped JSON plus any `~/.logox/themes/*.json` overlay.
  loadThemePresets(homeDir);
  const ui = new UiPreferences(homeDir);
  const stockTheme = themeSchema.parse({});
  const themeCustomizedInToml = config?.theme
    ? config.theme.user !== stockTheme.user || config.theme.accent !== stockTheme.accent
      || config.theme.dream_collapsed !== stockTheme.dream_collapsed || config.theme.dream_expanded !== stockTheme.dream_expanded
    : false;
  void ui.load().then(saved => {
    if (ui.saved) {
      // Older preferences stored display names; resolve to the file ID.
      applyThemePreset(resolveTheme(saved.theme)?.name ?? DEFAULT_THEME);
      applyCursorStyle(saved.cursor as CursorStyleName, process.stdout);
    } else if (!themeCustomizedInToml) applyThemePreset(DEFAULT_THEME);
  }).catch(() => {});
  return ui;
}

export interface PagesDeps {
  cwd: string; homeDir: string; config: Config; state: SessionState;
  store: RuntimeStore; surfaces: CommandSurfaces; statusbar: StatusbarPreferences; permissions: PermissionEngine; ui: UiPreferences;
  actors: ActorCatalog; actorServices: ActorServices; toolRegistry: ToolRegistry; extensions: ProjectExtensions;
  registry: ProviderRegistry; modelPool: ModelPool;
  modelSelection: Pick<ModelSelection, 'saveEffort' | 'openModels'>;
  providersPage: Pick<ProvidersPage, 'action'>;
  status: Pick<SessionStatus, 'status' | 'actorUsage'>;
  /** The data record the tabbed pages render from. */
  buildContext(): ApplicationCommandContext;
  /** Resolves once the preferred name has loaded. */
  profileReady: Promise<void>;
}

export function createPages(deps: PagesDeps) {
  const {cwd, homeDir, config, state, store, surfaces, statusbar, permissions, ui, actors, actorServices, toolRegistry, extensions,
    registry, modelPool, modelSelection, providersPage, status, buildContext, profileReady} = deps;
  const resources = extensions.resources;
  const pageIsOpen = () => {const open = surfaces.getSnapshot(); return open?.kind === 'page' || open?.kind === 'settings' && open.sub !== undefined;};
  const refreshCurrentPage = () => {
    if (!pageIsOpen() || !state.activeCommandPage) return;
    const spec = createCommandTabsFor(state.activeCommandPage, buildContext());
    if (spec) surfaces.updatePage(spec.tabs);
  };
  /** Save and action handlers of the tabbed pages; /settings reuses them for the sub-pages it opens. */
  const pageActions = (closeOnSave: boolean): PageActions => ({
    closeOnSave,
    onSaveToggles: async (tabId, items, appearance) => {
      if (tabId !== 'statusbar') throw new Error('This page does not support configuration');
      await statusbar.save(items.map(({id, enabled}) => ({id, enabled})), appearance);
      refreshCurrentPage();
      return {message: 'Statusbar layout saved.', presentation: 'status'};
    },
    onTabAction: async (tabId, action) => {
      if (action === 'cancel_confirm') return {message: 'Cancelled.', presentation: 'status'};
      if (tabId === 'permissions' && action.startsWith('set_mode:')) {
        // The page edits a draft; only Enter reaches here, and this is the single place the mode is saved.
        const nextMode = permissionModeSchema.parse(action.slice('set_mode:'.length));
        await permissions.setMode(nextMode);
        return {message: 'Permission mode set to ' + nextMode, presentation: 'status', close: true};
      }
      if (tabId === 'permissions' && action.startsWith('delete_rule:')) {
        await permissions.revoke(action.slice('delete_rule:'.length));
        return {message: 'Permission rule deleted', presentation: 'status'};
      }
      if (tabId === 'permissions' && action.startsWith('add_rule:')) {
        const input = z.strictObject({scope: permissionScopeSchema, decision: permissionDecisionSchema, tool: z.string(), pattern: z.string()}).parse(JSON.parse(action.slice('add_rule:'.length)));
        const checked = validateRuleInput(input, permissions.userScopeAvailable);
        if (!checked.ok) throw new Error(checked.error);
        await permissions.add(checked.rule);
        return {message: 'Permission rule added (' + checked.rule.decision + ' ' + checked.rule.tool + ' · ' + checked.rule.scope + ')', presentation: 'status'};
      }
      if (tabId === 'providers') return providersPage.action(action);
      return {};
    },
  });

  /** Everything /settings reads and writes, wired to the real stores. */
  const settingsEnv: SettingsEnv = {
    ui, statusbar,
    themes: () => listThemes().map(theme => theme.name),
    applyTheme: name => {applyThemePreset(name);},
    applyCursor: name => applyCursorStyle(name as CursorStyleName, process.stdout),
    userName: () => state.userName,
    saveUserName: async name => {
      await profileReady;
      try {state.userName = await saveUserName(homeDir, name);}
      catch {throw new Error('Could not save the preferred name; it is unchanged.');}
      setUserLabel(state.userName);
      return state.userName;
    },
    thinking: () => registry.thinking(),
    saveEffort: effort => modelSelection.saveEffort(effortSchema.parse(effort)),
    permissionMode: () => permissions.mode,
    permissionModes: () => Object.keys(permissionModes),
    savePermissionMode: mode => permissions.setMode(permissionModeSchema.parse(mode)),
  };
  const settingsItems = (): SettingsItem[] => settingDefinitions.map(definition => ({
    key: definition.key, label: definition.label, description: definition.description, group: definition.group, kind: definition.kind,
    options: settingOptions(definition, settingsEnv), value: definition.read(settingsEnv),
    ...(definition.labels ? {labels: definition.labels} : {}),
    ...(definition.min !== undefined ? {min: definition.min} : {}), ...(definition.max !== undefined ? {max: definition.max} : {}), ...(definition.step !== undefined ? {step: definition.step} : {}),
  }));
  /** The page behind a `Pages` row of /settings; Esc returns to the settings with their drafts. */
  const settingsSubPage = (id: string) => {
    const context = buildContext();
    if (id === 'statusbar') {
      const spec = createCommandTabsFor('/statusbar', context);
      state.activeCommandPage = '/statusbar';
      return spec ? {title: 'Status bar', tabs: spec.tabs, initialTab: spec.initialTab, actions: pageActions(false)} : null;
    }
    if (id === 'permissions') {
      const spec = createCommandTabsFor('/permissions', context);
      state.activeCommandPage = '/permissions';
      return spec ? {title: 'Permissions', tabs: spec.tabs, initialTab: spec.initialTab, actions: pageActions(true)} : null;
    }
    state.activeCommandPage = '';
    if (id === 'models') {
      return {title: 'Models & pricing', initialTab: 'models', actions: {onSaveToggles: () => ({})} as PageActions,
        tabs: [{id: 'models', title: 'Models', ...tabContent(modelsRows(config, registry.names(), modelPool.snapshot()))}]};
    }
    if (id === 'shortcuts') {
      return {title: 'Shortcuts', initialTab: 'shortcuts', actions: {onSaveToggles: () => ({})} as PageActions,
        tabs: [{id: 'shortcuts', title: 'Shortcuts', ...tabContent(shortcutRows())}]};
    }
    return null;
  };
  const openSettings = () => {
    let previewed = false;
    surfaces.openSettings(settingsItems(), settingsPages.map(({id, label, description}) => ({id, label, description})), {
      save: changes => saveSettings(settingsEnv, changes),
      preview: (key, value) => {const definition = settingDefinition(key); if (definition?.preview) {previewed = true; definition.preview(settingsEnv, value);}},
      revert: () => {if (previewed) for (const definition of settingDefinitions) definition.revert?.(settingsEnv);},
      openPage: settingsSubPage,
    });
  };
  /** /ensemble: a read-only snapshot per actor; `m` leaves for the model picker and `e` hands a file to the external editor. */
  const openEnsemble = (initial?: string) => {
    const data = buildEnsemble({actors: () => actors.list(), cwd, home: homeDir, status: status.status, policy: id => actorServices.policy(id),
      tools: id => toolRegistry.resolveForActor(id, mcpRegistrations(extensions.mcp)), mcp: () => extensions.mcp.folders(),
      skills: actor => resources.skillsFor({actorId: actor.id, skills: actor.skills}), snapshot: () => store.getSnapshot(),
      usage: id => status.actorUsage(id)}, initial);
    surfaces.openEnsemble(data, {
      model: async id => {const actor = actors.find(id); if (!actor) return; if (isDirector(actor.id)) modelSelection.openModels(actor.name); else await actorServices.management.openDefaultModel(actor.id, surfaces);},
      edit: path => openInEditor(path),
    });
  };
  return {pageActions, openSettings, openEnsemble, pageIsOpen, refreshCurrentPage};
}
export type Pages = ReturnType<typeof createPages>;
