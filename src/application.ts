/**
 * The application container. `createSessionApplication` is a composition root: it constructs the services of one session
 * (stores, registry, model pool, ensemble, command surfaces), hands each service group its dependencies explicitly, and
 * returns the public object the TUI and the tests drive. Behaviour lives in the group modules: `src/app/` (state, status,
 * request assembly, input delivery, restore, command dispatch), `src/commands/` (model selection, pages, provider page,
 * command context) and `src/providers/management.ts`. Statement order below is the startup order; keep it.
 */
import {DIRECTOR_ID, isDirector} from './runtime/director-id.js';
import {isOutageWake} from './runtime/outage.js';
import type {ResourceOptions} from './resources/manager.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import {ProjectExtensions, observeTasks, observeExtra} from './extensions/runtime.js';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {CommandSurfaces} from './commands/surfaces.js';
import type {ResultLine} from './runtime/command-surface.js';
import {join} from 'node:path';
import {z} from 'zod';
import {DynamicEnsemble} from './actors/ensemble.js';
import {ActorCatalog} from './actors/catalog.js';
import {ActorServices} from './actors/services.js';
import {roundScope, workingNames} from './runtime/round-scope.js';
import {DeliveryQueue} from './actors/delivery-queue.js';
import {TaskModels, TaskModelLedger} from './actors/task-models.js';
import type {Config} from './config/config.js';
import {StateFile, preferenceSchema} from './config/model-preferences.js';
import {uiSettings} from './config/ui-settings.js';
import {RoundNotifier} from './tui/terminal/notify.js';
import {terminalFocus} from './tui/terminal/focus.js';
import {UsageLedger} from './context/usage.js';
import {ContextManager} from './context/manager.js';
import {createAgent} from './kernel/agent.js';
import {cacheLifetimeMs, roleCacheRetention} from './providers/cache.js';
import {getScratchpadDir, ensureScratchpadDir} from './kernel/scratchpad.js';
import {ProviderRegistry} from './providers/registry.js';
import {LoginFlow} from './providers/login.js';
import {askPreferredName} from './providers/login-wizard.js';
import {createProviderManagement} from './providers/management.js';
import {loadUserName, saveUserName, setUserLabel} from './config/user-profile.js';
import {readOnboardingPrefs, markOnboardingDone, markOnboardingSkipped, shouldOfferOnboarding, ONBOARDING_VERSION} from './config/onboarding-preferences.js';
import {ModelPool} from './providers/model-pool.js';
import {ensureProjectBulletin} from './actors/bulletin.js';
import {RuntimeStore} from './runtime/store.js';
import {Journal} from './store/journal.js';
import type {SubmitDelivery} from './runtime/delivery.js';
export type {SubmitDelivery} from './runtime/delivery.js';
import type {PermissionEngine} from './permissions/engine.js';
import {Tools} from './tools/tools.js';
import {USER_STOP_REASON, killActiveProcess, killActivityProcesses, killBackgroundJobs} from './tools/process.js';
import {createManagedApplication} from './application-sessions.js';
import type {Provider} from './runtime/messages.js';
import {SystemHistory} from './store/system-history.js';
import {StatusbarPreferences} from './config/statusbar-preferences.js';
import {ToolRegistry} from './tools/registry.js';
import {applyTheme} from './tui/appearance/theme.js';
import type {CommandContext} from './commands.js';
import {createModelSelection} from './commands/model-selection.js';
import {createProvidersPage} from './commands/providers-page.js';
import {createCommandContext} from './commands/command-context.js';
import {createPages, loadUiPreferences} from './commands/pages.js';
import {createSessionStatus} from './app/status.js';
import {createRequestAssembly} from './app/request.js';
import {createInput} from './app/input.js';
import {createSubmit} from './app/submit.js';
import {recoverCheckpoints, replaySession} from './app/restore.js';
import type {SessionState} from './app/state.js';

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
  const stateDir = join(cwd, '.logox', 'state'), session = options.sessionId;
  const initialSelection = registry.selection();
  const commands = new AbortController();
  const store = new RuntimeStore(), journal = new Journal(join(stateDir, 'sessions'));
  const deliveries = new DeliveryQueue(session, journal);
  const resources = extensions.resources;
  const systems = new SystemHistory(session, store, journal, options.isPersistent);
  const statusbar = new StatusbarPreferences(options.statusbarPath ?? join(options.resourceOptions?.home ?? homedir(), '.logox', 'statusbar.json'));
  const state: SessionState = {closed: false, commandOwner: DIRECTOR_ID, loginOwner: DIRECTOR_ID, pageOwner: DIRECTOR_ID, activeCommandPage: '',
    userName: undefined, compactTask: undefined, reloadTask: undefined, permissionTask: undefined};
  const notice = (text: string, kind: Parameters<SystemHistory['emit']>[1] = 'command_result', owner = state.commandOwner, activityId?: string,
    display: NonNullable<Parameters<SystemHistory['emit']>[5]> = {}) => {
    const presentation = display.presentation ?? 'timeline';
    systems.emit(text, kind, owner, activityId, true, {...display, presentation});
    extensions.hooks.emit('notification', {session_id: session});
  };
  const receipt = (text: string, presentation: 'silent' | 'status' | 'panel', title?: string, owner = state.commandOwner) => {
    notice(text, 'command_result', owner, undefined, {presentation, ...(title ? {title} : {})});
    if (presentation === 'panel') surfaces.openResult(title ?? 'Command result', text, {sessionId: session, ownerId: owner});
  };
  const queryResult = async (owner: string, title: string, query: () => Promise<string | {text: string; lines: readonly ResultLine[]} | undefined>) => {
    const id = surfaces.openResult(title, 'Loading...', {sessionId: session, ownerId: owner});
    try {
      const result = await query();
      if (state.closed) return;
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
  const directorReports = new Map<string, string>();
  const homeDir = options.resourceOptions?.home ?? homedir();
  // The preferred name is application-owned; the timeline label is synced from it (renderers read the live label).
  setUserLabel(undefined);
  const profileReady = loadUserName(homeDir).then(name => {state.userName = name; setUserLabel(name);});
  const toolRegistry = new ToolRegistry(cwd, homeDir);
  await toolRegistry.reloadUserConfigs();
  tools.setRegistry(toolRegistry);
  tools.setActivityProbe(() => store.getSnapshot().activities);
  const modelPool = new ModelPool(registry, join(homeDir, '.logox', 'models-store.json'));
  void modelPool.loadCache().catch(() => {});
  const taskModelLedger = new TaskModelLedger(join(stateDir, 'task-models'));
  const taskModels = new TaskModels({registry, ledger: taskModelLedger,
    defaultModel: owner => actors.modelStorage.get(owner) ?? actors.find(owner)?.defaultModel,
    defaultFallbackModel: () => {
      const active = registry.selection();
      if (active && registry.names().includes(active.provider)) return {provider: active.provider, model: active.model};
      return undefined;
    },
    provider: (_selection, provider) => options.provider ?? provider,
    checkpoint: async checkpoint => {
      const activity = store.activities.get(session, checkpoint.activityId);
      if (activity && !['completed', 'failed', 'cancelled'].includes(activity.status)) store.activities.update(session, checkpoint.activityId,
        {taskModel: {initial: checkpoint.initial, actual: checkpoint.actual, inherited: checkpoint.inherited, switched: checkpoint.switched, phase: checkpoint.phase}});
    },
    summaryModel: identity => {
      const policy = actorServices.policy(identity.ownerId);
      if (!policy.summary_provider && !policy.summary_model) return undefined;
      return {provider: policy.summary_provider ?? taskModels.selection(identity).provider,
        model: policy.summary_model ?? taskModels.selection(identity).model};
    },
  });
  void ensureProjectBulletin(cwd);
  // Tasks, compaction, reload, a model save or a permission save each make the session busy; a switch of model or provider waits for idle.
  const busy = () => ensemble.isBusy() || !!state.compactTask || modelSelection.isSelecting() || !!state.reloadTask || !!state.permissionTask;
  const requireIdle = () => {if (busy()) throw new Error('Tasks are running. Please wait for completion or cancel before switching models or providers.');};
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
    coordinationPath: join(stateDir, 'actor-coordination', createHash('sha256').update(session).digest('hex') + '.json'),
    approve: (context, review) => tools.permissionGuard(context).authorize({tool: 'craft_actor', paths: [review.path], risky: false, effect: 'write'},
      {path: review.path, content: review.content, previous: review.previous ?? null}, context),
    authorize: (call, context) => tools.authorizeExtension(call, context, 'read'),
    modelResolver: (actorId: string) => {
      const identity = {sessionId: session, ownerId: actorId};
      const configured = (isDirector(actorId) ? undefined : actors.modelStorage.get(actorId) ?? actors.find(actorId)?.defaultModel) ?? registry.selection();
      try {
        // A running task reports what it runs with; otherwise the model and effort the next task would start with (so a saved binding shows at once).
        const running = store.getSnapshot().activities.some(activity => activity.sessionId === session && activity.ownerId === actorId && activity.taskModel && ['running', 'waiting_input', 'queued', 'paused'].includes(activity.status));
        const sel = running ? taskModels.selection(identity) : taskModels.idleSelection(actorId);
        const th = running ? taskModels.thinking(identity) : taskModels.thinkingOf(sel);
        return {provider: sel.provider, model: sel.model, effort: th.effort, levels: th.levels};
      } catch {
        // Display remains available before model selection or when a provider is unavailable.
        return configured.model.trim() ? {provider: configured.provider, model: configured.model} : undefined;
      }
    },
    modelPool,
  });
  const contexts = new ContextManager({journal, pricing: config, cwd,
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
    if (result.message && !state.closed) notice(result.message, result.kind ?? 'command_result', completion.ownerId ?? state.commandOwner, undefined,
      // A dismissed surface cannot show feedback: its late failure surfaces in the timeline, its late success stays silent.
      {presentation: !completion.active ? result.kind === 'command_error' ? 'timeline' : 'silent' : result.presentation ?? 'status',
        ...(result.title ? {title: result.title} : {})});
  }, () => ({sessionId: session, ownerId: state.commandOwner}));
  let surfaceError = '';
  const stopSurfaceErrors = surfaces.subscribe(() => {
    const current = surfaces.getSnapshot();
    const error = current && 'error' in current ? current.error : undefined;
    const key = error ? current!.id + ':' + error : '';
    const changed = Boolean(error && key !== surfaceError);
    // Recording the event refreshes the page synchronously; latch before publishing.
    surfaceError = key;
    if (error && changed) notice(error, 'command_error', current?.ownerId ?? state.commandOwner, undefined, {presentation: 'silent'});
  });
  const modelSelection = createModelSelection({registry, preferences, homeDir, initial: initialSelection, modelPool, tools, actors, actorServices,
    resources, surfaces, signal: commands.signal, receipt, requireIdle, isEnsembleBusy: () => ensemble.isBusy()});
  const authentication = new LoginFlow(registry.auth, async provider => {
    const owner = state.loginOwner;
    // A saved key or finished account sign-in always belongs to a provider record.
    await registry.ensureTemplateRecord(provider).catch(() => {});
    try {await modelSelection.saveSelection(registry.candidate(provider));}
    catch {notice('API key saved; model preference was not updated. The current model is unchanged.', 'command_error', owner);}
    await modelPool.syncProvider(provider).catch(() => {});
    receipt('API key saved for ' + provider + '.', 'status', undefined, owner);
  }, (input, init) => registry.fetcher(input, init));
  const providers = createProviderManagement({registry, modelPool, actors, actorServices, tools, config, env: options.env ?? process.env, authentication,
    signal: commands.signal, selection: modelSelection.current, saveSelection: modelSelection.saveSelection, notice, receipt});
  let loginError = '';
  const stopLoginErrors = authentication.subscribe(() => {
    sessionStatus.refreshSubscriptions();
    const current = authentication.getSnapshot();
    const key = current?.error ? current.provider + ':' + current.error : '';
    const changed = Boolean(current?.error && key !== loginError);
    loginError = key;
    if (current?.error && changed) notice(current.error, 'command_error', state.loginOwner, undefined, {presentation: 'silent'});
  });
  const extraTools = [...actorServices.definitionsForValidation(), ...extensions.mcp.definitions()];
  const sessionStatus = createSessionStatus({session, cwd, stateDir, config, store, actors, registry, taskModels, contexts, permissions, statusbar, usage});
  const {requestBase, keepAlive} = createRequestAssembly({session, cwd, stateDir, config, state, store, journal, deliveries, tools, toolRegistry, registry,
    modelPool, actors, actorServices, taskModels, contexts, permissions, extensions, profileReady, directorReports,
    configureMeter: sessionStatus.configureMeter});
  const dumpRequests = process.env.LOGOX_DUMP_REQUESTS === '1';
  const ensemble = new DynamicEnsemble(session, store, journal, observeTasks(extensions.hooks, createAgent({
    cwd, store, tools, context: contexts, taskModels, requestBase, provider: () => options.provider ?? registry.provider(), keepAlive,
    ...(config.kernel.request_fingerprints ? {requestFingerprintFile: (context: {sessionId: string; ownerId: string}) => join(stateDir, 'sessions', context.sessionId, 'requests', context.ownerId + '.fingerprints.jsonl')} : {}),
    ...(dumpRequests ? {requestDumpDir: (context: {sessionId: string; ownerId: string}) => join(stateDir, 'sessions', context.sessionId, 'requests', context.ownerId)} : {}),
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
    roundStart: async (context, info) => {
      // The Anthropic protocol binds replayed thinking to every earlier message (`appendOnlyHistory`); unknown settings count as such.
      let appendOnly = true;
      try {const selection = taskModels.selection(context); appendOnly = registry.configuredSettings(selection.provider, selection.model).kind === 'anthropic';} catch {}
      await contexts.roundStart(context, await requestBase(context), context.signal, info, appendOnly);
    },
    handoff: result => state.closed ? Promise.resolve() : actorServices.handoff(result),
    directAnchor: async result => {
      const text = `Direct conversation with ${result.ownerId} (${result.activityId}) settled as ${result.status}. Use ReadActor for details if needed.`;
      notice(text, 'task_notice', DIRECTOR_ID);
    },
    settled: async (activityId, status) => {directorReports.delete(activityId); await actorServices.settled(activityId, status);},
  });
  const recovered = await recoverCheckpoints({session, journal, actors, actorServices, taskModels, taskModelLedger, configureMeter: sessionStatus.configureMeter});
  const {checkpoints, owners} = recovered;
  const ui = loadUiPreferences(homeDir, config);
  const providersPage = createProvidersPage({registry, modelPool, management: providers, signal: commands.signal, selection: modelSelection.current,
    isEnsembleBusy: () => ensemble.isBusy(), commandOwner: () => state.commandOwner, refreshPage: () => pages.refreshCurrentPage()});
  const buildContext = createCommandContext({session, config, state, store, permissions, tools, statusbar, extensions, contexts, taskModels,
    status: sessionStatus, actors, providersPage, selection: modelSelection.current});
  const pages = createPages({cwd, homeDir, config, state, store, surfaces, statusbar, permissions, ui, actors, actorServices, toolRegistry,
    extensions, registry, modelPool, modelSelection, providersPage, status: sessionStatus, buildContext, profileReady});
  // Store changes and status bumps (usage recorded, subscriptions found) both refresh an open page, so `/usage` grows with the session.
  const stopPageUpdates = sessionStatus.subscribe(() => {if (pages.pageIsOpen()) pages.refreshCurrentPage();});
  // `Notify when done`: a bell or OSC 9 notification when a stretch of work longer than 30 s ends (see `tui/terminal/notify.ts`).
  const roundNotifier = new RoundNotifier({sessionId: session, mode: () => uiSettings().notify, focused: terminalFocus,
    write: data => {if (process.stdout.isTTY) process.stdout.write(data);}});
  const stopNotifier = store.subscribe(() => {roundNotifier.observe(store.getSnapshot());});
  const stopPermissions = tools.configurePermissions(session, {
    reviewer: () => {const selected = registry.selection(); return {provider: options.provider ?? registry.provider(), model: JSON.stringify([selected.provider, selected.model])};},
    charge: async (context, amount, model) => {await sessionStatus.configureMeter(context.ownerId); contexts.meter(context).chargeUsage(amount, model, 'approval');},
    changed: () => {if (pages.pageIsOpen()) pages.refreshCurrentPage();},
  });
  const stopPermissionPolicy = permissions.subscribe(() => {
    sessionStatus.bumpStatus();
    for (const request of store.interactions.list()) if (request.status === 'pending' &&
      (request.kind === 'permission' || request.kind === 'question' && request.title === 'Approval failed; action paused')) {
      store.interactions.cancel(request.requestId, 'Permissions changed; pending actions will be re-evaluated');
    }
    if (pages.pageIsOpen()) pages.refreshCurrentPage();
  });
  surfaces.subscribe(() => {
    if (!surfaces.getSnapshot()) state.activeCommandPage = '';
  });
  const replayed = await replaySession({session, journal, store, ensemble, actors, actorServices, notice, ...recovered});
  const welcomeTitle = 'Session ' + session;
  const welcomeSelection = modelSelection.current();
  const welcomeBody = welcomeSelection.model
    ? `${welcomeSelection.provider}/${welcomeSelection.model} · Type /help for assistance`
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
  const input = createInput({session, state, store, ensemble, actorServices, systems, notice, beforeTask: options.beforeTask});
  const submitCommand = createSubmit({session, cwd, homeDir, state, env: options.env ?? process.env, resourceOptions: options.resourceOptions, store, journal,
    surfaces, authentication, ensemble, permissions, tools, toolRegistry, actors, actorServices, resources, contexts, registry, modelPool, owners,
    profileReady, signal: commands.signal, notice, receipt, queryResult, input, modelSelection, providers, pages, buildContext,
    sessionCommand: options.sessionCommand, requireIdle});
  return {
    sendPendingNow: input.sendPendingNow, discardPending: input.discardPending,
    sessionId: session, store, ensemble, journal, tools, permissions, authentication, surfaces, contexts, extensions, resources, actors, taskModels, statusbar,
    status: sessionStatus.status, isBusy: busy,
    systemNotice: notice,
    getInputQueue: (ownerId?: string) => ({queued: ensemble.queuedInputs(ownerId), steering: deliveries.snapshot().filter(item =>
      item.kind === 'human_steer' && item.status === 'pending' && (!ownerId || item.ownerId === ownerId))}),
    getStatusSnapshot: sessionStatus.revision,
    subscribeStatus: sessionStatus.subscribe,
    async recordError(error: unknown, owner = DIRECTOR_ID) {
      notice(error instanceof Error ? error.message : String(error), 'command_error', owner);
      await systems.flush();
    },
    activate() {
      extensions.hooks.emit('session_start', {session_id: session, model: modelSelection.current().model});
      const isTest = typeof (globalThis as any).IS_REACT_ACT_ENVIRONMENT !== 'undefined' ||
        process.execArgv.some(arg => arg.startsWith('--test'));
      const onboardingPrefs = readOnboardingPrefs(homeDir);
      if (shouldOfferOnboarding(onboardingPrefs) && !modelSelection.current().model && !checkpoints.length && session !== 'demo' && !isTest && Boolean(process.stdout.isTTY)) {
        void (async () => {
          if (!ensemble.isBusy() && !authentication.getSnapshot()) {
            state.loginOwner = DIRECTOR_ID;
            // Optional first step: Enter on an empty field or Esc skips it and setup continues.
            const preferred = await askPreferredName(authentication.ask);
            if (preferred) {state.userName = await saveUserName(homeDir, preferred).catch(() => state.userName); setUserLabel(state.userName);}
            const outcome = await providers.loginWizard(DIRECTOR_ID);
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
    commandContext: (): CommandContext => modelSelection.completionContext(),
    noteDraft() {},
    /** Stops one running tool call (its child process) without ending the owner's step; false when the call is not cancellable or already done. */
    cancelTool(callId: string): boolean {return killActiveProcess(callId, USER_STOP_REASON, 'user');},
    cancel(activityId: string) {if (state.compactTask?.activityId === activityId) state.compactTask.controller.abort(); else {
      const director = store.activities.get(session, activityId)?.ownerId === DIRECTOR_ID;
      if (director) actorServices.stopDirector(activityId); else actorServices.stopActor(activityId);
      // Stopping Logox leaves its companions running; the interrupt marker names them so the next message can redirect or cancel them.
      const working = director ? workingNames(roundScope(store.getSnapshot().activities, session).actors, id => actors.list().find(item => item.id === id)?.name ?? id) : [];
      ensemble.cancel(activityId, 'user', working.length ? working.join(', ') : undefined);
      // Foreground commands die with the user reason; background Shell jobs of the stopped activity go with it.
      killActivityProcesses(activityId, USER_STOP_REASON, 'user'); killBackgroundJobs(activityId);
    }},
    async close() {
      state.closed = true; actorServices.close(); keepAlive.dispose(); commands.abort(); surfaces.close(); stopPageUpdates(); stopNotifier(); store.interactions.close(); state.compactTask?.controller.abort();
      try {
        await Promise.all([authentication.close(), ensemble.close(), state.compactTask?.done, state.reloadTask, state.permissionTask, sessionStatus.meterRestore, sessionStatus.subscriptionsDone(), permissions.flushStats()]);
        await Promise.allSettled([modelSelection.selectionDone()]); await actorServices.flush(); await usage.flush(); await systems.flush(); await replayed.heldTail();
      } finally {replayed.stopHeld(); await sessionStatus.closeGit(); stopPermissionPolicy(); stopPermissions(); stopSystemUpdates(); input.stopPending(); stopSurfaceErrors(); stopLoginErrors();}
    },
    async submit(raw: string, source = DIRECTOR_ID, inputDelivery: SubmitDelivery = {mode: 'queue'}): Promise<void> {
      await submitCommand(raw, source, inputDelivery);
    },
  };
}

export async function createApplication(options: ApplicationOptions) {
  return createManagedApplication(options, createSessionApplication);
}
