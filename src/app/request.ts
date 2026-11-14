/**
 * Model request assembly for every actor of a session. Wires the Automa worker environment and the cache keep-alive, and
 * builds the `requestBase` the agent kernel and the context manager call before each round: role prompt, environment
 * baseline and updates, and task-state slots (restriction, pending handoff and the one-off ensemble record). It owns the environment
 * state (what the model was last told about its surroundings); it reads, never writes, the preferred name.
 */
import {join} from 'node:path';
import type {ActorCatalog} from '../actors/catalog.js';
import type {ActorServices} from '../actors/services.js';
import type {DeliveryQueue} from '../actors/delivery-queue.js';
import type {TaskModels} from '../actors/task-models.js';
import type {Config} from '../config/config.js';
import {turnUsageOf} from '../context/cost.js';
import {sessionLanguage} from '../context/language.js';
import {EnvironmentState, environmentVersion, formatEnvironment} from '../context/environment.js';
import type {ContextManager} from '../context/manager.js';
import type {ProjectExtensions} from '../extensions/runtime.js';
import {mcpRegistrations} from '../extensions/runtime.js';
import {agentRequestBase, type AgentAssembly, type createAgent} from '../kernel/agent.js';
import {CacheKeeper} from '../kernel/cache-keepalive.js';
import {getActorScratchpadDir, ensureActorScratchpadDir} from '../kernel/scratchpad.js';
import type {PermissionEngine} from '../permissions/engine.js';
import {certainToWake, openWork} from '../actors/facts.js';
import {FALLBACK_CAPABILITIES} from '../providers/capabilities.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderRegistry} from '../providers/registry.js';
import {PENDING_HANDOFF_HEADER, REVOCATION_RESTRICTION, TOOLS_RESTRICTED_RESULT} from '../prompts/runtime/environment.js';
import {asksFor} from '../runtime/asks.js';
import {createRuntimeContextMessage, type RuntimeContextMessage} from '../runtime/context-updates.js';
import {isDirector} from '../runtime/director-id.js';
import {permissionModes} from '../runtime/permission-mode.js';
import type {RuntimeStore} from '../runtime/store.js';
import {storedMessage, type Journal} from '../store/journal.js';
import {markInterruptedJobs} from '../tools/orchestration/AutomaTool/AutomaTool.js';
import {chooseAutomaModel} from '../tools/orchestration/AutomaTool/preset.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {Tools} from '../tools/tools.js';
import type {SessionState} from './state.js';

export interface RequestAssemblyDeps {
  session: string; cwd: string; stateDir: string; config: Config; state: SessionState;
  store: RuntimeStore; journal: Journal; deliveries: DeliveryQueue; tools: Tools; toolRegistry: ToolRegistry;
  registry: ProviderRegistry; modelPool: ModelPool; actors: ActorCatalog; actorServices: ActorServices;
  taskModels: TaskModels; contexts: ContextManager; permissions: PermissionEngine; extensions: ProjectExtensions;
  /** Resolves once the preferred name has loaded. */
  profileReady: Promise<void>;
  /** The Director's open task reports by activity id, written by the ensemble hooks and drained here. */
  directorReports: ReadonlyMap<string, string>;
  configureMeter(ownerId: string): Promise<void>;
}

export function createRequestAssembly(deps: RequestAssemblyDeps) {
  const {session, cwd, stateDir, config, state, store, journal, deliveries, tools, toolRegistry, registry, modelPool, actors, actorServices,
    taskModels, contexts, permissions, extensions, profileReady, directorReports, configureMeter} = deps;
  const resources = extensions.resources;
  const environment = new EnvironmentState();
  const automaJournal = (sessionId: string) => join(stateDir, 'sessions', sessionId, 'subagents', 'automa.jsonl');
  void markInterruptedJobs(automaJournal(session));
  tools.setAutomaEnvironment({
    resolveModel: preferred => {
      const session = registry.selection();
      const chosen = chooseAutomaModel({dedicated: tools.modelStorage.get('automa'), preferred, session, pool: modelPool.snapshot(),
        expand: name => modelPool.resolveShorthand(name, session.provider)});
      return {provider: registry.candidate(chosen.provider, chosen.model, chosen.effort).provider(), model: chosen.provider + '/' + chosen.model};
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
      ...(language ? {language} : {}), ...(state.userName ? {userName: state.userName} : {})}, history);
    const base = await agentRequestBase(cwd, context.ownerId, mcpRegistrations(extensions.mcp),
      resources, {prompt: role.prompt, execution: role.execution, collaboration: role.collaboration,
        compression: role.compression, visibility: policy}, true, actorScratchpad, formatEnvironment(effective.baseline), toolRegistry, {...assembly, history});
    const contextUpdates: RuntimeContextMessage[] = [...effective.updates, ...base.contextUpdates ?? []];
    const restriction = context.recovery?.exhausted && !context.recovery.key.startsWith('execution:') ? REVOCATION_RESTRICTION : '';
    const pending = directorReports.get(context.activityId);
    await actorServices.flush();
    // After a fold or a restart the actor gets one stored record of the ensemble (never one per request); an identical latest record means it is already there.
    const record = actorServices.restoreRecord(context);
    if (record) {
      if (history.findLast(message => message.role === 'context' && message.kind === 'task-state' && message.data?.slot === 'ensemble')?.text === record) actorServices.recordStored(context.ownerId);
      else contextUpdates.push(createRuntimeContextMessage('task-state', record, {slot: 'ensemble'}));
    }
    for (const [slot, text] of [['restriction', restriction], ['handoff', pending ? PENDING_HANDOFF_HEADER + '\n' + pending : '']] as const) {
      const previous = history.findLast(message => message.role === 'context' && message.kind === 'task-state' &&
        message.data?.slot === slot && message.data?.activityId === context.activityId);
      if (text || previous?.text) contextUpdates.push(createRuntimeContextMessage('task-state', text || 'No current ' + slot + '.', {slot, activityId: context.activityId}));
    }
    return {...base, contextUpdates, ...(restriction ? {refuseTools: TOOLS_RESTRICTED_RESULT} : {}), ...(role.cacheRetention ? {cacheRetention: role.cacheRetention} : {})};
  };
  return {requestBase, keepAlive};
}
