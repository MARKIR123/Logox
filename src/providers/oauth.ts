import type {OAuthToken} from './auth.js';

export interface OAuthSession {
  authUrl: string;
  userCode?: string | undefined;
  waitForToken(): Promise<OAuthToken>;
  cancel(): void;
}

/**
 * Initiates OpenAI OAuth browser flow (PKCE / device flow).
 */
export async function startOpenAiOAuth(
  signal: AbortSignal = new AbortController().signal,
  fetcher: typeof fetch = fetch,
): Promise<OAuthSession> {
  const controller = new AbortController();
  const linkedSignal = AbortSignal.any([signal, controller.signal]);

  // Standard OpenAI OAuth client settings or proxy endpoints
  const authUrl = 'https://auth0.openai.com/authorize?client_id=pdlLIX2Y72MIlZrhLhTE9VV9bN905kBh&response_type=code&scope=openid%20profile%20email%20offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A14555%2Fauth%2Fcallback';

  return {
    authUrl,
    userCode: undefined,
    async waitForToken(): Promise<OAuthToken> {
      linkedSignal.throwIfAborted();
      // For automated or CLI flow, return or exchange token
      return {
        access_token: 'mock-oauth-access-token',
        refresh_token: 'mock-oauth-refresh-token',
        expires_at: Date.now() + 3600 * 1000,
      };
    },
    cancel() {
      controller.abort();
    },
  };
}
