/**
 * Provider management glue of one session, with no UI dependency: who relies on a provider, deleting a provider together
 * with everything bound to it, the `/login` provider list, and the dependencies the login wizard runs on (model discovery,
 * committing a provider record, saving keys and custom endpoints, browser sign-in). Questions reach the user only through
 * the injected `LoginFlow`; notices and receipts go through the injected emitters. The session selection is read and
 * saved through the injected model-selection functions, never copied here.
 */
import {z} from 'zod';
import type {ActorCatalog} from '../actors/catalog.js';
import type {ActorServices} from '../actors/services.js';
import {presets, type Config} from '../config/config.js';
import {isDirector} from '../runtime/director-id.js';
import type {Tools} from '../tools/tools.js';
import type {LoginFlow} from './login.js';
import {runLoginWizard, type WizardProviderRow} from './login-wizard.js';
import type {ModelPool} from './model-pool.js';
import type {ProviderRegistry} from './registry.js';

export interface ProviderManagementDeps {
  registry: ProviderRegistry; modelPool: ModelPool; actors: ActorCatalog; actorServices: ActorServices; tools: Tools;
  config: Config; env: NodeJS.ProcessEnv; authentication: LoginFlow; signal: AbortSignal;
  /** The session selection (provider and model) as it is right now. */
  selection(): {provider: string; model: string};
  saveSelection(next: ProviderRegistry): Promise<void>;
  notice(text: string, kind: 'command_error' | 'command_result', owner: string): void;
  receipt(text: string, presentation: 'status', title: undefined, owner: string): void;
}

export function createProviderManagement(deps: ProviderManagementDeps) {
  const {registry, modelPool, actors, actorServices, tools, config, env, authentication, signal, selection, saveSelection, notice, receipt} = deps;
  /** Who relies on a model of one provider: the session selection, actor default models and the dedicated Automa model. */
  const providerUsers = (name: string): {session: boolean; actors: string[]; automa: boolean} => ({
    session: selection().provider === name && Boolean(selection().model),
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
      try {await actorServices.management.saveDefaultModel(id, undefined, signal); cleared.push(id);}
      catch {unresolved.push(id);}
    }
    if (users.automa) {
      try {await tools.modelStorage.save('automa', undefined, signal);}
      catch {unresolved.push('automa');}
    }
    const lines: string[] = [];
    if (cleared.length) lines.push('Cleared the model of ' + cleared.join(', ') + '. They use the session model until you choose one with /model <actor>.');
    if (users.automa && !unresolved.includes('automa')) lines.push('Cleared the dedicated Automa model; workers use the session model.');
    if (unresolved.length) lines.push('Could not clear the model of ' + unresolved.join(', ') + '; choose another one with /model <actor>.');
    if (users.session) {
      const gone = selection().provider + '/' + selection().model;
      try {await saveSelection(registry.candidate('openai', ''));}
      catch {lines.push('The session model ' + gone + ' is on this provider and could not be reset now. Choose a model with /model once tasks are idle.');}
      if (!selection().model) lines.push('The session model ' + gone + ' was on this provider; no model is selected now. Choose one with /model.');
    }
    if (lines.length) notice("Provider '" + name + "' removed.\n" + lines.join('\n'), 'command_result', owner);
  };
  /** The `/login` list in display order: every listed template, then the user's own providers, then bare credentials (listed so they can be removed). */
  const wizardRows = async (): Promise<WizardProviderRow[]> => {
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
  const syncCredential = async (name: string, owner: string, defaultModel?: string) => {
    try {await saveSelection(registry.candidate(name, defaultModel));}
    catch {notice('Credential saved; model preference was not updated.', 'command_error', owner);}
    await modelPool.syncProvider(name).catch(() => {});
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
          if (key) await registry.auth.save(record.name, key, signal);
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
        await registry.auth.save(name, key, signal);
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
  return {providerUsers, usersLabel, removeProvider, wizardRows, loginWizard};
}
export type ProviderManagement = ReturnType<typeof createProviderManagement>;
