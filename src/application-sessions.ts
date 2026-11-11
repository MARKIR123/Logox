import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {ActorCatalog} from './actors/catalog.js';
import {assertActorProfiles, seedActorProfiles} from './actors/profiles.js';
import {loadConfig} from './config/config.js';
import {ProviderRegistry} from './providers/registry.js';
import {AuthStorage} from './providers/auth.js';
import {CustomProviderStorage} from './providers/custom-storage.js';
import {Journal} from './store/journal.js';
import {SessionManager, type SessionLease} from './store/sessions.js';
import {Tools} from './tools/tools.js';
import {PermissionEngine} from './permissions/engine.js';
import {StateFile, preferenceSchema} from './config/model-preferences.js';
import {UsageLedger} from './context/usage.js';
import {ProjectExtensions, observeTools} from './extensions/runtime.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import type {createSessionApplication, ApplicationOptions, SubmitDelivery} from './application.js';

/** Project services stay stable; the session runtime is replaced as a whole once the candidate loads successfully. */
export async function createManagedApplication(options: ApplicationOptions, createSession: typeof createSessionApplication) {
  const manager = await SessionManager.open(options.cwd), cwd = manager.project;
  if (options.sessionId !== undefined && !options.sessionId.trim()) throw new Error('Session ID must not be empty');
  const recent = options.sessionId === undefined ? await manager.recent() : undefined;
  let sessionId = options.sessionId?.trim() ?? recent ?? (options.resume ? undefined : randomUUID());
  if (!sessionId) throw new Error('No session to resume');
  const config = options.config ?? await loadConfig(cwd, {}, options.env ?? process.env, options.resourceOptions?.home, options.resourceOptions?.boundary);
  const home = options.resourceOptions?.home ?? homedir();
  const registry = new ProviderRegistry(config, options.env ?? process.env, options.fetcher,
    new AuthStorage(options.authPath ?? join(home, '.logox', 'auth.json')),
    new CustomProviderStorage(join(home, '.logox', 'custom-providers.json')));
  await registry.syncCustom();
  const journal = new Journal(join(manager.directory, 'sessions'));
  if (options.resourceOptions?.home && resolve(home) !== resolve(homedir())) await seedActorProfiles(home);
  else await assertActorProfiles(home);
  const actors = new ActorCatalog(cwd, options.resourceOptions?.home ? {home} : {});
  await actors.load();
  const owners = async (id: string) => [...new Set([...actors.list().map(actor => actor.id), ...(await journal.tasks(id)).map(task => task.ownerId)])];
  let current: Awaited<ReturnType<typeof createSession>>;
  const preferences = new StateFile(join(manager.directory, 'model-preferences.json'), preferenceSchema);
  const permissions = new PermissionEngine(cwd, config.permissions.mode, undefined, join(home, '.logox', 'user-permissions.json'));
  await permissions.load();
  const earlyNotices: string[] = [];
  const diagnose = (text: string) => {if (current) current.systemNotice(text); else earlyNotices.push(text);};
  const usage = new UsageLedger(join(manager.directory, 'usage'), diagnose);
  const approveExtension: ExtensionApproval = options.approveExtension ?? ((request, context) => tools.authorizeExtension({
    id: request.callId, name: 'mcp:' + request.server + ':' + request.tool, arguments: JSON.stringify(request.arguments),
  }, context, request.action === 'list' ? 'read' : 'unknown'));
  const extensions = options.extensions ?? new ProjectExtensions(cwd, config, options.resourceOptions, approveExtension, diagnose);
  const tools = observeTools(new Tools(cwd, undefined, permissions, {home}), extensions.hooks);
  let lease: SessionLease;
  let closed = false, transition: Promise<void> | undefined;
  let entry: Promise<void> = Promise.resolve();
  let snapshot: Readonly<{revision: number; sessionId: string}> = Object.freeze({revision: 0, sessionId});
  const listeners = new Set<() => void>();
  const publish = () => {snapshot = Object.freeze({revision: snapshot.revision + 1, sessionId: current.sessionId}); for (const listener of listeners) listener();};
  const notice = (text: string) => current.systemNotice(text);
  const requireIdle = () => {
    if (closed) throw new Error('Application is closed');
    if (transition || current.isBusy()) throw new Error('Tasks are running. Cancel or wait for completion before switching sessions or rewinding.');
    if (current.authentication.getSnapshot()) throw new Error('Complete or cancel the login first');
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
        if (!entries.length && !(await journal.activeTasks(id)).length) throw new Error('No session for this project: ' + id);
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
      if (await journal.pending(id)) notice('This session has an unfinished rewind. Use /rewind to retry the same target; no new model tasks start until it completes.');
    })();
    transition = operation;
    return operation.finally(() => {transition = undefined;});
  };
  const turns = async () => {
    const ledgers = await Promise.all((await owners(current.sessionId)).map(async owner => ({owner, entries: await journal.load(current.sessionId, owner)})));
    const entries = ledgers.flatMap(ledger => ledger.entries);
    // The round's own _FinishRound title and outcome name it better than the first input does.
    const memories = new Map<string, {title: string; summary?: string | undefined}>();
    for (const ledger of ledgers) {
      try {
        for (const record of await journal.rounds(current.sessionId, ledger.owner, ledger.entries))
          if (record.memory?.source === 'model') memories.set(record.activityId, {title: record.memory.title, summary: record.memory.summary});
      } catch {}
    }
    const tasks = await journal.activeTasks(current.sessionId);
    const records = new Map(tasks.map(task => [task.activityId, {id: task.activityId, owner: task.ownerId, text: task.prompt, time: task.time}]));
    for (const entry of entries) if (entry.role === 'user' && entry.activityId)
      records.set(entry.activityId, {id: entry.activityId, owner: entry.ownerId, text: entry.text, time: records.get(entry.activityId)?.time ?? entry.time ?? 0});
    return [...records.values()].sort((a, b) => a.time - b.time).map(round => ({...round, memory: memories.get(round.id)}));
  };
  const rewind = (target: string): Promise<void> => {
    requireIdle();
    const operation = (async () => {
      const id = current.sessionId, pending = await journal.pending(id), rounds = await turns();
      if (pending && pending.target !== target) throw new Error('Retry the unfinished rewind target first: ' + pending.target);
      const index = rounds.findIndex(round => round.id === target);
      if (!pending && index < 0) throw new Error('The rewind round is no longer valid. Select again.');
      const activities = pending?.activities ?? rounds.slice(index).map(round => round.id);
      await journal.savePending(id, {target, activities});
      const result = await tools.snapshots.restore(activities);
      if (!result.success) throw new Error('Rewind incomplete; the conversation branch did not advance. Restored: ' + (result.restored.join(', ') || 'none') + '\nFailed: ' + result.failed.join(', ') + '\n' + result.error + '\nFix the cause and use /rewind to retry the same target. Shell/MCP side effects are not restored.');
      await journal.fork(id, await owners(id), activities);
      await usage.flush();
      const next = await create(id);
      try {await journal.savePending(id, null);} catch (error) {await next.close(); throw error;}
      await current.close(); permissions.clearSession(); current = next; current.activate(); publish();
      notice('Rewound the selected round and everything after it, including file changes.\n' + (result.restored.join('\n') || 'No file tool changes in this range') + '\nShell/MCP side effects are not restored by a file rewind.');
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
        if (await journal.pending(sourceId)) throw new Error('The source session has an unfinished file rewind. Repair the original ledger and finish the rewind before recovering a branch.');
        const inspected = await Promise.all((await owners(sourceId)).map(async owner => ({owner, ...await journal.inspect(sourceId, owner)})));
        if (!inspected.some(item => item.issue)) throw new Error('The source ledger is intact. Use a normal resume.');
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
        await manager.touch(id, 'Recovered branch: ' + sourceId);
        await manager.remember(id);
      } catch (error) {await next?.close(); await nextLease?.release(); throw error;}
      finally {await sourceLease?.release();}
      await current.close(); await lease.release();
      permissions.clearSession(); current = next; lease = nextLease; current.activate(); publish();
      notice('Recovered the intact valid prefix as a new session. The source ledger is preserved; damaged lines and everything after them are not in the new branch, and tasks will not resume automatically.');
    })();
    transition = operation;
    return operation.finally(() => {transition = undefined;});
  };
  async function openResume(): Promise<void> {
    await current.surfaces.replacePicker({title: 'Resume Session', description: 'Current project history · search by title or ID · Ctrl+X deletes the selected entry', current: JSON.stringify([current.sessionId, false]),
      emptyText: 'No saved sessions for this project yet. Keep working; sessions are saved as you go, then use /resume again.'},
      async () => {
        const {sessions, issues} = await manager.list();
        const items = await Promise.all(sessions.map(async info => {
          try {
            const reports = await Promise.all((await owners(info.id)).map(owner => journal.inspect(info.id, owner)));
            const issue = reports.find(report => report.issue)?.issue;
            const count = reports.reduce((sum, report) => sum + report.entries.filter(entry => entry.role === 'user').length, 0);
            return {id: JSON.stringify([info.id, !!issue]), deletable: info.id !== current.sessionId, label: issue ? 'Recover intact prefix: ' + info.title : info.title,
              description: info.id + ' · ' + count + ' rounds · ' + (issue ?? new Date(info.updated).toLocaleString('en-US'))};
          } catch (error) {return {id: JSON.stringify([info.id, false]), label: info.title, description: error instanceof Error ? error.message : 'Session diagnosis failed', deletable: info.id !== current.sessionId};}
        }));
        return {items: [...items, {id: JSON.stringify([randomUUID(), 'new']), label: 'New temporary session', description: 'Saved only after the first real task'}], warning: issues.join('\n')};
      }, async value => {
        const [id, mode] = z.tuple([z.string(), z.union([z.boolean(), z.literal('new')])]).parse(JSON.parse(value));
        if (mode === 'new') await change(id, true); else if (mode) await recover(id); else await change(id);
        return {};
      }, {deleteLabel: 'Delete session', onDelete: async value => {
      requireIdle();
      const [id] = z.tuple([z.string(), z.boolean()]).parse(JSON.parse(value));
      if (id === current.sessionId) throw new Error('The current session cannot be deleted. Use /new first.');
      const info = await manager.info(id), title = info?.title ?? id;
      await current.surfaces.replacePicker({title: 'Delete Session', description: title + ' · ' + id + '; the record moves to the local recycle folder and project files are untouched', current: 'cancel'},
        async () => ({items: [{id: 'cancel', label: 'Cancel'}, {id: 'delete', label: 'Move to recycle folder'}]}), async choice => {
          if (choice === 'delete') {
            requireIdle();
            if (id === current.sessionId) throw new Error('The current session cannot be deleted. Use /new first.');
            const operation = (async () => {
              await usage.flush();
              const result = await manager.remove(id, actors.list().map(actor => actor.id));
              notice('Session moved to the recycle folder: ' + result.archive + (result.remaining.length ? '\nUncleaned records remain in the active directory: ' + result.remaining.join(', ') : ''));
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
      if (await journal.pending(current.sessionId)) throw new Error('Finish the unfinished rewind first');
      requireIdle();
      current.store.clearTimeline(current.sessionId); publish();
      current.systemNotice('Conversation view cleared. Model context, history and files are unchanged.', 'command_result', 'logox', undefined, {presentation: 'status'});
      return true;
    }
    if (text === '/resume') {requireIdle(); await openResume(); return true;}
    if (text.startsWith('/resume ')) {
      const id = text.slice(8).trim(); if (!id) throw new Error('Usage: /resume [session ID]');
      await manager.info(id);
      const reports = await Promise.all((await owners(id)).map(owner => journal.inspect(id, owner)));
      const issue = reports.find(report => report.issue)?.issue;
      if (issue) {
        requireIdle();
        await current.surfaces.openPicker({title: 'Ledger Diagnosis', description: id + ' · ' + issue + '. The source ledger is preserved; cancelling does not switch.', current: ''},
          async () => ({items: [{id, label: 'Recover the intact valid prefix as a new session'}]}), async selected => {await recover(selected); return {};});
      } else await change(id);
      return true;
    }
    if (text === '/rewind') {
      requireIdle();
      await current.surfaces.openPicker({title: 'Rewind to Before Round', description: 'Undo the selected round and later conversation and file tool changes; Shell/MCP side effects are not restored', current: '', emptyText: 'No conversation rounds to rewind yet. Send a message first; rounds appear here once a task has run.'},
        async () => {
          const rounds = await turns(), pending = await journal.pending(current.sessionId);
          return {items: pending ? [{id: pending.target, label: 'Retry unfinished rewind', description: pending.target}] : rounds.map((round, index) => ({id: round.id, label: (index + 1) + '. ' + (round.memory?.title ?? round.text.replace(/\s+/g, ' ').slice(0, 100)),
            description: round.owner + (round.memory ? ' · ' + (round.memory.summary || round.text).replace(/\s+/g, ' ').slice(0, 160) : '')})).reverse()};
        }, async id => {await rewind(id); return {};});
      return true;
    }
    throw new Error('Usage: /new, /resume [session ID], /clear or /rewind');
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
      startupIssue = 'Cannot open the recent session: ' + recent + '\n' + (error instanceof Error ? error.message : 'Load failed') + '\nSelect another session or start a new temporary session.';
      sessionId = randomUUID(); lease = await manager.acquire(sessionId); initial = await create(sessionId);
    }
    current = initial;
    snapshot = Object.freeze({revision: 0, sessionId});
    if (persistence.get(current)!.saved) {await manager.touch(sessionId); await manager.remember(sessionId);}
    current.activate();
    for (const message of earlyNotices.splice(0)) diagnose(message);
    if (await journal.pending(sessionId)) notice('The last rewind did not finish. Use /rewind to retry; new model tasks are blocked until it completes.');
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
    getInputQueue: (ownerId?: string) => current.getInputQueue(ownerId),
    sendPendingNow: (id: string) => current.sendPendingNow(id), discardPending: (id: string) => current.discardPending(id),
    cancel: (activityId: string) => current.cancel(activityId),
    cancelTool: (callId: string) => current.cancelTool(callId),
    async submit(raw: string, source = 'logox', delivery: SubmitDelivery = {mode: 'queue'}): Promise<void> {
      // Serialize only the entry checks and call start; long tasks stay protected by each module's busy state.
      // The async pending read must not let a later /new overtake the previous setting save.
      const previous = entry;
      let release!: () => void;
      entry = new Promise<void>(resolve => {release = resolve;});
      await previous;
      const text = raw.trim(), active = current;
      let operation: Promise<void>;
      try {
        if (closed) return;
        if (transition) throw new Error('The session is switching or rewinding. Wait for it to finish.');
        if (text.startsWith('/permissions ') && await journal.pending(active.sessionId)) throw new Error('Session rewind is unfinished. Use /rewind to retry first.');
        if (text && !/^\/(new|resume|rewind|status|config|help|usage|permissions|commands|skills)(?:\s|$)/.test(text) && await journal.pending(active.sessionId)) throw new Error('Session rewind is unfinished. Use /rewind to retry first.');
        if (transition || active !== current || closed) throw new Error('The session is switching or closing. Wait for it to finish.');
        operation = active.submit(raw, source, delivery);
      } catch (error) {await active.recordError(error, source); throw error;}
      finally {release();}
      try {
        await operation;
      } catch (error) {await active.recordError(error, source); throw error;}
      if (delivery.mode === 'queue' && text && !text.startsWith('/') && persistence.get(active)!.saved) {
        // Initial registration completed before dispatch; a title update failure must not turn an accepted task into a failed submission.
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
