import {expandPortOrUrl, type CustomProviderKind} from './login.js';
import type {ImportedCredential} from './credential-import.js';

export interface WizardOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
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
  readonly api?: 'completions' | 'responses' | undefined;
  readonly models?: readonly string[] | undefined;
  readonly accountSignedIn?: boolean | undefined;
}
export interface WizardProviderRecord {
  name: string;
  base_url: string;
  kind: CustomProviderKind;
  api?: 'completions' | 'responses';
  models?: string[];
  catalog?: boolean;
}
export interface LoginWizardDeps {
  readonly ask: WizardAsk;
  readonly askBatch?: (questions: readonly WizardQuestion[]) => Promise<readonly WizardAnswer[] | null>;
  readonly notify: (text: string, level?: 'info' | 'error') => void;
  readonly rows: () => Promise<readonly WizardProviderRow[]>;
  readonly catalog?: () => readonly WizardProviderRow[];
  readonly discoverModels?: (record: WizardProviderRecord, key: string | undefined) => Promise<readonly string[]>;
  readonly commitProvider?: (record: WizardProviderRecord, key: string) => Promise<void>;
  readonly saveKey: (provider: string, key: string) => Promise<void>;
  readonly saveCustom: (record: WizardProviderRecord) => Promise<void>;
  readonly removeCustom: (name: string) => Promise<void>;
  readonly browserLogin: (provider: string) => Promise<'done' | 'unsupported' | 'cancelled'>;
  readonly signOut?: (provider: string) => Promise<void>;
  readonly importable?: () => readonly ImportedCredential[];
  readonly applyImport?: (credential: ImportedCredential) => Promise<void>;
}
export type LoginWizardOutcome = 'added' | 'updated' | 'deleted' | 'imported' | 'signed-in' | 'signed-out' | 'cancelled' | 'failed';

type Answered = Extract<WizardAnswer, {status: 'answered'}>;
const option = (id: string, label: string, description = ''): WizardOption => ({id, label, description});
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
    ...(row.api ? {api: row.api} : {}), models: [...row.models ?? []], ...(!row.custom ? {catalog: true} : {}),
  };
}

/** Local orchestration only: credentials remain in local variables until the explicit save boundary. */
export async function runLoginWizard(deps: LoginWizardDeps): Promise<LoginWizardOutcome> {
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
    const candidates = unique([...discovered, ...record.models ?? []]);
    const answer = await ask(field('Select the models to enable', {
      multiSelect: true, allowEmpty: Boolean(record.catalog), defaultSelected: record.models ?? [],
      detail: record.catalog ? 'Select models or leave empty to use the whole catalog. You can also enter model names.'
        : 'Select models or enter model names separated by spaces or commas.',
      options: candidates.map(name => option(name, name)),
    }));
    if (!answer) return null;
    return unique([...answer.selected ?? [], ...words(answer.value)]);
  };
  const confirm = async (record: WizardProviderRecord, hasKey: boolean): Promise<boolean> => {
    const answer = await ask({...menu('Write this provider configuration?', [option('write', 'Write and enable'), option('cancel', 'Cancel')]),
      detail: [record.name, record.base_url, protocol(record), record.models?.join(', ') || 'Whole catalog', hasKey ? 'API key supplied' : 'No new API key'].join(' · ')});
    return answer?.value === 'write';
  };
  const oauth = async (name: string): Promise<LoginWizardOutcome> => {
    const result = await deps.browserLogin(name);
    if (result === 'done') return 'signed-in';
    if (result === 'cancelled') return 'cancelled';
    deps.notify('Account sign-in is not supported for this provider.', 'error');
    return 'failed';
  };
  try {
    const root = await ask(menu('Manage providers', [option('add', 'Add a new provider'), option('edit', 'Edit an existing provider')]));
    if (!root) return 'cancelled';
    if (root.value === 'add') {
      const branch = await ask(menu('Choose a provider source', [option('api', 'Built-in provider'), option('url', 'Custom API endpoint'), option('account', 'Account sign-in')]));
      if (!branch) return 'cancelled';
      if (branch.value === 'account') {
        const account = await ask(menu('Choose an account provider', [option('openai', 'OpenAI / ChatGPT'), option('__cancel', 'Cancel')]));
        return account?.value === 'openai' ? await oauth('openai') : 'cancelled';
      }
      let record: WizardProviderRecord;
      let key: string;
      if (branch.value === 'url') {
        const route = await ask(field('Enter a route name'));
        if (!route || !route.value.trim()) return 'cancelled';
        const name = route.value.trim();
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(name)) throw new Error('Invalid route name.');
        // Add must never reuse an existing route's credential with a replacement endpoint.
        const existing = [...await deps.rows(), ...deps.catalog?.() ?? []];
        if (existing.some(row => row.name === name)) {
          deps.notify('This provider route already exists. Use Edit an existing provider instead.', 'error');
          return 'failed';
        }
        const credential = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Optional for endpoints that do not require authentication.'}));
        if (!credential) return 'cancelled';
        key = credential.value.trim();
        const connection = await batch([field('Enter the base URL or port'), menu('Choose the wire protocol', protocols)]);
        if (!connection) return 'cancelled';
        record = withProtocol({name, base_url: expandPortOrUrl(connection[0]!.value), kind: 'openai_compat', models: []}, connection[1]!.value);
      } else if (branch.value === 'api') {
        const catalog = deps.catalog ? deps.catalog() : (await deps.rows()).filter(row => !row.custom);
        const provider = await ask(menu('Choose a built-in provider', catalog.map(row => option(row.name, row.name))));
        if (!provider) return 'cancelled';
        const row = catalog.find(row => row.name === provider.value);
        if (!row) return 'cancelled';
        record = fromRow(row);
        record.catalog = true;
        const credential = await ask(field('Enter the API key', {secret: true}));
        if (!credential || !credential.value.trim()) return 'cancelled';
        key = credential.value.trim();
        const endpoint = await ask(field('Choose the base URL', {options: [option('default', 'Use default endpoint', record.base_url)], allowEmpty: true}));
        if (!endpoint) return 'cancelled';
        if (endpoint.value && endpoint.value !== 'default') record.base_url = expandPortOrUrl(endpoint.value);
      } else return 'cancelled';
      // An explicit empty key means anonymous discovery for this new route.
      // Undefined is reserved for edits, where the host resolves an existing credential.
      const models = await chooseModels(record, key);
      if (models === null || (!record.catalog && !models.length)) return 'cancelled';
      record.models = models;
      if (!await confirm(record, Boolean(key))) return 'cancelled';
      await save(record, key);
      return 'added';
    }
    if (root.value !== 'edit') return 'cancelled';
    const rows = (await deps.rows()).filter(row => row.saved);
    const provider = await ask(menu('Choose a provider to edit', rows.map(row => option(row.name, row.name))));
    if (!provider) return 'cancelled';
    const row = rows.find(row => row.name === provider.value);
    if (!row) return 'cancelled';
    let record = fromRow(row);
    const action = await ask(menu('Choose one field to edit', [option('key', 'API key'),
      ...(row.custom ? [option('url', 'Base URL'), option('protocol', 'Wire protocol')] : []),
      option('models', 'Model list'), option('delete', 'Delete provider')]));
    if (!action) return 'cancelled';
    switch (action.value) {
      case 'key': {
        const answer = await ask(field('Enter the API key', {secret: true, allowEmpty: true, detail: 'Leave empty to keep the current key.'}));
        if (!answer?.value.trim()) return 'cancelled';
        await deps.saveKey(row.name, answer.value.trim());
        return 'updated';
      }
      case 'url': {
        if (!row.custom) return 'cancelled';
        const answer = await ask(field('Enter the base URL or port', {allowEmpty: true}));
        if (!answer?.value.trim()) return 'cancelled';
        const url = expandPortOrUrl(answer.value);
        if (url === record.base_url) return 'cancelled';
        record.base_url = url;
        break;
      }
      case 'protocol': {
        if (!row.custom) return 'cancelled';
        const answer = await ask(menu('Choose the wire protocol', protocols));
        if (!answer || answer.value === protocol(record)) return 'cancelled';
        record = withProtocol(record, answer.value);
        break;
      }
      case 'models': {
        const models = await chooseModels(record);
        if (models === null || (!row.custom ? false : !models.length) || sameModels(models, record.models ?? [])) return 'cancelled';
        record.models = models;
        break;
      }
      case 'delete': {
        const answer = await ask(menu('Delete this provider?', [option('delete', 'Delete provider'), option('cancel', 'Cancel')]));
        if (answer?.value !== 'delete') return 'cancelled';
        await deps.removeCustom(row.name);
        return 'deleted';
      }
      default: return 'cancelled';
    }
    await save(record);
    return 'updated';
  } catch {
    // Callback failures may include credentials in their messages. Never echo them into the UI.
    try {deps.notify('Provider operation failed. No successful completion was reported.', 'error');} catch { /* Notification cannot turn failure into success. */ }
    return 'failed';
  }
}
