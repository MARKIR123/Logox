import {AuthStorage} from './auth.js';
import {CustomProviderStorage} from './custom-storage.js';
import {discoverImportable, type ImportedCredential} from './credential-import.js';
import {startOpenAiOAuth, type OAuthSession} from './oauth.js';
import {createHttpTransport} from './transport.js';
import {formatDetailedError} from './error-format.js';
import type {WizardQuestion, WizardAnswer} from './login-wizard.js';

export interface WizardDraft {readonly selected: readonly string[]; readonly custom?: string}
export interface LocalWizardView {
  readonly key: number; readonly index: number; readonly questions: readonly WizardQuestion[];
  readonly answered: number;
}

export function expandPortOrUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Invalid URL or port: input is empty');
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    if (port <= 0 || port > 65535) throw new Error('Invalid port number: must be between 1 and 65535');
    return 'http://127.0.0.1:' + port + '/v1';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL or port: must be a numeric port or valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) base URL without credentials, query parameters, or fragments.');
  }
  return trimmed;
}

export type CustomProviderKind = 'openai_compat' | 'anthropic';

export interface LoginProviderRow {
  name: string;
  saved: boolean;
  custom?: boolean | undefined;
  baseUrl?: string | undefined;
  kind?: CustomProviderKind | undefined;
  deletable?: boolean | undefined;
  /** Custom providers open the prefilled edit wizard on Enter. */
  editable?: boolean | undefined;
}

/** Providers with a browser-account authorization flow; oauth.ts currently ships OpenAI only. */
export const accountProviders: readonly string[] = ['openai'];

export interface LoginState {
  wizard?: LocalWizardView | undefined;
  collapsed?: boolean | undefined;
  phase: 'wizard' | 'provider' | 'add' | 'account' | 'method' | 'key' | 'oauth' | 'custom_name' | 'custom_url' | 'custom_kind' | 'custom_key' | 'import' | 'saving';
  providers: readonly LoginProviderRow[];
  provider: string;
  customUrl?: string | undefined;
  customKind?: CustomProviderKind | undefined;
  /** True while the custom wizard edits an existing record instead of adding one. */
  editing?: boolean | undefined;
  methods?: readonly {id: 'key' | 'oauth'; label: string}[] | undefined;
  /** Import candidates carry no secret; selecting one copies the value into Logox's own store. */
  importables?: readonly {id: string; label: string; provider: string; kind: 'api_key' | 'oauth'}[] | undefined;
  oauthUrl?: string | undefined;
  userCode?: string | undefined;
  error: string;
}

/** Login state snapshot holds no credentials; credentials transfer only between editor and storage save. */
export class LoginFlow {
  private state: LoginState | null = null;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | undefined;
  private oauthSession: OAuthSession | undefined;
  private oauthGeneration = 0;
  private oauthAbort: AbortController | undefined;
  private importCandidates = new Map<string, ImportedCredential>();
  private wizardSequence = 0;
  private wizardBatch: {questions: readonly WizardQuestion[]; index: number;
    answers: (WizardDraft | undefined)[]; drafts: (WizardDraft | undefined)[];
    resolve: (answers: readonly WizardAnswer[] | null) => void} | undefined;

  /** Local forms never enter runtime interactions, transcripts, or model context. */
  ask = async (question: WizardQuestion): Promise<WizardAnswer> =>
    (await this.askBatch([question]))?.[0] ?? {status: 'cancelled'};
  askBatch = (questions: readonly WizardQuestion[]): Promise<readonly WizardAnswer[] | null> => {
    if (this.state || this.wizardBatch) throw new Error('Authentication is already in progress.');
    if (!questions.length) return Promise.resolve([]);
    return new Promise(resolve => {
      this.wizardSequence++;
      this.wizardBatch = {questions, index: 0, answers: [], drafts: [], resolve};
      this.refreshWizard();
    });
  };
  private refreshWizard(): void {
    const batch = this.wizardBatch;
    this.publish(batch ? {phase: 'wizard', provider: '', providers: [], error: '', collapsed: this.state?.collapsed ?? false,
      wizard: {key: this.wizardSequence, index: batch.index, questions: batch.questions, answered: batch.answers.filter(Boolean).length}} : null);
  }
  wizardDraft = (): WizardDraft | undefined => this.wizardBatch?.drafts[this.wizardBatch.index];
  keepWizardDraft = (draft: WizardDraft): void => {
    const batch = this.wizardBatch; if (batch) batch.drafts[batch.index] = draft;
  };
  answerWizard = (draft: WizardDraft): void => {
    const batch = this.wizardBatch; if (!batch) return;
    batch.answers[batch.index] = draft; batch.drafts[batch.index] = draft;
    const next = batch.questions.findIndex((_question, index) => !batch.answers[index]);
    if (next >= 0) {batch.index = next; this.refreshWizard(); return;}
    this.wizardBatch = undefined; this.publish(null);
    batch.resolve(batch.questions.map((question, index) => {
      const answer = batch.answers[index]!;
      return {status: 'answered', value: question.multiSelect ? answer.custom ?? '' : answer.selected[0] ?? answer.custom ?? '', selected: answer.selected};
    }));
  };
  navigateWizard = (direction: -1 | 1, draft: WizardDraft): void => {
    const batch = this.wizardBatch; if (!batch) return;
    const next = batch.index + direction; if (next < 0 || next >= batch.questions.length) return;
    if (JSON.stringify(batch.answers[batch.index]) !== JSON.stringify(draft)) batch.answers[batch.index] = undefined;
    batch.drafts[batch.index] = draft; batch.index = next; this.refreshWizard();
  };
  toggleWizardFold = (): void => {
    if (this.state?.phase === 'wizard') this.publish({...this.state, collapsed: !this.state.collapsed});
  };
  async browserLogin(provider: string): Promise<'done' | 'cancelled'> {
    await this.begin(provider, false, true);
    if (this.state?.phase !== 'oauth') return 'cancelled';
    const generation = this.oauthGeneration + 1;
    const succeeded = await this.startOAuth();
    if (!succeeded && generation === this.oauthGeneration && this.getSnapshot()?.phase === 'method') this.cancel();
    return succeeded ? 'done' : 'cancelled';
  }

  constructor(
    private readonly auth: AuthStorage,
    private readonly names: () => string[],
    private readonly onSaved: (provider: string) => unknown,
    private readonly customStorage = new CustomProviderStorage(),
    private readonly fetcher: typeof fetch = createHttpTransport().fetch,
    private readonly onRemove?: ((name: string) => Promise<void> | void) | undefined,
    private readonly imports: () => Promise<ImportedCredential[]> = discoverImportable,
    private readonly oauthStart: typeof startOpenAiOAuth = startOpenAiOAuth,
  ) {}

  getSnapshot = (): LoginState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  private publish(state: LoginState | null): void {this.state = state; for (const listener of this.listeners) listener();}

  async begin(provider?: string, scanImports = provider === undefined, directAccount = false): Promise<void> {
    if (this.state) throw new Error('Login already in progress. Complete or cancel first.');
    const names = this.names();
    if (provider && !names.includes(provider) && provider !== '+ Custom' && provider !== '+ Add') throw new Error('Provider does not support API key login.');
    const saved = await this.auth.providers();
    const custom = new Map((await this.customStorage.list().catch(() => [])).map(record => [record.name, record]));
    const importable = scanImports ? await this.imports().catch(() => []) : [];
    this.importCandidates = new Map(importable.map(item => [item.id, item]));
    const providerList: LoginProviderRow[] = [
      ...names.map(name => {
        const record = custom.get(name);
        return {
          name,
          saved: saved.includes(name),
          ...(record ? {custom: true, baseUrl: record.base_url, kind: record.kind, deletable: true, editable: true} : {}),
        };
      }),
      {name: '+ Add', saved: false},
      ...(importable.length ? [{name: '+ Import', saved: false}] : []),
    ];

    if (provider === 'openai') {
      this.publish({
        phase: directAccount ? 'oauth' : 'method',
        providers: providerList,
        provider: 'openai',
        methods: [
          {id: 'key', label: 'API Key'},
          {id: 'oauth', label: 'OpenAI Account (Browser authorization)'},
        ],
        error: '',
      });
      return;
    }

    if (provider === '+ Custom') {
      this.publish({
        phase: 'custom_name',
        providers: providerList,
        provider: '',
        error: '',
      });
      return;
    }

    this.publish({
      phase: provider ? 'key' : 'provider',
      providers: providerList,
      provider: provider ?? '',
      error: '',
    });
  }

  choose(provider: string): void {
    if (this.state?.phase !== 'provider' || !this.state.providers.some(item => item.name === provider)) return;
    if (provider === '+ Add') {
      this.publish({...this.state, phase: 'add', error: ''});
      return;
    }
    const row = this.state.providers.find(item => item.name === provider);
    if (row?.custom) {
      this.beginEditCustom(provider);
      return;
    }
    if (provider === '+ Import') {
      this.publish({
        ...this.state,
        phase: 'import',
        importables: [...this.importCandidates.values()].map(({id, label, provider: owner, kind}) => ({id, label, provider: owner, kind})),
        error: '',
      });
      return;
    }
    if (provider === 'openai') {
      this.publish({
        ...this.state,
        phase: 'method',
        provider: 'openai',
        methods: [
          {id: 'key', label: 'API Key'},
          {id: 'oauth', label: 'OpenAI Account (Browser authorization)'},
        ],
        error: '',
      });
      return;
    }
    this.publish({...this.state, phase: 'key', provider, error: ''});
  }

  /** Pick how a new provider is added: an account login or a custom endpoint URL. */
  chooseAddMode(mode: 'account' | 'url'): void {
    const state = this.state;
    if (!state || state.phase !== 'add') return;
    if (mode === 'account') {this.publish({...state, phase: 'account', error: ''}); return;}
    this.publish({...state, phase: 'custom_name', provider: '', customUrl: undefined, customKind: undefined, editing: false, error: ''});
  }

  /** Add flow: pick a provider that supports account authorization. */
  chooseAccount(provider: string): void {
    const state = this.state;
    if (!state || state.phase !== 'account' || !accountProviders.includes(provider)) return;
    if (provider === 'openai') {
      this.publish({...state, phase: 'method', provider, methods: [
        {id: 'key', label: 'API Key'},
        {id: 'oauth', label: 'OpenAI Account (Browser authorization)'},
      ], error: ''});
      return;
    }
    this.publish({...state, phase: 'key', provider, error: ''});
  }

  /** Open the wizard prefilled with an existing custom provider record. */
  private beginEditCustom(name: string): void {
    const state = this.state;
    const row = state?.providers.find(item => item.name === name);
    if (!state || !row?.custom) return;
    this.publish({...state, phase: 'custom_url', provider: name, customUrl: row.baseUrl, customKind: row.kind, editing: true, error: ''});
  }

  /** Copy one discovered external credential into Logox's own store. */
  async chooseImport(id: string): Promise<void> {
    const state = this.state;
    if (!state || state.phase !== 'import') return;
    const candidate = this.importCandidates.get(id);
    if (!candidate) return;
    this.publish({...state, phase: 'saving', error: ''});
    this.saving = (async () => {
      try {
        const signal = new AbortController().signal;
        if (candidate.kind === 'oauth') {
          await this.auth.saveOAuth(candidate.provider, {
            access_token: candidate.secret,
            ...(candidate.accountId ? {account_id: candidate.accountId} : {}),
          }, signal);
        } else {
          await this.auth.save(candidate.provider, candidate.secret, signal);
        }
        await this.onSaved(candidate.provider);
        this.publish(null);
      } catch (error) {
        this.publish({...state, phase: 'import', error: formatDetailedError(error, 'Failed to import credential.')});
      }
    })();
    try {await this.saving;} finally {this.saving = undefined;}
  }

  chooseMethod(method: 'key' | 'oauth'): void {
    if (this.state?.phase !== 'method') return;
    if (method === 'key') {
      this.publish({...this.state, phase: 'key', error: ''});
      return;
    }
    void this.startOAuth();
  }

  submitCustomName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || !/^[a-z0-9_-]+$/i.test(trimmed)) {
      this.publish({...this.state!, error: 'Provider name must contain only letters, numbers, dashes, or underscores.'});
      return;
    }
    this.publish({...this.state!, phase: 'custom_url', provider: trimmed, error: ''});
  }

  submitCustomUrl(urlOrPort: string): void {
    try {
      const expanded = expandPortOrUrl(urlOrPort);
      this.publish({...this.state!, phase: 'custom_kind', customUrl: expanded, error: ''});
    } catch (error) {
      this.publish({...this.state!, error: error instanceof Error ? error.message : 'Invalid URL or port number.'});
    }
  }

  chooseCustomKind(kind: CustomProviderKind): void {
    const state = this.state;
    if (!state || state.phase !== 'custom_kind') return;
    if (kind !== 'openai_compat' && kind !== 'anthropic') return;
    this.publish({...state, phase: 'custom_key', customKind: kind, error: ''});
  }

  /** Remove one custom provider together with its saved credential. */
  async delete(name: string): Promise<void> {
    const state = this.state;
    if (!state || state.phase !== 'provider' || !this.onRemove) return;
    const target = state.providers.find(item => item.name === name);
    if (!target?.custom) return;
    this.publish({...state, error: ''});
    try {
      await this.onRemove(name);
      this.publish({
        ...state,
        providers: state.providers.filter(item => item.name !== name),
        error: '',
      });
    } catch (error) {
      this.publish({...state, error: formatDetailedError(error, 'Failed to remove provider.')});
    }
  }

  async submitCustomKey(key: string): Promise<void> {
    const state = this.state;
    if (!state || state.phase !== 'custom_key') return;
    this.publish({...state, phase: 'saving', error: ''});
    this.saving = (async () => {
      try {
        await this.customStorage.save({
          name: state.provider,
          base_url: state.customUrl!,
          kind: state.customKind ?? 'openai_compat',
        });
        const trimmedKey = key.trim();
        if (trimmedKey) {
          await this.auth.save(state.provider, trimmedKey, new AbortController().signal);
        }
        await this.onSaved(state.provider);
        this.publish(null);
      } catch (error) {
        this.publish({...state, phase: 'custom_key', error: formatDetailedError(error, 'Failed to save custom provider.')});
      }
    })();
    try {await this.saving;} finally {this.saving = undefined;}
  }

  private async startOAuth(): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    const generation = ++this.oauthGeneration;
    const controller = new AbortController(); this.oauthAbort = controller;
    let succeeded = false;
    this.publish({...state, phase: 'oauth', error: ''});
    this.saving = (async () => {
      try {
        const session = await this.oauthStart(controller.signal, this.fetcher);
        if (generation !== this.oauthGeneration) {session.cancel(); return;}
        this.oauthSession = session;
        this.publish({
          ...state,
          phase: 'oauth',
          oauthUrl: session.authUrl,
          userCode: session.userCode,
          error: '',
        });
        const token = await session.waitForToken();
        if (generation !== this.oauthGeneration) return;
        await this.auth.saveOAuth(state.provider, token, controller.signal);
        if (generation !== this.oauthGeneration) return;
        await this.onSaved(state.provider);
        if (generation !== this.oauthGeneration) return;
        succeeded = true; this.publish(null);
      } catch (error) {
        if (generation !== this.oauthGeneration) return;
        this.publish({
          ...state,
          phase: 'method',
          error: formatDetailedError(error, 'OAuth login failed.'),
        });
      } finally {
        if (generation === this.oauthGeneration) {this.oauthSession = undefined; this.oauthAbort = undefined;}
      }
    })();
    await this.saving;
    return succeeded;
  }

  cancel(): void {
    const batch = this.wizardBatch;
    if (batch) {this.wizardBatch = undefined; this.publish(null); batch.resolve(null); return;}
    if (this.state?.phase !== 'saving') {
      this.oauthGeneration++; this.oauthAbort?.abort();
      this.oauthSession?.cancel();
      this.oauthSession = undefined;
      this.publish(null);
    }
  }

  async submit(key: string): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.phase === 'custom_name') {this.submitCustomName(key); return;}
    if (state.phase === 'custom_url') {this.submitCustomUrl(key); return;}
    if (state.phase === 'custom_key') {await this.submitCustomKey(key); return;}
    if (state.phase !== 'key') return;
    this.publish({...state, phase: 'saving', error: ''});
    this.saving = (async () => {
      try {
        await this.auth.save(state.provider, key, new AbortController().signal);
        await this.onSaved(state.provider);
        this.publish(null);
      } catch (error) {
        this.publish({...state, phase: 'key', error: error instanceof Error ? error.message : 'Failed to save API key.'});
      }
    })();
    try {await this.saving;} finally {this.saving = undefined;}
  }

  async close(): Promise<void> {
    this.cancel();
    this.oauthGeneration++; this.oauthAbort?.abort();
    this.oauthSession?.cancel();
    this.oauthSession = undefined;
    await this.saving;
    this.publish(null);
  }
}
