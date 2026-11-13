import {expandPortOrUrl, type CustomProviderKind} from './login.js';
import {groupModelFamilies} from '../config/model-grouping.js';

/** One piece of an option's status badge; `success`, `warning` and `info` (a reminder, not a state) are coloured, `dim` stays quiet. */
export interface WizardBadgeSegment {readonly text: string; readonly tone: 'success' | 'warning' | 'info' | 'dim'}
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
  | {readonly status: 'cancelled'}
  /** The host closed the whole wizard (not Esc on one page): the wizard ends at once instead of going back a page. */
  | {readonly status: 'closed'};
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
  /** Template property: an account-only provider (browser sign-in, no API key). */
  readonly account?: boolean | undefined;
  /** Template property: the account provider of the same vendor, named by an API-key template. */
  readonly accountSibling?: string | undefined;
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
 * An API-key provider never shows an account state and an account provider never an API key state. An API-key entry without its own
 * credential whose template names a signed-in account sibling reads `account signed in` in the info tone: a reminder that the vendor is
 * already usable through the account, not a state of this entry.
 */
export function badgeOf(row: WizardProviderRow, list: 'key' | 'account' = 'key', rows: readonly WizardProviderRow[] = []): readonly WizardBadgeSegment[] {
  if (!row.baseUrl) return [{text: 'credential only', tone: 'warning'}];
  const origin: WizardBadgeSegment = {text: row.custom ? 'custom' : 'built-in', tone: 'dim'};
  const state = list === 'account' ? (row.state === 'account' ? row.state : undefined) : (row.state === 'account' ? undefined : row.state);
  if (state) return [origin, {text: ' · ', tone: 'dim'}, {text: stateLabels[state], tone: 'success'}];
  const sibling = list === 'key' && row.accountSibling ? rows.find(item => item.name === row.accountSibling) : undefined;
  return sibling?.state === 'account' ? [origin, {text: ' · ', tone: 'dim'}, {text: 'account signed in', tone: 'info'}] : [origin];
}
function describe(row: WizardProviderRow): string {
  return !row.baseUrl ? 'Saved credential without an endpoint' : row.custom ? row.baseUrl : row.description ?? row.baseUrl;
}
/** A provider that is set up: a record, a stored credential, a config entry, or the template's key variable. */
const isSetUp = (row: WizardProviderRow): boolean => row.saved || row.state !== undefined;
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

/** Esc on a page: go back to the page before it instead of ending the wizard. */
const BACK = Symbol('back');
/** Thrown inside the wizard when the host closed it, so every nested page unwinds at once. */
const CLOSED = Symbol('closed');
type Step = LoginWizardOutcome | typeof BACK;

/** Local orchestration only: credentials remain in local variables until the explicit save boundary. */
export async function runLoginWizard(deps: LoginWizardDeps, initial?: string): Promise<LoginWizardOutcome> {
  const ask = async (question: WizardQuestion): Promise<Answered | null> => {
    const answer = await deps.ask(question);
    if (answer.status === 'closed') throw CLOSED;
    return answer.status === 'answered' && answer.value !== '__cancel' ? answer : null;
  };
  const batch = async (questions: readonly WizardQuestion[]): Promise<readonly Answered[] | null> => {
    if (deps.askBatch) {
      const answers = await deps.askBatch(questions);
      if (answers?.some(a => a.status === 'closed')) throw CLOSED;
      if (!answers || answers.length !== questions.length || answers.some(a => a.status !== 'answered' || a.value === '__cancel')) return null;
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
  /** `write`, `cancel` (the Cancel option: ends the wizard) or null (Esc: one step back). */
  const confirm = async (record: WizardProviderRecord, hasKey: boolean): Promise<'write' | 'cancel' | null> => {
    const answer = await ask({...menu('Write this provider configuration?', [option('write', 'Write and enable'), option('cancel', 'Cancel')]),
      detail: [record.name, record.base_url, protocol(record), record.models?.join(', ') || 'Whole catalog', hasKey ? 'API key supplied' : 'No new API key'].join(' · ')});
    return answer ? answer.value === 'write' ? 'write' : 'cancel' : null;
  };
  const oauth = async (name: string): Promise<LoginWizardOutcome> => {
    const result = await deps.browserLogin(name);
    if (result === 'done') return 'signed-in';
    if (result === 'cancelled') return 'cancelled';
    deps.notify('Account sign-in is not supported for this provider.', 'error');
    return 'failed';
  };
  /** Runs the steps in order. A step that returns false (Esc) goes back to the one before it; backing out of the first step returns false. */
  const sequence = async (steps: readonly (() => Promise<boolean>)[]): Promise<boolean> => {
    let index = 0;
    while (index < steps.length) {
      if (await steps[index]!()) index++;
      else if (index === 0) return false;
      else index--;
    }
    return true;
  };
  /** The shared tail of both add flows: the model list, then the confirmation that writes. `done.outcome` is set once the flow ends. */
  const finishSteps = (record: () => WizardProviderRecord, key: () => string, done: {outcome?: LoginWizardOutcome}): (() => Promise<boolean>)[] => {
    let ownDefault: string | undefined, first = true;
    return [
      async () => {
        const target = record();
        if (first) {ownDefault = target.default_model; first = false;}
        for (;;) {
          // An explicit empty key means anonymous discovery for this new route.
          // Undefined is reserved for edits, where the host resolves an existing credential.
          const models = await chooseModels(target, key());
          if (models === null) return false;
          if (!target.catalog && !models.length) continue;
          target.models = models;
          const fallback = ownDefault ?? models[0];
          if (fallback) target.default_model = fallback; else delete target.default_model;
          return true;
        }
      },
      async () => {
        const answer = await confirm(record(), Boolean(key()));
        if (answer === null) return false;
        if (answer === 'write') await save(record(), key());
        done.outcome = answer === 'write' ? 'added' : 'cancelled';
        return true;
      },
    ];
  };
  const addCustom = async (): Promise<Step> => {
    let name = '', key = '';
    let record: WizardProviderRecord = {name: '', base_url: '', kind: 'openai_compat', models: []};
    const done: {outcome?: LoginWizardOutcome} = {};
    const finished = await sequence([
      async () => {
        const route = await ask(field('Enter a route name'));
        if (!route || !route.value.trim()) return false;
        name = route.value.trim();
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(name)) throw new Error('Invalid route name.');
        // Add must never reuse an existing route's credential with a replacement endpoint.
        if ((await deps.rows()).some(row => row.name === name)) {
          deps.notify('This provider route already exists. Choose it in the list to edit it instead.', 'error');
          done.outcome = 'failed';
        }
        return true;
      },
      async () => {
        if (done.outcome) return true;
        const credential = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Optional for endpoints that do not require authentication.'}));
        if (!credential) return false;
        key = credential.value.trim();
        return true;
      },
      async () => {
        if (done.outcome) return true;
        const connection = await batch([field('Enter the base URL or port'), menu('Choose the wire protocol', protocols)]);
        if (!connection) return false;
        record = withProtocol({name, base_url: expandPortOrUrl(connection[0]!.value), kind: 'openai_compat', models: []}, connection[1]!.value);
        return true;
      },
      ...finishSteps(() => record, () => key, done).map(step => async () => done.outcome === 'failed' ? true : step()),
    ]);
    return finished ? done.outcome ?? 'cancelled' : BACK;
  };
  /** A template the user has not set up: the template only pre-fills the base URL; the saved record owns it. */
  const addTemplate = async (row: WizardProviderRow): Promise<Step> => {
    const record = fromRow(row);
    record.catalog = true;
    const official = record.base_url;
    let key = '';
    const done: {outcome?: LoginWizardOutcome} = {};
    const finished = await sequence([
      async () => {
        const endpoint = await ask(field('Choose the base URL', {options: [option('default', 'Use default endpoint', official)], allowEmpty: true}));
        if (!endpoint) return false;
        record.base_url = endpoint.value && endpoint.value !== 'default' ? expandPortOrUrl(endpoint.value) : official;
        return true;
      },
      async () => {
        // Every listed API-key template needs a key; keyless endpoints are custom ones (`addCustom`).
        const credential = await ask(field('Enter the API key', {secret: true}));
        if (!credential || !credential.value.trim()) return false;
        key = credential.value.trim();
        return true;
      },
      ...finishSteps(() => record, () => key, done),
    ]);
    return finished ? done.outcome ?? 'cancelled' : BACK;
  };
  const remove = async (row: WizardProviderRow): Promise<Step> => {
    const users = await deps.users?.(row.name) ?? [];
    const answer = await ask({...menu('Delete this provider?', [option('delete', 'Delete provider'), option('cancel', 'Cancel')]),
      ...(users.length ? {detail: 'In use by: ' + users.join(', ') + '. Their model bindings are cleared; nothing is switched to another model.'} : {})});
    if (answer?.value !== 'delete') return BACK;
    await deps.removeCustom(row.name);
    return 'deleted';
  };
  const editModels = async (row: WizardProviderRow): Promise<Step> => {
    const record = fromRow(row);
    const models = await chooseModels(record);
    if (models === null || (!row.custom ? false : !models.length) || sameModels(models, record.models ?? [])) return BACK;
    record.models = models;
    await save(record);
    return 'updated';
  };
  /** A provider signed in by account (listed under Account sign-in): sign in again, change its models, or delete it. Esc in a sub-page returns to this menu. */
  const editAccount = async (row: WizardProviderRow): Promise<Step> => {
    for (;;) {
      const action = await ask(menu('Choose one field to edit', [option('signin', 'Sign in again'), option('models', 'Model list'), option('delete', 'Delete provider')]));
      if (!action) return BACK;
      if (action.value === 'signin') return oauth(row.name);
      const result = action.value === 'models' ? await editModels(row) : action.value === 'delete' ? await remove(row) : BACK;
      if (result !== BACK) return result;
    }
  };
  /** A provider that is set up (built-in or custom): change one field of its record or delete it. Esc or an unchanged value in a field returns to this menu. */
  const edit = async (row: WizardProviderRow): Promise<Step> => {
    for (;;) {
      let record = fromRow(row);
      const action = await ask(menu('Choose one field to edit', [option('key', 'API key'), option('url', 'Base URL'), option('protocol', 'Wire protocol'),
        option('models', 'Model list'), ...(row.saved ? [option('delete', 'Delete provider')] : [])]));
      if (!action) return BACK;
      if (action.value === 'key') {
        const answer = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Leave empty to keep the current key.'}));
        if (!answer?.value.trim()) continue;
        await deps.saveKey(row.name, answer.value.trim());
        return 'updated';
      }
      if (action.value === 'models' || action.value === 'delete') {
        const result = action.value === 'models' ? await editModels(row) : row.saved ? await remove(row) : BACK;
        if (result !== BACK) return result;
        continue;
      }
      if (action.value === 'url') {
        const answer = await ask(field('Enter the base URL or port', {allowEmpty: true}));
        if (!answer?.value.trim()) continue;
        const url = expandPortOrUrl(answer.value);
        if (url === record.base_url) continue;
        record.base_url = url;
      } else if (action.value === 'protocol') {
        const answer = await ask(menu('Choose the wire protocol', protocols));
        if (!answer || answer.value === protocol(record)) continue;
        record = withProtocol(record, answer.value);
      } else continue;
      await save(record);
      return 'updated';
    }
  };
  /** Opens one provider: a bare credential can only be deleted, a set-up provider is edited, an unset template is added. */
  const open = async (row: WizardProviderRow): Promise<Step> => {
    if (!row.baseUrl) {
      for (;;) {
        const action = await ask(menu('Choose one field to edit', [option('delete', 'Delete provider')]));
        if (action?.value !== 'delete') return BACK;
        const result = await remove(row);
        if (result !== BACK) return result;
      }
    }
    // An account provider has no API-key flow: signed in it opens its account menu, otherwise it starts the browser sign-in.
    if (row.account) {
      if (row.state === 'account') return editAccount(row);
      const result = await oauth(row.name);
      return result === 'cancelled' ? BACK : result;
    }
    return isSetUp(row) ? edit(row) : addTemplate(row);
  };
  const entry = (list: 'key' | 'account', rows: readonly WizardProviderRow[]) => (row: WizardProviderRow) =>
    option(row.name, row.name, describe(row), badgeOf(row, list, rows));
  try {
    const rows = await deps.rows();
    // `/login <name>` jumps straight to that provider's key flow or edit menu; backing out of it closes the wizard.
    const target = initial === undefined ? undefined : rows.find(row => row.name === initial);
    if (target) {
      const result = await open(target);
      return result === BACK ? 'cancelled' : result;
    }
    // Esc on any page returns to the page before it; only Esc on this first page closes the wizard.
    for (;;) {
      const method = await ask(menu('Choose a sign-in method', [option('key', 'API key', 'Sign in with a URL and an API key'),
        option('account', 'Account sign-in', 'Authorize in the browser with a provider account')]));
      if (!method) return 'cancelled';
      // Which providers offer account sign-in is a template property, not a name.
      const accounts = rows.filter(row => row.account);
      if (method.value === 'account' && !accounts.length) {
        deps.notify('Account sign-in is not supported for this provider.', 'error');
        return 'failed';
      }
      for (;;) {
        // One list per method: for API keys every template, then the user's own providers, then the entry that starts a custom endpoint.
        const chosen = method.value === 'account'
          ? await ask(menu('Choose an account provider', accounts.map(entry('account', rows))))
          : await ask(menu('Choose a provider', [...rows.filter(row => !row.account).map(entry('key', rows)), option(CUSTOM_ENTRY, 'Custom endpoint', CUSTOM_DESCRIPTION)]));
        if (!chosen) break;
        const row = (method.value === 'account' ? accounts : rows).find(row => row.name === chosen.value);
        const result = method.value !== 'account' && chosen.value === CUSTOM_ENTRY ? await addCustom() : row ? await open(row) : BACK;
        if (result !== BACK) return result;
      }
    }
  } catch (error) {
    if (error === CLOSED) return 'cancelled';
    // Callback failures may include credentials in their messages. Never echo them into the UI.
    try {deps.notify('Provider operation failed. No successful completion was reported.', 'error');} catch { /* Notification cannot turn failure into success. */ }
    return 'failed';
  }
}
