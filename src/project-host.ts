/**
 * Project-level services shared by every session of one project: identity/config, provider registry, journal, actors, the
 * permission engine, usage, extensions and the tool set. A session runtime is built on top by `createSessionApplication`;
 * the legacy single-session adapter and `SessionHub` use the same host so their wiring cannot drift.
 *
 * The host owns only project-wide state. Session state (runtime store, queue, timers, tools registrations) belongs to the
 * session application and is released with it.
 */
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {ActorCatalog} from './actors/catalog.js';
import {assertActorProfiles, seedActorProfiles} from './actors/profiles.js';
import {loadConfig} from './config/config.js';
import {StatusbarPreferences} from './config/statusbar-preferences.js';
import {loadUserName} from './config/user-profile.js';
import {migrateProjectData} from './store/project-migration.js';
import {ProviderRegistry} from './providers/registry.js';
import {AuthStorage} from './providers/auth.js';
import {CustomProviderStorage} from './providers/custom-storage.js';
import {migrateOpenAiAccount} from './providers/account-migration.js';
import {Journal} from './store/journal.js';
import {SessionManager} from './store/sessions.js';
import {Tools} from './tools/tools.js';
import {PermissionEngine} from './permissions/engine.js';
import {StateFile, preferenceSchema} from './config/model-preferences.js';
import {UsageLedger} from './context/usage.js';
import {SkillUsage} from './resources/skill-usage.js';
import {SkillCurator} from './resources/skill-curator.js';
import {ProjectExtensions, observeTools} from './extensions/runtime.js';
import type {ExtensionApproval} from './extensions/mcp.js';
import {loadUiPreferences} from './commands/pages.js';
import type {ApplicationOptions} from './application.js';
import type {createSessionApplication} from './application.js';

export type SessionApplicationFactory = typeof createSessionApplication;
export type SessionApplication = Awaited<ReturnType<SessionApplicationFactory>>;

export interface HostSessionOptions {
  sessionId: string;
  sessionCommand(text: string): Promise<boolean>;
  beforeTask(): Promise<void>;
  isPersistent(): boolean;
  /** Disables terminal-only onboarding and notifications. */
  interactive?: boolean;
}

/** Everything one session needs from the project, plus the legacy session factory. */
export class ProjectHost {
  private closed = false;
  private closeTask: Promise<void> | undefined;
  /** Diagnostics emitted before a session exists (migration, extensions, usage). */
  noticeSink: (text: string) => void = () => {};
  private constructor(
    readonly options: ApplicationOptions,
    private readonly factory: SessionApplicationFactory,
    readonly cwd: string,
    readonly manager: SessionManager,
    readonly dataDir: string,
    readonly config: Awaited<ReturnType<typeof loadConfig>>,
    readonly registry: ProviderRegistry,
    readonly journal: Journal,
    readonly actors: ActorCatalog,
    readonly preferences: StateFile<z.infer<typeof preferenceSchema>>,
    readonly permissions: PermissionEngine,
    readonly usage: UsageLedger,
    readonly extensions: ProjectExtensions,
    readonly tools: Tools,
    readonly statusbar: StatusbarPreferences,
    readonly ui: ReturnType<typeof loadUiPreferences>,
    readonly profile: Promise<string | undefined>,
    readonly notices: readonly string[],
    private readonly ownsExtensions: boolean,
    readonly skillUsage: SkillUsage,
  ) {}

  static async open(options: ApplicationOptions, factory: SessionApplicationFactory): Promise<ProjectHost> {
    const home = options.resourceOptions?.home ?? homedir();
    // Before anything reads state: runtime state written under `<project>/.logox/` by older versions moves to the project data folder.
    const dataMigration = await migrateProjectData({project: await realpath(options.cwd), home});
    const manager = await SessionManager.open(options.cwd, {dataDir: dataMigration.dataDir}), cwd = manager.project;
    if (options.sessionId !== undefined && !options.sessionId.trim()) throw new Error('Session ID must not be empty');
    let registry: ProviderRegistry | undefined, extensions: ProjectExtensions | undefined, usage: UsageLedger | undefined;
    let host: ProjectHost | undefined;
    try {
      const auth = new AuthStorage(options.authPath ?? join(home, '.logox', 'auth.json')), customStorage = new CustomProviderStorage(join(home, '.logox', 'custom-providers.json'));
      // Before the config reads the saved selection: the account sign-in used to live under the provider `openai`.
      const migration = await migrateOpenAiAccount({auth, customStorage, home, project: cwd, dataDir: dataMigration.dataDir}).catch(() => undefined);
      const config = options.config ?? await loadConfig(cwd, {}, options.env ?? process.env, options.resourceOptions?.home, options.resourceOptions?.boundary);
      const providers = registry = new ProviderRegistry(config, options.env ?? process.env, options.fetcher, auth, customStorage);
      await providers.syncCustom();
      if (migration?.status === 'migrated' && providers.selection().provider === 'openai') providers.select('openai-auth', config.provider.model);
      const journal = new Journal(join(manager.directory, 'sessions'));
      const actors = new ActorCatalog(cwd, options.resourceOptions?.home ? {home} : {});
      // Both are project files; load them even when the first session starts before a profile exists.
      await (options.resourceOptions?.home && resolve(home) !== resolve(homedir()) ? seedActorProfiles(home) : assertActorProfiles(home));
      await actors.load();
      const preferences = new StateFile(join(manager.directory, 'model-preferences.json'), preferenceSchema);
      const permissions = new PermissionEngine(cwd, config.permissions.mode, join(dataMigration.dataDir, 'permissions.json'),
        join(home, '.logox', 'user-permissions.json'), join(home, '.logox', 'permission-mode.json'));
      await permissions.load();
      const notices: string[] = [...dataMigration.notices];
      if (migration?.notice) notices.push(migration.notice);
      const ledger = usage = new UsageLedger(join(manager.directory, 'usage'), text => host?.noticeSink(text) ?? notices.push(text));
      const approveExtension: ExtensionApproval = options.approveExtension ?? ((request, context) => {
        const tools = host?.tools;
        if (!tools) return Promise.reject(new Error('Project host is not ready'));
        return tools.authorizeExtension({id: request.callId, name: 'mcp:' + request.server + ':' + request.tool, arguments: JSON.stringify(request.arguments)},
          context, request.action === 'list' ? 'read' : 'unknown');
      });
      const projectExtensions = extensions = options.extensions ?? new ProjectExtensions(cwd, config, options.resourceOptions, approveExtension,
        text => host?.noticeSink(text) ?? notices.push(text));
      const tools = observeTools(new Tools(cwd, undefined, permissions, {home, dataDir: dataMigration.dataDir}), projectExtensions.hooks);
      const skillUsage = new SkillUsage({home, cwd, dataDir: dataMigration.dataDir, resources: projectExtensions.resources});
      tools.onSkillRead = (path, context) => skillUsage.read(path, context);
      tools.shellAutoBackgroundMs = () => config.kernel.shell_auto_background_seconds * 1000;
      const curator = projectExtensions.resources.curator = new SkillCurator({usage: skillUsage, resources: projectExtensions.resources,
        onError: error => host?.noticeSink('Skill curator: ' + (error instanceof Error ? error.message : 'failed'))});
      tools.skills = {visible: actorId => projectExtensions.resources.skillsFor({actorId}), uses: skills => skillUsage.entriesFor(skills),
        archived: actorId => projectExtensions.resources.archivedFor({actorId}), restore: name => curator.restore(name)};
      projectExtensions.resources.usage = skills => skillUsage.entriesFor(skills);
      const statusbar = new StatusbarPreferences(options.statusbarPath ?? join(home, '.logox', 'statusbar.json'));
      let statusbarIssue: string | undefined;
      try {await statusbar.load();} catch (error) {statusbarIssue = error instanceof Error ? error.message : 'Could not read statusbar preferences; using default layout.';}
      // User-wide preferences are read once for the project; each session copies the profile name into its own state.
      const ui = loadUiPreferences(home, config);
      const profile = loadUserName(home).catch(() => undefined);
      if (!options.extensions) await projectExtensions.initialize();
      host = new ProjectHost(options, factory, cwd, manager, dataMigration.dataDir, config, providers, journal, actors, preferences, permissions, ledger,
        projectExtensions, tools, statusbar, ui, profile, statusbarIssue ? [...notices, statusbarIssue] : notices, options.extensions === undefined, skillUsage);
      return host;
    } catch (error) {
      try {await host?.close();} catch {}
      try {if (!options.extensions) await extensions?.close();} catch {}
      try {await registry?.close();} catch {}
      try {await usage?.flush();} catch {}
      throw error;
    }
  }

  /** Every owner this project knows for a session, used by history/rewind listings. */
  async owners(sessionId: string): Promise<string[]> {
    return [...new Set([...this.actors.list().map(actor => actor.id), ...(await this.journal.tasks(sessionId)).map(task => task.ownerId)])];
  }

  /** True when the project has a catalog entry, ledger or task record for the id. */
  async hasHistory(sessionId: string): Promise<boolean> {
    if (await this.manager.info(sessionId)) return true;
    const entries = (await Promise.all((await this.owners(sessionId)).map(owner => this.journal.load(sessionId, owner)))).flat();
    return entries.length > 0 || (await this.journal.activeTasks(sessionId)).length > 0;
  }

  async createSession(options: HostSessionOptions): Promise<SessionApplication> {
    if (this.closed) throw new Error('Project host is closed');
    this.skillUsage.recordDay();
    // Once per session start, after the active day is recorded: idle skills turn stale or move to .archive/ (never deleted).
    try {
      const run = await this.extensions.resources.curator?.run();
      if (run?.archived.length) this.noticeSink('Archived ' + run.archived.length + ' unused skill' + (run.archived.length === 1 ? '' : 's') + ': ' + run.archived.join(', ') + '. Restore them from /skills.');
    } catch (error) {this.noticeSink('Skill curator: ' + (error instanceof Error ? error.message : 'failed'));}
    return this.factory({...this.options, cwd: this.cwd, config: this.config, sessionId: options.sessionId, dataDir: this.dataDir,
      registry: this.registry, tools: this.tools, preferences: this.preferences, permissions: this.permissions, usage: this.usage,
      extensions: this.extensions, actors: this.actors, sessionCommand: options.sessionCommand, beforeTask: options.beforeTask,
      isPersistent: options.isPersistent, statusbar: this.statusbar, uiPreferences: this.ui, profile: this.profile,
      ...(options.interactive === undefined ? {} : {interactive: options.interactive})});
  }

  async close(): Promise<void> {
    this.closeTask ??= (async () => {
      this.closed = true;
      const failures: unknown[] = [];
      try {await this.usage.flush();} catch (error) {failures.push(error);}
      if (this.ownsExtensions) try {await this.extensions.close();} catch (error) {failures.push(error);}
      try {await this.registry.close();} catch (error) {failures.push(error);}
      if (failures.length) throw new AggregateError(failures, 'Some project services did not close');
    })();
    return this.closeTask;
  }
}

