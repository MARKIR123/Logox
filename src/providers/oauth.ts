import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, createHash, randomUUID} from 'node:crypto';
import {exec} from 'node:child_process';
import type {OAuthToken} from './auth.js';

export interface OAuthSession {
  authUrl: string;
  userCode?: string | undefined;
  waitForToken(): Promise<OAuthToken>;
  cancel(): void;
}

const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME_HINT = 'LOGOX';
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = 'http://127.0.0.1:' + CALLBACK_PORT + CALLBACK_PATH;
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = 'openid profile email offline_access resource.invoke ' + DIRECT_TOKEN_SCOPE;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function loadDeviceId(): string {
  const settingsPaths = [
    join(homedir(), '.logox-ts', 'settings.json'),
    join(homedir(), '.logox', 'settings.json'),
    join(homedir(), '.pi', 'agent', 'settings.json'),
  ];
  for (const p of settingsPaths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (typeof data?.deviceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.deviceId)) {
        return data.deviceId.toLowerCase();
      }
    } catch {}
  }
  return randomUUID().toLowerCase();
}

/**
 * Initiates OpenAI OAuth browser PKCE flow (matching Pi coding agent),
 * starts local callback server on port 1455, and launches the system browser.
 */
export async function startOpenAiOAuth(
  signal: AbortSignal = new AbortController().signal,
  fetcher: typeof fetch = fetch,
): Promise<OAuthSession> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const hostId = 'urn:uuid:' + loadDeviceId();

  const params = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: AGENT_NAME_HINT,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce,
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
      const clientId = parsedUrl.searchParams.get('client_id')?.trim() || DYNAMIC_CLIENT_ID;
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
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
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
