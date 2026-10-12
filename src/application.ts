import {randomUUID} from 'node:crypto';
import {CommandSurfaces} from './commands/surfaces.js';
import type {CommandTab} from './runtime/command-surface.js';
import {commandHelp, type CommandContext} from './commands.js';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {cast, Ensemble, type ActorId} from './actors/ensemble.js';
import {loadConfig, type Config} from './config/config.js';
import {ContextManager} from './context/manager.js';
import {createAgent, agentRequestBase} from './kernel/agent.js';
import {ProviderRegistry} from './providers/registry.js';
import {AuthStorage} from './providers/auth.js';
import {LoginFlow} from './providers/login.js';
import {RuntimeStore} from './runtime/store.js';
import {Journal} from './store/journal.js';
import {Tools} from './tools/tools.js';
import type {Provider, ToolDefinition} from './runtime/messages.js';

const dispatchSchema = z.strictObject({
  tasks: z.array(z.strictObject({ownerId: z.enum(['aletheia', 'techne', 'kalon']), prompt: z.string().trim().min(1)})).min(1).max(3),
});
const dispatchTool: ToolDefinition = {name: 'dispatch_role',
  description: '将具体任务派给 Aletheia（侦察）、Techne（实现）、Kalon（审美）。角色串行登场，结果在当前 Director 回合结束后自动返回。派发后应向用户说明安排并结束当前回合，不轮询。',
  parameters: z.toJSONSchema(dispatchSchema)};
export interface ApplicationOptions {
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  config?: Config;
  provider?: Provider;
  authPath?: string;
  env?: NodeJS.ProcessEnv;
}
export async function createApplication(options: ApplicationOptions) {
  const {cwd} = options;
  const state = join(cwd, '.logox', 'state');
  if (options.sessionId !== undefined && !options.sessionId.trim()) throw new Error('会话 ID 不能为空');
  let sessionId = options.sessionId?.trim();
  if (!sessionId && options.resume) {
    try {sessionId = (await readFile(join(state, 'last-session'), 'utf8')).trim();}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (!sessionId) throw new Error('没有可恢复的会话');
  }
  sessionId ??= randomUUID();
  const session = sessionId;
  const config = options.config ?? await loadConfig(cwd, {}, options.env ?? process.env);
  const registry = new ProviderRegistry(config, options.env ?? process.env, fetch, new AuthStorage(options.authPath));
  let settings = registry.selection();
  const modelCandidates = new Map<string, readonly string[]>();
  const commands = new AbortController();
  const store = new RuntimeStore();
  const journal = new Journal(join(state, 'sessions'));
  const tools = new Tools(cwd);
  const depths = new Map<string, number>();
  let closed = false;
  let compactTask: {activityId: string; controller: AbortController; done: Promise<void>} | undefined;
  const contexts = new ContextManager({journal, policy: config.context, maxOutput: config.provider.max_tokens,
    model: () => registry.capacity(),
    summarizer: () => {
      const provider = config.context.summary_provider ?? registry.selection().provider;
      const model = config.context.summary_model ?? (provider === registry.selection().provider ? registry.selection().model : undefined);
      return {model: registry.capacity(provider, model), provider: options.provider ?? registry.providerFor(provider, model)};
    },
    report: (identity, text) => {store.message(session, identity.ownerId, 'notice', text);},
  });
  const notice = (text: string) => {store.message(session, 'logox', 'notice', text);};
  const surfaces = new CommandSurfaces(result => {if (result.message) notice(result.message);});
  const authentication = new LoginFlow(registry.auth, () => registry.loginNames(), provider => {
    registry.select(provider);
    settings = registry.selection();
    notice('已保存 ' + provider + ' 的 API key，重启后自动读取。' + (settings.model ? '\n当前模型：' + settings.model : '\n使用 /models 查询，再用 /model 名称选择模型。'));
  });
  const ensemble = new Ensemble(session, store, journal, createAgent({
    cwd, store, tools, context: contexts, provider: () => options.provider ?? registry.provider(),
    iterations: config.kernel.max_iterations, retries: config.kernel.max_retries,
    extraTools: [dispatchTool],
    executeExtra: async (call, context) => {
      const parsed = dispatchSchema.safeParse(JSON.parse(call.arguments));
      if (!parsed.success) return {text: '派发参数无效；tasks 需要角色和具体 prompt。', isError: true};
      const depth = depths.get(context.activityId) ?? 0;
      if (depth >= 3) return {text: '本轮已达到 3 次角色协作往返，请根据已有结果完成任务或询问用户。', isError: true};
      const handles = ensemble.dispatchBatch(parsed.data.tasks);
      const cancelChildren = () => {for (const handle of handles) handle.cancel();};
      context.signal.addEventListener('abort', cancelChildren, {once: true});
      void Promise.all(handles.map(handle => handle.done)).then(() => {
        context.signal.removeEventListener('abort', cancelChildren);
        if (closed || context.signal.aborted) return;
        const snapshot = store.getSnapshot();
        const reports = handles.map(handle => {
          const activity = snapshot.activities.find(item => item.activityId === handle.activityId)!;
          const output = snapshot.messages.filter(message => message.activityId === handle.activityId && message.role === 'assistant' && !message.kind)
            .map(message => message.text).join('\n').slice(-16_000);
          return activity.ownerId + '（' + activity.status + '）：\n' + (output || activity.detail);
        }).join('\n\n');
        const next = ensemble.dispatch('logox', '角色结果已返回。请核对、继续原任务，不能把失败当成完成。\n' + reports);
        depths.set(next.activityId, depth + 1);
      }).catch(error => {context.signal.removeEventListener('abort', cancelChildren); notice(error instanceof Error ? error.message : String(error));});
      return {text: '任务已排队：' + handles.map(handle => handle.activityId).join(', ') + '。结束当前回合后会自动收到结果。', isError: false};
    },
  }));
  const busy = () => ensemble.isBusy() || !!compactTask;
  const requireIdle = () => {if (busy()) throw new Error('任务处理中，请先取消或等待完成，再切换模型或提供商');};
  let pageOwner: ActorId = 'logox';
  const contextLines = (): string[] => {
    const identity = {sessionId: session, ownerId: pageOwner};
    const usage = contexts.status(identity), spent = contexts.meter(identity).spent;
    let window = '未知，请配置模型 context_window';
    try {window = String(registry.capacity().window) + ' token';} catch {}
    return ['模型窗口：' + window, ...(usage ? ['最近请求输入占用：约 ' + usage.input + ' token',
      '整理触发水位：' + usage.high + ' token；目标：' + usage.low + ' token', '本次输出额度：' + usage.output + ' token'] : ['当前输入占用：尚未发起任务']),
      '本进程已记录的任务及汇总输入 / 输出：' + spent.input + ' / ' + spent.output + ' token'];
  };
  const pageTabs = (): readonly CommandTab[] => [
    {id: 'status', title: '状态', lines: ['会话：' + session, '当前窗口的角色任务共用会话模型',
      '提供商：' + settings.provider, '模型：' + (settings.model || '尚未选择'), '接口：' + settings.kind,
      '活动任务：' + store.getSnapshot().activities.filter(a => ['queued', 'running', 'waiting_input'].includes(a.status)).length,
      ...contextLines()]},
    {id: 'config', title: '配置', lines: ['当前生效配置', '', '提供商：' + settings.provider, '模型：' + (settings.model || '尚未选择'),
      '模型地址：' + settings.baseUrl, 'Temperature：' + config.provider.temperature, '最大输出 token：' + config.provider.max_tokens,
      '请求超时：' + config.provider.timeout + ' 秒', '每轮循环上限：' + config.kernel.max_iterations,
      '连接重试上限：' + config.kernel.max_retries, '', '用 /model、/provider 切换；其他配置修改 config.toml 后重启。']},
    {id: 'commands', title: '命令', lines: [...commandHelp().split('\n'), '', '@aletheia / @techne / @kalon 后接任务：直接派发',
      'Ctrl+G：角色窗口 · Tab：补全/审批', 'Ctrl+C：取消任务 · Ctrl+D：退出']},
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
      }, id => {
        requireIdle();
        const [provider, model] = z.tuple([z.string(), z.string()]).parse(JSON.parse(id));
        registry.select(provider, model); settings = registry.selection();
        return {message: '当前模型：' + provider + ' / ' + model};
      });
  };
  const openProviders = () => {
    requireIdle();
    void surfaces.openPicker({title: '选择提供商', description: '切换后使用该提供商的默认模型；/model 查看已登录模型', current: settings.provider},
      async () => ({items: registry.names().map(name => ({id: name, label: name}))}), name => {
        requireIdle(); registry.select(name); settings = registry.selection();
        return {message: '当前提供商：' + name + '\n模型：' + (settings.model || '使用 /model 选择')};
      });
  };
  // 恢复实际模型消息；旧 TS 演示账本也能读取，工具不会重新执行。
  const savedRounds = new Map<string, Awaited<ReturnType<Journal['rounds']>>[number]>();
  const restored = (await Promise.all(Object.keys(cast).map(async owner => {
    const entries = await journal.load(session, owner);
    try {for (const round of await journal.rounds(session, owner, entries)) savedRounds.set(round.activityId, round);}
    catch {notice(owner + ' 的轮次摘要无法读取，保留原始消息。');}
    return entries;
  }))).flat().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const entry of restored) {
    const origin = {...(entry.activityId ? {activityId: entry.activityId} : {}), ...(entry.source ? {source: entry.source} : {})};
    const activityId = entry.activityId;
    if (activityId && !store.activities.get(session, activityId)) {
      store.activities.create({sessionId: session, activityId, ownerId: entry.ownerId, kind: entry.ownerId === 'logox' ? 'director' : 'actor',
        title: entry.text.slice(0, 80) || entry.ownerId, status: savedRounds.get(activityId)?.status ?? 'completed',
        stage: savedRounds.has(activityId) ? '恢复的' + ({completed: '完成', failed: '失败', cancelled: '取消'}[savedRounds.get(activityId)!.status]) : '历史记录',
        detail: savedRounds.get(activityId)?.summary.report ?? '恢复的记录，工具不会重放'});
    }
    if (entry.message?.role === 'assistant' && entry.message.reasoning) {
      store.message(session, entry.ownerId, 'assistant', entry.message.reasoning, {...origin, kind: 'thinking'});
    }
    if (entry.text) store.message(session, entry.ownerId, entry.role === 'tool' ? 'notice' : entry.role, entry.message?.role === 'tool' ? entry.message.name + '\n' + entry.text : entry.text,
      {...origin, ...(entry.role === 'tool' ? {kind: 'tool' as const} : {})});
  }
  await mkdir(state, {recursive: true});
  await writeFile(join(state, 'last-session'), session, 'utf8');
  notice('会话 ' + session + '\n' + (settings.model ? settings.model : '尚未设置模型，使用 /model 模型名') + ' · /help 查看操作');
  return {
    sessionId: session, store, ensemble, journal, tools, authentication, surfaces, contexts,
    commandContext(): CommandContext {
      return {providers: registry.names(), loginProviders: registry.loginNames(),
        models: [...new Set([settings.model, ...modelCandidates.get(settings.provider) ?? [],
          ...[...modelCandidates].flatMap(([provider, models]) => models.map(model => provider + '/' + model))].filter(Boolean))]};
    },
    noteDraft() {},
    cancel(activityId: string) {if (compactTask?.activityId === activityId) compactTask.controller.abort(); else ensemble.cancel(activityId);},
    async close() {closed = true; commands.abort(); surfaces.close(); stopPageUpdates(); store.interactions.close(); compactTask?.controller.abort(); await Promise.all([authentication.close(), ensemble.close(), compactTask?.done]);},
    async submit(raw: string, source: ActorId = 'logox'): Promise<void> {
      const text = raw.trim();
      if (!text || closed) return;
      if (compactTask) throw new Error('上下文正在整理，请先等待或取消扬弃');
      if (surfaces.getSnapshot()) throw new Error('请先关闭当前命令界面');
      if (authentication.getSnapshot()) throw new Error('登录正在进行，请先完成或取消');
      if (text === '/login' || text.startsWith('/login ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再登录');
        await authentication.begin(text === '/login' ? undefined : text.slice(7).trim()); return;
      }
      if (['/help', '/status', '/config'].includes(text)) {
        pageOwner = source; surfaces.openPage('LOGOX', pageTabs(), text === '/help' ? 'commands' : text.slice(1)); return;
      }
      if (text === '/providers' || text === '/provider') {openProviders(); return;}
      if (text === '/model') {openModels(); return;}
      if (text.startsWith('/provider ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再切换提供商');
        const parts = text.slice(10).trim().split(/\s+/);
        if (!parts[0] || parts.length > 2) throw new Error('用法：/provider 名称 [模型]');
        registry.select(parts[0], parts[1]);
        settings = registry.selection();
        notice('当前提供商：' + settings.provider + '\n模型：' + (settings.model || '使用 /models 查询，再用 /model 名称选择')); return;
      }
      if (text.startsWith('/model ')) {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再切换模型');
        const model = text.slice(7).trim();
        if (!model) throw new Error('请输入模型名称');
        const provider = registry.names().filter(name => model.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0];
        registry.select(provider ?? settings.provider, provider ? model.slice(provider.length + 1) : model);
        settings = registry.selection();
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
            await contexts.prepare({sessionId: session, ownerId: source}, await agentRequestBase(cwd, source, [dispatchTool]), controller.signal, true);
            controller.signal.throwIfAborted();
            store.activities.update(session, activityId, {status: 'completed', stage: '整理完成'});
          } catch (error) {
            store.activities.update(session, activityId, {status: controller.signal.aborted ? 'cancelled' : 'failed',
              stage: controller.signal.aborted ? '已中断' : '整理失败', detail: error instanceof Error ? error.message : String(error)});
            notice(controller.signal.aborted ? '扬弃已取消，原始记录保留。' : '扬弃未完成：' + (error instanceof Error ? error.message : String(error)));
          } finally {compactTask = undefined;}
        })();
        compactTask = {activityId, controller, done: operation};
        await operation;
        return;
      }
      if (text === '/undo') {
        if (ensemble.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再撤销');
        const paths = await tools.snapshots.undo();
        notice(paths.length ? '已撤销：\n' + paths.join('\n') : '没有可撤销的文件修改'); return;
      }
      if (text.startsWith('/cast ')) {
        const prompt = text.slice(6).trim();
        if (!prompt) throw new Error('请输入角色任务');
        ensemble.dispatchBatch((['aletheia', 'techne', 'kalon'] as const).map(ownerId => ({ownerId, prompt}))); return;
      }
      if (text.startsWith('/')) throw new Error('未知命令，使用 /help 查看已实现的命令');
      const mention = /^@(\w+)\s+([\s\S]+)$/.exec(text);
      if (text.startsWith('@') && (!mention || !Object.hasOwn(cast, mention[1]!))) throw new Error('角色名称无效：使用 @aletheia、@techne 或 @kalon 后接任务');
      const owner = mention ? mention[1] as ActorId : source;
      ensemble.dispatch(owner, mention ? mention[2]! : text, source);
    },
  };
}
