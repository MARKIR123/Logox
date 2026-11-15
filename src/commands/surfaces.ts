import {randomUUID} from 'node:crypto';
import {applyTheme, palette, type ThemePalette} from '../config/theme-palette.js';
import {immutable} from '../runtime/contracts.js';
import type {ResultLine, CommandOrigin, CommandSurface, CommandTab, CommandToggle, CommandResult, PickerItem, SettingsItem, SettingsPageLink, SettingsSubPage, ThemePageData} from '../runtime/command-surface.js';
export type PickerSpec = Pick<Extract<CommandSurface, {kind: 'picker'}>, 'title' | 'description' | 'current'> & {
  /** Shown instead of the search box when the list loads empty; say what to do next. */
  readonly emptyText?: string;
  readonly focus?: string;
  readonly items?: readonly PickerItem[];
  readonly effort?: string;
  readonly effortLevels?: readonly string[];
};
/** Callbacks of the /ensemble page: `/model <actor>` and the external editor stay in the application. */
export interface EnsembleActions {
  model(actorId: string): void | Promise<void>;
  edit(path: string): Promise<{readonly ok: boolean; readonly message: string}>;
}
export interface PickerActions {readonly deleteLabel: string; onDelete(id: string): void | Promise<void>}
export interface PageActions {
  /** Multi-editor settings pages apply one tab without discarding drafts in the others. */
  readonly closeOnSave?: boolean;
  onSaveToggles(tabId: string, items: readonly CommandToggle[], appearance?: import('../config/statusbar-preferences.js').StatusbarAppearance): CommandResult | Promise<CommandResult>;
  onTabAction?(tabId: string, action: string): CommandResult | Promise<CommandResult>;
  /** Esc on a page opened from another page: the page closes, then this runs (it opens the parent again). */
  onBack?(): void | Promise<void>;
}
/** Callbacks of the /settings page; drafts live in the page, only Enter reaches `save`. */
export interface SettingsActions {
  /** Persists the changed drafts; resolves with the saved values and, when one failed, the reason (the page stays open then). */
  save(changes: Readonly<Record<string, string | number | boolean>>): Promise<{saved: Readonly<Record<string, string | number | boolean>>; error?: string}>;
  /** Live preview of a draft (theme); `revert` undoes every preview when the page is discarded. */
  preview?(key: string, value: string | number | boolean): void;
  revert?(): void;
  /** Builds the sub-page behind a `Pages` row; null when it cannot open. */
  openPage(id: string): {title: string; tabs: readonly CommandTab[]; initialTab: string; actions: PageActions} | null;
  /** Data and callbacks of the /theme page the Theme row opens; the saved theme name comes back through `pages` afterwards. */
  openTheme?(): {data: ThemePageData; actions: ThemeActions};
}
/** Callbacks of the /theme page. Nothing is written until `save`; the surface restores the palette it found when the page closes without one. */
export interface ThemeActions {
  /** Puts a theme on the live palette (preview). */
  apply(name: string): void;
  /** Persists the choice through the preference store and applies it. */
  save(name: string): Promise<void>;
}
export interface CommandCompletion extends Partial<CommandOrigin> {readonly surfaceId: string; readonly active: boolean}

/** Owns the command surface lifecycle; callbacks and query cancellation signals stay in the business layer. */
export class CommandSurfaces {
  private state: CommandSurface | null = null;
  private listeners = new Set<() => void>();
  private controller: AbortController | undefined;
  private select: ((id: string, effort?: string) => CommandResult | Promise<CommandResult>) | undefined;
  private pickerActions: PickerActions | undefined;
  private pickerBack: (() => void | Promise<void>) | undefined;
  private pageActions: PageActions | undefined;
  private settingsActions: SettingsActions | undefined;
  private ensembleActions: EnsembleActions | undefined;
  private subActions: PageActions | undefined;
  private themeActions: ThemeActions | undefined;
  /** The palette in force when the /theme page opened; present exactly while a preview may be on screen. */
  private themeSnapshot: ThemePalette | undefined;
  getSnapshot = (): CommandSurface | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  constructor(private readonly onDone: (result: CommandResult, completion: CommandCompletion) => void,
    private readonly origin?: () => CommandOrigin) {}
  private completion(state: CommandSurface, active: boolean): CommandCompletion {
    return {surfaceId: state.id, active, ...(state.ownerId ? {ownerId: state.ownerId} : {}),
      ...(state.sessionId ? {sessionId: state.sessionId} : {})};
  }
  private publish(state: CommandSurface | null): void {this.state = immutable(state); for (const listener of this.listeners) listener();}
  private assertIdle(): void {if (this.state) throw new Error('Please close current command surface first');}
  openPage(title: string, tabs: readonly CommandTab[], initialTab: string, actions?: PageActions): void {
    this.assertIdle();
    if (!tabs.length || !tabs.some(tab => tab.id === initialTab)) throw new Error('Page missing valid tab');
    this.pageActions = actions;
    this.publish({id: randomUUID(), kind: 'page', title, tabs, initialTab, ...this.origin?.()});
  }
  /** Read-only output has no save callback or model execution semantics. */
  openResult(title: string, text: string, origin = this.origin?.(), lines?: readonly ResultLine[]): string {
    this.assertIdle();
    const id = randomUUID();
    this.publish({id, kind: 'result', title, text, ...(lines ? {lines} : {}), ...origin});
    return id;
  }
  updateResult(surfaceId: string, text: string, lines?: readonly ResultLine[]): void {
    if (this.state?.kind === 'result' && this.state.id === surfaceId) this.publish({...this.state, text, ...(lines ? {lines} : {})});
  }
  /** The page being edited: a plain page, or the sub-page open over /settings. */
  private pageLike(): (Pick<SettingsSubPage, 'tabs'> & {readonly id: string; readonly saving?: boolean; readonly error?: string; readonly confirm?: SettingsSubPage["confirm"]}) | null {
    const state = this.state;
    if (state?.kind === 'page') return state;
    if (state?.kind === 'settings' && state.sub) return {...state.sub, id: state.id};
    return null;
  }
  private pageHandlers(): PageActions | undefined {return this.state?.kind === 'settings' ? this.subActions : this.pageActions;}
  /** Replaces the page fields (tabs, saving, error, confirm) of the open page or sub-page. */
  private applyPage(fields: {readonly tabs: readonly CommandTab[]; readonly saving?: boolean; readonly error?: string; readonly confirm?: SettingsSubPage["confirm"]}): void {
    const state = this.state;
    if (state?.kind === 'page') {
      const {tabs: _tabs, saving: _saving, error: _error, confirm: _confirm, ...rest} = state;
      this.publish({...rest, ...fields} as CommandSurface);
    } else if (state?.kind === 'settings' && state.sub) {
      const {tabs: _tabs, saving: _saving, error: _error, confirm: _confirm, ...rest} = state.sub;
      this.publish({...state, sub: {...rest, ...fields}});
    }
  }
  /** Leaves the page: a sub-page returns to /settings, anything else closes the surface. */
  private leavePage(): void {
    const state = this.state;
    if (state?.kind === 'settings' && state.sub) {const {sub: _sub, ...rest} = state; this.subActions = undefined; this.publish(rest);}
    else this.dismiss();
  }
  async saveToggles(surfaceId: string, tabId: string, items: readonly CommandToggle[], appearance?: import('../config/statusbar-preferences.js').StatusbarAppearance): Promise<void> {
    const state = this.state, page = this.pageLike(), actions = this.pageHandlers();
    if (!state || !page || page.id !== surfaceId || page.saving || !actions) return;
    const tab = page.tabs.find(tab => tab.id === tabId);
    if (!tab?.toggles || items.length !== tab.toggles.length || new Set(items.map(item => item.id)).size !== items.length ||
      items.some(item => !tab.toggles!.some(original => original.id === item.id))) return;
    this.applyPage({tabs: page.tabs, saving: true, error: ""});
    try {
      const result = await actions.onSaveToggles(tabId, immutable([...items]), appearance && immutable({...appearance}));
      const current = this.pageLike();
      if (current?.id === surfaceId) {
        if (actions.closeOnSave === false || this.state?.kind === 'settings') {
          this.applyPage({saving: false, error: "", tabs: current.tabs.map(item => item.id === tabId
            ? {...item, toggles: [...items], ...(item.statusbar && appearance ? {statusbar: {...item.statusbar, appearance}} : {})} : item)});
        } else this.leavePage();
        this.onDone(result, this.completion(state, true));
      }
    } catch (error) {
      const current = this.pageLike();
      if (current?.id === surfaceId) this.applyPage({tabs: current.tabs, saving: false, error: error instanceof Error ? error.message : 'Save failed'});
    }
  }
  async triggerTabAction(surfaceId: string, tabId: string, action: string): Promise<void> {
    const state = this.state, page = this.pageLike(), actions = this.pageHandlers();
    if (!state || !page || page.id !== surfaceId || page.saving || !actions?.onTabAction) return;
    try {
      const result = await actions.onTabAction(tabId, action);
      const current = this.pageLike();
      if (current?.id === surfaceId) {
        const keep = {tabs: current.tabs, ...(current.saving ? {saving: current.saving} : {}), ...(current.error ? {error: current.error} : {})};
        if (result?.confirm) this.applyPage({...keep, confirm: {tabId, ...result.confirm}});
        else if (current.confirm) this.applyPage(keep);
      }
      const stillOpen = this.pageLike()?.id === surfaceId;
      if (result?.close && stillOpen) this.leavePage();
      if (result?.message) this.onDone(result, this.completion(state, stillOpen));
    } catch (error) {
      const current = this.pageLike();
      if (current?.id === surfaceId) this.applyPage({tabs: current.tabs, error: error instanceof Error ? error.message : 'Operation failed'});
      else this.onDone({message: error instanceof Error ? error.message : 'Operation failed', kind: 'command_error', presentation: 'timeline'}, this.completion(state, false));
    }
  }
  updatePage(tabs: readonly CommandTab[]): void {
    const page = this.pageLike();
    if (page) this.applyPage({tabs, ...(page.saving ? {saving: page.saving} : {}), ...(page.error ? {error: page.error} : {}), ...(page.confirm ? {confirm: page.confirm} : {})});
  }
  /** Opens /settings: `items` carry the saved values and `pages` the sub-page rows; the page keeps unsaved drafts itself. */
  openSettings(items: readonly SettingsItem[], pages: readonly SettingsPageLink[], actions: SettingsActions): void {
    this.assertIdle();
    this.settingsActions = actions;
    this.publish({id: randomUUID(), kind: 'settings', title: 'Settings', items, pages, ...this.origin?.()});
  }
  /** Opens /theme: the page previews the highlighted theme live; closing without a choice puts the palette back. */
  openTheme(data: ThemePageData, actions: ThemeActions): void {
    this.assertIdle();
    this.beginTheme(actions);
    this.publish({id: randomUUID(), kind: 'theme', title: 'Theme', ...data});
  }
  private beginTheme(actions: ThemeActions): void {
    this.themeActions = actions;
    this.themeSnapshot = {...palette};
  }
  /** Puts back the palette found when the page opened (exactly, token by token); a no-op once a theme was saved. */
  private restoreTheme(): void {
    const snapshot = this.themeSnapshot;
    this.themeSnapshot = undefined; this.themeActions = undefined;
    if (snapshot) applyTheme({...snapshot});
  }
  private themeOpen(surfaceId: string): ThemePageData | undefined {
    const state = this.state;
    if (state?.kind === 'theme' && state.id === surfaceId) return state;
    if (state?.kind === 'settings' && state.id === surfaceId) return state.theme;
    return undefined;
  }
  /** Live preview of one listed theme; nothing is written. */
  previewTheme(surfaceId: string, name: string): void {
    const data = this.themeOpen(surfaceId);
    if (!data || data.saving || !this.themeActions || !data.themes.some(theme => theme.name === name && !theme.unavailable)) return;
    try {this.themeActions.apply(name);} catch {/* a theme that cannot apply leaves the palette as it was */}
  }
  /** Saves the chosen theme and closes (back to /settings when it was opened from there). A failure keeps the page open with the reason. */
  async chooseTheme(surfaceId: string, name: string): Promise<void> {
    const data = this.themeOpen(surfaceId), actions = this.themeActions, state = this.state;
    if (!data || !state || data.saving || !actions || !data.themes.some(theme => theme.name === name && !theme.unavailable)) return;
    const patch = (fields: Partial<ThemePageData>) => this.publish(state.kind === 'settings' ? {...state, theme: {...data, ...fields}} : {...state, ...fields} as CommandSurface);
    patch({saving: true, error: ''});
    try {await actions.save(name);}
    catch (error) {
      if (this.themeOpen(surfaceId)) patch({saving: false, error: error instanceof Error ? error.message : 'Save failed'});
      return;
    }
    this.themeSnapshot = undefined;
    const current = this.state;
    if (current?.id !== surfaceId) return;
    if (current.kind === 'settings') {
      const {theme: _theme, ...rest} = current;
      this.themeActions = undefined;
      this.publish({...rest, pages: current.pages.map(page => page.id === 'theme' ? {...page, value: name} : page)});
    } else {
      this.dismiss();
      this.onDone({message: 'Theme set to ' + name, presentation: 'status'}, this.completion(current, true));
    }
  }
  /** Opens /ensemble; the page is read-only and reports edits and model changes through `actions`. */
  openEnsemble(data: import('../runtime/ensemble-view.js').EnsembleData, actions: EnsembleActions): void {
    this.assertIdle();
    this.ensembleActions = actions;
    this.publish({id: randomUUID(), kind: 'ensemble', title: 'Ensemble', data, ...this.origin?.()});
  }
  /** Leaves the page and opens the model picker of one actor. */
  async ensembleModel(surfaceId: string, actorId: string): Promise<void> {
    const state = this.state, actions = this.ensembleActions;
    if (state?.kind !== 'ensemble' || state.id !== surfaceId || !actions) return;
    this.dismiss();
    await actions.model(actorId);
  }
  /** Opens one file in the external editor; resolves with the notice to show. */
  async ensembleEdit(surfaceId: string, path: string): Promise<{readonly ok: boolean; readonly message: string}> {
    const state = this.state, actions = this.ensembleActions;
    if (state?.kind !== 'ensemble' || state.id !== surfaceId || !actions) return {ok: false, message: 'The page is closed.'};
    return actions.edit(path);
  }
  /** Live preview of one draft; failures are the page's own concern, not an error state. */
  previewSetting(surfaceId: string, key: string, value: string | number | boolean): void {
    if (this.state?.kind === 'settings' && this.state.id === surfaceId) this.settingsActions?.preview?.(key, value);
  }
  /** Saves the changed drafts. Success closes the page with a `Settings saved` receipt; a failure keeps the page, the drafts and the error. */
  async saveSettings(surfaceId: string, changes: Readonly<Record<string, string | number | boolean>>): Promise<void> {
    const state = this.state, actions = this.settingsActions;
    if (state?.kind !== 'settings' || state.id !== surfaceId || state.saving || !actions) return;
    this.publish({...state, saving: true, error: ""});
    let outcome: Awaited<ReturnType<SettingsActions['save']>>;
    try {outcome = await actions.save(immutable({...changes}));}
    catch (error) {outcome = {saved: {}, error: error instanceof Error ? error.message : 'Save failed'};}
    const current = this.state;
    if (current?.kind !== 'settings' || current.id !== surfaceId) return;
    if (outcome.error) {
      this.publish({...current, saving: false, error: outcome.error, items: current.items.map(item => Object.hasOwn(outcome.saved, item.key) ? {...item, value: outcome.saved[item.key]!} : item)});
      this.onDone({message: outcome.error, kind: 'command_error', presentation: 'status'}, this.completion(state, true));
      return;
    }
    this.dismiss();
    this.onDone({message: 'Settings saved', presentation: 'status'}, this.completion(state, true));
  }
  /** Opens the sub-page behind a `Pages` row over /settings (drafts stay in the page). */
  openSettingsPage(surfaceId: string, pageId: string): void {
    const state = this.state, actions = this.settingsActions;
    if (state?.kind !== 'settings' || state.id !== surfaceId || state.saving || state.sub || state.theme || !actions) return;
    if (pageId === 'theme') {
      const theme = actions.openTheme?.();
      if (!theme) return;
      this.beginTheme(theme.actions);
      this.publish({...state, error: "", theme: theme.data});
      return;
    }
    const opened = actions.openPage(pageId);
    if (!opened) return;
    this.subActions = opened.actions;
    this.publish({...state, error: "", sub: {id: pageId, title: opened.title, tabs: opened.tabs, initialTab: opened.initialTab}});
  }
  closeSettingsPage(surfaceId: string): void {
    const state = this.state;
    if (state?.kind === 'settings' && state.id === surfaceId && state.sub && !state.sub.saving) this.leavePage();
  }
  async openPicker(spec: PickerSpec, load: (signal: AbortSignal) => Promise<{items: readonly PickerItem[]; warning?: string}>,
    select: (id: string, effort?: string) => CommandResult | Promise<CommandResult>, actions?: PickerActions, back?: () => void | Promise<void>): Promise<void> {
    this.assertIdle();
    const id = randomUUID(), controller = new AbortController();
    this.controller = controller; this.select = select; this.pickerActions = actions; this.pickerBack = back;
    const initialItems = spec.items ?? [];
    this.publish({id, kind: 'picker', ...spec, ...this.origin?.(), items: initialItems, status: initialItems.length ? 'ready' : 'loading', error: '', ...(actions ? {deleteLabel: actions.deleteLabel} : {})});
    try {
      const result = await load(controller.signal);
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, items: result.items, status: 'ready', error: result.warning ?? ''});
    } catch (error) {
      if (this.state?.id === id && this.state.kind === 'picker' && !controller.signal.aborted)
        this.publish({...this.state, status: 'ready', error: error instanceof Error ? error.message : 'Query failed'});
    }
  }
  async replacePicker(...args: Parameters<CommandSurfaces['openPicker']>): Promise<void> {
    this.dismiss(); await this.openPicker(...args);
  }
  async deleteItem(surfaceId: string, itemId: string): Promise<void> {
    const state = this.state, actions = this.pickerActions;
    if (state?.kind !== 'picker' || state.id !== surfaceId || state.status !== 'ready' || !actions) return;
    if (!state.items.some(item => item.id === itemId && item.deletable)) return;
    this.publish({...state, status: 'saving', error: ''});
    try {await actions.onDelete(itemId); if (this.state?.id === surfaceId) this.publish({...state, status: 'ready'});}
    catch (error) {if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : 'Delete failed'});}
  }
  async choose(surfaceId: string, itemId: string, effort?: string): Promise<void> {
    const state = this.state;
    if (!state || state.kind !== 'picker' || state.id !== surfaceId || state.status !== 'ready' || !this.select) return;
    const item = state.items.find(item => item.id === itemId);
    if (!item || item.disabled) return;
    const select = this.select;
    this.publish({...state, status: 'saving', error: ''});
    try {
      const result = await select(itemId, effort);
      if (this.state?.id === surfaceId) {this.dismiss(); this.onDone(result, this.completion(state, true));}
    } catch (error) {
      if (this.state?.id === surfaceId) this.publish({...state, error: error instanceof Error ? error.message : 'Operation failed'});
    }
  }
  cancel(): void {
    const state = this.state;
    if (state?.kind === 'theme') {
      if (!state.saving) this.dismiss();
      return;
    }
    if (state?.kind === 'settings') {
      if (state.saving) return;
      if (state.theme) {
        if (state.theme.saving) return;
        const {theme: _theme, ...rest} = state;
        this.restoreTheme(); this.publish(rest);
        return;
      }
      if (state.sub) {if (!state.sub.saving) this.leavePage(); return;}
      this.settingsActions?.revert?.();
      this.dismiss(); return;
    }
    // A list or page opened from another page goes back one level before it closes.
    const back = state?.kind === 'picker' && state.status !== 'saving' ? this.pickerBack : state?.kind === 'page' && !state.saving ? this.pageActions?.onBack : undefined;
    if (back) {this.dismiss(); void Promise.resolve().then(back).catch(() => {}); return;}
    if (state?.kind === 'page' ? !state.saving : state?.kind !== 'picker' || state.status !== 'saving') this.dismiss();
  }
  private dismiss(): void {this.restoreTheme(); this.controller?.abort(); this.controller = undefined; this.select = undefined; this.pickerActions = undefined; this.pickerBack = undefined; this.pageActions = undefined; this.settingsActions = undefined; this.ensembleActions = undefined; this.subActions = undefined; this.publish(null);}
  close(): void {this.dismiss();}
}
