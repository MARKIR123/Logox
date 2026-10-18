import {createServer, type Server} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {exec} from 'node:child_process';
import type {OAuthToken} from './auth.js';

export interface OAuthSession {
  authUrl: string;
  userCode?: string | undefined;
  waitForToken(): Promise<OAuthToken>;
  cancel(): void;
}

const CLIENT_ID = 'oaiapp_beG5rTYszdsC4BC6r8AvjYVNR';
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = 'http://127.0.0.1:' + CALLBACK_PORT + CALLBACK_PATH;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Initiates OpenAI OAuth browser PKCE flow, starts local callback server on port 1455,
 * and launches the system browser.
 */
export async function startOpenAiOAuth(
  signal: AbortSignal = new AbortController().signal,
  fetcher: typeof fetch = fetch,
): Promise<OAuthSession> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = AUTHORIZE_URL + '?' + params.toString();

  let server: Server | undefined;
  let codeResolve: (value: {code: string; clientId: string}) => void;
  let codeReject: (reason?: unknown) => void;
  const codePromise = new Promise<{code: string; clientId: string}>((resolve, reject) => {
    codeResolve = resolve;
    codeReject = reject;
  });

  const closeServer = () => {
    if (server) {
      server.close();
      server = undefined;
    }
  };

  server = createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url || '', REDIRECT_URI);
      if (parsedUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end('Not found');
        return;
      }
      const returnedState = parsedUrl.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('OAuth state mismatch');
        codeReject(new Error('OAuth state mismatch'));
        closeServer();
        return;
      }
      const code = parsedUrl.searchParams.get('code');
      if (!code) {
        const error = parsedUrl.searchParams.get('error') || 'Missing authorization code';
        res.writeHead(400, {'Content-Type': 'text/plain'});
        res.end('Authorization failed: ' + error);
        codeReject(new Error('OpenAI authorization failed: ' + error));
        closeServer();
        return;
      }
      const clientId = parsedUrl.searchParams.get('client_id') || CLIENT_ID;
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;background:#18181b;color:#f4f4f5;">
        <h2 style="color:#7ee7c4;">Authorization Successful</h2>
        <p>You can close this browser window and return to LOGOX.</p>
      </body></html>`);
      closeServer();
      codeResolve({code, clientId});
    } catch (err) {
      res.writeHead(500, {'Content-Type': 'text/plain'});
      res.end('Internal callback error');
      codeReject(err);
      closeServer();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(CALLBACK_PORT, '127.0.0.1', () => {
      server?.removeListener('error', reject);
      resolve();
    });
  });

  // Automatically launch default browser
  const launchCommand = process.platform === 'win32'
    ? 'start "" "' + authUrl + '"'
    : process.platform === 'darwin'
      ? 'open "' + authUrl + '"'
      : 'xdg-open "' + authUrl + '"';
  exec(launchCommand, () => {});

  const cancel = () => {
    closeServer();
    codeReject(new Error('Authorization cancelled'));
  };

  signal.addEventListener('abort', cancel, {once: true});

  return {
    authUrl,
    userCode: undefined,
    async waitForToken(): Promise<OAuthToken> {
      try {
        const {code, clientId} = await codePromise;
        signal.throwIfAborted();
        const tokenRes = await fetcher(TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          }).toString(),
          signal,
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => '');
          throw new Error('OpenAI token exchange failed (' + tokenRes.status + '): ' + body);
        }

        const data = await tokenRes.json() as Record<string, unknown>;
        const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
        const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

        if (!accessToken) throw new Error('Token response did not contain access_token');

        return {
          access_token: accessToken,
          ...(refreshToken ? {refresh_token: refreshToken} : {}),
          expires_at: Date.now() + expiresIn * 1000,
          account_id: clientId,
        };
      } finally {
        closeServer();
      }
    },
    cancel,
  };
}
