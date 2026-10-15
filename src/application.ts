import {reloadResources} from './resources/reload.js';
import type {ResourceOptions} from './resources/manager.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import {ProjectExtensions, observeTasks, observeExtra} from './extensions/runtime.js';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {CommandSurfaces} from './commands/surfaces.js';
import type {CommandTab} from './runtime/command-surface.js';
import {commandHelp, type CommandContext} from './commands.js';
import {join} from 'node:path';
import {z} from 'zod';
import {DynamicEnsemble} from './actors/ensemble.js';
import {ActorCatalog} from './actors/catalog.js';
import {ActorServices} from './actors/services.js';
import {TaskModels, TaskModelLedger} from './actors/task-models.js';
import {loadConfig, type Config} from './config/config.js';
import {StateFile, preferenceSchema, effortSchema, type ThinkingEffort} from './config/model-preferences.js';
import {UsageLedger, usageLines} from './context/usage.js';
import {ContextManager} from './context/manager.js';
import {createAgent, agentRequestBase} from './kernel/agent.js';
import {ProviderRegistry} from './providers/registry.js';
import {LoginFlow} from './providers/login.js';
import {RuntimeStore} from './runtime/store.js';
import {Journal} from './store/journal.js';
import {inputKind} from './runtime/provenance.js';
import {PermissionEngine, permissionModeSchema} from './permissions/engine.js';
import {permissionModes} from './runtime/permission-mode.js';
import {Tools} from './tools/tools.js';
import {createManagedApplication} from './application-sessions.js';
import type {Provider} from './runtime/messages.js';
import {SystemHistory} from './store/system-history.js';
import {StatusbarPreferences} from './config/statusbar-preferences.js';
import {stageStatus} from './application-status.js';
import {EnvironmentState, environmentVersion} from './context/environment.js';
import {applyTheme} from './tui/cards.js';

export interface ApplicationOptions {
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  config?: Config;
  provider?: Provider;
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
  const resources = extensions.resources;
  const systems = new SystemHistory(session, store, journal, options.isPersistent);
  const statusbar = new StatusbarPreferences(options.statusbarPath ?? join(options.resourceOptions?.home ?? homedir(), '.logox-ts', 'statusbar.json'));
  let commandOwner = 'logox';
  const notice = (text: string, kind: Parameters<SystemHistory['emit']>[1] = 'command_result', owner = commandOwner, activityId?: string) => {
    systems.emit(text, kind, owner, activityId); extensions.hooks.emit('notification', {session_id: session});
  };
  await systems.restore();
  try {await statusbar.load();} catch (error) {notice(error instanceof Error ? error.message : '状态栏配置无法读取，使用默认布局。', 'command_error');}
  const environment = new EnvironmentState();
  const directorReports = new Map<string, string>();
  let closed = false;
  let compactTask: {activityId: string; controller: AbortController; done: Promise<void>} | undefined;
  let reloadTask: Promise<void> | undefined;
  let permissionTask: Promise<void> | undefined;
  const taskModelLedger = new TaskModelLedger(join(state, 'task-models'));
  const taskModels = new TaskModels({registry, ledger: taskModelLedger,
    defaultModel: owner => actors.find(owner)?.defaultModel,
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
  const actorServices = new ActorServices({sessionId: session, catalog: actors, registry, resources, journal, config,
    requireIdle: () => requireIdle(),
    enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: batch => ensemble.pauseBatch(batch),
    resumeBatch: batch => ensemble.resumeBatch(batch),
    coordinationPath: join(state, 'actor-coordination', createHash('sha256').update(session).digest('hex') + '.json'),
    approve: (context, review) => tools.permissionGuard(context).authorize({tool: 'craft_actor', paths: [review.path], risky: false, effect: 'write'},
      {path: review.path, content: review.content, previous: review.previous ?? null}, context),
    authorize: (call, context) => tools.authorizeExtension(call, context, 'read'),
  });
  const contexts = new ContextManager({journal, policy: identity => actorServices.policy(identity.ownerId), maxOutput: config.provider.max_tokens,
    model: identity => taskModels.model(identity), summarizer: identity => taskModels.summarizer(identity),
    contract: identity => actorServices.contract(identity.ownerId),
    anchors: async identity => identity.ownerId === 'logox'
      ? (await journal.activeTasks(session)).filter(task => task.source === 'direct' && task.ownerId !== 'logox' &&
          ['completed', 'failed', 'cancelled'].includes(task.status)).slice(-16).map(task => ({role: 'user',
          text: `【角色直接对话索引】${task.ownerId} · ${task.activityId} · ${task.status}；需要详情时使用 read_actor。`})) : [],
    report: (identity, text) => notice(text, 'task_notice', identity.ownerId, identity.activityId),
    beforeCompact: (identity, tokens) => extensions.hooks.emit('pre_compact', {session_id: identity.sessionId, owner_id: identity.ownerId, tokens}),
  });
  const surfaces = new CommandSurfaces(result => {if (result.message) notice(result.message);});
  let surfaceError = '';
  const stopSurfaceErrors = surfaces.subscribe(() => {
    const current = surfaces.getSnapshot();
    const key = current?.error ? current.id + ':' + current.error : '';
    if (current?.error && key !== surfaceError) notice(current.error, 'command_error');
    surfaceError = key;
  });
  const authentication = new LoginFlow(registry.auth, () => registry.loginNames(), async provider => {
    try {await saveSelection(registry.candidate(provider));}
    catch {notice('API key 已保存；模型偏好保存失败，当前模型保留。'); return;}
    notice('已保存 ' + provider + ' 的 API key，重启后自动读取。' + (settings.model ? '\n当前模型：' + settings.model : '\n使用 /models 查询，再用 /model 名称选择模型。'));
  });
  let loginError = '';
  const stopLoginErrors = authentication.subscribe(() => {
    const current = authentication.getSnapshot();
    const key = current?.error ? current.provider + ':' + current.error : '';
    if (current?.error && key !== loginError) notice(current.error, 'command_error');
    loginError = key;
  });
  const extraTools = [...actorServices.definitionsForValidation(), ...extensions.mcp.definitions()];
  const meteredOwners = new Set<string>();
  async function configureMeter(ownerId: string) {
    if (meteredOwners.has(ownerId)) return;
    const meter = contexts.meter({sessionId: session, ownerId});
    meter.configureUsage(() => taskModels.summarizer({sessionId: session, ownerId}).model.identity,
      record => usage.record(session, ownerId, record), await usage.read(session, ownerId));
    meteredOwners.add(ownerId);
  }
  const stopPermissions = tools.configurePermissions(session, {
    reviewer: () => {const selected = registry.selection(); return {provider: options.provider ?? registry.provider(), model: JSON.stringify([selected.provider, selected.model])};},
    charge: async (context, amount, model) => {await configureMeter(context.ownerId); contexts.meter(context).chargeUsage(amount, model, 'approval');},
    changed: () => {if (surfaces.getSnapshot()?.kind === 'page') surfaces.updatePage(pageTabs());},
  });
  const stopPermissionPolicy = permissions.subscribe(() => {
    for (const request of store.interactions.list()) if (request.status === 'pending' &&
      (request.kind === 'permission' || request.kind === 'question' && request.title === '审批失败，操作已暂停')) {
      store.interactions.cancel(request.requestId, '权限已变化，重新裁决待执行操作');
    }
    if (surfaces.getSnapshot()?.kind === 'page') surfaces.updatePage(pageTabs());
  });
  const requestBase = async (context: Parameters<ReturnType<typeof createAgent>>[1]) => {
    await configureMeter(context.ownerId);
    const role = actorServices.definition(context);
    const base = await agentRequestBase(cwd, context.ownerId, [...actorServices.tools(context.ownerId), ...extensions.mcp.definitions()],
      resources, {prompt: role.prompt, visibility: actorServices.skills(context)}, false);
    const model = taskModels.selection(context), thinking = taskModels.thinking(context);
    const policy = actorServices.skills(context);
    const permissionRules = permissions.snapshot().map(rule => rule.decision + ' ' + rule.tool + ' ' + rule.pattern).join('；') || '无';
    const effective = environment.update(context.ownerId, {model: model.provider + '/' + model.model,
      effort: thinking.levels.length > 1 ? thinking.effort : '不支持', permission: permissions.mode + ' · ' +
        permissionModes[permissions.mode].description +
        '\n显式规则（运行时仍逐次裁决）：' + permissionRules,
      directory: cwd, tools: base.tools.map(tool => tool.name).sort(), skills: resources.skillsFor(policy).map(skill => skill.name + ' · ' + skill.description).sort(),
      rules: environmentVersion(resources.prompt(policy).context), services: extensions.mcp.status().map(service => service.name + ':' + service.state).sort()});
    if (effective.changes) notice('执行环境已更新：\n' + effective.changes, 'environment_change', context.ownerId, context.activityId);
    const restriction = context.recovery?.exhausted && !context.recovery.key.startsWith('execution:')
      ? '\n本任务同一故障已补救两次，本轮只说明原因、已有进展和下一步，不执行工具或重新派工。工具能力未移除。' : '';
    if (restriction) base.tools = [];
    const pending = directorReports.get(context.activityId);
    if (pending) await actorServices.flush();
    return {...base, system: base.system + '\n当前执行环境（以本次请求为准）：\n' + effective.text +
      restriction + (pending ? '\n待处理角色交接（用户新指示优先）：\n' + pending : '')};
  };
  const ensemble = new DynamicEnsemble(session, store, journal, observeTasks(extensions.hooks, createAgent({
    cwd, store, tools, context: contexts, taskModels, requestBase, provider: () => options.provider ?? registry.provider(),
    iterations: config.kernel.max_iterations, retries: config.kernel.max_retries, readonlyConcurrency: config.permissions.readonly_concurrency,
    supportsVision: registry.selection().kind === 'anthropic' || !registry.selection().model.toLowerCase().includes('deepseek'),
    retryProvider: async (context, error) => {
      const recovery = await actorServices.recovery.next(context.rootActivityId ?? context.activityId, error, context.recovery);
      context.signal.throwIfAborted();
      if (recovery.exhausted) return false;
      notice('网络中断，正在重试；已完成工具结果保留。\n' + error.message,
        'task_notice', context.ownerId, context.activityId);
      return true;
    },
    recoverExecution: (context, kind) => actorServices.recovery.execution(context.rootActivityId ?? context.activityId, kind, context.ownerId),
    executionProgress: (context, fingerprint) => actorServices.recovery.progress(context.rootActivityId ?? context.activityId, fingerprint),
    executionNotice: (context, text) => {if (context.ownerId === 'logox') notice(text, 'task_notice', context.ownerId, context.activityId);},
    resources, extraTools, extraApprovalHandled: extraTools.map(tool => tool.name),
    executeExtra: observeExtra(extensions.hooks, async (call, context) => {
      if (call.name === 'mcp') return extensions.mcp.execute(call, context);
      return actorServices.execute(call, context);
    }),
  })), {
    concurrency: 'actor',
    member: owner => actors.find(owner),
    taskEnd: async context => {await contexts.taskEnd(context, await requestBase(context), context.signal);},
    handoff: result => closed ? Promise.resolve() : actorServices.handoff(result),
    directAnchor: async result => {
      const text = `直接对话 ${result.ownerId} · ${result.activityId} · ${result.status}；详情按需使用 read_actor 查阅。`;
      notice(text, 'task_notice', 'logox');
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
  const requireIdle = () => {if (busy()) throw new Error('任务处理中，请先取消或等待完成，再切换模型或提供商');};
  const saveSelection = async (next: ProviderRegistry) => {
    requireIdle(); selecting = true;
    selectionDone = (async () => {
      try {
        const selection = next.selection();
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
    requireIdle();
    const thinking = registry.thinking();
    void surfaces.openPicker({title: '思考档位', description: '只显示当前模型声明支持的档位；auto 使用服务默认值', current: thinking.effort},
      async () => ({items: thinking.levels.map(id => ({id, label: id}))}), async id => {
        await saveEffort(effortSchema.parse(id)); return {message: '思考档位：' + id + '（已保存）'};
      });
  };
  let pageOwner = 'logox';
  const contextLines = (): string[] => {
    const identity = {sessionId: session, ownerId: pageOwner};
    const usage = contexts.status(identity), spent = contexts.meter(identity).spent;
    let window = '未知，请配置模型 context_window';
    try {window = String(taskModels.model(identity).window) + ' token';} catch {}
    return ['模型窗口：' + window, ...(usage ? ['最近请求输入占用：约 ' + usage.input + ' token',
      '整理触发水位：' + usage.high + ' token；目标：' + usage.low + ' token', '本次输出额度：' + usage.output + ' token'] : ['当前输入占用：尚未发起任务']),
      '已记录的任务、汇总及审批输入 / 输出：' + spent.input + ' / ' + spent.output + ' token'];
  };
  const status = (ownerId: string) => stageStatus({sessionId: session, cwd, store, actors, registry, taskModels, contexts, permissions, config}, ownerId);
  const sessionUsageRecords = () => [...meteredOwners].flatMap(ownerId => contexts.meter({sessionId: session, ownerId}).usageRecords());
  const pageTabs = (): readonly CommandTab[] => [
    {id: 'status', title: '状态', lines: ['会话：' + session + ' · 角色：' + pageOwner, '角色任务固定自己的模型；默认不可用时确认转用',
      '提供商：' + status(pageOwner).model?.provider, '模型：' + (status(pageOwner).model?.model || '尚未选择'),
      '思考档位：' + status(pageOwner).effort, '权限模式：' + permissions.mode, '运行状态：' + status(pageOwner).state,
      '活动任务：' + store.getSnapshot().activities.filter(a => ['queued', 'running', 'waiting_input'].includes(a.status)).length,
      ...contextLines(), '资源来源：', ...resources.snapshot().guidelines.map(item => item.path),
      '技能：' + resources.snapshot().skills.length + '；模板命令：' + resources.snapshot().commands.length,
      ...resources.snapshot().issues.map(item => item.kind + '：' + item.path + ' · ' + item.reason),
      ...extensions.mcp.status().map(item => 'MCP ' + item.name + '：' + item.state)]},
    {id: 'config', title: '配置', lines: ['当前生效配置', '', '提供商：' + settings.provider, '模型：' + (settings.model || '尚未选择'),
      '思考档位：' + registry.thinking().effort, '模型地址：' + settings.baseUrl, 'Temperature：' + config.provider.temperature, '最大输出 token：' + config.provider.max_tokens,
      '请求超时：' + config.provider.timeout + ' 秒', '每轮循环上限：' + config.kernel.max_iterations,
      '连接重试上限：' + config.kernel.max_retries, '', '用 /model、/provider 切换；其他配置修改 config.toml 后重启。']},
    {id: 'usage', title: '用量', lines: ['会话：' + session + ' · 角色：' + pageOwner,
      '会话所有角色合计：' + sessionUsageRecords().reduce((sum, record) => sum + record.input + record.output, 0) + ' token（含审批）',
      ...usageLines(contexts.meter({sessionId: session, ownerId: pageOwner}).usageRecords(), config)]},
    {id: 'statusbar', title: '状态栏', lines: ['Space 开关 · 左右调整顺序 · Enter 保存 · Esc 放弃'], toggles: statusbar.getSnapshot().modules},
    {id: 'animations', title: '动效', lines: ['Space 开关 · Enter 保存 · Esc 放弃', '关闭后保留静态状态和耗时。'], toggles: [{id: 'motion', label: '运行指示与 Actor 呼吸动效', enabled: statusbar.getSnapshot().motion}]},
    {id: 'permissions', title: '权限', color: permissionModes[permissions.mode].color, lines: ['模式：' + permissions.mode + ' · ' + permissionModes[permissions.mode].description, ...tools.permissionGuard({sessionId: session}).lines(), '只读并发：' + config.permissions.readonly_concurrency,
      '会话累计审批：' + sessionUsageRecords().filter(record => record.category === 'approval').reduce((sum, record) => sum + record.input + record.output, 0) + ' token', '', ...permissions.snapshot().map(rule => rule.id + ' · ' + rule.scope + ' · ' + rule.decision + ' · ' + rule.tool + ' · ' + rule.pattern), '', '/permissions mode [default|auto|creative]', '/permissions add session|project allow|deny 工具 模式', '/permissions revoke ID', '路径支持 *、**、?；Shell 使用静态词元前缀。单次许可不学习规则。']},
    actorServices.management.tab(),
    {id: 'commands', title: '命令', lines: [...commandHelp().split('\n'), ...resources.snapshot().commands.map(item => '/' + item.name + '：' + item.description), '', '@角色 后接任务：直接对话；/actors model 角色：设置默认模型',
      'Ctrl+G：角色窗口 · Tab：补全/审批/卡片操作', 'Ctrl+C：复制；连续两次退出 · Esc：返回/停止 Logox · Actor 卡片：停止对应任务 · Ctrl+D：退出']},
  ];
  const stopPageUpdates = store.subscribe(() => {if (surfaces.getSnapshot()?.kind === 'page') surfaces.updatePage(pageTabs());});
  const openModels = () => {
    requireIdle();
    void surfaces.openPicker({title: '选择模型', description: '已登录提供商与已配置本地接口 · 可搜索模型或提供商', current: JSON.stringify([settings.provider, settings.model])},
      async signal => {
        const catalog = await registry.modelCatalog(AbortSignal.any([signal, commands.signal]));
        for (const provider of new Set(catalog.models.map(item => item.provider))) modelCandidates.set(provider, catalog.models.filter(item => item.provider === provider).map(item => item.id));
        return {items: catalog.models.map(item => ({id: JSON.stringify([item.provider, item.id]), label: item.id, description: item.provider})),
          warning: catalog.issues.join(' · ') || (!catalog.models.length ? '没有可用模型；请先 /login 或配置本地接口' : '')};
      }, async id => {
        requireIdle();
        const [provider, model] = z.tuple([z.string(), z.string()]).parse(JSON.parse(id));
        await saveSelection(registry.candidate(provider, model));
        return {message: '当前模型：' + provider + ' / ' + model};
      });
  };
  const openProviders = () => {
    requireIdle();
    void surfaces.openPicker({title: '选择提供商', description: '切换后使用该提供商的默认模型；/model 查看已登录模型', current: settings.provider},
      async () => ({items: registry.names().map(name => ({id: name, label: name}))}), async name => {
        await saveSelection(registry.candidate(name));
        return {message: '当前提供商：' + name + '\n模型：' + (settings.model || '使用 /model 选择')};
      });
  };
  // 恢复实际模型消息；旧 TS 演示账本也能读取，工具不会重新执行。
  const savedRounds = new Map<string, Awaited<ReturnType<Journal['rounds']>>[number]>();
  for (const task of checkpoints) {
    if (['queued', 'running', 'waiting_input', 'paused'].includes(task.status)) {
      await journal.checkpoint(session, {...task, status: 'cancelled', stopReason: 'interrupted'});
      task.status = 'cancelled';
    }
  }
  const restored = (await Promise.all(owners.map(async owner => {
    const entries = await journal.load(session, owner);
    try {for (const round of await journal.rounds(session, owner, entries)) savedRounds.set(round.activityId, round);}
    catch {notice(owner + ' 的轮次摘要无法读取，保留原始消息。');}
    return entries;
  }))).flat().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const entry of restored) {
    const origin = {...(entry.activityId ? {activityId: entry.activityId} : {}), ...(entry.source ? {source: entry.source} : {}),
      inputKind: inputKind(entry), time: entry.time ?? 0};
    const activityId = entry.activityId;
    if (activityId && !store.activities.get(session, activityId)) {
      const round = savedRounds.get(activityId), checkpoint = checkpoints.find(task => task.activityId === activityId);
      const savedModel = savedModels.find(item => item.activityId === activityId);
      store.activities.create({sessionId: session, activityId, ownerId: entry.ownerId, kind: entry.ownerId === 'logox' ? 'director' : 'actor',
        title: entry.text.slice(0, 80) || entry.ownerId, status: round?.status ?? checkpoint?.status ?? 'completed',
        stage: round ? '恢复的' + ({completed: '完成', failed: '失败', cancelled: '取消'}[round.status])
          : checkpoint ? checkpoint.status === 'completed' ? '恢复的完成' : checkpoint.status === 'failed' ? '恢复的失败' : '已中断' : '历史记录',
        detail: checkpoint?.error ? '失败原因：' + checkpoint.error + '\n' + (round?.summary.report ?? '')
          : round?.summary.report ?? (checkpoint ? '恢复任务检查点；工具不会重放' : '历史记录未保存终态；工具不会重放'),
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
    if (entry.message?.role === 'assistant' && (entry.message.reasoning || entry.step)) {
      store.message(session, entry.ownerId, 'assistant', entry.message.reasoning ?? '', {...origin, kind: 'thinking', ...(entry.step ? {step: entry.step} : {})});
    }
    if (entry.text) store.message(session, entry.ownerId, entry.role === 'tool' ? 'notice' : entry.role, entry.message?.role === 'tool' ? entry.message.name + '\n' + entry.text : entry.text,
      {...origin, ...(entry.role === 'tool' ? {kind: 'tool' as const, ...(entry.step ? {step: entry.step} : {})} : {})});
  }
  for (const task of checkpoints) {
    if (store.activities.get(session, task.activityId)) continue;
    store.activities.create({sessionId: session, activityId: task.activityId, ownerId: task.ownerId,
      kind: task.ownerId === 'logox' ? 'director' : 'actor', title: task.prompt.slice(0, 80),
      status: task.status, stage: task.status === 'cancelled' ? '已中断' : '恢复的任务',
      detail: task.error ? '失败原因：' + task.error : '恢复检查点，不自动执行',
      ...(task.progress ? {progress: task.progress} : {}), ...(task.recovery ? {recovery: task.recovery} : {}),
      ...(task.resumeTaskId ? {resumeTaskId: task.resumeTaskId} : {}),
      ...(task.rootActivityId ? {rootActivityId: task.rootActivityId} : {})});
    store.message(session, task.ownerId, 'user', task.prompt, {activityId: task.activityId, source: task.source,
      inputKind: inputKind(task), time: task.time});
  }
  systems.emit('会话 ' + session + '\n' + (settings.model ? settings.model : '尚未设置模型，使用 /model 模型名') + ' · /help 查看操作', 'task_notice', 'logox', undefined, false);
  for (const issue of resources.snapshot().issues) notice('资源未加载：' + issue.path + ' · ' + issue.reason);
  const terminal = new Set(checkpoints.filter(task => ['failed', 'cancelled'].includes(task.status)).map(task => task.activityId));
  const stopSystemUpdates = store.subscribe(() => {
    for (const activity of store.getSnapshot().activities) {
      if (!['failed', 'cancelled'].includes(activity.status) || terminal.has(activity.activityId)) continue;
      terminal.add(activity.activityId);
      notice(activity.status === 'failed' ? '执行失败：' + activity.detail : '任务已停止。',
        activity.status === 'failed' ? 'model_error' : 'task_notice', activity.ownerId, activity.activityId);
    }
  });
  const beginTask = async () => {await options.beforeTask(); await systems.flush();};
  const dispatchInput = async (owner: string, prompt: string, source: string) => {
    const latest = [...store.getSnapshot().activities].reverse().find(activity => activity.ownerId === owner);
    const previous = /^(?:继续|接着|续做)/u.test(prompt) && latest &&
      actorServices.recovery.hasExecution(latest.rootActivityId ?? latest.activityId) ? latest : undefined;
    const rootActivityId = previous?.rootActivityId ?? previous?.activityId;
    if (rootActivityId) await actorServices.recovery.grantExecution(rootActivityId);
    const task = ensemble.dispatch(owner, prompt, source, {inputKind: 'human', ...(rootActivityId ? {rootActivityId} : {}),
      ...(previous?.ownerId === owner && previous.progress ? {resumeTaskId: previous.activityId} : {})});
    const pending = owner === 'logox' ? actorServices.resumeDirector(task.activityId) : '';
    if (pending) directorReports.set(task.activityId, pending);
    return task;
  };
  return {
    sessionId: session, store, ensemble, journal, tools, permissions, authentication, surfaces, contexts, extensions, resources, actors, taskModels, statusbar, status, isBusy: busy,
    systemNotice: notice,
    getStatusSnapshot: () => store.getSnapshot().revision + ':' + statusbar.getSnapshot().revision,
    subscribeStatus(listener: () => void) {const stopStore = store.subscribe(listener), stopPreferences = statusbar.subscribe(listener); return () => {stopStore(); stopPreferences();};},
    async recordError(error: unknown, owner = 'logox') {
      notice(error instanceof Error ? error.message : String(error), 'command_error', owner);
      await systems.flush();
    },
    activate() {extensions.hooks.emit('session_start', {session_id: session, model: settings.model});},
    commandContext(): CommandContext {
      return {providers: registry.names(), loginProviders: registry.loginNames(), customCommands: resources.snapshot().commands,
        models: [...new Set([settings.model, ...modelCandidates.get(settings.provider) ?? [],
          ...[...modelCandidates].flatMap(([provider, models]) => models.map(model => provider + '/' + model))].filter(Boolean))]};
    },
    noteDraft() {},
    cancel(activityId: string) {if (compactTask?.activityId === activityId) compactTask.controller.abort(); else {
      if (store.activities.get(session, activityId)?.ownerId === 'logox') actorServices.stopDirector(activityId); else actorServices.stopActor(activityId);
      ensemble.cancel(activityId, 'user');
    }},
    async close() {
      closed = true; commands.abort(); surfaces.close(); stopPageUpdates(); store.interactions.close(); compactTask?.controller.abort();
      try {
        await Promise.all([authentication.close(), ensemble.close(), compactTask?.done, reloadTask, permissionTask]);
        await Promise.allSettled([selectionDone]); await actorServices.flush(); await usage.flush(); await systems.flush();
      } finally {stopPermissionPolicy(); stopPermissions(); stopSystemUpdates(); stopSurfaceErrors(); stopLoginErrors();}
    },
    async submit(raw: string, source = 'logox'): Promise<void> {
      const text = raw.trim();
      if (!text || closed) return;
      if (permissionTask) throw new Error('权限正在保存，请等待完成');
      if (selecting) throw new Error('模型设置正在保存，请稍后重试');
      if (reloadTask) throw new Error('资源正在重载，请等待完成');
      if (compactTask) throw new Error('上下文正在整理，请先等待或取消扬弃');
      if (surfaces.getSnapshot()) throw new Error('请先关闭当前命令界面');
      if (authentication.getSnapshot()) throw new Error('登录正在进行，请先完成或取消');
      commandOwner = source;
      if (/^\/(new|resume|clear|rewind)(?:\s|$)/.test(text) && await options.sessionCommand(text)) return;
      if (text === '/login' || text.startsWith('/login ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再登录');
        await authentication.begin(text === '/login' ? undefined : text.slice(7).trim()); return;
      }
      if (text === '/permissions mode') {
        void surfaces.openPicker({title: '权限模式', description: '三档共用显式 deny；切换后待执行操作重新裁决', current: permissions.mode},
          async () => ({items: Object.entries(permissionModes).map(([id, mode]) => ({id, label: id, description: mode.description, color: mode.color}))}),
          async id => {await permissions.setMode(permissionModeSchema.parse(id)); return {message: '权限模式：' + id};});
        return;
      }
      if (text.startsWith('/permissions ')) {
        if (!text.startsWith('/permissions mode ')) requireIdle();
        permissionTask = (async () => {
          const parts = text.slice(13).trim().split(/\s+/);
          if (parts[0] === 'mode') {if (parts.length !== 2) throw new Error('用法：/permissions mode default|auto|creative'); await permissions.setMode(permissionModeSchema.parse(parts[1]));}
          else if (parts[0] === 'revoke' && parts.length === 2) await permissions.revoke(parts[1]!);
          else if (parts[0] === 'add' && parts.length >= 5) await permissions.add({scope: z.enum(['session', 'project']).parse(parts[1]), decision: z.enum(['allow', 'deny']).parse(parts[2]), tool: z.string().min(1).parse(parts[3]), pattern: parts.slice(4).join(' ')});
          else throw new Error('使用 /permissions 查看用法');
          notice('权限已更新。');
        })();
        try {await permissionTask;} finally {permissionTask = undefined;}
        return;
      }
      if (text.startsWith('/actors model ')) {
        requireIdle(); await actorServices.management.openDefaultModel(text.slice(14).trim(), surfaces); return;
      }
      if (['/help', '/status', '/config', '/usage', '/permissions', '/commands', '/actors'].includes(text)) {
        pageOwner = source; surfaces.openPage('LOGOX', pageTabs(), ['/help', '/commands'].includes(text) ? 'commands' : text.slice(1), {
          onSaveToggles: async (tabId, items) => {if (tabId === 'animations') {await statusbar.saveMotion(items[0]?.enabled ?? true); return {message: '动效设置已保存。'};} if (tabId !== 'statusbar') throw new Error('此页面不支持设置'); await statusbar.save(items); return {message: '状态栏布局已保存。'};},
        }); return;
      }
      if (text === '/skills') {
        notice(resources.skillsFor({actorId: source, skills: actors.find(source)?.skills ?? []}).map(item => item.name + '：' + item.description + '\n' + item.path).join('\n\n') || '没有发现技能'); return;
      }
      if (text === '/reload') {
        requireIdle();
        reloadTask = (async () => {
          const report = await reloadResources(resources, () => loadConfig(cwd, {}, options.env ?? process.env,
            options.resourceOptions?.home, options.resourceOptions?.boundary));
          if (report.prefixChanged) contexts.invalidatePrefix();
          const actorState = await actors.reload(); contexts.invalidatePrefix();
          for (const issue of actorState.issues) notice('角色未加载：' + issue.path + ' · ' + issue.reason);
          if (!closed) notice(report.text);
        })();
        try {await reloadTask;} finally {reloadTask = undefined;}
        return;
      }
      const effortCommand = /^\/(?:effort|thinking|think)(?:\s+(\S+))?$/.exec(text);
      if (effortCommand) {
        if (!effortCommand[1]) {openThinking(); return;}
        const effort = effortSchema.safeParse(effortCommand[1]);
        if (!effort.success) throw new Error('思考档位：auto/off/low/medium/high/max；支持情况见 /effort');
        await saveEffort(effort.data); notice('思考档位：' + effort.data + '（已保存）'); return;
      }
      if (text === '/providers' || text === '/provider') {openProviders(); return;}
      if (text === '/model') {openModels(); return;}
      if (text.startsWith('/provider ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再切换提供商');
        const parts = text.slice(10).trim().split(/\s+/);
        if (!parts[0] || parts.length > 2) throw new Error('用法：/provider 名称 [模型]');
        await saveSelection(registry.candidate(parts[0], parts[1]));
        notice('当前提供商：' + settings.provider + '\n模型：' + (settings.model || '使用 /models 查询，再用 /model 名称选择')); return;
      }
      if (text.startsWith('/model ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再切换模型');
        const model = text.slice(7).trim();
        if (!model) throw new Error('请输入模型名称');
        const provider = registry.names().filter(name => model.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0];
        await saveSelection(registry.candidate(provider ?? settings.provider, provider ? model.slice(provider.length + 1) : model));
        notice('当前模型：' + model); return;
      }
      if (text === '/models') {
        const provider = settings.provider;
        const models = await registry.models(AbortSignal.any([commands.signal, AbortSignal.timeout(15000)]));
        modelCandidates.set(provider, models);
        notice(models.join('\n') || '接口返回空模型列表'); return;
      }
      if (text === '/check-provider') {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再检查提供商');
        const selection = registry.selection();
        const result = await registry.check(commands.signal);
        notice('提供商检查成功：' + selection.provider + ' / ' + selection.model + '\n' + result.text + '\n耗时：' + result.elapsedMs + ' ms'); return;
      }
      if (text === '/compact') {
        requireIdle();
        const activityId = randomUUID(), controller = new AbortController();
        store.activities.create({sessionId: session, activityId, ownerId: source, kind: source === 'logox' ? 'director' : 'actor',
          title: '扬弃', status: 'running', stage: '整理上下文', detail: '原始账本保留，不执行工具'});
        const operation = (async () => {
          try {
            const role = actors.find(source);
            const identity = {sessionId: session, ownerId: source, activityId};
            const base = await agentRequestBase(cwd, source, actorServices.tools(source), resources,
              role ? {prompt: role.prompt, visibility: {actorId: source, skills: role.skills}} : undefined, false);
            await contexts.prepare(identity, contexts.requestBase(identity, base), controller.signal, true);
            controller.signal.throwIfAborted();
            store.activities.update(session, activityId, {status: 'completed', stage: '整理完成'});
          } catch (error) {
            store.activities.update(session, activityId, {status: controller.signal.aborted ? 'cancelled' : 'failed',
              stage: controller.signal.aborted ? '已中断' : '整理失败', detail: error instanceof Error ? error.message : String(error)});
            notice(controller.signal.aborted ? '扬弃已取消，原始记录保留。' : '扬弃未完成：' + (error instanceof Error ? error.message : String(error)), 'command_error', source, activityId);
          } finally {compactTask = undefined;}
        })();
        compactTask = {activityId, controller, done: operation};
        await operation;
        return;
      }
      if (text === '/undo') {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再撤销');
        const activities = new Set((await journal.activeTasks(session)).map(task => task.activityId));
        for (const owner of owners) for (const entry of await journal.load(session, owner)) if (entry.activityId) activities.add(entry.activityId);
        const paths = await tools.snapshots.undo([...activities]);
        notice(paths.length ? '已撤销：\n' + paths.join('\n') : '没有可撤销的文件修改'); return;
      }
      if (text.startsWith('/cast ')) {
        const prompt = text.slice(6).trim();
        if (!prompt) throw new Error('请输入角色任务');
        await beginTask();
        ensemble.dispatchBatch((['aletheia', 'techne', 'kalon'] as const).map(ownerId => ({ownerId, prompt}))); return;
      }
      if (text.startsWith('/')) {
        const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(text);
        const expanded = match ? resources.expand(match[1]!, match[2] ?? '') : undefined;
        if (!expanded) throw new Error('未知命令，使用 /help 查看已实现的命令');
        await beginTask();
        await dispatchInput(source, expanded, source === 'logox' ? source : 'direct'); return;
      }
      const mention = /^@([a-z][a-z0-9_-]*)\s+([\s\S]+)$/.exec(text);
      if (text.startsWith('@') && (!mention || !actors.find(mention[1]!))) throw new Error('角色名称无效：使用 /actors 查看角色，再用 @角色 后接任务');
      const owner = mention ? mention[1]! : source;
      await beginTask();
      await dispatchInput(owner, mention ? mention[2]! : text, owner === 'logox' ? source : 'direct');
    },
  };
}

export async function createApplication(options: ApplicationOptions) {
  return createManagedApplication(options, createSessionApplication);
}
