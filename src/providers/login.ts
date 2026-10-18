import {AuthStorage} from './auth.js';
import {startOpenAiOAuth, type OAuthSession} from './oauth.js';

export interface LoginState {
  phase: 'provider' | 'method' | 'key' | 'oauth' | 'saving';
  providers: readonly {name: string; saved: boolean}[];
  provider: string;
  methods?: readonly {id: 'key' | 'oauth'; label: string}[] | undefined;
  oauthUrl?: string | undefined;
  userCode?: string | undefined;
  error: string;
}

/** 登录快照不持有密钥；密钥只在编辑器和一次保存调用之间传递。 */
export class LoginFlow {
  private state: LoginState | null = null;
  private listeners = new Set<() => void>();
  private saving: Promise<void> | undefined;
  private oauthSession: OAuthSession | undefined;

  constructor(
    private readonly auth: AuthStorage,
    private readonly names: () => string[],
    private readonly onSaved: (provider: string) => unknown,
  ) {}

  getSnapshot = (): LoginState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  private publish(state: LoginState | null): void {this.state = state; for (const listener of this.listeners) listener();}

  async begin(provider?: string): Promise<void> {
    if (this.state) throw new Error('登录正在进行，请先完成或取消');
    const names = this.names();
    if (provider && !names.includes(provider)) throw new Error('该提供商不支持当前 API key 登录');
    const saved = await this.auth.providers();

    if (provider === 'openai') {
      this.publish({
        phase: 'method',
        providers: names.map(name => ({name, saved: saved.includes(name)})),
        provider: 'openai',
        methods: [
          {id: 'key', label: 'API Key'},
          {id: 'oauth', label: 'OpenAI Account (Browser authorization)'},
        ],
        error: '',
      });
      return;
    }

    this.publish({
      phase: provider ? 'key' : 'provider',
      providers: names.map(name => ({name, saved: saved.includes(name)})),
      provider: provider ?? '',
      error: '',
    });
  }

  choose(provider: string): void {
    if (this.state?.phase !== 'provider' || !this.state.providers.some(item => item.name === provider)) return;
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
    // method === 'oauth'
    this.startOAuth();
  }

  private startOAuth(): void {
    const state = this.state;
    if (!state) return;
    this.publish({...state, phase: 'oauth', error: ''});
    this.saving = (async () => {
      try {
        const session = await startOpenAiOAuth();
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
          error: error instanceof Error ? error.message : 'OAuth 登录失败',
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
    if (state?.phase !== 'key') return;
    this.publish({...state, phase: 'saving', error: ''});
    this.saving = (async () => {
      try {
        await this.auth.save(state.provider, key, new AbortController().signal);
        await this.onSaved(state.provider);
        this.publish(null);
      } catch (error) {
        this.publish({...state, phase: 'key', error: error instanceof Error ? error.message : '保存 API key 失败'});
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
