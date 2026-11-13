import {expandPortOrUrl, type CustomProviderKind} from './login.js';
import type {ImportedCredential} from './credential-import.js';
import {groupModelFamilies} from '../config/model-grouping.js';

/** One piece of an option's status badge; only the `success` and `warning` pieces are coloured, `dim` stays quiet. */
export interface WizardBadgeSegment {readonly text: string; readonly tone: 'success' | 'warning' | 'dim'}
export interface WizardOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Right-aligned status on the option's first row. */
  readonly badge?: readonly WizardBadgeSegment[];
}
export interface WizardQuestion {
  readonly title: string;
  readonly question: string;
  readonly detail?: string;
  readonly options?: readonly WizardOption[];
  readonly secret?: boolean;
  readonly hideCustomInput?: boolean;
  readonly multiSelect?: boolean;
  readonly allowEmpty?: boolean;
  readonly defaultSelected?: readonly string[];
}
export type WizardAnswer = {readonly status: 'answered'; readonly value: string; readonly selected?: readonly string[]}
  | {readonly status: 'cancelled'};
export type WizardAsk = (question: WizardQuestion) => Promise<WizardAnswer>;
export interface WizardProviderRow {
  readonly name: string;
  readonly custom: boolean;
  readonly saved: boolean;
  readonly baseUrl?: string | undefined;
  readonly kind?: string | undefined;
  readonly default_model?: string | undefined;
  readonly api?: 'completions' | 'responses' | undefined;
  readonly models?: readonly string[] | undefined;
  readonly accountSignedIn?: boolean | undefined;
  /** Template property: the provider supports browser account sign-in. */
  readonly account?: boolean | undefined;
  /** Template property: the endpoint needs no API key (a local server). */
  readonly keyless?: boolean | undefined;
  /** Template property: one short phrase shown under the name. */
  readonly description?: string | undefined;
  /** Where the credential comes from: a stored key or sign-in, only the template's environment variable, or a keyless local endpoint that has a record. */
  readonly state?: 'signed-in' | 'account' | 'env-key' | 'local' | undefined;
}
export interface WizardProviderRecord {
  name: string;
  base_url: string;
  kind: CustomProviderKind;
  default_model?: string | undefined;
  api?: 'completions' | 'responses';
  models?: string[];
  catalog?: boolean;
}
export interface LoginWizardDeps {
  readonly ask: WizardAsk;
  readonly askBatch?: (questions: readonly WizardQuestion[]) => Promise<readonly WizardAnswer[] | null>;
  readonly notify: (text: string, level?: 'info' | 'error') => void;
  /** The list in display order: every template, then the user's own providers (and bare credentials). */
  readonly rows: () => Promise<readonly WizardProviderRow[]>;
  readonly discoverModels?: (record: WizardProviderRecord, key: string | undefined) => Promise<readonly string[]>;
  readonly commitProvider?: (record: WizardProviderRecord, key: string) => Promise<void>;
  readonly saveKey: (provider: string, key: string) => Promise<void>;
  readonly saveCustom: (record: WizardProviderRecord) => Promise<void>;
  /** Who currently relies on a model of this provider (for example `session`, actor ids); shown before a deletion. */
  readonly users?: (name: string) => Promise<readonly string[]>;
  readonly removeCustom: (name: string) => Promise<void>;
  readonly browserLogin: (provider: string) => Promise<'done' | 'unsupported' | 'cancelled'>;
  readonly signOut?: (provider: string) => Promise<void>;
  readonly importable?: () => readonly ImportedCredential[];
  readonly applyImport?: (credential: ImportedCredential) => Promise<void>;
}
export type LoginWizardOutcome = 'added' | 'updated' | 'deleted' | 'imported' | 'signed-in' | 'signed-out' | 'cancelled' | 'failed';

type Answered = Extract<WizardAnswer, {status: 'answered'}>;
const option = (id: string, label: string, description = '', badge?: readonly WizardBadgeSegment[]): WizardOption =>
  ({id, label, description, ...(badge ? {badge} : {})});
const CUSTOM_ENTRY = '__custom';
const CUSTOM_DESCRIPTION = 'Any OpenAI- or Anthropic-compatible URL with an API key';
const stateLabels = {'signed-in': '✓ signed in', account: '✓ account', 'env-key': '✓ env key', local: '✓ local'} as const;
/**
 * `built-in` or `custom`, then the credential state in the success tone; an orphan credential is flagged instead.
 * One provider name holds one credential, so each list shows only its own kind: `✓ account` in the account list,
 * `✓ signed in` / `✓ env key` / `✓ local` in the API key list (where an account login counts as not set up).
 */
export function badgeOf(row: WizardProviderRow, list: 'key' | 'account' = 'key'): readonly WizardBadgeSegment[] {
  if (!row.baseUrl) return [{text: 'credential only', tone: 'warning'}];
  const origin: WizardBadgeSegment = {text: row.custom ? 'custom' : 'built-in', tone: 'dim'};
  const state = list === 'account' ? (row.state === 'account' ? row.state : undefined) : (row.state === 'account' ? undefined : row.state);
  return state ? [origin, {text: ' · ', tone: 'dim'}, {text: stateLabels[state], tone: 'success'}] : [origin];
}
function describe(row: WizardProviderRow): string {
  return !row.baseUrl ? 'Saved credential without an endpoint' : row.custom ? row.baseUrl : row.description ?? row.baseUrl;
}
/** A provider set up for API-key use: a record, a stored key, a config entry, or the template's key variable. An account login does not count. */
const isSetUp = (row: WizardProviderRow): boolean => row.state !== 'account' && (row.saved || row.state !== undefined);
const menu = (question: string, options: readonly WizardOption[]): WizardQuestion =>
  ({title: 'Providers', question, options, hideCustomInput: true});
const field = (question: string, extra: Partial<WizardQuestion> = {}): WizardQuestion =>
  ({title: 'Providers', question, ...extra});
const protocols = [option('completions', 'Chat Completions'), option('responses', 'Responses'), option('anthropic', 'Anthropic Messages')];
const words = (value: string): string[] => value.split(/[\s,]+/u).filter(Boolean);
const unique = (items: readonly string[]): string[] => [...new Set(items.map(item => item.trim()).filter(Boolean))];
const sameModels = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every(item => b.includes(item));
function protocol(record: WizardProviderRecord): string {
  return record.kind === 'anthropic' ? 'anthropic' : record.api ?? 'completions';
}
function withProtocol(record: WizardProviderRecord, value: string): WizardProviderRecord {
  const {api: _api, ...rest} = record;
  if (value === 'anthropic') return {...rest, kind: 'anthropic'};
  if (value !== 'completions' && value !== 'responses') throw new Error('Invalid wire protocol.');
  return {...rest, kind: 'openai_compat', api: value};
}
function fromRow(row: WizardProviderRow): WizardProviderRecord {
  return {
    name: row.name, base_url: row.baseUrl ?? '', kind: row.kind === 'anthropic' ? 'anthropic' : 'openai_compat',
    ...(row.default_model ? {default_model: row.default_model} : {}),
    ...(row.api ? {api: row.api} : {}), models: [...row.models ?? []], ...(!row.custom ? {catalog: true} : {}),
  };
}

/** Optional first-run step: returns the typed name, or undefined when skipped (empty Enter or Esc). */
export async function askPreferredName(ask: WizardAsk): Promise<string | undefined> {
  const answer = await ask({title: 'Welcome', question: 'What should Logox call you?', allowEmpty: true,
    detail: 'Optional. Enter or Esc skips; change it later with /name.'});
  if (answer.status !== 'answered' || answer.value === '__cancel') return undefined;
  return answer.value.trim() || undefined;
}

/** Local orchestration only: credentials remain in local variables until the explicit save boundary. */
export async function runLoginWizard(deps: LoginWizardDeps, initial?: string): Promise<LoginWizardOutcome> {
  const ask = async (question: WizardQuestion): Promise<Answered | null> => {
    const answer = await deps.ask(question);
    return answer.status === 'answered' && answer.value !== '__cancel' ? answer : null;
  };
  const batch = async (questions: readonly WizardQuestion[]): Promise<readonly Answered[] | null> => {
    if (deps.askBatch) {
      const answers = await deps.askBatch(questions);
      if (!answers || answers.length !== questions.length || answers.some(a => a.status === 'cancelled' || a.value === '__cancel')) return null;
      return answers as readonly Answered[];
    }
    const answers: Answered[] = [];
    for (const question of questions) {
      const answer = await ask(question);
      if (!answer) return null;
      answers.push(answer);
    }
    return answers;
  };
  const save = async (record: WizardProviderRecord, key = ''): Promise<void> => {
    if (deps.commitProvider) await deps.commitProvider(record, key);
    else {
      if (key) await deps.saveKey(record.name, key);
      await deps.saveCustom(record);
    }
  };
  const chooseModels = async (record: WizardProviderRecord, key?: string): Promise<string[] | null> => {
    let discovered: readonly string[] = [];
    if (deps.discoverModels) {
      try {discovered = await deps.discoverModels(record, key);}
      catch {deps.notify('Model discovery failed. Enter model names manually.');}
    }
    const rawCandidates = unique([...discovered, ...record.models ?? []]);
    const families = groupModelFamilies(rawCandidates, record.name);
    const activeModelSet = new Set(record.models ?? []);
    const defaultSelected = families
      .filter(f => f.variants.some(v => activeModelSet.has(v)) || activeModelSet.has(f.baseModel))
      .map(f => f.baseModel);

    const answer = await ask(field('Select the models to enable', {
      multiSelect: true,
      allowEmpty: Boolean(record.catalog),
      ...(defaultSelected.length ? {defaultSelected} : {}),
      detail: record.catalog
        ? 'Select model families or leave empty to use the whole catalog. Space toggles.'
        : 'Select model families or enter model names separated by spaces or commas. Space toggles.',
      options: families.map(f => option(f.baseModel, f.baseModel, f.description)),
    }));
    if (!answer) return null;
    const selectedInputs = [...new Set([...answer.selected ?? [], ...words(answer.value)])];
    const expanded = selectedInputs.flatMap(item => {
      const family = families.find(f => f.baseModel === item);
      return family && family.variants.length ? family.variants : [item];
    });
    return unique(expanded);
  };
  const confirm = async (record: WizardProviderRecord, hasKey: boolean, note?: string): Promise<boolean> => {
    const answer = await ask({...menu('Write this provider configuration?', [option('write', 'Write and enable'), option('cancel', 'Cancel')]),
      detail: [record.name, record.base_url, protocol(record), record.models?.join(', ') || 'Whole catalog', hasKey ? 'API key supplied' : 'No new API key', ...note ? [note] : []].join(' · ')});
    return answer?.value === 'write';
  };
  const oauth = async (name: string): Promise<LoginWizardOutcome> => {
    const result = await deps.browserLogin(name);
    if (result === 'done') return 'signed-in';
    if (result === 'cancelled') return 'cancelled';
    deps.notify('Account sign-in is not supported for this provider.', 'error');
    return 'failed';
  };
  /** Persists a chosen record, confirming first; shared by the template add flow and the custom endpoint flow. */
  const finishAdd = async (record: WizardProviderRecord, key: string, note?: string): Promise<LoginWizardOutcome> => {
    // An explicit empty key means anonymous discovery for this new route.
    // Undefined is reserved for edits, where the host resolves an existing credential.
    const models = await chooseModels(record, key);
    if (models === null || (!record.catalog && !models.length)) return 'cancelled';
    record.models = models;
    if (models.length > 0 && !record.default_model) {
      record.default_model = models[0];
    }
    if (!await confirm(record, Boolean(key), note)) return 'cancelled';
    await save(record, key);
    return 'added';
  };
  const addCustom = async (): Promise<LoginWizardOutcome> => {
    const route = await ask(field('Enter a route name'));
    if (!route || !route.value.trim()) return 'cancelled';
    const name = route.value.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(name)) throw new Error('Invalid route name.');
    // Add must never reuse an existing route's credential with a replacement endpoint.
    if ((await deps.rows()).some(row => row.name === name)) {
      deps.notify('This provider route already exists. Choose it in the list to edit it instead.', 'error');
      return 'failed';
    }
    const credential = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Optional for endpoints that do not require authentication.'}));
    if (!credential) return 'cancelled';
    const connection = await batch([field('Enter the base URL or port'), menu('Choose the wire protocol', protocols)]);
    if (!connection) return 'cancelled';
    return finishAdd(withProtocol({name, base_url: expandPortOrUrl(connection[0]!.value), kind: 'openai_compat', models: []}, connection[1]!.value), credential.value.trim());
  };
  /** A template the user has not set up: the template only pre-fills the base URL; the saved record owns it. */
  const addTemplate = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    const record = fromRow(row);
    record.catalog = true;
    const endpoint = await ask(field('Choose the base URL', {options: [option('default', 'Use default endpoint', record.base_url)], allowEmpty: true}));
    if (!endpoint) return 'cancelled';
    if (endpoint.value && endpoint.value !== 'default') record.base_url = expandPortOrUrl(endpoint.value);
    const credential = await ask(row.keyless
      ? field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Optional for endpoints that do not require authentication.'})
      : field('Enter the API key', {secret: true}));
    if (!credential || (!row.keyless && !credential.value.trim())) return 'cancelled';
    // One provider name holds one credential: a key saved here replaces an account login.
    return finishAdd(record, credential.value.trim(), row.state === 'account' ? 'Replaces the account sign-in' : undefined);
  };
  const remove = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    const users = await deps.users?.(row.name) ?? [];
    const answer = await ask({...menu('Delete this provider?', [option('delete', 'Delete provider'), option('cancel', 'Cancel')]),
      ...(users.length ? {detail: 'In use by: ' + users.join(', ') + '. Their model bindings are cleared; nothing is switched to another model.'} : {})});
    if (answer?.value !== 'delete') return 'cancelled';
    await deps.removeCustom(row.name);
    return 'deleted';
  };
  const editModels = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    const record = fromRow(row);
    const models = await chooseModels(record);
    if (models === null || (!row.custom ? false : !models.length) || sameModels(models, record.models ?? [])) return 'cancelled';
    record.models = models;
    await save(record);
    return 'updated';
  };
  /** A provider signed in by account (listed under Account sign-in): sign in again, change its models, or delete it. */
  const editAccount = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    const action = await ask(menu('Choose one field to edit', [option('signin', 'Sign in again'), option('models', 'Model list'), option('delete', 'Delete provider')]));
    if (action?.value === 'signin') return oauth(row.name);
    if (action?.value === 'models') return editModels(row);
    return action?.value === 'delete' ? remove(row) : 'cancelled';
  };
  /** A provider that is set up (built-in or custom): change one field of its record or delete it. */
  const edit = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    let record = fromRow(row);
    const action = await ask(menu('Choose one field to edit', [option('key', 'API key'), option('url', 'Base URL'), option('protocol', 'Wire protocol'),
      option('models', 'Model list'), ...(row.saved ? [option('delete', 'Delete provider')] : [])]));
    if (!action) return 'cancelled';
    switch (action.value) {
      case 'key': {
        const answer = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Leave empty to keep the current key.'}));
        if (!answer?.value.trim()) return 'cancelled';
        await deps.saveKey(row.name, answer.value.trim());
        return 'updated';
      }
      case 'url': {
        const answer = await ask(field('Enter the base URL or port', {allowEmpty: true}));
        if (!answer?.value.trim()) return 'cancelled';
        const url = expandPortOrUrl(answer.value);
        if (url === record.base_url) return 'cancelled';
        record.base_url = url;
        break;
      }
      case 'protocol': {
        const answer = await ask(menu('Choose the wire protocol', protocols));
        if (!answer || answer.value === protocol(record)) return 'cancelled';
        record = withProtocol(record, answer.value);
        break;
      }
      case 'models': return editModels(row);
      case 'delete': return row.saved ? remove(row) : 'cancelled';
      default: return 'cancelled';
    }
    await save(record);
    return 'updated';
  };
  /** Opens one provider: a bare credential can only be deleted, a set-up provider is edited, an unset template is added. */
  const open = async (row: WizardProviderRow): Promise<LoginWizardOutcome> => {
    if (!row.baseUrl) {
      const action = await ask(menu('Choose one field to edit', [option('delete', 'Delete provider')]));
      return action?.value === 'delete' ? remove(row) : 'cancelled';
    }
    return isSetUp(row) ? edit(row) : addTemplate(row);
  };
  const entry = (list: 'key' | 'account') => (row: WizardProviderRow) => option(row.name, row.name, describe(row), badgeOf(row, list));
  try {
    const rows = await deps.rows();
    // `/login <name>` jumps straight to that provider's key flow or edit menu.
    const target = initial === undefined ? undefined : rows.find(row => row.name === initial);
    if (target) return await open(target);
    const method = await ask(menu('Choose a sign-in method', [option('key', 'API key', 'Sign in with a URL and an API key'),
      option('account', 'Account sign-in', 'Authorize in the browser with a provider account')]));
    if (!method) return 'cancelled';
    if (method.value === 'account') {
      // Which providers offer account sign-in is a template property, not a name.
      const accounts = rows.filter(row => row.account);
      if (!accounts.length) {
        deps.notify('Account sign-in is not supported for this provider.', 'error');
        return 'failed';
      }
      const account = await ask(menu('Choose an account provider', accounts.map(entry('account'))));
      const row = accounts.find(row => row.name === account?.value);
      if (!row) return 'cancelled';
      if (row.state === 'account') return await editAccount(row);
      if (row.state === 'signed-in') {
        // One provider name holds one credential: signing in by account replaces the saved key.
        const replace = await ask({...menu('Sign in with this account?', [option('continue', 'Sign in'), option('cancel', 'Cancel')]), detail: 'Replaces the saved API key'});
        if (replace?.value !== 'continue') return 'cancelled';
      }
      return await oauth(row.name);
    }
    // One list: every template, then the user's own providers, then the entry that starts a custom endpoint.
    const chosen = await ask(menu('Choose a provider', [...rows.map(entry('key')), option(CUSTOM_ENTRY, 'Custom endpoint', CUSTOM_DESCRIPTION)]));
    if (!chosen) return 'cancelled';
    if (chosen.value === CUSTOM_ENTRY) return await addCustom();
    const row = rows.find(row => row.name === chosen.value);
    return row ? await open(row) : 'cancelled';
  } catch {
    // Callback failures may include credentials in their messages. Never echo them into the UI.
    try {deps.notify('Provider operation failed. No successful completion was reported.', 'error');} catch { /* Notification cannot turn failure into success. */ }
    return 'failed';
  }
}
