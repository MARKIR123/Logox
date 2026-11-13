import {AuthStorage} from './auth.js';
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

/** `wizard` is a local form; `oauth` is a browser sign-in in progress (or failed, with `error`). */
export interface LoginState {
  wizard?: LocalWizardView | undefined;
  collapsed?: boolean | undefined;
  phase: 'wizard' | 'oauth';
  provider: string;
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
    this.publish(batch ? {phase: 'wizard', provider: '', error: '', collapsed: this.state?.collapsed ?? false,
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
  /** Starts the browser sign-in of an account provider (`startOAuth`); resolves when it finished or was cancelled. A failure is published as `error` (and surfaced by the host) before the flow closes. */
  async browserLogin(provider: string): Promise<'done' | 'cancelled'> {
    if (this.state || this.wizardBatch) throw new Error('Login already in progress. Complete or cancel first.');
    this.publish({phase: 'oauth', provider, error: ''});
    const generation = this.oauthGeneration + 1;
    const succeeded = await this.startOAuth();
    if (!succeeded && generation === this.oauthGeneration && this.getSnapshot()?.phase === 'oauth') this.cancel();
    return succeeded ? 'done' : 'cancelled';
  }

  constructor(
    private readonly auth: AuthStorage,
    private readonly onSaved: (provider: string) => unknown,
    private readonly fetcher: typeof fetch = createHttpTransport().fetch,
    private readonly oauthStart: typeof startOpenAiOAuth = startOpenAiOAuth,
  ) {}

  getSnapshot = (): LoginState | null => this.state;
  subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener);};
  private publish(state: LoginState | null): void {this.state = state; for (const listener of this.listeners) listener();}

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
        this.publish({...state, phase: 'oauth', error: formatDetailedError(error, 'OAuth login failed.')});
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
    this.oauthGeneration++; this.oauthAbort?.abort();
    this.oauthSession?.cancel();
    this.oauthSession = undefined;
    this.publish(null);
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
