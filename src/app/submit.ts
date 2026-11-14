/**
 * The command dispatcher behind `Application.submit`: admission rules (what blocks input while a save, reload, compaction
 * or login is running), steering of a running task, then the slash commands (`/login`, `/permissions`, `/model`, `/name`,
 * `/settings`, `/reload`, `/providers`, `/compact`, `/undo`, `/doctor`, `/cast`, custom templates), `@actor` routing and
 * plain prompts. Commands whose behaviour belongs to a service group delegate to it (model forms, pages, provider wizard);
 * this module only decides which one runs. It holds no state of its own: the in-flight tasks live in the session state.
 */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ActorCatalog} from '../actors/catalog.js';
import type {DynamicEnsemble} from '../actors/ensemble.js';
import type {ActorServices} from '../actors/services.js';
import {createCommandTabsFor} from '../application-commands.js';
import type {SubmitDelivery} from '../runtime/delivery.js';
import {submitDeliverySchema} from '../runtime/delivery.js';
import type {CommandContextBuilder} from '../commands/command-context.js';
import type {ModelSelection} from '../commands/model-selection.js';
import type {Pages} from '../commands/pages.js';
import type {CommandSurfaces} from '../commands/surfaces.js';
import {rowText} from '../commands/tab-rows.js';
import {loadConfig} from '../config/config.js';
import {effortSchema} from '../config/model-preferences.js';
import {markOnboardingDone, markOnboardingSkipped, ONBOARDING_VERSION} from '../config/onboarding-preferences.js';
import {sanitizeUserName, saveUserName, setUserLabel, USER_NAME_MAX_CELLS} from '../config/user-profile.js';
import type {ContextManager} from '../context/manager.js';
import type {ResourceOptions, Resources} from '../resources/manager.js';
import {reloadResources} from '../resources/reload.js';
import {agentRequestBase} from '../kernel/agent.js';
import {getActorScratchpadDir} from '../kernel/scratchpad.js';
import type {LoginFlow} from '../providers/login.js';
import type {ProviderManagement} from '../providers/management.js';
import type {ModelPool} from '../providers/model-pool.js';
import type {ProviderRegistry} from '../providers/registry.js';
import {permissionDecisionSchema, permissionModeSchema, permissionScopeSchema, type PermissionEngine} from '../permissions/engine.js';
import type {ResultLine} from '../runtime/command-surface.js';
import {isDirector} from '../runtime/director-id.js';
import {permissionModes} from '../runtime/permission-mode.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {Journal} from '../store/journal.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {Tools} from '../tools/tools.js';
import {palette} from '../tui/appearance/theme.js';
import type {InputDelivery} from './input.js';
import type {Notice, Receipt, SessionState} from './state.js';

export interface SubmitDeps {
  session: string; cwd: string; homeDir: string; state: SessionState; env: NodeJS.ProcessEnv; resourceOptions: ResourceOptions | undefined;
  store: RuntimeStore; journal: Journal; surfaces: CommandSurfaces; authentication: LoginFlow; ensemble: DynamicEnsemble;
  permissions: PermissionEngine; tools: Tools; toolRegistry: ToolRegistry; actors: ActorCatalog; actorServices: ActorServices;
  resources: Resources; contexts: ContextManager; registry: ProviderRegistry; modelPool: ModelPool;
  /** Every owner the session has a ledger for; `/undo` walks them. */
  owners: readonly string[];
  profileReady: Promise<void>;
  signal: AbortSignal;
  notice: Notice; receipt: Receipt;
  queryResult(owner: string, title: string, query: () => Promise<string | {text: string; lines: readonly ResultLine[]} | undefined>): Promise<void>;
  input: Pick<InputDelivery, 'beginTask' | 'dispatchInput' | 'ownerIsBusy'>;
  modelSelection: Pick<ModelSelection, 'isSelecting' | 'saveSelection' | 'saveEffort' | 'openThinking' | 'openModels' | 'modelCommand' | 'rememberProvider' | 'current'>;
  providers: Pick<ProviderManagement, 'wizardRows' | 'loginWizard' | 'removeProvider'>;
  pages: Pick<Pages, 'openSettings' | 'openEnsemble' | 'pageActions'>;
  buildContext: CommandContextBuilder;
  sessionCommand(text: string): Promise<boolean>;
  requireIdle(): void;
}

export function createSubmit(deps: SubmitDeps) {
  const {session, cwd, homeDir, state, env, resourceOptions, store, journal, surfaces, authentication, ensemble, permissions, tools, toolRegistry,
    actors, actorServices, resources, contexts, registry, owners, profileReady, signal, notice, receipt, queryResult, input, modelSelection,
    providers, pages, buildContext, sessionCommand, requireIdle} = deps;
  const {beginTask, dispatchInput, ownerIsBusy} = input;
  /** `/providers check` and `/check-provider`: one request against the session provider, reported in a result panel. */
  const checkProvider = async (source: string) => {
    if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before checking provider.');
    const selection = registry.selection();
    await queryResult(source, 'Provider check', async () => {
      const result = await registry.check(signal);
      return 'Provider check succeeded: ' + selection.provider + ' / ' + selection.model + '\n' + result.text + '\nLatency: ' + result.elapsedMs + ' ms';
    });
  };
  return async function submit(raw: string, source: string, inputDelivery: SubmitDelivery): Promise<void> {
    const text = raw.trim();
    if (!text || state.closed) return;
    if (state.permissionTask) throw new Error('Permissions are saving, please wait...');
    if (modelSelection.isSelecting()) throw new Error('Model settings are saving, please try again shortly...');
    if (state.reloadTask) throw new Error('Resources are reloading, please wait...');
    if (state.compactTask) throw new Error('Context is compacting, please wait or cancel...');
    const previousSurface = surfaces.getSnapshot();
    if (previousSurface) {
      if (text.startsWith('/') || previousSurface.kind === 'result' && previousSurface.ownerId && previousSurface.ownerId !== source) {
        surfaces.close();
      } else {
        throw new Error('Please close the current command pane first');
      }
    }
    if (authentication.getSnapshot()) throw new Error('Authentication is in progress, please complete or cancel first');
    state.commandOwner = source;
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
    if (/^\/(new|resume|clear|rewind)(?:\s|$)/.test(text) && await sessionCommand(text)) return;
    if (text === '/setup' || text === '/login' || text.startsWith('/login ')) {
      if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before logging in.');
      state.loginOwner = source;
      const target = text.startsWith('/login ') ? text.slice(7).trim() : '';
      // A known provider jumps to its key flow, account flow or edit menu in the wizard; any other name is an error.
      if (target && !(await providers.wizardRows()).some(row => row.name === target)) throw new Error("Unknown provider '" + target + "'. Run /login to choose a provider or add a custom endpoint.");
      const outcome = await providers.loginWizard(source, target || undefined);
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
      state.permissionTask = (async () => {
        const parts = text.slice(13).trim().split(/\s+/);
        if (parts[0] === 'mode') {if (parts.length !== 2) throw new Error('Usage: /permissions mode default|auto|creative'); await permissions.setMode(permissionModeSchema.parse(parts[1]));}
        else if (parts[0] === 'revoke' && parts.length === 2) await permissions.revoke(parts[1]!);
        else if (parts[0] === 'add' && parts.length >= 5) await permissions.add({scope: permissionScopeSchema.parse(parts[1]), decision: permissionDecisionSchema.parse(parts[2]), tool: z.string().min(1).parse(parts[3]), pattern: parts.slice(4).join(' ')});
        else throw new Error('Run /permissions to view usage');
        receipt('Permissions updated.', 'status', undefined, source);
      })();
      try {await state.permissionTask;} finally {state.permissionTask = undefined;}
      return;
    }
    if (text.startsWith('/model ') || text === '/model') {
      await modelSelection.modelCommand(text, source);
      return;
    }
    if (text === '/name' || text.startsWith('/name ')) {
      const arg = text.slice(5).trim();
      if (!arg) {
        receipt(state.userName ? 'Preferred name: ' + state.userName : 'No preferred name set (shown as You). Use /name <new name> to set one.', 'status', undefined, source);
        return;
      }
      const reset = arg === '--reset';
      const next = reset ? undefined : sanitizeUserName(arg);
      if (!reset && !next) throw new Error('Usage: /name <new name> | /name --reset');
      await profileReady;
      try {state.userName = await saveUserName(homeDir, next);}
      catch {throw new Error('Could not save the preferred name; it is unchanged.');}
      setUserLabel(state.userName);
      receipt(state.userName ? 'Preferred name set to ' + state.userName + '.' + (sanitizeUserName(arg) !== arg ? ' (Limited to ' + USER_NAME_MAX_CELLS + ' cells, control characters removed.)' : '') : 'Preferred name cleared.', 'status', undefined, source);
      return;
    }
    if (text === '/help' || text === '/commands') {
      receipt(buildContext().commandsLines.map(rowText).join('\n'), 'panel', 'Help & Commands'); return;
    }
    state.pageOwner = source;
    if (text === '/settings' || text === '/animations') {pages.openSettings(); return;}
    if (text === '/ensemble') {pages.openEnsemble(source); return;}
    const pageSpec = createCommandTabsFor(text, buildContext());
    if (pageSpec) {
      state.activeCommandPage = text;

      surfaces.openPage(pageSpec.title, pageSpec.tabs, pageSpec.initialTab, pages.pageActions(pageSpec.tabs.filter(tab => tab.toggles).length <= 1)); return;
    }
    if (text === '/skills') {
      receipt(resources.skillsFor({actorId: source, skills: actors.find(source)?.skills ?? []}).map(item => item.name + ': ' + item.description + '\n' + item.path).join('\n\n') || 'No skills found', 'panel', 'Skills'); return;
    }
    if (text === '/reload') {
      requireIdle();
      state.reloadTask = queryResult(source, 'Resource reload', async () => {
        const report = await reloadResources(resources, () => loadConfig(cwd, {}, env,
          resourceOptions?.home, resourceOptions?.boundary));
        if (report.prefixChanged) contexts.invalidatePrefix();
        await toolRegistry.reloadUserConfigs();
        const actorState = await actors.reload(); contexts.invalidatePrefix();
        for (const issue of actorState.issues) notice('Actor failed to load: ' + issue.path + ' · ' + issue.reason, 'command_error', source);
        return report.text;
      });
      try {await state.reloadTask;} finally {state.reloadTask = undefined;}
      return;
    }
    const effortCommand = /^\/(?:effort|thinking|think)(?:\s+(\S+))?$/.exec(text);
    if (effortCommand) {
      if (!effortCommand[1]) {modelSelection.openThinking(); return;}
      const effort = effortSchema.safeParse(effortCommand[1]);
      if (!effort.success) throw new Error('Thinking effort: auto/off/low/medium/high/max; see /effort');
      await modelSelection.saveEffort(effort.data); receipt('Thinking effort: ' + effort.data + ' (saved)', 'status', undefined, source); return;
    }
    if (text === '/models') {
      const provider = modelSelection.current().provider;
      await queryResult(source, 'Available models', async () => {
        const models = await registry.models(AbortSignal.any([signal, AbortSignal.timeout(15000)]));
        modelSelection.rememberProvider(provider, models);
        return models.join('\n') || 'Provider returned empty model list';
      }); return;
    }
    if (text.startsWith('/providers ')) {
      const parts = text.replace(/^\/providers\s+/, '').trim().split(/\s+/);
      if (parts[0] === 'check') {await checkProvider(source); return;}
      if (parts[0] === 'unregister' || parts[0] === 'logout') {
        if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before unregistering provider.');
        const target = parts[1];
        if (!target) throw new Error('Usage: /providers unregister <name>');
        await providers.removeProvider(target, source);
        receipt("Provider '" + target + "' unregistered successfully.", 'status', undefined, source); return;
      }
      if (ensemble.isBusy()) throw new Error('Tasks are running. Wait or cancel before switching provider.');
      if (!parts[0] || parts.length > 2) throw new Error('Usage: /providers <name> [model]');
      await modelSelection.saveSelection(registry.candidate(parts[0], parts[1]));
      receipt('Current provider: ' + modelSelection.current().provider + '\nModel: ' + (modelSelection.current().model || 'Select with /model'), 'status', undefined, source); return;
    }
    if (text === '/check-provider') {await checkProvider(source); return;}
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
        } finally {state.compactTask = undefined;}
      })();
      state.compactTask = {activityId, controller, done: operation};
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
      const {runDoctorChecks, doctorLines} = await import('../doctor.js');
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
  };
}
