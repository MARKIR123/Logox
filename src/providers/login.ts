import {AuthStorage} from './auth.js';
import {CustomProviderStorage} from './custom-storage.js';
import {startOpenAiOAuth, type OAuthSession} from './oauth.js';
import {createHttpTransport} from './transport.js';

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
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Invalid URL protocol: must be http or https');
  }
  return trimmed;
}

export interface LoginState {
  phase: 'provider' | 'method' | 'key' | 'oauth' | 'custom_name' | 'custom_url' | 'custom_key' | 'saving';
  providers: readonly {name: string; saved: boolean}[];
  provider: string;
  customUrl?: string | undefined;
  methods?: readonly {id: 'key' | 'oauth'; label: string}[] | undefined;
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

  constructor(
    private readonly auth: AuthStorage,
    private readonly names: () => string[],
    private readonly onSaved: (provider: string) => unknown,
    private readonly customStorage = new CustomProviderStorage(),
    private readonly fetcher: typeof fetch = createHttpTransport().fetch,
  ) {}

  getSnapshot = (): LoginState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  private publish(state: LoginState | null): void {this.state = state; for (const listener of this.listeners) listener();}

  async begin(provider?: string): Promise<void> {
    if (this.state) throw new Error('Login already in progress. Complete or cancel first.');
    const names = this.names();
    if (provider && !names.includes(provider) && provider !== '+ Custom') throw new Error('Provider does not support API key login.');
    const saved = await this.auth.providers();
    const providerList: {name: string; saved: boolean}[] = [
      ...names.map(name => ({name, saved: saved.includes(name)})),
      {name: '+ Custom', saved: false},
    ];

    if (provider === 'openai') {
      this.publish({
        phase: 'method',
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
    if (provider === '+ Custom') {
      this.publish({
        ...this.state,
        phase: 'custom_name',
        provider: '',
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

  chooseMethod(method: 'key' | 'oauth'): void {
    if (this.state?.phase !== 'method') return;
    if (method === 'key') {
      this.publish({...this.state, phase: 'key', error: ''});
      return;
    }
    this.startOAuth();
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
      this.publish({...this.state!, phase: 'custom_key', customUrl: expanded, error: ''});
    } catch (error) {
      this.publish({...this.state!, error: error instanceof Error ? error.message : 'Invalid URL or port number.'});
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
          kind: 'openai_compat',
        });
        const trimmedKey = key.trim();
        if (trimmedKey) {
          await this.auth.save(state.provider, trimmedKey, new AbortController().signal);
        }
        await this.onSaved(state.provider);
        this.publish(null);
      } catch (error) {
        this.publish({...state, phase: 'custom_key', error: error instanceof Error ? error.message : 'Failed to save custom provider.'});
      }
    })();
    try {await this.saving;} finally {this.saving = undefined;}
  }

  private startOAuth(): void {
    const state = this.state;
    if (!state) return;
    this.publish({...state, phase: 'oauth', error: ''});
    this.saving = (async () => {
      try {
        const session = await startOpenAiOAuth(new AbortController().signal, this.fetcher);
        this.oauthSession = session;
        this.publish({
          ...state,
          phase: 'oauth',
          oauthUrl: session.authUrl,
          userCode: session.userCode,
          error: '',
        });
        const token = await session.waitForToken();
        await this.auth.saveOAuth(state.provider, token, new AbortController().signal);
        await this.onSaved(state.provider);
        this.publish(null);
      } catch (error) {
        this.publish({
          ...state,
          phase: 'method',
          error: error instanceof Error ? error.message : 'OAuth login failed.',
        });
      } finally {
        this.oauthSession = undefined;
      }
    })();
  }

  cancel(): void {
    if (this.state?.phase !== 'saving') {
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
    this.oauthSession?.cancel();
    this.oauthSession = undefined;
    await this.saving;
    this.publish(null);
  }
}
