import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {ActorCatalog} from './actors/catalog.js';
import {loadConfig} from './config/config.js';
import {ProviderRegistry} from './providers/registry.js';
import {AuthStorage} from './providers/auth.js';
import {Journal} from './store/journal.js';
import {SessionManager, type SessionLease} from './store/sessions.js';
import {Tools} from './tools/tools.js';
import {PermissionEngine} from './permissions/engine.js';
import {StateFile, preferenceSchema} from './config/model-preferences.js';
import {UsageLedger} from './context/usage.js';
import {ProjectExtensions, observeTools} from './extensions/runtime.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import type {createSessionApplication, ApplicationOptions} from './application.js';

/** 项目服务保持稳定；会话运行时在候选加载成功后整体替换。 */
export async function createManagedApplication(options: ApplicationOptions, createSession: typeof createSessionApplication) {
  const manager = await SessionManager.open(options.cwd), cwd = manager.project;
  if (options.sessionId !== undefined && !options.sessionId.trim()) throw new Error('会话 ID 不能为空');
  const recent = options.sessionId === undefined ? await manager.recent() : undefined;
  let sessionId = options.sessionId?.trim() ?? recent ?? (options.resume ? undefined : randomUUID());
  if (!sessionId) throw new Error('没有可恢复的会话');
  const config = options.config ?? await loadConfig(cwd, {}, options.env ?? process.env);
  const registry = new ProviderRegistry(config, options.env ?? process.env, undefined, new AuthStorage(options.authPath));
  await registry.syncCustom();
  const journal = new Journal(join(manager.directory, 'sessions'));
  const actors = new ActorCatalog(cwd, options.resourceOptions?.home ? {home: options.resourceOptions.home} : {});
  await actors.load();
  const owners = async (id: string) => [...new Set([...actors.list().map(actor => actor.id), ...(await journal.tasks(id)).map(task => task.ownerId)])];
  let current: Awaited<ReturnType<typeof createSession>>;
  const preferences = new StateFile(join(manager.directory, 'model-preferences.json'), preferenceSchema);
  const permissions = new PermissionEngine(cwd, config.permissions.mode);
  await permissions.load();
  const earlyNotices: string[] = [];
  const diagnose = (text: string) => {if (current) current.systemNotice(text); else earlyNotices.push(text);};
  const usage = new UsageLedger(join(manager.directory, 'usage'), diagnose);
  const approveExtension: ExtensionApproval = options.approveExtension ?? ((request, context) => tools.authorizeExtension({
    id: request.callId, name: 'mcp:' + request.server + ':' + request.tool, arguments: JSON.stringify(request.arguments),
  }, context, request.action === 'list' ? 'read' : 'unknown'));
  const extensions = options.extensions ?? new ProjectExtensions(cwd, config, options.resourceOptions, approveExtension, diagnose);
  const tools = observeTools(new Tools(cwd, undefined, permissions), extensions.hooks);
  let lease: SessionLease;
  let closed = false, transition: Promise<void> | undefined;
  let entry: Promise<void> = Promise.resolve();
  let snapshot: Readonly<{revision: number; sessionId: string}> = Object.freeze({revision: 0, sessionId});
  const listeners = new Set<() => void>();
  const publish = () => {snapshot = Object.freeze({revision: snapshot.revision + 1, sessionId: current.sessionId}); for (const listener of listeners) listener();};
  const notice = (text: string) => current.systemNotice(text);
  const requireIdle = () => {
    if (closed) throw new Error('应用已关闭');
    if (transition || current.isBusy()) throw new Error('任务处理中，请先取消或等待完成，再切换会话或回退');
    if (current.authentication.getSnapshot()) throw new Error('请先完成或取消登录');
  };
  const persistence = new WeakMap<Awaited<ReturnType<typeof createSession>>, {saved: boolean; save(): Promise<void>}>();
  const create = async (id: string) => {
    let saving: Promise<void> | undefined;
    const state = {saved: await manager.hasContent(id), async save() {
      if (state.saved) return;
      saving ??= (async () => {
        await manager.touch(id);
        await manager.remember(id);
        state.saved = true;
      })();
      try {await saving;} finally {saving = undefined;}
    }};
    const application = await createSession({...options, cwd, config, sessionId: id, registry, tools, preferences, permissions,
      usage, extensions, actors, sessionCommand, beforeTask: () => state.save(), isPersistent: () => state.saved});
    persistence.set(application, state);
    return application;
  };
  const change = (id: string, fresh = false): Promise<void> => {
    requireIdle();
    const operation = (async () => {
      if (!fresh && !await manager.info(id)) {
        const entries = (await Promise.all((await owners(id)).map(owner => journal.load(id, owner)))).flat();
        if (!entries.length && !(await journal.activeTasks(id)).length) throw new Error('没有此项目的会话：' + id);
      }
      const same = id === current.sessionId;
      let nextLease: SessionLease | undefined, next: typeof current | undefined;
      try {
        nextLease = same ? lease : await manager.acquire(id);
        await usage.flush();
        next = await create(id);
        if (persistence.get(next)!.saved) {await manager.touch(id); await manager.remember(id);}
      } catch (error) {
        await next?.close();
        if (nextLease && !same) await nextLease.release();
        throw error;
      }
      await current.close();
      if (!same) await lease.release();
      permissions.clearSession();
      current = next; lease = nextLease;
      current.activate(); publish();
      if (await journal.pending(id)) notice('此会话有未完成回退。使用 /rewind 重试相同目标，完成前不会发起新模型任务。');
    })();
    transition = operation;
    return operation.finally(() => {transition = undefined;});
  };
  const turns = async () => {
    const entries = (await Promise.all((await owners(current.sessionId)).map(owner => journal.load(current.sessionId, owner)))).flat();
    const tasks = await journal.activeTasks(current.sessionId);
    const records = new Map(tasks.map(task => [task.activityId, {id: task.activityId, owner: task.ownerId, text: task.prompt, time: task.time}]));
    for (const entry of entries) if (entry.role === 'user' && entry.activityId)
      records.set(entry.activityId, {id: entry.activityId, owner: entry.ownerId, text: entry.text, time: records.get(entry.activityId)?.time ?? entry.time ?? 0});
    return [...records.values()].sort((a, b) => a.time - b.time);
  };
  const rewind = (target: string): Promise<void> => {
    requireIdle();
    const operation = (async () => {
      const id = current.sessionId, pending = await journal.pending(id), rounds = await turns();
      if (pending && pending.target !== target) throw new Error('先重试未完成的回退目标：' + pending.target);
      const index = rounds.findIndex(round => round.id === target);
      if (!pending && index < 0) throw new Error('回退轮次已失效，请重新选择');
      const activities = pending?.activities ?? rounds.slice(index).map(round => round.id);
      await journal.savePending(id, {target, activities});
      const result = await tools.snapshots.restore(activities);
      if (!result.success) throw new Error('回退未完成，对话分支未推进。已恢复：' + (result.restored.join(', ') || '无') + '\n失败：' + result.failed.join(', ') + '\n' + result.error + '\n修复后使用 /rewind 重试相同目标；Shell/MCP 外部副作用不恢复。');
      await journal.fork(id, await owners(id), activities);
      await usage.flush();
      const next = await create(id);
      try {await journal.savePending(id, null);} catch (error) {await next.close(); throw error;}
      await current.close(); permissions.clearSession(); current = next; current.activate(); publish();
      notice('已回退所选轮次及之后的对话和文件修改。\n' + (result.restored.join('\n') || '该区间没有文件工具修改') + '\nShell/MCP 外部副作用不由文件回退恢复。');
    })();
    transition = operation;
    return operation.finally(() => {transition = undefined;});
  };
  const recover = (sourceId: string): Promise<void> => {
    requireIdle();
    const operation = (async () => {
      const sourceLease = sourceId === current.sessionId ? undefined : await manager.acquire(sourceId);
      const id = randomUUID();
      let nextLease: SessionLease | undefined, next: typeof current | undefined;
      try {
        if (await journal.pending(sourceId)) throw new Error('源会话有未完成文件回退，先修复原账本并完成回退，再恢复分支');
        const inspected = await Promise.all((await owners(sourceId)).map(async owner => ({owner, ...await journal.inspect(sourceId, owner)})));
        if (!inspected.some(item => item.issue)) throw new Error('源账本已完整，请使用普通恢复');
        nextLease = await manager.acquire(id);
        for (const {owner, entries} of inspected) {
          let activity: string | undefined;
          const rounds = await journal.rounds(sourceId, owner, entries).catch(() => []);
          const finish = async () => {if (activity) await journal.finish(id, owner, activity, rounds.find(round => round.activityId === activity)?.status ?? 'cancelled');};
          for (const entry of entries) {
            if (entry.role === 'user' && entry.activityId !== activity) {await finish(); activity = entry.activityId;}
            await journal.append({...entry, sessionId: id});
          }
          await finish();
        }
        await usage.flush();
        next = await create(id);
        await persistence.get(next)!.save();
        await manager.touch(id, '恢复分支：' + sourceId);
        await manager.remember(id);
      } catch (error) {await next?.close(); await nextLease?.release(); throw error;}
      finally {await sourceLease?.release();}
      await current.close(); await lease.release();
      permissions.clearSession(); current = next; lease = nextLease; current.activate(); publish();
      notice('已将完整有效前缀恢复为新会话。源账本保留；损坏行及其后续未进入新分支，任务不会自动续跑。');
    })();
    transition = operation;
    return operation.finally(() => {transition = undefined;});
  };
  async function openResume(): Promise<void> {
    await current.surfaces.replacePicker({title: '恢复会话', description: '当前项目历史 · 搜索标题或 ID · Ctrl+X 删除选中的历史', current: JSON.stringify([current.sessionId, false])},
      async () => {
        const {sessions, issues} = await manager.list();
        const items = await Promise.all(sessions.map(async info => {
          try {
            const reports = await Promise.all((await owners(info.id)).map(owner => journal.inspect(info.id, owner)));
            const issue = reports.find(report => report.issue)?.issue;
            const count = reports.reduce((sum, report) => sum + report.entries.filter(entry => entry.role === 'user').length, 0);
            return {id: JSON.stringify([info.id, !!issue]), deletable: info.id !== current.sessionId, label: issue ? '恢复完整前缀：' + info.title : info.title,
              description: info.id + ' · ' + count + ' 轮 · ' + (issue ?? new Date(info.updated).toLocaleString('zh-CN'))};
          } catch (error) {return {id: JSON.stringify([info.id, false]), label: info.title, description: error instanceof Error ? error.message : '会话诊断失败', deletable: info.id !== current.sessionId};}
        }));
        return {items: [...items, {id: JSON.stringify([randomUUID(), 'new']), label: '新建临时会话', description: '首次正式任务才保存'}], warning: issues.join('\n')};
      }, async value => {
        const [id, mode] = z.tuple([z.string(), z.union([z.boolean(), z.literal('new')])]).parse(JSON.parse(value));
        if (mode === 'new') await change(id, true); else if (mode) await recover(id); else await change(id);
        return {};
      }, {deleteLabel: '删除会话', onDelete: async value => {
      requireIdle();
      const [id] = z.tuple([z.string(), z.boolean()]).parse(JSON.parse(value));
      if (id === current.sessionId) throw new Error('当前会话不能删除，请先使用 /new');
      const info = await manager.info(id), title = info?.title ?? id;
      await current.surfaces.replacePicker({title: '删除会话', description: title + ' · ' + id + '；记录移入本地回收目录，项目文件保持原样', current: 'cancel'},
        async () => ({items: [{id: 'cancel', label: '取消'}, {id: 'delete', label: '移到回收目录'}]}), async choice => {
          if (choice === 'delete') {
            requireIdle();
            if (id === current.sessionId) throw new Error('当前会话不能删除，请先使用 /new');
            const operation = (async () => {
              await usage.flush();
              const result = await manager.remove(id, actors.list().map(actor => actor.id));
              notice('会话已移到回收目录：' + result.archive + (result.remaining.length ? '\n活动目录有未清理记录：' + result.remaining.join('、') : ''));
            })();
            transition = operation;
            try {await operation;} finally {transition = undefined;}
          }
          await openResume(); return {};
        });
    }});
  }
  async function sessionCommand(text: string): Promise<boolean> {
    if (text === '/new') {await change(randomUUID(), true); return true;}
    if (text === '/clear') {
      requireIdle();
      if (await journal.pending(current.sessionId)) throw new Error('请先完成未结束的回退');
      requireIdle();
      current.store.clearTimeline(current.sessionId); publish();
      notice('已清空当前对话显示，模型上下文、账本与文件保留。');
      return true;
    }
    if (text === '/resume') {requireIdle(); await openResume(); return true;}
    if (text.startsWith('/resume ')) {
      const id = text.slice(8).trim(); if (!id) throw new Error('用法：/resume [会话 ID]');
      await manager.info(id);
      const reports = await Promise.all((await owners(id)).map(owner => journal.inspect(id, owner)));
      const issue = reports.find(report => report.issue)?.issue;
      if (issue) {
        requireIdle();
        await current.surfaces.openPicker({title: '账本诊断', description: id + ' · ' + issue + '。源账本保留，取消不切换。', current: ''},
          async () => ({items: [{id, label: '将完整有效前缀恢复为新会话'}]}), async selected => {await recover(selected); return {};});
      } else await change(id);
      return true;
    }
    if (text === '/rewind') {
      requireIdle();
      await current.surfaces.openPicker({title: '回退到轮次之前', description: '撤销所选轮次及之后的对话和文件工具修改；Shell/MCP 外部副作用不恢复', current: ''},
        async () => {
          const rounds = await turns(), pending = await journal.pending(current.sessionId);
          return {items: pending ? [{id: pending.target, label: '重试未完成回退', description: pending.target}] : rounds.map((round, index) => ({id: round.id, label: (index + 1) + '. ' + round.text.slice(0, 100), description: round.owner})).reverse()};
        }, async id => {await rewind(id); return {};});
      return true;
    }
    throw new Error('用法：/new、/resume [会话 ID]、/clear 或 /rewind');
  }
  let initial: typeof current | undefined;
  let startupIssue: string | undefined;
  try {
    if (!options.extensions) await extensions.initialize();
    try {
      lease = await manager.acquire(sessionId);
      await manager.info(sessionId);
      await journal.pending(sessionId);
      initial = await create(sessionId);
    } catch (error) {
      await initial?.close(); await lease!?.release();
      if (options.sessionId !== undefined || options.resume || !recent) throw error;
      startupIssue = '最近会话无法进入：' + recent + '\n' + (error instanceof Error ? error.message : '加载失败') + '\n请选择其它会话，或新建临时会话。';
      sessionId = randomUUID(); lease = await manager.acquire(sessionId); initial = await create(sessionId);
    }
    current = initial;
    snapshot = Object.freeze({revision: 0, sessionId});
    if (persistence.get(current)!.saved) {await manager.touch(sessionId); await manager.remember(sessionId);}
    current.activate();
    for (const message of earlyNotices.splice(0)) diagnose(message);
    if (await journal.pending(sessionId)) notice('上次回退未完成。使用 /rewind 重试，完成前禁止新模型任务。');
    if (startupIssue) {notice(startupIssue); await sessionCommand('/resume');}
  } catch (error) {try {await initial?.close();} finally {try {await lease!?.release(); if (!options.extensions) await extensions.close();} finally {await registry.close();}} throw error;}
  let closeTask: Promise<void> | undefined;
  return {
    get sessionId() {return current.sessionId;}, get store() {return current.store;}, get ensemble() {return current.ensemble;},
    get journal() {return current.journal;}, get tools() {return tools;}, get authentication() {return current.authentication;},
    get permissions() {return permissions;}, get extensions() {return extensions;}, get resources() {return extensions.resources;},
    get surfaces() {return current.surfaces;}, get contexts() {return current.contexts;}, sessions: manager,
    get actors() {return actors;}, get taskModels() {return current.taskModels;},
    get statusbar() {return current.statusbar;},
    status: (ownerId: string) => current.status(ownerId),
    getStatusSnapshot: () => snapshot.revision + ':' + current.getStatusSnapshot(),
    subscribeStatus(listener: () => void) {
      let unsubscribeCurrent = current.subscribeStatus(listener);
      const unsubscribeSession = () => {
        unsubscribeCurrent(); unsubscribeCurrent = current.subscribeStatus(listener); listener();
      };
      listeners.add(unsubscribeSession);
      return () => {listeners.delete(unsubscribeSession); unsubscribeCurrent();};
    },
    persistSession: () => persistence.get(current)!.save(),
    isSessionPersistent: () => persistence.get(current)!.saved,
    getSessionSnapshot: () => snapshot,
    subscribeSession(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    commandContext: () => current.commandContext(), noteDraft: () => current.noteDraft(),
    cancel: (activityId: string) => current.cancel(activityId),
    async submit(raw: string, source = 'logox'): Promise<void> {
      // 只串行入口检查和调用开始，长任务仍由各模块的忙碌状态保护。
      // pending 的异步读取不能让后来 /new 抢在前一项设置保存之前。
      const previous = entry;
      let release!: () => void;
      entry = new Promise<void>(resolve => {release = resolve;});
      await previous;
      const text = raw.trim(), active = current;
      let operation: Promise<void>;
      try {
        if (closed) return;
        if (transition) throw new Error('会话正在切换或回退，请等待完成');
        if (text.startsWith('/permissions ') && await journal.pending(active.sessionId)) throw new Error('会话回退未完成，请先使用 /rewind 重试');
        if (text && !/^\/(new|resume|rewind|status|config|help|usage|permissions|commands|skills)(?:\s|$)/.test(text) && await journal.pending(active.sessionId)) throw new Error('会话回退未完成，请先使用 /rewind 重试');
        if (transition || active !== current || closed) throw new Error('会话正在切换或关闭，请等待完成');
        operation = active.submit(raw, source);
      } catch (error) {await active.recordError(error, source); throw error;}
      finally {release();}
      try {
        await operation;
      } catch (error) {await active.recordError(error, source); throw error;}
      if (text && !text.startsWith('/') && persistence.get(active)!.saved) {
        // 首次登记已经在派发前完成；标题更新失败不能把已接受的任务变成一次提交失败。
        try {await manager.touch(active.sessionId, text);}
        catch (error) {await active.recordError(error, source);}
      }
    },
    close(): Promise<void> {
      closeTask ??= (async () => {
        closed = true;
        await transition?.catch(() => {});
        try {await current.close();}
        finally {
          try {await usage.flush(); if (!options.extensions) await extensions.close(); permissions.clearSession();}
          finally {try {await lease.release();} finally {await registry.close();}}
        }
      })();
      return closeTask;
    },
  };
}
