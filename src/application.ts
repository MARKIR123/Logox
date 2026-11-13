import {DIRECTOR_ID, isDirector} from './runtime/director-id.js';
import {reloadResources} from './resources/reload.js';
import {isOutageWake} from './runtime/outage.js';
import type {ResourceOptions} from './resources/manager.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import {ProjectExtensions, observeTasks, observeExtra} from './extensions/runtime.js';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {CommandSurfaces, type PageActions} from './commands/surfaces.js';
import type {CommandTab, PickerItem, SettingsItem} from './runtime/command-surface.js';
import {commandHelp, type CommandContext} from './commands.js';
import {dirname, join} from 'node:path';
import {appendFile, mkdir} from 'node:fs/promises';
import {turnUsageOf} from './context/cost.js';
import {z} from 'zod';
import {DynamicEnsemble} from './actors/ensemble.js';
import {ActorCatalog} from './actors/catalog.js';
import {ActorServices} from './actors/services.js';
import {steeredText} from './prompts/runtime/interruption.js';
import {TEXT_TOOL_CALL_NOTE} from './prompts/runtime/recovery.js';
import {roundScope, workingNames} from './runtime/round-scope.js';
import {DeliveryQueue} from './actors/delivery-queue.js';
import {planRestart, restartDependencies, restartStopped} from './actors/restart.js';
import {TaskModels, TaskModelLedger} from './actors/task-models.js';
import {loadConfig, themeSchema, type Config} from './config/config.js';
import {StateFile, preferenceSchema, effortSchema, type ThinkingEffort} from './config/model-preferences.js';
import {UiPreferences, uiSettings} from './config/ui-settings.js';
import {RoundNotifier} from './tui/terminal/notify.js';
import {terminalFocus} from './tui/terminal/focus.js';
import {settingDefinition, settingDefinitions, settingOptions, settingsPages, saveSettings, type SettingsEnv} from './config/settings-definitions.js';
import {modelsRows} from './commands/models-page.js';
import {shortcutRows} from './commands/shortcuts.js';
import {groupModelsForProvider, resolveActualModel, detectEffortLevels, type GroupedModel} from './config/model-grouping.js';
import {bindingChoices, type ChoiceModel} from './commands/model-choices.js';
import {UsageLedger, usageRows} from './context/usage.js';
import {row, rowText, tabContent} from './commands/tab-rows.js';
import {ContextManager} from './context/manager.js';
import {createAgent, agentRequestBase, type AgentAssembly} from './kernel/agent.js';
import {CacheKeeper} from './kernel/cache-keepalive.js';
import {cacheLifetimeMs, roleCacheRetention} from './providers/cache.js';
import {certainToWake, openWork} from './actors/facts.js';
import {asksFor} from './runtime/asks.js';
import {FALLBACK_CAPABILITIES} from './providers/capabilities.js';
import {getScratchpadDir, ensureScratchpadDir, getActorScratchpadDir, ensureActorScratchpadDir} from './kernel/scratchpad.js';
import {ProviderRegistry} from './providers/registry.js';
import {LoginFlow} from './providers/login.js';
import {askPreferredName, runLoginWizard, type WizardProviderRow} from './providers/login-wizard.js';
import {presets} from './config/config.js';
import {loadUserName, saveUserName, sanitizeUserName, setUserLabel, USER_NAME_MAX_CELLS} from './config/user-profile.js';
import {
  readOnboardingPrefs,
  markOnboardingDone,
  markOnboardingSkipped,
  shouldOfferOnboarding,
  ONBOARDING_VERSION,
} from './config/onboarding-preferences.js';
import {ModelPool} from './providers/model-pool.js';
import {ensureProjectBulletin} from './actors/bulletin.js';
import {RuntimeStore} from './runtime/store.js';
import {settleStep} from './runtime/contracts.js';
import {Journal} from './store/journal.js';
import {inputKind} from './runtime/provenance.js';
import {submitDeliverySchema, type SubmitDelivery} from './runtime/delivery.js';
export type {SubmitDelivery} from './runtime/delivery.js';
import {PermissionEngine, permissionDecisionSchema, permissionModeSchema, permissionScopeSchema} from './permissions/engine.js';
import {validateRuleInput} from './permissions/rule-input.js';
import {permissionModes} from './runtime/permission-mode.js';
import {Tools} from './tools/tools.js';
import {USER_STOP_REASON, killActiveProcess, killActivityProcesses, killBackgroundJobs} from './tools/process.js';
import {markInterruptedJobs} from './tools/orchestration/AutomaTool/AutomaTool.js';
import {chooseAutomaModel} from './tools/orchestration/AutomaTool/preset.js';
import {createManagedApplication} from './application-sessions.js';
import type {Provider} from './runtime/messages.js';
import {SystemHistory} from './store/system-history.js';
import {StatusbarPreferences} from './config/statusbar-preferences.js';
import {actorUsage, stageStatus} from './application-status.js';
import {buildEnsemble} from './commands/ensemble-model.js';
import {openInEditor} from './commands/editor.js';
import {sessionLanguage} from './context/language.js';
import {EnvironmentState, environmentVersion, formatEnvironment} from './context/environment.js';
import {createRuntimeContextMessage, type RuntimeContextMessage} from './runtime/context-updates.js';
import {planToolCatalog} from './tools/discovery.js';
import {ToolRegistry} from './tools/registry.js';
import type {ToolRegistration} from './tools/catalog.js';
import {storedMessage} from './store/journal.js';
import {PENDING_HANDOFF_HEADER, REVOCATION_RESTRICTION, TOOLS_RESTRICTED_RESULT} from './prompts/runtime/environment.js';
import {applyTheme, palette} from './tui/appearance/theme.js';
import type {ResultLine, TabLine} from './runtime/command-surface.js';
import {GitStatusSource} from './extensions/git-status.js';
import {createCommandTabsFor, type ApplicationCommandContext} from './application-commands.js';
import {applyThemePreset, applyCursorStyle, DEFAULT_THEME, listThemes, loadThemePresets, resolveTheme, type CursorStyleName} from './config/theme-presets.js';

export interface ApplicationOptions {
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  config?: Config;
  provider?: Provider;
  /** Test hook: Director wake delays while a provider is down (default 30 s, 2 min, 5 min). */
  outageDelaysMs?: readonly number[];
  fetcher?: typeof fetch;
  authPath?: string;
  env?: NodeJS.ProcessEnv;
  resourceOptions?: ResourceOptions;
  extensions?: ProjectExtensions;
  approveExtension?: ExtensionApproval;
  statusbarPath?: string;
}
export interface SessionApplicationOptions extends ApplicationOptions {
  sessionId: string;
  config: Config;
  registry: ProviderRegistry;
  preferences: StateFile<z.infer<typeof preferenceSchema>>;
  permissions: PermissionEngine;
  tools: Tools;
  usage: UsageLedger;
  extensions: ProjectExtensions;
  actors: ActorCatalog;
  sessionCommand(text: string): Promise<boolean>;
  beforeTask(): Promise<void>;
  isPersistent(): boolean;
}
export async function createSessionApplication(options: SessionApplicationOptions) {
  const {cwd, config, registry, preferences, permissions, tools, usage, extensions, actors} = options;
  if (config?.theme) applyTheme(config.theme);
  const state = join(cwd, '.logox', 'state'), session = options.sessionId;
  let settings = registry.selection();
  const modelCandidates = new Map<string, readonly string[]>();
  const commands = new AbortController();
  const store = new RuntimeStore(), journal = new Journal(join(state, 'sessions'));
  const deliveries = new DeliveryQueue(session, journal);
  const resources = extensions.resources;
  const systems = new SystemHistory(session, store, journal, options.isPersistent);
  const statusbar = new StatusbarPreferences(options.statusbarPath ?? join(options.resourceOptions?.home ?? homedir(), '.logox', 'statusbar.json'));
  let commandOwner = DIRECTOR_ID;
  let loginOwner = DIRECTOR_ID;
  const notice = (text: string, kind: Parameters<SystemHistory['emit']>[1] = 'command_result', owner = commandOwner, activityId?: string,
    display: NonNullable<Parameters<SystemHistory['emit']>[5]> = {}) => {
    const presentation = display.presentation ?? 'timeline';
    systems.emit(text, kind, owner, activityId, true, {...display, presentation});
    extensions.hooks.emit('notification', {session_id: session});
  };
  const receipt = (text: string, presentation: 'silent' | 'status' | 'panel', title?: string, owner = commandOwner) => {
    notice(text, 'command_result', owner, undefined, {presentation, ...(title ? {title} : {})});
    if (presentation === 'panel') surfaces.openResult(title ?? 'Command result', text, {sessionId: session, ownerId: owner});
  };
  const queryResult = async (owner: string, title: string, query: () => Promise<string | {text: string; lines: readonly ResultLine[]} | undefined>) => {
    const id = surfaces.openResult(title, 'Loading...', {sessionId: session, ownerId: owner});
    try {
      const result = await query();
      if (closed) return;
      if (result === undefined) {if (surfaces.getSnapshot()?.id === id) surfaces.cancel(); return;}
      const text = typeof result === 'string' ? result : result.text;
      notice(text, 'command_result', owner, undefined, {presentation: 'panel', title});
      surfaces.updateResult(id, text, typeof result === 'string' ? undefined : result.lines);
    } catch (error) {
      if (surfaces.getSnapshot()?.id === id) surfaces.cancel();
      throw error;
    }
  };
  await systems.restore();
  try {await statusbar.load();} catch (error) {notice(error instanceof Error ? error.message : 'Could not read statusbar preferences; using default layout.', 'command_error');}
  const scratchpad = getScratchpadDir(cwd, session);
  void ensureScratchpadDir(cwd, session);
  permissions.setScratchpadDir(scratchpad);
  const environment = new EnvironmentState();
  const directorReports = new Map<string, string>();
  let closed = false;
  let compactTask: {activityId: string; controller: AbortController; done: Promise<void>} | undefined;
  let reloadTask: Promise<void> | undefined;
  let permissionTask: Promise<void> | undefined;
  const homeDir = options.resourceOptions?.home ?? homedir();
  // The preferred name is application-owned; the timeline label is synced from it (renderers read the live label).
  let userName: string | undefined;
  setUserLabel(undefined);
  const profileReady = loadUserName(homeDir).then(name => {userName = name; setUserLabel(name);});
  const toolRegistry = new ToolRegistry(cwd, homeDir);
  await toolRegistry.reloadUserConfigs();
  tools.setRegistry(toolRegistry);
  tools.setActivityProbe(() => store.getSnapshot().activities);
  const modelPool = new ModelPool(registry, join(homeDir, '.logox', 'models-store.json'));
  void modelPool.loadCache().catch(() => {});
  const taskModelLedger = new TaskModelLedger(join(state, 'task-models'));
  const taskModels = new TaskModels({registry, ledger: taskModelLedger,
    defaultModel: owner => actors.modelStorage.get(owner) ?? actors.find(owner)?.defaultModel,
    defaultFallbackModel: () => {
      const active = registry.selection();
      if (active && registry.names().includes(active.provider)) return {provider: active.provider, model: active.model};
      return undefined;
    },
    provider: (_selection, provider) => options.provider ?? provider,
    checkpoint: async state => {
      const activity = store.activities.get(session, state.activityId);
      if (activity && !['completed', 'failed', 'cancelled'].includes(activity.status)) store.activities.update(session, state.activityId,
        {taskModel: {initial: state.initial, actual: state.actual, inherited: state.inherited, switched: state.switched, phase: state.phase}});
    },
    summaryModel: identity => {
      const policy = actorServices.policy(identity.ownerId);
      if (!policy.summary_provider && !policy.summary_model) return undefined;
      return {provider: policy.summary_provider ?? taskModels.selection(identity).provider,
        model: policy.summary_model ?? taskModels.selection(identity).model};
    },
  });
  void ensureProjectBulletin(cwd);
  const actorServices = new ActorServices({sessionId: session, catalog: actors, registry, resources, journal, config, deliveries, toolRegistry,
    notice: text => notice(text, 'task_notice', DIRECTOR_ID),
    ...(options.outageDelaysMs ? {outageDelaysMs: options.outageDelaysMs} : {}),
    outageNotice: (text, first) => notice(text, 'task_notice', DIRECTOR_ID, undefined, {presentation: first ? 'timeline' : 'status'}),
    requireIdle: () => requireIdle(),
    enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    getActiveTask: (owner) => ensemble.getActiveTask(owner),
    canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    injectMessage: (target, msg, src, sum, mode) => ensemble.injectTaskMessage(target, msg, src, sum, mode),
    interrupt: (target, message, source, summary) => ensemble.interruptTask(target, message, source, summary),
    recordPeerMessage: (target, activityId, text, source) => {
      store.message(session, target, 'user', text, {activityId, source, inputKind: 'collaboration'});
    },
    cancelTool: (actorId, toolId, reason) => ensemble.cancelTool(actorId, toolId, reason),
    cancelActor: (actorId, scope, toolId, reason) => ensemble.cancelActor(actorId, scope, toolId, reason),
    cancelActivity: (activityId, reason) => ensemble.cancel(activityId, 'director_cancel', reason),
    getSnapshot: () => store.getSnapshot(),
    projectDir: cwd,
    pauseBatch: batch => ensemble.pauseBatch(batch),
    resumeBatch: batch => ensemble.resumeBatch(batch),
    coordinationPath: join(state, 'actor-coordination', createHash('sha256').update(session).digest('hex') + '.json'),
    approve: (context, review) => tools.permissionGuard(context).authorize({tool: 'craft_actor', paths: [review.path], risky: false, effect: 'write'},
      {path: review.path, content: review.content, previous: review.previous ?? null}, context),
    authorize: (call, context) => tools.authorizeExtension(call, context, 'read'),
    modelResolver: (actorId: string) => {
      const identity = {sessionId: session, ownerId: actorId};
      const configured = (isDirector(actorId) ? undefined : actors.modelStorage.get(actorId) ?? actors.find(actorId)?.defaultModel) ?? registry.selection();
      try {
        const sel = taskModels.selection(identity);
        const th = taskModels.thinking(identity);
        return {provider: sel.provider, model: sel.model, effort: th.effort, levels: th.levels};
      } catch {
        // Display remains available before model selection or when a provider is unavailable.
        return configured.model.trim() ? {provider: configured.provider, model: configured.model} : undefined;
      }
    },
    modelPool,
  });
  const contexts = new ContextManager({journal, pricing: config,
    cacheLifetimeMs: identity => {
      const selection = taskModels.selection(identity), actor = actors.find(identity.ownerId);
      return cacheLifetimeMs(registry.configuredSettings(selection.provider, selection.model),
        {cacheRetention: {role: roleCacheRetention(identity.ownerId), ...(actor?.cacheRetention ? {actor: actor.cacheRetention} : {})}});
    }, policy: identity => actorServices.policy(identity.ownerId), maxOutput: config.provider.max_tokens,
    model: identity => taskModels.model(identity), summarizer: identity => taskModels.summarizer(identity),
    contract: identity => actorServices.contract(identity.ownerId),
    anchors: async identity => isDirector(identity.ownerId)
      ? (await journal.activeTasks(session)).filter(task => task.source === 'direct' && !isDirector(task.ownerId) &&
          ['completed', 'failed', 'cancelled'].includes(task.status)).slice(-16).map(task => ({role: 'user',
          text: `[Direct conversation] ${task.ownerId} (${task.activityId}) · ${task.status}. Use ReadActor for details if needed.`})) : [],
    report: (identity, text) => notice(text, 'task_notice', identity.ownerId, identity.activityId),
    beforeCompact: (identity, tokens) => extensions.hooks.emit('pre_compact', {session_id: identity.sessionId, owner_id: identity.ownerId, tokens}),
    // The activity phase is what the timeline reads for `Compacting context`; the next model round restores its own phase.
    compacting: (identity, active) => {
      const current = identity.activityId ? store.activities.get(identity.sessionId, identity.activityId) : undefined;
      if (!current || !['running', 'waiting_input'].includes(current.status)) return;
      if (active) store.activities.update(identity.sessionId, current.activityId, {phase: 'compacting'});
      else if (current.phase === 'compacting') store.activities.update(identity.sessionId, current.activityId, {phase: 'model'});
    },
  });
  const surfaces = new CommandSurfaces((result, completion) => {
    if (result.message && !closed) notice(result.message, result.kind ?? 'command_result', completion.ownerId ?? commandOwner, undefined,
      // A dismissed surface cannot show feedback: its late failure surfaces in the timeline, its late success stays silent.
      {presentation: !completion.active ? result.kind === 'command_error' ? 'timeline' : 'silent' : result.presentation ?? 'status',
        ...(result.title ? {title: result.title} : {})});
  }, () => ({sessionId: session, ownerId: commandOwner}));
  let surfaceError = '';
  const stopSurfaceErrors = surfaces.subscribe(() => {
    const current = surfaces.getSnapshot();
    const error = current && 'error' in current ? current.error : undefined;
    const key = error ? current!.id + ':' + error : '';
    const changed = Boolean(error && key !== surfaceError);
    // Recording the event refreshes the page synchronously; latch before publishing.
    surfaceError = key;
    if (error && changed) notice(error, 'command_error', current?.ownerId ?? commandOwner, undefined, {presentation: 'silent'});
  });
  const authentication = new LoginFlow(registry.auth, async provider => {
    const owner = loginOwner;
    // A saved key or finished account sign-in always belongs to a provider record.
    await registry.ensureTemplateRecord(provider).catch(() => {});
    try {await saveSelection(registry.candidate(provider));}
    catch {notice('API key saved; model preference was not updated. The current model is unchanged.', 'command_error', owner);}
    await modelPool.syncProvider(provider).catch(() => {});
    receipt('API key saved for ' + provider + '.', 'status', undefined, owner);
  }, (input, init) => registry.fetcher(input, init));
  /** Who relies on a model of one provider: the session selection, actor default models and the dedicated Automa model. */
  const providerUsers = (name: string): {session: boolean; actors: string[]; automa: boolean} => ({
    session: settings.provider === name && Boolean(settings.model),
    actors: actors.list().filter(actor => !isDirector(actor.id) && actor.defaultModel?.provider === name).map(actor => actor.id),
    automa: tools.modelStorage.get('automa')?.provider === name,
  });
  const usersLabel = (users: ReturnType<typeof providerUsers>): string[] =>
    [...users.session ? ['session'] : [], ...users.actors, ...users.automa ? ['automa'] : []];
  /**
   * Deletes a provider and everything bound to it. Bindings are cleared, never rewritten to another model: actors and Automa then use the session model,
   * and a session model on the removed provider becomes "no model selected". One notice says what was cleared and what the user has to choose.
   */
  const removeProvider = async (name: string, owner: string): Promise<void> => {
    const users = providerUsers(name), unresolved: string[] = [], cleared: string[] = [];
    await registry.unregister(name);
    modelPool.forget(name);
    await modelPool.saveCache().catch(() => {});
    for (const id of users.actors) {
      try {await actorServices.management.saveDefaultModel(id, undefined, commands.signal); cleared.push(id);}
      catch {unresolved.push(id);}
    }
    if (users.automa) {
      try {await tools.modelStorage.save('automa', undefined, commands.signal);}
      catch {unresolved.push('automa');}
    }
    const lines: string[] = [];
    if (cleared.length) lines.push('Cleared the model of ' + cleared.join(', ') + '. They use the session model until you choose one with /model <actor>.');
    if (users.automa && !unresolved.includes('automa')) lines.push('Cleared the dedicated Automa model; workers use the session model.');
    if (unresolved.length) lines.push('Could not clear the model of ' + unresolved.join(', ') + '; choose another one with /model <actor>.');
    if (users.session) {
      const gone = settings.provider + '/' + settings.model;
      try {await saveSelection(registry.candidate('openai', ''));}
      catch {lines.push('The session model ' + gone + ' is on this provider and could not be reset now. Choose a model with /model once tasks are idle.');}
      if (!settings.model) lines.push('The session model ' + gone + ' was on this provider; no model is selected now. Choose one with /model.');
    }
    if (lines.length) notice("Provider '" + name + "' removed.\n" + lines.join('\n'), 'command_result', owner);
  };
  /** The `/login` list in display order: every listed template, then the user's own providers, then bare credentials (listed so they can be removed). */
  const wizardRows = async (): Promise<WizardProviderRow[]> => {
    const env = options.env ?? process.env;
    const stored = await registry.auth.providers();
    const account = new Set<string>();
    for (const name of stored) if (presets[name]?.account && (await registry.auth.credential(name))?.type === 'oauth') account.add(name);
    const records = new Map((await registry.customStorage.list().catch(() => [])).map(record => [record.name, record]));
    const listed = new Set(registry.templateNames());
    const own = [...new Set([...registry.names(), ...stored])].filter(name => !listed.has(name) && (stored.includes(name) || records.has(name) || config.providers[name]));
    return [...listed, ...own].map((name): WizardProviderRow => {
      // A known endpoint that is not listed (a local proxy) is a plain custom provider here; only listed templates are built-in.
      const record = records.get(name), template = listed.has(name) ? presets[name] : undefined;
      const baseUrl = record?.base_url ?? config.providers[name]?.base_url ?? template?.base_url;
      const keyEnv = config.providers[name]?.api_key_env ?? presets[name]?.api_key_env;
      const local = baseUrl !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
      return {
        name,
        custom: !template,
        saved: stored.includes(name) || Boolean(record) || Boolean(config.providers[name]),
        accountSignedIn: account.has(name),
        ...(template?.account ? {account: true} : {}),
        ...(template?.accountSibling ? {accountSibling: template.accountSibling} : {}),
        ...(template ? {description: template.description} : {}),
        ...(baseUrl ? {baseUrl} : {}),
        kind: record?.kind ?? config.providers[name]?.kind ?? template?.kind,
        api: record?.api ?? config.providers[name]?.api,
        ...(record?.models ? {models: record.models} : {}),
        ...(account.has(name) ? {state: 'account' as const}
          : stored.includes(name) ? {state: 'signed-in' as const}
          : keyEnv && env[keyEnv] ? {state: 'env-key' as const}
          : (record || config.providers[name]) && !keyEnv && local ? {state: 'local' as const} : {}),
      };
    });
  };
  /**
   * Local provider form: project wizard questions into the private UI form channel.
   * Questions are not attached to an activity, so they appear only in the bottom dock, not in the timeline or ledger.
   */
  const loginWizard = async (source: string, entry?: string) => {
    if (authentication.getSnapshot()) throw new Error('Authentication is in progress, please complete or cancel first');
    return runLoginWizard({
      ask: authentication.ask,
      askBatch: authentication.askBatch,
      discoverModels: async (record, key) => {
        // A provider the registry already knows, edited without a new key, is listed the way the model picker lists it (stored credential, offline fallbacks).
        const known = registry.names().includes(record.name) ? registry.candidate(record.name).selection().baseUrl : undefined;
        if (!key && known?.replace(/\/$/, '') === record.base_url.replace(/\/$/, '')) return registry.availableModels(record.name, AbortSignal.timeout(5000), false);
        key ??= (await registry.candidate(record.name).settings(false)).key;
        const url = record.base_url.replace(/\/$/, '') + '/models';
        const headers: Record<string, string> = record.kind === 'anthropic'
          ? {'anthropic-version': '2023-06-01', ...(key ? {'x-api-key': key} : {})}
          : key ? {Authorization: 'Bearer ' + key} : {};
        const response = await registry.fetcher(url, {headers, signal: AbortSignal.timeout(5000), redirect: 'error'});
        if (!response.ok) throw new Error('Model discovery failed.');
        const payload = z.object({data: z.array(z.object({id: z.string().min(1)}))}).parse(await response.json());
        return payload.data.map(item => item.id);
      },
      notify: (text, level) => level === 'error' ? notice(text, 'command_error', source) : receipt(text, 'status', undefined, source),
      rows: wizardRows,
      commitProvider: async (record, key) => {
        const previous = await registry.customStorage.get(record.name);
        const credential = await registry.auth.credential(record.name);
        try {
          if (key) await registry.auth.save(record.name, key, commands.signal);
          await registry.customStorage.save({...previous, ...record, api: record.api});
        } catch (error) {
          if (key) {
            if (!credential) await registry.auth.remove(record.name);
            else if (credential.type === 'api_key') await registry.auth.save(record.name, credential.key, new AbortController().signal);
            else await registry.auth.saveOAuth(record.name, credential, new AbortController().signal);
          }
          throw error;
        }
        await registry.syncCustom();
        await syncCredential(record.name, source, record.models?.[0]);
      },
      saveKey: async (name, key) => {
        await registry.auth.save(name, key, commands.signal);
        await registry.ensureTemplateRecord(name);
        await syncCredential(name, source);
      },
      saveCustom: async record => {
        const previous = await registry.customStorage.get(record.name);
        await registry.customStorage.save({...previous, ...record, api: record.api});
        await registry.syncCustom().catch(() => {});
        await syncCredential(record.name, source, record.models?.[0]);
      },
      users: async name => usersLabel(providerUsers(name)),
      removeCustom: name => removeProvider(name, source),
      signOut: async name => {await registry.auth.remove(name);},
      browserLogin: async name => presets[name]?.account ? authentication.browserLogin(name) : 'unsupported',
    }, entry);
  };
  const syncCredential = async (name: string, owner: string, defaultModel?: string) => {
    try {await saveSelection(registry.candidate(name, defaultModel));}
    catch {notice('Credential saved; model preference was not updated.', 'command_error', owner);}
    await modelPool.syncProvider(name).catch(() => {});
  };
  let loginError = '';
  const stopLoginErrors = authentication.subscribe(() => {
    refreshSubscriptions();
    const current = authentication.getSnapshot();
    const key = current?.error ? current.provider + ':' + current.error : '';
    const changed = Boolean(current?.error && key !== loginError);
    loginError = key;
    if (current?.error && changed) notice(current.error, 'command_error', loginOwner, undefined, {presentation: 'silent'});
  });
  const extraTools = [...actorServices.definitionsForValidation(), ...extensions.mcp.definitions()];
  // Status revision: anything that changes the footer without touching the store or statusbar preferences bumps it.
  let statusTick = 0;
  const statusListeners = new Set<() => void>();
  const bumpStatus = () => {statusTick++; for (const listener of [...statusListeners]) listener();};
  const gitStatus = new GitStatusSource(cwd, bumpStatus);
  // The git module is off by default: only spawn git once the user enables it.
  const gitEnabled = () => statusbar.getSnapshot().modules.some(module => module.id === 'git' && module.enabled);
  let gitStarted = false;
  const startGit = () => {if (!gitStarted && gitEnabled()) {gitStarted = true; gitStatus.start();}};
  startGit();
  const stopGitWatch = statusbar.subscribe(startGit);
  const subscriptionProviders = new Set<string>();
  let subscriptionsDone: Promise<void> = Promise.resolve();
  const refreshSubscriptions = () => {subscriptionsDone = (async () => {
    const found = new Set<string>();
    for (const name of await registry.auth.providers()) if ((await registry.auth.credential(name))?.type === 'oauth') found.add(name);
    subscriptionProviders.clear(); for (const name of found) subscriptionProviders.add(name);
    bumpStatus();
  })().catch(() => {});};
  refreshSubscriptions();
  const meterReady = new Map<string, Promise<void>>();
  /** Restores one owner's persisted usage into its meter exactly once, however many callers race. */
  function configureMeter(ownerId: string): Promise<void> {
    let ready = meterReady.get(ownerId);
    if (!ready) {
      ready = (async () => {
        const meter = contexts.meter({sessionId: session, ownerId});
        meter.configureUsage(() => taskModels.summarizer({sessionId: session, ownerId}).model.identity,
          record => {
            usage.record(session, ownerId, record); bumpStatus();
            // Automa turns are stored on their automa.jsonl events; summary and approval calls get an append-only session-level line.
            if (record.category === 'summary' || record.category === 'approval' || record.category === 'keepalive') {
              const turn = turnUsageOf(record, record.model, config);
              if (turn) {
                const file = join(state, 'sessions', session, 'usage.jsonl');
                void mkdir(dirname(file), {recursive: true}).then(() => appendFile(file, JSON.stringify({version: 1, time: Date.now(), ownerId, category: record.category, usage: turn}) + String.fromCharCode(10))).catch(() => {});
              }
            }
          }, await usage.read(session, ownerId));
        bumpStatus();
      })();
      meterReady.set(ownerId, ready);
    }
    return ready;
  }
  // A resumed session shows its totals and context readings before any actor runs.
  const meterRestore = Promise.all([DIRECTOR_ID, ...actors.list().map(item => item.id)].map(async ownerId => {
    await configureMeter(ownerId);
    await contexts.restoreReading({sessionId: session, ownerId});
  })).then(bumpStatus).catch(() => {});
  const automaJournal = (sessionId: string) => join(state, 'sessions', sessionId, 'subagents', 'automa.jsonl');
  void markInterruptedJobs(automaJournal(session));
  tools.setAutomaEnvironment({
    resolveModel: preferred => {
      const session = registry.selection();
      const chosen = chooseAutomaModel({dedicated: tools.modelStorage.get('automa'), preferred, session, pool: modelPool.snapshot(),
        expand: name => modelPool.resolveShorthand(name, session.provider)});
      return {provider: registry.candidate(chosen.provider, chosen.model).provider(), model: chosen.provider + '/' + chosen.model};
    },
    profile: ownerId => actors.find(ownerId)?.automa,
    actorName: ownerId => actors.find(ownerId)?.name,
    maxParallel: () => config.automa.max_parallel,
    journalPath: automaJournal,
    charge: (context, amount, model) => {void configureMeter(context.ownerId).then(() => contexts.meter(context).chargeUsage(amount, model, 'automa'));},
    priceUsage: (amount, model) => turnUsageOf(amount, model, config),
  });
  // Replays an idle actor's last request just before its short cache expires, only while a wake-up is certain (never while the human is awaited).
  const keepAlive = new CacheKeeper({
    enabled: () => config.kernel.cache_keepalive, pricing: config,
    certain: who => {
      const snapshot = store.getSnapshot();
      if (isDirector(who.ownerId)) return certainToWake(openWork(snapshot, who.rootActivityId ?? who.activityId, deliveries.snapshot()));
      const asks = asksFor(store);
      return asks.isParked(who.sessionId, who.ownerId) && asks.awaited(who.activityId).some(ask => !ask.ended &&
        (isDirector(ask.to) || snapshot.activities.some(item => item.sessionId === who.sessionId && item.ownerId === ask.to && ['queued', 'running'].includes(item.status))));
    },
    charge: (who, amount, model) => {void configureMeter(who.ownerId).then(() => contexts.meter(who).chargeUsage(amount, model, 'keepalive'));},
  });
  const dumpRequests = process.env.LOGOX_DUMP_REQUESTS === '1';
  const requestBase = async (context: Parameters<ReturnType<typeof createAgent>>[1],
    assembly: AgentAssembly = {capabilities: FALLBACK_CAPABILITIES, history: []}) => {
    await configureMeter(context.ownerId);
    await profileReady;
    const role = actorServices.definition(context);
    const model = taskModels.selection(context), thinking = taskModels.thinking(context);
    const policy = actorServices.skills(context);
    const actorScratchpad = getActorScratchpadDir(cwd, context.sessionId, context.ownerId);
    void ensureActorScratchpadDir(cwd, context.sessionId, context.ownerId);
    const permissionRules = permissions.snapshot().map(rule => rule.decision + ' ' + rule.tool + ' ' + rule.pattern).join(', ') || 'none';
    const history = (await journal.load(context.sessionId, context.ownerId)).map(storedMessage);
    const language = sessionLanguage(store.getSnapshot().messages
      .filter(message => message.role === 'user' && message.inputKind === 'human').map(message => message.text));
    const effective = environment.plan({model: model.provider + '/' + model.model,
      effort: thinking.levels.length > 1 ? thinking.effort : 'unsupported', permission: permissions.mode + ' · ' +
        permissionModes[permissions.mode].description +
        '\nExplicit rules (still adjudicated per call): ' + permissionRules,
      directory: cwd, scratchpad: actorScratchpad,
      rules: environmentVersion(resources.prompt(policy).context), services: extensions.mcp.status().map(service => service.name + ':' + service.state).sort(),
      ...(language ? {language} : {}), ...(userName ? {userName} : {})}, history);
    const extensionRegistrations: ToolRegistration[] = extensions.mcp.definitions().map(definition => ({definition,
      metadata: {name: definition.name, category: 'extensions', roles: 'all', terminalVisibility: 'card', description: 'Discover and call configured MCP services'}}));
    const base = await agentRequestBase(cwd, context.ownerId, extensionRegistrations,
      resources, {prompt: role.prompt, execution: role.execution, collaboration: role.collaboration,
        compression: role.compression, visibility: policy}, true, actorScratchpad, formatEnvironment(effective.baseline), toolRegistry, {...assembly, history});
    const contextUpdates: RuntimeContextMessage[] = [...effective.updates, ...base.contextUpdates ?? []];
    const restriction = context.recovery?.exhausted && !context.recovery.key.startsWith('execution:') ? REVOCATION_RESTRICTION : '';
    const pending = directorReports.get(context.activityId);
    await actorServices.flush();
    const facts = actorServices.facts(context);
    for (const [slot, text] of [['restriction', restriction], ['handoff', pending ? PENDING_HANDOFF_HEADER + '\n' + pending : '']] as const) {
      const previous = history.findLast(message => message.role === 'context' && message.kind === 'task-state' &&
        message.data?.slot === slot && message.data?.activityId === context.activityId);
      if (text || previous?.text) contextUpdates.push(createRuntimeContextMessage('task-state', text || 'No current ' + slot + '.', {slot, activityId: context.activityId}));
    }
    return {...base, contextUpdates, ...(restriction ? {refuseTools: TOOLS_RESTRICTED_RESULT} : {}), ...(facts ? {snapshot: facts} : {}), ...(role.cacheRetention ? {cacheRetention: role.cacheRetention} : {})};
  };
  const ensemble = new DynamicEnsemble(session, store, journal, observeTasks(extensions.hooks, createAgent({
    cwd, store, tools, context: contexts, taskModels, requestBase, provider: () => options.provider ?? registry.provider(), keepAlive,
    ...(dumpRequests ? {requestDumpDir: (context: {sessionId: string; ownerId: string}) => join(state, 'sessions', context.sessionId, 'requests', context.ownerId)} : {}),
    iterations: config.kernel.max_iterations, retries: config.kernel.max_retries, readonlyConcurrency: config.permissions.readonly_concurrency,
    supportsVision: () => true,
    retryProvider: async (context, error) => {
      // A Director wake that meets an outage waits on the outage backoff and never spends the root's recovery budget.
      if (context.coordinationWake) {notice('[Network] Connection interrupted. Retrying...', 'task_notice', context.ownerId, context.activityId); return true;}
      const recovery = await actorServices.recovery.next(context.rootActivityId ?? context.activityId, error, context.recovery);
      context.signal.throwIfAborted();
      if (recovery.exhausted) return false;
      const attemptText = `(${recovery.attempt}/${config.kernel.max_retries})`;
      notice(`[Network] Connection interrupted. Retrying ${attemptText}...`,
        'task_notice', context.ownerId, context.activityId);
      return true;
    },
    recoverExecution: (context, kind) => actorServices.recovery.execution(context.rootActivityId ?? context.activityId, kind, context.ownerId),
    executionProgress: (context, fingerprint) => actorServices.recovery.progress(context.rootActivityId ?? context.activityId, fingerprint),
    contextUpdated: (context, update) => {if (update.kind === 'environment-change') notice('Execution environment updated:\n' + update.text, 'environment_change', context.ownerId, context.activityId, {presentation: 'silent'});},
    executionNotice: (context, text) => {if (isDirector(context.ownerId)) notice(text, 'task_notice', context.ownerId, context.activityId);},
    resources, extraTools, extraApprovalHandled: extraTools.map(tool => tool.name),
    executeExtra: observeExtra(extensions.hooks, async (call, context) => {
      if (call.name === 'mcp') return extensions.mcp.execute(call, context);
      return actorServices.execute(call, context);
    }),
  })), {
    concurrency: 'actor', deliveries,
    member: owner => actors.find(owner),
    taskStart: async context => {
      if (context.inputKind !== 'human') return;
      await actorServices.grantExecution(context);
      context.signal.throwIfAborted();
      if (isDirector(context.ownerId)) {
        const pending = actorServices.resumeDirector(context.activityId);
        if (pending) directorReports.set(context.activityId, pending);
        await actorServices.flush();
      }
    },
    roundStart: async (context, info) => {await contexts.roundStart(context, await requestBase(context), context.signal, info);},
    handoff: result => closed ? Promise.resolve() : actorServices.handoff(result),
    directAnchor: async result => {
      const text = `Direct conversation with ${result.ownerId} (${result.activityId}) settled as ${result.status}. Use ReadActor for details if needed.`;
      notice(text, 'task_notice', DIRECTOR_ID);
    },
    settled: async (activityId, status) => {directorReports.delete(activityId); await actorServices.settled(activityId, status);},
  });
  const checkpoints = await journal.activeTasks(session);
  await actorServices.recover(new Set(checkpoints.map(task => task.activityId)));
  const owners = [...new Set([...actors.list().map(actor => actor.id), ...checkpoints.map(task => task.ownerId)])];
  const savedModels = (await taskModelLedger.load(session, new Set(checkpoints.map(task => task.activityId))))
    .map(model => ['started', 'confirming', 'ready'].includes(model.phase) ? {...model, phase: 'cancelled' as const} : model);
  taskModels.restore(savedModels);
  await actorServices.collaboration.recover();
  for (const ownerId of owners) {
    await configureMeter(ownerId);
  }
  let selecting = false;
  let selectionDone: Promise<void> | undefined;
  const busy = () => ensemble.isBusy() || !!compactTask || selecting || !!reloadTask || !!permissionTask;
  const requireIdle = () => {if (busy()) throw new Error('Tasks are running. Please wait for completion or cancel before switching models or providers.');};
  const saveSelection = async (next: ProviderRegistry) => {
    requireIdle(); selecting = true;
    selectionDone = (async () => {
      try {
        const selection = next.selection();
        const globalPref = new StateFile(join(homeDir, '.logox', 'model-preferences.json'), preferenceSchema);
        await globalPref.save({version: 1, provider: selection.provider, model: selection.model, effort: next.thinking().effort}).catch(() => {});
        await preferences.save({version: 1, provider: selection.provider, model: selection.model, effort: next.thinking().effort});
        registry.adopt(next); settings = registry.selection();
      } finally {selecting = false;}
    })();
    await selectionDone;
  };
  const saveEffort = async (effort: ThinkingEffort) => {
    const next = registry.candidate(settings.provider, settings.model);
    next.selectEffort(effort); await saveSelection(next);
  };
  const openThinking = () => {
    const thinking = registry.thinking();
    void surfaces.openPicker({title: 'Thinking Effort', description: 'Available effort tiers for current model; auto uses provider default', current: thinking.effort},
      async () => ({items: thinking.levels.map(id => ({id, label: id}))}), async id => {
        await saveEffort(effortSchema.parse(id)); return {message: 'Thinking effort: ' + id + ' (saved)', presentation: 'status'};
      });
  };
  let pageOwner = DIRECTOR_ID;
  let activeCommandPage = '';
  // Themes are data: shipped JSON plus any `~/.logox/themes/*.json` overlay.
  loadThemePresets(homeDir);
  const ui = new UiPreferences(homeDir);
  // A `[theme]` table that differs from stock wins over the default theme file;
  // an untouched table lets the shipped default take over.
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
  const contextRows = (): TabLine[] => {
    const identity = {sessionId: session, ownerId: pageOwner};
    const reading = contexts.status(identity), shown = status(pageOwner), usage = shown.usage;
    let window = 'Unknown, configure model context_window';
    try {window = String(taskModels.model(identity).window) + ' tokens';} catch {}
    const totals = (value: {input: number; output: number; cached: number} | undefined) =>
      value ? value.input + ' in / ' + value.output + ' out / ' + value.cached + ' cached' : 'none recorded';
    return [row.field('Model context window', window),
      ...(reading ? [row.field('Context in use', (reading.estimated ? '~' : '') + reading.input + ' tokens' + (reading.estimated ? ' (estimate)' : ' (provider-reported)') + (reading.input > reading.window ? ' · over the window' : '')),
        row.field('Compaction threshold', reading.high + ' tokens; target ' + reading.low + ' tokens'), row.field('Output limit', reading.output + ' tokens')]
        : [row.field('Context in use', 'No history yet')]),
      row.field('Tokens (this window)', totals(usage?.window)), row.field('Tokens (session, all windows)', totals(usage?.session)),
      row.muted('Input excludes cache reads; cached counts cache reads. Includes task, summary, approval and Automa usage.')];
  };
  const status = (ownerId: string) => stageStatus({sessionId: session, cwd, store, actors, registry, taskModels, contexts, permissions, config,
    subscriptions: () => subscriptionProviders, git: () => gitStatus.get()}, ownerId);
  const sessionUsageRecords = () => [...contexts.sessionMeters(session).values()].flatMap(meter => meter.usageRecords());
  let viewingProviderIndex = -1;
  const providerStatuses = new Map<string, string>();
  const providersTabRows = (): TabLine[] => {
    const names = registry.names();
    if (names.length === 0) {
      return [row.heading('Connected Providers'), row.rule(), row.text('No providers currently configured.'), row.blank(),
        row.text('Run /login to add an official provider or custom reverse proxy.')];
    }
    if (viewingProviderIndex < 0 || viewingProviderIndex >= names.length) {
      const activeIdx = names.indexOf(settings.provider);
      viewingProviderIndex = activeIdx >= 0 ? activeIdx : 0;
    }
    const current = names[viewingProviderIndex]!;
    const poolModels = modelPool.snapshot();
    const currentModels = poolModels.filter(m => m.provider === current);

    // Horizontal Provider Navigation
    const navItems = names.map((name, i) => {
      const count = poolModels.filter(m => m.provider === name).length;
      return i === viewingProviderIndex ? '❯ [ ' + name + ' (' + count + ') ]' : '  ' + name + ' (' + count + ')';
    }).join('    ');

    const candSettings = registry.candidate(current).selection();
    const statusText = providerStatuses.get(current) ?? '● Ready (press [t] to test)';

    const rows: TabLine[] = [
      row.text(navItems),
      row.rule(),
      row.field('Provider', current),
      row.field('Base URL', candSettings.baseUrl),
      row.field('Status', statusText),
      row.field('Models count', currentModels.length),
      row.blank(),
      row.rule('Models (' + currentModels.length + ')'),
    ];

    if (currentModels.length === 0) {
      rows.push(row.text('  No models cached. Press [r] to fetch models from provider.'));
    } else {
      for (const m of currentModels) {
        const win = m.window ? (Math.round(m.window / 1000) + 'k') : '128k';
        const eff = m.thinkingLevels && m.thinkingLevels.length > 0
          ? '✦ ' + m.thinkingLevels.filter((l: string) => l !== 'auto').join(' / ')
          : '-';
        const offlineTag = m.isOffline ? ' [offline]' : '';
        rows.push(row.bullet(m.id + offlineTag + ' · ' + win + ' · Thinking: ' + eff));
      }
    }
    return rows;
  };

  const buildAppCommandContext = (): ApplicationCommandContext => ({
    session,
    pageOwner,
    permissions: {
      mode: permissions.mode,
      description: permissionModes[permissions.mode].description,
      modes: Object.entries(permissionModes).map(([id, mode]) => ({id, description: mode.description})),
      color: palette[permissionModes[permissions.mode].colorToken],
      page: {
        mode: {current: permissions.mode, options: Object.entries(permissionModes).map(([id, mode]) => ({id, description: mode.description}))},
        rules: permissions.snapshot().map(rule => ({id: rule.id, scope: rule.scope, decision: rule.decision, tool: rule.tool, pattern: rule.pattern, hits: rule.hits ?? 0,
          ...rule.lastHit ? {lastHit: rule.lastHit} : {}})),
        stats: tools.permissionGuard({sessionId: session}).stats(),
        userScope: permissions.userScopeAvailable,
      },
      lines: [
        ...tools.permissionGuard({sessionId: session}).rows(),
        row.field('Readonly concurrency', config.permissions.readonly_concurrency),
        row.field('Cumulative approval tokens', sessionUsageRecords().filter(record => record.category === 'approval').reduce((sum, record) => sum + record.input + record.output, 0) + ' tokens'),
      ],
      readonly_concurrency: config.permissions.readonly_concurrency,
      approvalTokens: sessionUsageRecords().filter(record => record.category === 'approval').reduce((sum, record) => sum + record.input + record.output, 0),
    },
    statusbarModules: statusbar.getSnapshot().modules,
    statusbarAppearance: {style: statusbar.getSnapshot().style, colorScheme: statusbar.getSnapshot().colorScheme, gaugeCells: statusbar.getSnapshot().gaugeCells},
    statusbarStatus: status(pageOwner),
    statusLines: (() => {
      const shown = status(pageOwner), snapshot = resources.snapshot(), automaModel = tools.modelStorage.get('automa');
      return [
        row.field('Session', session + ' · Role: ' + pageOwner),
        row.rule(),
        row.field('Provider', shown.model?.provider ?? 'None'),
        row.field('Model', shown.model?.model || 'None selected'),
        row.field('Thinking effort', shown.effort + (shown.effortError ? ' (' + shown.effortError + ')' : '')),
        row.field('Permission mode', permissions.mode),
        row.field('Execution state', shown.state),
        row.field('Active tasks', store.getSnapshot().activities.filter(a => ['queued', 'running', 'waiting_input'].includes(a.status)).length),
        ...(shown.git ? [row.field('Git', shown.git.branch + (shown.git.dirty ? ' · ' + shown.git.dirty + ' changed' : '') + (shown.git.ahead ? ' · ahead ' + shown.git.ahead : '') + (shown.git.behind ? ' · behind ' + shown.git.behind : ''))] : []),
        ...(automaModel ? [row.field('Automa worker', automaModel.provider + '/' + automaModel.model)] : []),
        row.blank(),
        row.rule('Context & Tokens'),
        ...contextRows(),
        row.blank(),
        row.rule('Resources & Environment'),
        ...(snapshot.guidelines.length ? [row.text('Project rules loaded from:'), ...snapshot.guidelines.map(item => row.bullet(item.path))] : [row.field('Project rules', 'none loaded')]),
        row.field('Skills', snapshot.skills.length + ' · Template commands: ' + snapshot.commands.length),
        ...snapshot.issues.map(item => row.bullet(item.kind + ': ' + item.path + ' · ' + item.reason)),
        ...extensions.mcp.status().map(item => row.bullet('MCP ' + item.name + ': ' + item.state)),
      ];
    })(),
    configLines: (() => {
      const shown = status(pageOwner), automaModel = tools.modelStorage.get('automa');
      return [
        row.field('Provider', shown.model?.provider ?? settings.provider),
        row.field('Model', shown.model?.model || 'None selected'),
        row.field('Thinking effort', shown.effort + (shown.effortError ? ' (' + shown.effortError + ')' : '')),
        row.field('Base URL', settings.baseUrl),
        row.field('Automa worker', automaModel ? automaModel.provider + '/' + automaModel.model + ' (dedicated)' : 'Inherits session model (' + settings.provider + '/' + (settings.model || 'none') + ')'),
        row.blank(),
        row.rule('Execution Limits'),
        row.field('Temperature', config.provider.temperature),
        row.field('Max tokens', config.provider.max_tokens),
        row.field('Request timeout', config.provider.timeout + 's'),
        ...(config.kernel.max_iterations > 0 ? [row.field('Max loop iterations', config.kernel.max_iterations)] : []),
        row.field('Max connection retries', config.kernel.max_retries),
        row.blank(),
        row.rule('Instructions'),
        row.text('Switch via /model or /providers; use /settings to customize themes and preferences.'),
      ];
    })(),
    usageLines: [
      row.field('Session', session + ' · Role: ' + pageOwner),
      row.field('Total across session roles', sessionUsageRecords().reduce((sum, record) => sum + record.input + record.output, 0) + ' tokens (including approval)'),
      row.blank(),
      row.rule('Breakdown'),
      ...usageRows(contexts.meter({sessionId: session, ownerId: pageOwner}).usageRecords(), config),
    ],
    providersLines: providersTabRows(),
    commandsLines: [...commandHelp().split('\n').map(line => row.text(line)), ...resources.snapshot().commands.map(item => row.text('/' + item.name + ': ' + item.description))],
  });

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
      if (tabId === 'providers') {
        const names = registry.names();
        if (action === 'next_provider' && names.length > 0) {
          viewingProviderIndex = (viewingProviderIndex + 1) % names.length;
          refreshCurrentPage();
          return {};
        }
        if (action === 'prev_provider' && names.length > 0) {
          viewingProviderIndex = (viewingProviderIndex - 1 + names.length) % names.length;
          refreshCurrentPage();
          return {};
        }
        const current = names[viewingProviderIndex];
        if (!current) return {};
        if (action === 'test') {
          providerStatuses.set(current, 'Testing connection...');
          refreshCurrentPage();
          const start = Date.now();
          try {
            const candidate = registry.candidate(current);
            await candidate.check(commands.signal);
            const elapsed = Date.now() - start;
            providerStatuses.set(current, '● Connected (' + elapsed + 'ms)');
            refreshCurrentPage();
            return {message: "Provider '" + current + "' connected (" + elapsed + "ms)", presentation: 'status'};
          } catch (error) {
            providerStatuses.set(current, '○ Offline (' + (error instanceof Error ? error.message : 'failed') + ')');
            refreshCurrentPage();
            return {message: "Provider '" + current + "' connection failed", kind: 'command_error', presentation: 'status'};
          }
        }
        if (action === 'refresh') {
          providerStatuses.set(current, 'Refreshing models...');
          refreshCurrentPage();
          try {
            const pool = await modelPool.syncProvider(current, commands.signal);
            const count = pool.filter(m => m.provider === current).length;
            providerStatuses.set(current, '● Connected (' + count + ' models synced)');
            refreshCurrentPage();
            return {message: "Refreshed " + count + " models from '" + current + "'", presentation: 'status'};
          } catch (error) {
            providerStatuses.set(current, '○ Sync failed');
            refreshCurrentPage();
            return {message: "Failed to refresh models from '" + current + "'", kind: 'command_error', presentation: 'status'};
          }
        }
        if (action === 'logout') {
          if (ensemble.isBusy()) return {message: 'Tasks are running. Wait or cancel before unregistering provider.', kind: 'command_error', presentation: 'status'};
          const using = usersLabel(providerUsers(current));
          return {confirm: {action: 'confirm_logout', prompt: "Log out of provider '" + current + "' and remove its credentials?" + (using.length ? ' In use by: ' + using.join(', ') + '.' : '')}};
        }
        if (action === 'confirm_logout') {
          if (ensemble.isBusy()) return {message: 'Tasks are running. Wait or cancel before unregistering provider.', kind: 'command_error', presentation: 'status'};
          await removeProvider(current, commandOwner);
          if (viewingProviderIndex >= registry.names().length) {
            viewingProviderIndex = Math.max(0, registry.names().length - 1);
          }
          refreshCurrentPage();
          return {message: "Logged out provider '" + current + "'", presentation: 'status'};
        }
      }
      return {};
    },
  });

  /** Everything /settings reads and writes, wired to the real stores. */
  const settingsEnv: SettingsEnv = {
    ui, statusbar,
    themes: () => listThemes().map(theme => theme.name),
    applyTheme: name => {applyThemePreset(name);},
    applyCursor: name => applyCursorStyle(name as CursorStyleName, process.stdout),
    userName: () => userName,
    saveUserName: async name => {
      await profileReady;
      try {userName = await saveUserName(homeDir, name);}
      catch {throw new Error('Could not save the preferred name; it is unchanged.');}
      setUserLabel(userName);
      return userName;
    },
    thinking: () => registry.thinking(),
    saveEffort: effort => saveEffort(effortSchema.parse(effort)),
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
    const context = buildAppCommandContext();
    if (id === 'statusbar') {
      const spec = createCommandTabsFor('/statusbar', context);
      activeCommandPage = '/statusbar';
      return spec ? {title: 'Status bar', tabs: spec.tabs, initialTab: spec.initialTab, actions: pageActions(false)} : null;
    }
    if (id === 'permissions') {
      const spec = createCommandTabsFor('/permissions', context);
      activeCommandPage = '/permissions';
      return spec ? {title: 'Permissions', tabs: spec.tabs, initialTab: spec.initialTab, actions: pageActions(true)} : null;
    }
    activeCommandPage = '';
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
    const statusOptions = {sessionId: session, cwd, store, actors, registry, taskModels, contexts, permissions, config, subscriptions: () => subscriptionProviders, git: () => gitStatus.get()};
    const mcpRegistrations = (): ToolRegistration[] => extensions.mcp.definitions().map(definition => ({definition,
      metadata: {name: definition.name, category: 'extensions', roles: 'all', terminalVisibility: 'card', description: 'Discover and call configured MCP services'}}));
    const data = buildEnsemble({actors: () => actors.list(), cwd, home: homeDir, status, policy: id => actorServices.policy(id),
      tools: id => toolRegistry.resolveForActor(id, mcpRegistrations()), mcp: () => extensions.mcp.folders(),
      skills: actor => resources.skillsFor({actorId: actor.id, skills: actor.skills}), snapshot: () => store.getSnapshot(),
      usage: id => actorUsage(statusOptions, id)}, initial);
    surfaces.openEnsemble(data, {
      model: async id => {const actor = actors.find(id); if (!actor) return; if (isDirector(actor.id)) openModels(actor.name); else await actorServices.management.openDefaultModel(actor.id, surfaces);},
      edit: path => openInEditor(path),
    });
  };

  const pageIsOpen = () => {const open = surfaces.getSnapshot(); return open?.kind === 'page' || open?.kind === 'settings' && open.sub !== undefined;};
  const refreshCurrentPage = () => {
    if (!pageIsOpen() || !activeCommandPage) return;
    const spec = createCommandTabsFor(activeCommandPage, buildAppCommandContext());
    if (spec) surfaces.updatePage(spec.tabs);
  };

  const stopPageUpdates = store.subscribe(() => {if (pageIsOpen()) refreshCurrentPage();});
  // `Notify when done`: a bell or OSC 9 notification when a stretch of work longer than 30 s ends (see `tui/terminal/notify.ts`).
  const roundNotifier = new RoundNotifier({sessionId: session, mode: () => uiSettings().notify, focused: terminalFocus,
    write: data => {if (process.stdout.isTTY) process.stdout.write(data);}});
  const stopNotifier = store.subscribe(() => {roundNotifier.observe(store.getSnapshot());});
  const stopPermissions = tools.configurePermissions(session, {
    reviewer: () => {const selected = registry.selection(); return {provider: options.provider ?? registry.provider(), model: JSON.stringify([selected.provider, selected.model])};},
    charge: async (context, amount, model) => {await configureMeter(context.ownerId); contexts.meter(context).chargeUsage(amount, model, 'approval');},
    changed: () => {if (pageIsOpen()) refreshCurrentPage();},
  });
  const stopPermissionPolicy = permissions.subscribe(() => {
    bumpStatus();
    for (const request of store.interactions.list()) if (request.status === 'pending' &&
      (request.kind === 'permission' || request.kind === 'question' && request.title === 'Approval failed; action paused')) {
      store.interactions.cancel(request.requestId, 'Permissions changed; pending actions will be re-evaluated');
    }
    if (pageIsOpen()) refreshCurrentPage();
  });
  surfaces.subscribe(() => {
    if (!surfaces.getSnapshot()) activeCommandPage = '';
  });
  const openModels = (forActor = 'Logox') => {
    const groupedMap = new Map<string, GroupedModel>();
    const currentBase = (() => {
      const match = /^(.*?)-(low|medium|high|extra-low|max|tiered|thinking)$/.exec(settings.model);
      return match ? match[1]! : settings.model;
    })();
    // 1. Immediately read from local model store (0ms, zero network)
    modelPool.loadCacheSync();
    const poolModels = modelPool.snapshot();
    for (const provider of new Set(poolModels.map(item => item.provider))) {
      modelCandidates.set(provider, poolModels.filter(item => item.provider === provider).map(item => item.id));
    }
    const items: PickerItem[] = [];
    const providers = [...new Set(poolModels.map(m => m.provider))];
    for (const provider of providers) {
      const providerModels = poolModels.filter(m => m.provider === provider).map(m => m.id);
      const currentForThisProvider = settings.provider === provider ? settings.model : '';
      const groupedList = groupModelsForProvider(providerModels, provider, currentForThisProvider);
      if (!groupedList.length) continue;
      for (const grouped of groupedList) {
        groupedMap.set(grouped.id, grouped);
        const currentThinkingEffort = registry.thinking().effort;
        const currentEffort = (settings.provider === grouped.provider && settings.model === grouped.baseModel && currentThinkingEffort)
          ? currentThinkingEffort
          : grouped.currentEffort;
        const recorded = poolModels.find(m => m.provider === provider && m.id === grouped.baseModel)
          ?? poolModels.find(m => m.provider === provider && (m.id.startsWith(grouped.baseModel + '-') || grouped.baseModel.startsWith(m.id)));
        const effortLevels = recorded?.thinkingLevels ?? grouped.effortLevels;
        const win = recorded?.window ? (Math.round(recorded.window / 1000) + 'k') : '128k';
        const eff = effortLevels && effortLevels.length > 0
          ? '✦ ' + effortLevels.filter((l: string) => l !== 'auto').join('/')
          : '-';
        items.push({
          id: grouped.id,
          label: grouped.baseModel,
          description: win + ' · ' + eff + (recorded?.isOffline ? ' · offline' : ''),
          effort: currentEffort,
          effortLevels: effortLevels.length > 0 ? effortLevels : undefined,
          group: provider,
        });
      }
    }

    void surfaces.openPicker({
      title: 'Select Model for ' + forActor,
      description: 'Model families grouped by provider · Tab switches provider',
      emptyText: 'No models available. Run /login to connect a provider, then /providers and press r to refresh its model list.',
      current: JSON.stringify([settings.provider, currentBase]),
      items,
    },
      async signal => {
        if (items.length) {
          return {items, warning: ''};
        }
        const poolModels = await modelPool.list(AbortSignal.any([signal, commands.signal]));
        for (const provider of new Set(poolModels.map(item => item.provider))) {
          modelCandidates.set(provider, poolModels.filter(item => item.provider === provider).map(item => item.id));
        }
        const freshItems: PickerItem[] = [];
        const providers = [...new Set(poolModels.map(m => m.provider))];
        for (const provider of providers) {
          const providerModels = poolModels.filter(m => m.provider === provider).map(m => m.id);
          const currentForThisProvider = settings.provider === provider ? settings.model : '';
          const groupedList = groupModelsForProvider(providerModels, provider, currentForThisProvider);
          if (!groupedList.length) continue;
          for (const grouped of groupedList) {
            groupedMap.set(grouped.id, grouped);
            const currentThinkingEffort = registry.thinking().effort;
            const currentEffort = (settings.provider === grouped.provider && settings.model === grouped.baseModel && currentThinkingEffort)
              ? currentThinkingEffort
              : grouped.currentEffort;
            const recorded = poolModels.find(m => m.provider === provider && m.id === grouped.baseModel)
              ?? poolModels.find(m => m.provider === provider && (m.id.startsWith(grouped.baseModel + '-') || grouped.baseModel.startsWith(m.id)));
            const effortLevels = recorded?.thinkingLevels ?? grouped.effortLevels;
            const win = recorded?.window ? (Math.round(recorded.window / 1000) + 'k') : '128k';
            const eff = effortLevels && effortLevels.length > 0
              ? '✦ ' + effortLevels.filter((l: string) => l !== 'auto').join('/')
              : '-';
            freshItems.push({
              id: grouped.id,
              label: grouped.baseModel,
              description: win + ' · ' + eff + (recorded?.isOffline ? ' · offline' : ''),
              effort: currentEffort,
              effortLevels: effortLevels.length > 0 ? effortLevels : undefined,
              group: provider,
            });
          }
        }
        return {
          items: freshItems,
          warning: !freshItems.length ? 'No models available. Run /login or configure a provider.' : '',
        };
      },
      async (id, chosenEffort) => {
        requireIdle();
        const grouped = groupedMap.get(id);
        let provider: string;
        let actualModel: string;
        let effort: string | undefined;

        if (grouped) {
          provider = grouped.provider;
          const resolved = resolveActualModel(grouped, chosenEffort);
          actualModel = resolved.modelId;
          effort = resolved.effort;
        } else {
          const parsed = z.tuple([z.string(), z.string()]).parse(JSON.parse(id));
          provider = parsed[0];
          actualModel = parsed[1];
          effort = chosenEffort;
        }

        const candidate = registry.candidate(provider, actualModel);
        if (effort) {
          const parsedEffort = effortSchema.safeParse(effort);
          if (parsedEffort.success) {
            try { candidate.selectEffort(parsedEffort.data); } catch {}
          }
        }
        await saveSelection(candidate);
        return {message: 'Current model: ' + provider + ' / ' + actualModel + (effort ? ' · Thinking effort: ' + effort : ''), presentation: 'status'};
      });
  };
  const openAutomaModel = async () => {
    modelPool.loadCacheSync();
    const poolModels = modelPool.snapshot();
    // The same list every actor's model picker shows: see `bindingChoices`.
    const choices = bindingChoices(tools.modelStorage.get('automa'));
    await surfaces.openPicker({
      title: 'Select Model for Automa',
      description: 'Select dedicated model for Automa worker; Esc to cancel',
      current: choices.current,
      ...(poolModels.length > 0 ? {items: choices.items(poolModels)} : {}),
    }, async signal => {
      let models: readonly ChoiceModel[] = poolModels;
      let warning: string | undefined;
      if (models.length === 0) {
        const result = await registry.modelCatalog(signal);
        warning = result.issues.join('; ');
        models = result.models.map(m => ({provider: m.provider, id: m.id, thinkingLevels: [...detectEffortLevels(m.id, m.provider)]}));
      }
      return {items: choices.items(models), ...(warning ? {warning} : {})};
    }, async (choice, chosenEffort) => {
      const chosen = choices.resolve(choice, chosenEffort);
      if (chosen === null) throw new Error('Invalid model selection');
      await tools.modelStorage.save('automa', chosen, commands.signal);
      return {message: chosen ? `Automa model set to: ${chosen.provider}/${chosen.model}` : 'Automa model set to inherit session model', presentation: 'status'};
    });
  };
  // Restore the actual model messages; legacy TS demo ledgers remain readable, and tools are not re-executed.
  const savedRounds = new Map<string, Awaited<ReturnType<Journal['rounds']>>[number]>();
  // Nothing runs after a restart: Director dispatches that never started come back as a paused batch, human requests that never started as held
  // messages, and everything else that was in flight is marked interrupted.
  const plan = planRestart(checkpoints, owner => !!actors.find(owner));
  for (const task of plan.cancel) {
    await journal.checkpoint(session, {...task, status: 'cancelled', stopReason: 'interrupted'});
    task.status = 'cancelled'; task.stopReason = 'interrupted';
  }
  for (const task of plan.restore) task.status = 'paused';
  const restoring = new Set(plan.restore.map(task => task.activityId));
  const restored = (await Promise.all(owners.map(async owner => {
    const entries = await journal.load(session, owner);
    try {for (const round of await journal.rounds(session, owner, entries)) savedRounds.set(round.activityId, round);}
    catch {notice(`Could not load round summary for ${owner}; preserving raw messages.`);}
    return entries;
  }))).flat().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const entry of restored) {
    if (entry.role === 'context') continue;
    const origin = {...(entry.activityId ? {activityId: entry.activityId} : {}), ...(entry.source ? {source: entry.source} : {}),
      inputKind: inputKind(entry), time: entry.time ?? 0};
    const activityId = entry.activityId;
    if (activityId && !store.activities.get(session, activityId)) {
      const round = savedRounds.get(activityId), checkpoint = checkpoints.find(task => task.activityId === activityId);
      const savedModel = savedModels.find(item => item.activityId === activityId);
      store.activities.create({sessionId: session, activityId, ownerId: entry.ownerId, kind: isDirector(entry.ownerId) ? 'director' : 'actor',
        title: checkpoint?.taskTitle ?? (entry.text.slice(0, 80) || entry.ownerId), status: round?.status ?? checkpoint?.status ?? 'completed',
        stage: round ? ({completed: 'Completed', failed: 'Failed', cancelled: 'Interrupted'}[round.status] ?? 'Completed')
          : checkpoint ? checkpoint.status === 'completed' ? 'Completed' : checkpoint.status === 'failed' ? 'Failed' : 'Interrupted' : 'History',
        detail: checkpoint?.error ? 'Failure reason: ' + checkpoint.error + '\n' + (round?.summary.report ?? '')
          : round?.summary.report ?? (checkpoint ? 'Loaded checkpoint from a previous session' : 'Historical session record'),
        inputKind: inputKind(checkpoint ?? entry),
        ...(checkpoint?.taskTitle ? {taskTitle: checkpoint.taskTitle} : {}),
        ...(round ? {summary: round.summary} : {}),
        ...(checkpoint?.stopReason ? {stopReason: checkpoint.stopReason} : {}),
        ...(checkpoint?.rootActivityId ? {rootActivityId: checkpoint.rootActivityId} : {}),
        ...(checkpoint?.parentActivityId ? {parentActivityId: checkpoint.parentActivityId} : {}),
        ...(checkpoint?.batchId ? {batchId: checkpoint.batchId} : {}),
        ...(checkpoint?.resumeTaskId ? {resumeTaskId: checkpoint.resumeTaskId} : {}),
        ...(checkpoint?.progress ? {progress: checkpoint.progress} : {}),
        ...(checkpoint?.recovery ? {recovery: checkpoint.recovery} : {}),
        ...(savedModel ? {taskModel: {initial: savedModel.initial, actual: savedModel.actual, inherited: savedModel.inherited,
          switched: savedModel.switched, phase: savedModel.phase}} : {})});
    }
    if (entry.message?.role === 'assistant' && entry.message.memoryOnly) continue;
    if (entry.message?.role === 'assistant' && entry.message.textToolCall) {
      if (entry.message.reasoning) store.message(session, entry.ownerId, 'assistant', entry.message.reasoning, {...origin, kind: 'thinking'});
      store.message(session, entry.ownerId, 'notice', TEXT_TOOL_CALL_NOTE, origin);
      continue;
    }
    // Nothing runs after a restart: a step the ledger left open is closed here, whatever tool it belonged to. A tool record that
    // carries its result finished the way the result says; one without a result was interrupted.
    const step = entry.step ? settleStep(entry.step, entry.message?.role === 'tool' ? entry.message.isError ? 'failed' : 'completed' : 'cancelled', entry.step.runningSince ?? 0) : undefined;
    if (entry.message?.role === 'assistant' && (entry.message.reasoning || step)) {
      store.message(session, entry.ownerId, 'assistant', entry.message.reasoning ?? '', {...origin, kind: 'thinking', ...(step ? {step} : {})});
    }
    if (entry.text) store.message(session, entry.ownerId, entry.role === 'tool' ? 'notice' : entry.role, entry.message?.role === 'tool' ? entry.message.name + '\n' + entry.text : entry.source === 'steered' && entry.role === 'user' ? steeredText(entry.text) : entry.text,
      {...origin, ...(entry.role === 'tool' ? {kind: 'tool' as const, ...(step ? {step} : {})} : {})});
  }
  for (const task of checkpoints) {
    if (store.activities.get(session, task.activityId) || restoring.has(task.activityId)) continue;
    store.activities.create({sessionId: session, activityId: task.activityId, ownerId: task.ownerId,
      kind: isDirector(task.ownerId) ? 'director' : 'actor', title: task.taskTitle ?? task.prompt.slice(0, 80),
      status: task.status, stage: task.status === 'cancelled' ? 'Interrupted' : 'Checkpoint loaded',
      detail: task.error ? 'Failure reason: ' + task.error : 'Loaded checkpoint from a previous session',
      inputKind: inputKind(task),
      ...(task.taskTitle ? {taskTitle: task.taskTitle} : {}),
      ...(task.parentActivityId ? {parentActivityId: task.parentActivityId} : {}), ...(task.batchId ? {batchId: task.batchId} : {}),
      ...(task.progress ? {progress: task.progress} : {}), ...(task.recovery ? {recovery: task.recovery} : {}),
      ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {}),
      ...(task.rootActivityId ? {rootActivityId: task.rootActivityId} : {})});
    store.message(session, task.ownerId, 'user', task.prompt, {activityId: task.activityId, source: task.source,
      inputKind: inputKind(task), time: task.time});
  }
  const dependencies = restartDependencies(plan.restore, checkpoints);
  ensemble.restoreQueued(plan.restore, dependencies);
  actorServices.restoreRestart(plan.restore, dependencies.interrupted, checkpoints.filter(task => restartStopped(task) && !isDirector(task.ownerId) && inputKind(task) === 'director').map(task => task.activityId));
  // Held human messages are saved whenever the list changes (one write at a time) and come back marked restored, so they never auto-send.
  let heldRef = store.getSnapshot().pending, heldTail: Promise<void> = Promise.resolve();
  const stopHeld = store.subscribe(() => {
    const next = store.getSnapshot().pending;
    if (next === heldRef) return;
    heldRef = next;
    const items = next.filter(item => item.sessionId === session).map(({restored: _restored, ...item}) => item);
    heldTail = heldTail.then(() => journal.saveHeld(session, items)).catch(() => {notice('Held messages could not be saved.', 'command_error');});
  });
  const heldBefore = await journal.loadHeld(session).catch(() => {notice('Held messages could not be restored.', 'command_error'); return [];});
  for (const task of plan.held) store.addPending({sessionId: session, ownerId: task.ownerId, windowId: task.source === 'direct' ? DIRECTOR_ID : task.source, text: task.prompt, time: task.time, restored: true});
  for (const item of heldBefore) store.addPending({...item, restored: true});
  const welcomeTitle = 'Session ' + session;
  const welcomeBody = settings.model
    ? `${settings.provider}/${settings.model} · Type /help for assistance`
    : 'Welcome to Logox Ensemble! No model configured yet.\n\nQuick setup:\n  • Run /login to connect providers (DeepSeek, OpenAI, Anthropic, or local)\n  • Or add your API key to .env in your project\n  • Type /doctor to diagnose environment readiness';
  systems.emit(welcomeTitle + '\n' + welcomeBody, 'task_notice', DIRECTOR_ID, undefined, false, {presentation: 'welcome'});
  for (const issue of resources.snapshot().issues) notice('Resource failed to load: ' + issue.path + ' · ' + issue.reason, 'command_error');
  const terminal = new Set(checkpoints.filter(task => ['failed', 'cancelled'].includes(task.status)).map(task => task.activityId));
  const stopSystemUpdates = store.subscribe(() => {
    for (const activity of store.getSnapshot().activities) {
      if (!['failed', 'cancelled'].includes(activity.status) || terminal.has(activity.activityId)) continue;
      terminal.add(activity.activityId);
      if (isOutageWake(activity)) continue;
      notice(activity.status === 'failed' ? 'Execution failed: ' + activity.detail : 'Task stopped.',
        activity.status === 'failed' ? 'model_error' : 'task_notice', activity.ownerId, activity.activityId);
    }
  });
  const beginTask = async () => {await options.beforeTask(); await systems.flush();};
  const dispatchInput = async (owner: string, prompt: string, source: string) => {
    const latest = [...store.getSnapshot().activities].reverse().find(activity => activity.ownerId === owner);
    const previous = /^(?:继续|接着|续做)/u.test(prompt) && latest &&
      actorServices.recovery.hasExecution(latest.rootActivityId ?? latest.activityId) ? latest : undefined;
    const rootActivityId = previous?.rootActivityId ?? previous?.activityId;
    const task = ensemble.dispatch(owner, prompt, source, {inputKind: 'human', ...(rootActivityId ? {rootActivityId, grantExecution: true} : {}),
      ...(previous?.ownerId === owner && previous.progress ? {resumeTaskId: previous.activityId} : {})});
    return task;
  };
  const ownerIsBusy = (owner: string) => store.getSnapshot().activities.some(item => item.sessionId === session && item.ownerId === owner && ['running', 'waiting_input'].includes(item.status));
  /** The oldest pending message of an owner is delivered once its round has ended and no earlier human task waits; the rest stay pending until then. */
  let settling = false;
  const settlePending = () => {
    if (settling || closed) return;
    const snapshot = store.getSnapshot();
    const next = snapshot.pending.find(item => item.sessionId === session && !item.restored && !ownerIsBusy(item.ownerId) &&
      !snapshot.activities.some(activity => activity.sessionId === session && activity.ownerId === item.ownerId && activity.status === 'queued' && activity.inputKind === 'human'));
    if (!next) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      if (closed || !store.takePending(next.id)) return;
      dispatchInput(next.ownerId, next.text, isDirector(next.ownerId) ? next.windowId : 'direct')
        .catch(error => {notice(error instanceof Error ? error.message : String(error), 'command_error', next.windowId);});
    });
  };
  const stopPending = store.subscribe(settlePending);
  const sendPendingNow = async (pendingId: string): Promise<void> => {
    const item = store.getSnapshot().pending.find(entry => entry.id === pendingId);
    if (!item || closed) return;
    const active = ensemble.getActiveTask(item.ownerId);
    if (!active) {
      if (!item.restored) settlePending();
      else if (store.takePending(pendingId)) await dispatchInput(item.ownerId, item.text, isDirector(item.ownerId) ? item.windowId : 'direct');
      return;
    }
    store.takePending(pendingId);
    if (!await ensemble.injectTaskMessage(item.ownerId, item.text, 'steered', undefined, 'queue',
      {activityId: active.activityId, inputKind: 'human', kind: 'human_steer'})) {
      await dispatchInput(item.ownerId, item.text, isDirector(item.ownerId) ? item.windowId : 'direct');
    }
  };
  /** Takes a pending message back (cancel or edit) and returns its text. */
  const discardPending = (pendingId: string): string | undefined => store.takePending(pendingId)?.text;
  return {
    sendPendingNow, discardPending,
    sessionId: session, store, ensemble, journal, tools, permissions, authentication, surfaces, contexts, extensions, resources, actors, taskModels, statusbar, status, isBusy: busy,
    systemNotice: notice,
    getInputQueue: (ownerId?: string) => ({queued: ensemble.queuedInputs(ownerId), steering: deliveries.snapshot().filter(item =>
      item.kind === 'human_steer' && item.status === 'pending' && (!ownerId || item.ownerId === ownerId))}),
    getStatusSnapshot: () => store.getSnapshot().revision + ':' + statusbar.getSnapshot().revision + ':' + statusTick,
    subscribeStatus(listener: () => void) {
      const stopStore = store.subscribe(() => {if (gitStarted) gitStatus.touch(); listener();}), stopPreferences = statusbar.subscribe(listener);
      statusListeners.add(listener);
      return () => {stopStore(); stopPreferences(); statusListeners.delete(listener);};
    },
    async recordError(error: unknown, owner = DIRECTOR_ID) {
      notice(error instanceof Error ? error.message : String(error), 'command_error', owner);
      await systems.flush();
    },
    activate() {
      extensions.hooks.emit('session_start', {session_id: session, model: settings.model});
      const isTest = typeof (globalThis as any).IS_REACT_ACT_ENVIRONMENT !== 'undefined' ||
        process.execArgv.some(arg => arg.startsWith('--test'));
      const onboardingPrefs = readOnboardingPrefs(homeDir);
      if (shouldOfferOnboarding(onboardingPrefs) && !settings.model && !checkpoints.length && session !== 'demo' && !isTest && Boolean(process.stdout.isTTY)) {
        void (async () => {
          if (!ensemble.isBusy() && !authentication.getSnapshot()) {
            loginOwner = DIRECTOR_ID;
            // Optional first step: Enter on an empty field or Esc skips it and setup continues.
            const preferred = await askPreferredName(authentication.ask);
            if (preferred) {userName = await saveUserName(homeDir, preferred).catch(() => userName); setUserLabel(userName);}
            const outcome = await loginWizard(DIRECTOR_ID);
            if (outcome === 'added' || outcome === 'signed-in') {
              markOnboardingDone(ONBOARDING_VERSION, homeDir);
              receipt('Setup complete! Model preference activated.', 'status', undefined, DIRECTOR_ID);
            } else if (outcome === 'cancelled') {
              markOnboardingSkipped(ONBOARDING_VERSION, homeDir);
              notice('Setup skipped — run /setup anytime to re-launch.', 'command_result', DIRECTOR_ID, undefined, {presentation: 'silent'});
            }
          }
        })().catch(() => {});
      }
    },
    commandContext(): CommandContext {
      const knownPresets: Record<string, string[]> = {
        openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4-turbo'],
        antigravity: ['gemini-3.8-flash', 'claude-sonnet-4-6', 'gemini-3.7-flash', 'claude-opus-4-6', 'gemini-3.1-pro-high', 'gpt-oss-120b-medium'],
        deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
        anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
      };
      const providerModels = modelCandidates.get(settings.provider) ?? knownPresets[settings.provider] ?? [];
      return {providers: registry.names(), loginProviders: registry.loginNames(), customCommands: resources.snapshot().commands,
        actors: actors.list().map(actor => actor.id),
        actorDetails: actors.list().map(actor => ({id: actor.id, name: actor.name, title: actor.title})),
        models: [...new Set([settings.model, ...providerModels,
          ...[...modelCandidates].flatMap(([provider, models]) => models.map(model => provider + '/' + model))].filter(Boolean))]};
    },
    noteDraft() {},
    /** Stops one running tool call (its child process) without ending the owner's step; false when the call is not cancellable or already done. */
    cancelTool(callId: string): boolean {return killActiveProcess(callId, USER_STOP_REASON, 'user');},
    cancel(activityId: string) {if (compactTask?.activityId === activityId) compactTask.controller.abort(); else {
      const director = store.activities.get(session, activityId)?.ownerId === DIRECTOR_ID;
      if (director) actorServices.stopDirector(activityId); else actorServices.stopActor(activityId);
      // Stopping Logox leaves its companions running; the interrupt marker names them so the next message can redirect or cancel them.
      const working = director ? workingNames(roundScope(store.getSnapshot().activities, session).actors, id => actors.list().find(item => item.id === id)?.name ?? id) : [];
      ensemble.cancel(activityId, 'user', working.length ? working.join(', ') : undefined);
      // Foreground commands die with the user reason; background Shell jobs of the stopped activity go with it.
      killActivityProcesses(activityId, USER_STOP_REASON, 'user'); killBackgroundJobs(activityId);
    }},
    async close() {
      closed = true; actorServices.close(); keepAlive.dispose(); commands.abort(); surfaces.close(); stopPageUpdates(); stopNotifier(); store.interactions.close(); compactTask?.controller.abort();
      try {
        await Promise.all([authentication.close(), ensemble.close(), compactTask?.done, reloadTask, permissionTask, meterRestore, subscriptionsDone, permissions.flushStats()]);
        await Promise.allSettled([selectionDone]); await actorServices.flush(); await usage.flush(); await systems.flush(); await heldTail;
      } finally {stopHeld(); stopGitWatch(); await gitStatus.close(); stopPermissionPolicy(); stopPermissions(); stopSystemUpdates(); stopPending(); stopSurfaceErrors(); stopLoginErrors();}
    },
    async submit(raw: string, source = DIRECTOR_ID, inputDelivery: SubmitDelivery = {mode: 'queue'}): Promise<void> {
      const text = raw.trim();
      if (!text || closed) return;
      if (permissionTask) throw new Error('Permissions are saving, please wait...');
      if (selecting) throw new Error('Model settings are saving, please try again shortly...');
      if (reloadTask) throw new Error('Resources are reloading, please wait...');
      if (compactTask) throw new Error('Context is compacting, please wait or cancel...');
      const previousSurface = surfaces.getSnapshot();
      if (previousSurface) {
        if (text.startsWith('/') || previousSurface.kind === 'result' && previousSurface.ownerId && previousSurface.ownerId !== source) {
          surfaces.close();
        } else {
          throw new Error('Please close the current command pane first');
        }
      }
      if (authentication.getSnapshot()) throw new Error('Authentication is in progress, please complete or cancel first');
      commandOwner = source;
      const delivery = submitDeliverySchema.parse(inputDelivery);
      if (delivery.mode === 'steer') {
        if (/^[@/]/.test(text)) throw new Error('Steering cannot execute commands or actor-routing syntax. Use Queue instead.');
        const target = store.activities.get(session, delivery.activityId);
        if (!target || !['running', 'waiting_input'].includes(target.status)) throw new Error('The steering target is no longer active. The draft was not queued.');
        if (target.ownerId !== source) throw new Error('The steering target does not match the selected Actor window.');
        await beginTask();
        if (!await ensemble.injectTaskMessage(target.ownerId, text, 'steered', undefined, 'queue',
          {activityId: delivery.activityId, inputKind: 'human', kind: 'human_steer'})) {
          throw new Error('The steering target is no longer available. The draft was not queued.');
        }
        return;
      }
      if (/^\/(new|resume|clear|rewind)(?:\s|$)/.test(text) && await options.sessionCommand(text)) return;
      if (text === '/setup' || text === '/login' || text.startsWith('/login ')) {
        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before logging in.');
        loginOwner = source;
        const target = text.startsWith('/login ') ? text.slice(7).trim() : '';
        // A known provider jumps to its key flow, account flow or edit menu in the wizard; any other name is an error.
        if (target && !(await wizardRows()).some(row => row.name === target)) throw new Error("Unknown provider '" + target + "'. Run /login to choose a provider or add a custom endpoint.");
        const outcome = await loginWizard(source, target || undefined);
        if (outcome === 'cancelled') {
          if (text === '/setup') markOnboardingSkipped(ONBOARDING_VERSION, homeDir);
          notice(text === '/setup' ? 'Setup closed without changes.' : 'Login wizard closed without changes.', 'command_result', source, undefined, {presentation: 'silent'});
        } else if (outcome !== 'failed') {
          markOnboardingDone(ONBOARDING_VERSION, homeDir);
          receipt(text === '/setup' ? 'Setup complete! Model preference activated.' : 'Provider changes saved.', 'status', undefined, source);
        }
        return;
      }
      if (text === '/permissions mode') {
        void surfaces.openPicker({title: 'Permission Mode', description: 'Explicit deny is shared across all 3 tiers; pending actions will be re-evaluated', current: permissions.mode},
          async () => ({items: Object.entries(permissionModes).map(([id, mode]) => ({id, label: id, description: mode.description, color: palette[mode.colorToken]}))}),
          async id => {await permissions.setMode(permissionModeSchema.parse(id)); return {message: 'Permission mode: ' + id, presentation: 'status'};});
        return;
      }
      if (text.startsWith('/permissions ')) {
        permissionTask = (async () => {
          const parts = text.slice(13).trim().split(/\s+/);
          if (parts[0] === 'mode') {if (parts.length !== 2) throw new Error('Usage: /permissions mode default|auto|creative'); await permissions.setMode(permissionModeSchema.parse(parts[1]));}
          else if (parts[0] === 'revoke' && parts.length === 2) await permissions.revoke(parts[1]!);
          else if (parts[0] === 'add' && parts.length >= 5) await permissions.add({scope: permissionScopeSchema.parse(parts[1]), decision: permissionDecisionSchema.parse(parts[2]), tool: z.string().min(1).parse(parts[3]), pattern: parts.slice(4).join(' ')});
          else throw new Error('Run /permissions to view usage');
          receipt('Permissions updated.', 'status', undefined, source);
        })();
        try {await permissionTask;} finally {permissionTask = undefined;}
        return;
      }
      if (text.startsWith('/model ') || text === '/model') {
        const rawArg = text === '/model' ? '' : text.slice(7).trim();
        const firstToken = rawArg.split(/\s+/)[0]?.toLowerCase();
        const targetActor = firstToken ? actors.find(firstToken) : undefined;

        if (text === '/model') {
          if (!isDirector(source) && actors.find(source)) {
            await actorServices.management.openDefaultModel(source, surfaces);
            return;
          }
          openModels(actors.find(DIRECTOR_ID)?.name ?? 'Logox');
          return;
        }

        if (firstToken === 'automa') {
          const specificModel = rawArg.slice(firstToken.length).trim();
          if (specificModel) {
            if (specificModel.toLowerCase() === 'inherit') {
              await tools.modelStorage.save('automa', undefined, commands.signal);
              receipt('Automa model set to inherit session model', 'status', undefined, source);
              return;
            }
            const resolved = modelPool.resolveShorthand(specificModel, settings.provider);
            await tools.modelStorage.save('automa', {provider: resolved.provider, model: resolved.model}, commands.signal);
            receipt('Automa model set to: ' + resolved.provider + '/' + resolved.model, 'status', undefined, source);
            return;
          }
          await openAutomaModel();
          return;
        }

        if (targetActor) {
          const specificModel = rawArg.slice(firstToken!.length).trim();
          if (specificModel) {
            const resolved = modelPool.resolveShorthand(specificModel, settings.provider);
            await actorServices.management.saveDefaultModel(targetActor.id, {provider: resolved.provider, model: resolved.model}, commands.signal);
            receipt('Actor ' + targetActor.name + ' model set to: ' + resolved.provider + '/' + resolved.model, 'status', undefined, source);
            return;
          }
          if (isDirector(targetActor.id)) {
            openModels(targetActor.name);
            return;
          }
          await actorServices.management.openDefaultModel(targetActor.id, surfaces);
          return;
        }

        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before switching model.');
        const model = rawArg;
        if (!model) throw new Error('Please specify a model name');
        const resolved = modelPool.resolveShorthand(model, settings.provider);
        await saveSelection(registry.candidate(resolved.provider, resolved.model));
        receipt('Current model: ' + resolved.provider + '/' + resolved.model, 'status', undefined, source);
        return;
      }
      if (text === '/name' || text.startsWith('/name ')) {
        const arg = text.slice(5).trim();
        if (!arg) {
          receipt(userName ? 'Preferred name: ' + userName : 'No preferred name set (shown as You). Use /name <new name> to set one.', 'status', undefined, source);
          return;
        }
        const reset = arg === '--reset';
        const next = reset ? undefined : sanitizeUserName(arg);
        if (!reset && !next) throw new Error('Usage: /name <new name> | /name --reset');
        await profileReady;
        try {userName = await saveUserName(homeDir, next);}
        catch {throw new Error('Could not save the preferred name; it is unchanged.');}
        setUserLabel(userName);
        receipt(userName ? 'Preferred name set to ' + userName + '.' + (sanitizeUserName(arg) !== arg ? ' (Limited to ' + USER_NAME_MAX_CELLS + ' cells, control characters removed.)' : '') : 'Preferred name cleared.', 'status', undefined, source);
        return;
      }
      if (text === '/help' || text === '/commands') {
        receipt(buildAppCommandContext().commandsLines.map(rowText).join('\n'), 'panel', 'Help & Commands'); return;
      }
      pageOwner = source;
      if (text === '/settings' || text === '/animations') {openSettings(); return;}
      if (text === '/ensemble') {openEnsemble(source); return;}
      const pageSpec = createCommandTabsFor(text, buildAppCommandContext());
      if (pageSpec) {
        activeCommandPage = text;

        surfaces.openPage(pageSpec.title, pageSpec.tabs, pageSpec.initialTab, pageActions(pageSpec.tabs.filter(tab => tab.toggles).length <= 1)); return;
      }
      if (text === '/skills') {
        receipt(resources.skillsFor({actorId: source, skills: actors.find(source)?.skills ?? []}).map(item => item.name + ': ' + item.description + '\n' + item.path).join('\n\n') || 'No skills found', 'panel', 'Skills'); return;
      }
      if (text === '/reload') {
        requireIdle();
        reloadTask = queryResult(source, 'Resource reload', async () => {
          const report = await reloadResources(resources, () => loadConfig(cwd, {}, options.env ?? process.env,
            options.resourceOptions?.home, options.resourceOptions?.boundary));
          if (report.prefixChanged) contexts.invalidatePrefix();
          await toolRegistry.reloadUserConfigs();
          const actorState = await actors.reload(); contexts.invalidatePrefix();
          for (const issue of actorState.issues) notice('Actor failed to load: ' + issue.path + ' · ' + issue.reason, 'command_error', source);
          return report.text;
        });
        try {await reloadTask;} finally {reloadTask = undefined;}
        return;
      }
      const effortCommand = /^\/(?:effort|thinking|think)(?:\s+(\S+))?$/.exec(text);
      if (effortCommand) {
        if (!effortCommand[1]) {openThinking(); return;}
        const effort = effortSchema.safeParse(effortCommand[1]);
        if (!effort.success) throw new Error('Thinking effort: auto/off/low/medium/high/max; see /effort');
        await saveEffort(effort.data); receipt('Thinking effort: ' + effort.data + ' (saved)', 'status', undefined, source); return;
      }
      if (text === '/model') {
        if (!isDirector(source) && actors.find(source)) {
          await actorServices.management.openDefaultModel(source, surfaces); return;
        }
        openModels(actors.find(DIRECTOR_ID)?.name ?? 'Logox'); return;
      }
      if (text === '/models') {
        const provider = settings.provider;
        await queryResult(source, 'Available models', async () => {
          const models = await registry.models(AbortSignal.any([commands.signal, AbortSignal.timeout(15000)]));
          modelCandidates.set(provider, models);
          return models.join('\n') || 'Provider returned empty model list';
        }); return;
      }
      if (text.startsWith('/providers ')) {
        const parts = text.replace(/^\/providers\s+/, '').trim().split(/\s+/);
        if (parts[0] === 'check') {
          if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before checking provider.');
          const selection = registry.selection();
          await queryResult(source, 'Provider check', async () => {
            const result = await registry.check(commands.signal);
            return 'Provider check succeeded: ' + selection.provider + ' / ' + selection.model + '\n' + result.text + '\nLatency: ' + result.elapsedMs + ' ms';
          }); return;
        }
        if (parts[0] === 'unregister' || parts[0] === 'logout') {
          if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before unregistering provider.');
          const target = parts[1];
          if (!target) throw new Error('Usage: /providers unregister <name>');
          await removeProvider(target, source);
          receipt("Provider '" + target + "' unregistered successfully.", 'status', undefined, source); return;
        }
        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before switching provider.');
        if (!parts[0] || parts.length > 2) throw new Error('Usage: /providers <name> [model]');
        await saveSelection(registry.candidate(parts[0], parts[1]));
        receipt('Current provider: ' + settings.provider + '\nModel: ' + (settings.model || 'Select with /model'), 'status', undefined, source); return;
      }
      if (text === '/check-provider') {
        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before checking provider.');
        const selection = registry.selection();
        await queryResult(source, 'Provider check', async () => {
          const result = await registry.check(commands.signal);
          return 'Provider check succeeded: ' + selection.provider + ' / ' + selection.model + '\n' + result.text + '\nLatency: ' + result.elapsedMs + ' ms';
        }); return;
      }
      if (text === '/compact') {
        requireIdle();
        const activityId = randomUUID(), controller = new AbortController();
        store.activities.create({sessionId: session, activityId, ownerId: source, kind: isDirector(source) ? 'director' : 'actor',
          title: 'Compact', status: 'running', stage: 'Compacting context', detail: 'Preserving raw journal without executing tools'});
        const operation = (async () => {
          try {
            const role = actors.find(source);
            const identity = {sessionId: session, ownerId: source, activityId};
            const base = await agentRequestBase(cwd, source, actorServices.tools(source), resources,
              role ? {prompt: role.prompt, compression: role.compression, visibility: {actorId: source, skills: role.skills}} : undefined, true, getActorScratchpadDir(cwd, session, source));
            await contexts.prepare(identity, contexts.requestBase(identity, base), controller.signal, true);
            controller.signal.throwIfAborted();
            store.activities.update(session, activityId, {status: 'completed', stage: 'Compacted'});
          } catch (error) {
            store.activities.update(session, activityId, {status: controller.signal.aborted ? 'cancelled' : 'failed',
              stage: controller.signal.aborted ? 'Aborted' : 'Compaction failed', detail: error instanceof Error ? error.message : String(error)});
            notice(controller.signal.aborted ? 'Compaction cancelled. Raw records preserved.' : 'Compaction failed: ' + (error instanceof Error ? error.message : String(error)), 'command_error', source, activityId);
          } finally {compactTask = undefined;}
        })();
        compactTask = {activityId, controller, done: operation};
        await operation;
        return;
      }
      if (text === '/undo') {
        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before undoing.');
        await queryResult(source, 'File undo', async () => {
          const activities = new Set((await journal.activeTasks(session)).map(task => task.activityId));
          for (const owner of owners) for (const entry of await journal.load(session, owner)) if (entry.activityId) activities.add(entry.activityId);
          const paths = await tools.snapshots.undo([...activities]);
          if (!paths.length) {receipt('No file changes to undo', 'status', undefined, source); return undefined;}
          return 'Undone:\n' + paths.join('\n');
        }); return;
      }
      if (text === '/doctor') {
        const {runDoctorChecks, doctorLines} = await import('./doctor.js');
        await queryResult(source, 'Logox Doctor', async () => {
          const lines = doctorLines(runDoctorChecks(cwd));
          return {text: lines.map(line => line.text).join('\n'), lines};
        });
        return;
      }
      if (text.startsWith('/cast ')) {
        const prompt = text.slice(6).trim();
        if (!prompt) throw new Error('Please specify a task prompt for actors');
        await beginTask();
        ensemble.dispatchBatch((['aletheia', 'techne', 'kalon'] as const).map(ownerId => ({ownerId, prompt}))); return;
      }
      if (text.startsWith('/')) {
        const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(text);
        const expanded = match ? resources.expand(match[1]!, match[2] ?? '') : undefined;
        if (!expanded) throw new Error('Unknown command. Run /help to view available commands.');
        await beginTask();
        await dispatchInput(source, expanded, isDirector(source) ? source : 'direct'); return;
      }
      const mention = /^@([a-z][a-z0-9_-]*)\s+([\s\S]+)$/.exec(text);
      if (text.startsWith('@') && (!mention || !actors.find(mention[1]!))) throw new Error('Unknown actor name. Use /ensemble to view available members, then dispatch tasks with @<actor> <task>.');
      const owner = mention ? mention[1]! : source;
      await beginTask();
      if (ownerIsBusy(owner)) {
        // The target is mid-round: hold the message above the composer (not in the timeline) until the round ends or Send now steers it.
        store.addPending({sessionId: session, ownerId: owner, windowId: source, text: mention ? mention[2]! : text});
        return;
      }
      await dispatchInput(owner, mention ? mention[2]! : text, isDirector(owner) ? source : 'direct');
    },
  };
}

export async function createApplication(options: ApplicationOptions) {
  return createManagedApplication(options, createSessionApplication);
}
