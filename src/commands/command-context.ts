/**
 * Builds the data record the tabbed command pages (`createCommandTabsFor`) render from: permissions, statusbar, session
 * status and context and token rows, configuration, usage, providers and the command list. Pure assembly over the
 * services it is given; it holds no state and writes nothing. The window being shown is read from the shared session
 * state (`pageOwner`) at build time.
 */
import type {TaskModels} from '../actors/task-models.js';
import type {ApplicationCommandContext} from '../application-commands.js';
import type {SessionState} from '../app/state.js';
import type {SessionStatus} from '../app/status.js';
import {commandHelp} from '../commands.js';
import type {Config} from '../config/config.js';
import type {StatusbarPreferences} from '../config/statusbar-preferences.js';
import type {ContextManager} from '../context/manager.js';
import {planUsageRows, sessionUsageRows, usageTotalRows, type UsagePageInput} from '../context/usage.js';
import type {ActorCatalog} from '../actors/catalog.js';
import {DIRECTOR_ID} from '../runtime/director-id.js';
import type {ProjectExtensions} from '../extensions/runtime.js';
import type {PermissionEngine} from '../permissions/engine.js';
import type {ProviderRegistry} from '../providers/registry.js';
import type {TabLine} from '../runtime/command-surface.js';
import {permissionModes} from '../runtime/permission-mode.js';
import type {RuntimeStore} from '../runtime/store.js';
import type {Tools} from '../tools/tools.js';
import {palette} from '../tui/appearance/theme.js';
import type {ProvidersPage} from './providers-page.js';
import {row} from './tab-rows.js';

export interface CommandContextDeps {
  session: string; config: Config; state: SessionState;
  store: RuntimeStore; permissions: PermissionEngine; tools: Tools; statusbar: StatusbarPreferences; extensions: ProjectExtensions;
  contexts: ContextManager; taskModels: TaskModels; status: Pick<SessionStatus, 'status' | 'sessionUsageRecords' | 'options'>;
  actors: Pick<ActorCatalog, 'list' | 'find'>;
  providersPage: Pick<ProvidersPage, 'rows'>;
  /** The session selection (provider, model, base URL). */
  selection(): ReturnType<ProviderRegistry['selection']>;
}

export type CommandContextBuilder = () => ApplicationCommandContext;

export function createCommandContext(deps: CommandContextDeps): CommandContextBuilder {
  const {session, config, state, store, permissions, tools, statusbar, extensions, contexts, taskModels, status, providersPage, selection} = deps;
  const resources = extensions.resources;
  const contextRows = (): TabLine[] => {
    const identity = {sessionId: session, ownerId: state.pageOwner};
    const reading = contexts.status(identity), shown = status.status(state.pageOwner), usage = shown.usage;
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
  const opened = Date.now();
  /** Everything the `/usage` tabs are built from: each actor's meter in roster order (Director first, then companions, then any other owner that spent), the session start and the subscription providers. */
  const usageInput = (): UsagePageInput => {
    const meters = contexts.sessionMeters(session), known = [DIRECTOR_ID, ...deps.actors.list().map(item => item.id).filter(id => id !== DIRECTOR_ID)];
    const ids = [...known, ...[...meters.keys()].filter(id => !known.includes(id))];
    const times = store.getSnapshot().messages.flatMap(message => message.time === undefined ? [] : [message.time]);
    return {owners: ids.map(id => ({id, name: deps.actors.find(id)?.name ?? id, records: meters.get(id)?.usageRecords() ?? []})), config, now: Date.now(),
      startedAt: Math.min(opened, ...times), subscriptions: status.options.subscriptions?.() ?? new Set<string>()};
  };
  return (): ApplicationCommandContext => {
    const settings = selection(), pageOwner = state.pageOwner;
    return {
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
          row.field('Cumulative approval tokens', status.sessionUsageRecords().filter(record => record.category === 'approval').reduce((sum, record) => sum + record.input + record.output, 0) + ' tokens'),
        ],
        readonly_concurrency: config.permissions.readonly_concurrency,
        approvalTokens: status.sessionUsageRecords().filter(record => record.category === 'approval').reduce((sum, record) => sum + record.input + record.output, 0),
      },
      statusbarModules: statusbar.getSnapshot().modules,
      statusbarAppearance: {style: statusbar.getSnapshot().style, colorScheme: statusbar.getSnapshot().colorScheme, gaugeCells: statusbar.getSnapshot().gaugeCells},
      statusbarStatus: status.status(pageOwner),
      statusLines: (() => {
        const shown = status.status(pageOwner), snapshot = resources.snapshot(), automaModel = tools.modelStorage.get('automa');
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
        const shown = status.status(pageOwner), automaModel = tools.modelStorage.get('automa');
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
        row.field('Session', session),
        ...usageTotalRows(status.sessionUsageRecords(), config),
        row.blank(),
        row.muted('Details: /usage'),
      ],
      usagePage: (() => {
        const input = usageInput(), plan = planUsageRows({...input, selected: [status.status(pageOwner).model?.provider ?? ''].filter(Boolean)});
        return {session: sessionUsageRows(input), ...(plan ? {plan} : {})};
      })(),
      providersLines: providersPage.rows(),
      commandsLines: [...commandHelp().split('\n').map(line => row.text(line)), ...resources.snapshot().commands.map(item => row.text('/' + item.name + ': ' + item.description))],
    };
  };
}
