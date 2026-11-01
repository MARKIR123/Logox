import {mkdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';

export const apiKeyCredentialSchema = z.object({
  type: z.literal('api_key'),
  key: z.string().min(1).max(16384),
});

export const oauthCredentialSchema = z.object({
  type: z.literal('oauth'),
  access_token: z.string().optional(),
  access: z.string().optional(),
  refresh_token: z.string().optional(),
  refresh: z.string().optional(),
  expires_at: z.number().optional(),
  expires: z.number().optional(),
  account_id: z.string().optional(),
  clientId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
}).passthrough();

export const credentialSchema = z.discriminatedUnion('type', [
  apiKeyCredentialSchema,
  oauthCredentialSchema,
]);
export type Credential = z.infer<typeof credentialSchema>;
export type OAuthToken = Omit<z.infer<typeof oauthCredentialSchema>, 'type'>;

const schema = z.record(z.string(), credentialSchema);
type Credentials = z.infer<typeof schema>;

/** User credentials are stored separately, belonging to neither project config nor session ledgers. */
export class AuthStorage {
  constructor(readonly path = join(homedir(), '.logox', 'auth.json')) {}
  private async read(): Promise<Credentials> {
    const merged: Credentials = {};
    try {
      const content = await readFile(this.path, 'utf8');
      const parsed = schema.parse(JSON.parse(content.replace(/^﻿/, '')));
      Object.assign(merged, parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return merged;
      }
      throw new Error('LOGOX auth file format is invalid; the original file is preserved. Check it and retry.');
    }
    return merged;
  }

  async credential(provider: string): Promise<Credential | undefined> {
    return (await this.read())[provider];
  }

  async key(provider: string): Promise<string> {
    const cred = (await this.read())[provider];
    if (!cred) return '';
    return cred.type === 'api_key' ? cred.key : (cred.access_token ?? cred.access ?? '');
  }

  async providers(): Promise<string[]> {return Object.keys(await this.read());}

  private async withLock<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const lock = this.path + '.lock';
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700}).catch(() => {throw new Error('Cannot create the LOGOX auth directory');});
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      signal.throwIfAborted();
      try {await mkdir(lock, {mode: 0o700}); locked = true; break;}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot lock the LOGOX auth file');
        await delay(25, undefined, {signal});
      }
    }
    if (!locked) throw new Error('Another process is saving credentials. Try again shortly.');
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  private async atomicWrite(credentials: Credentials, signal: AbortSignal): Promise<void> {
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      signal.throwIfAborted();
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, {force: true}).catch(() => {});
    }
  }

  async save(provider: string, input: string, signal: AbortSignal): Promise<void> {
    const key = input.trim();
    if (!key || key.length > 16384 || /[\x00-\x20\x7f]/.test(key)) throw new Error('Enter a valid API key without spaces or control characters');
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('Invalid provider name');
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      credentials[provider] = {type: 'api_key', key};
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }

  async saveOAuth(provider: string, token: OAuthToken, signal: AbortSignal): Promise<void> {
    if (!provider || ['__proto__', 'constructor', 'prototype'].includes(provider)) throw new Error('Invalid provider name');
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      credentials[provider] = {type: 'oauth', ...token};
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }

  async remove(provider: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    await this.withLock(signal, async () => {
      const credentials = await this.read();
      delete credentials[provider];
      signal.throwIfAborted();
      await this.atomicWrite(credentials, signal);
    });
  }
}
