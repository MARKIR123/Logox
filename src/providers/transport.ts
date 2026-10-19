import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {Client, Pool, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher} from 'undici';
import {ProviderError} from './http.js';
import {formatNetworkError} from './error-format.js';

const ignoreDispatcherError = () => {};
function guarded<T extends Dispatcher>(dispatcher: T): T {
  // 流读取仍会抛出原故障；拦住 Undici 内部的未订阅 error，避免进程退出。
  if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, 'error', ignoreDispatcherError);
  return dispatcher;
}
const client = (origin: string | URL, options: object) => guarded(new Client(origin, options));

function isLocalPortListening(port: number, timeout = 100): Promise<boolean> {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}

async function findActiveLocalProxy(currentPort: number): Promise<string | null> {
  const commonPorts = [7898, 7890, 7897, 10808, 10809].filter(p => p !== currentPort);
  for (const p of commonPorts) {
    if (await isLocalPortListening(p)) return 'http://127.0.0.1:' + p;
  }
  return null;
}

function loadConfiguredProxy(env: NodeJS.ProcessEnv): string {
  const envProxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
  if (envProxy) return envProxy;
  const settingsPaths = [
    join(homedir(), '.logox-ts', 'settings.json'),
    join(homedir(), '.logox', 'settings.json'),
  ];
  for (const p of settingsPaths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
      if (typeof data?.httpProxy === 'string' && data.httpProxy.trim()) {
        return data.httpProxy.trim();
      }
    } catch {}
  }
  return '';
}

/** 应用拥有连接，模型候选与会话共享；不修改全局 fetch、dispatcher 或环境。 */
export function createHttpTransport(env: NodeJS.ProcessEnv = process.env) {
  let configured = loadConfiguredProxy(env);
  let httpProxy = env.http_proxy || env.HTTP_PROXY || configured || '';
  let httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy;

  function buildDispatcher(proxyUrl: string): EnvHttpProxyAgent {
    return guarded(new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: env.no_proxy ?? env.NO_PROXY ?? 'localhost,127.0.0.1,::1',
      allowH2: false,
      proxyTunnel: true,
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: {
        autoSelectFamilyAttemptTimeout: 2000,
        keepAlive: true,
        keepAliveInitialDelay: 10_000,
      },
      clientFactory: client,
      factory: (origin, options) => Reflect.get(options, 'connections') === 1
        ? client(origin, options)
        : guarded(new Pool(origin, {...options, factory: client})),
    }));
  }

  let dispatcher: EnvHttpProxyAgent;
  try {
    for (const proxy of [httpProxy, httpsProxy]) {
      if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error('unsupported proxy');
    }
    dispatcher = buildDispatcher(httpProxy);
  } catch (err) {
    throw new ProviderError('网络代理配置无效；请检查 HTTP_PROXY / HTTPS_PROXY，仅支持 HTTP(S) 代理。');
  }

  const request = undiciFetch as unknown as (input: Parameters<typeof fetch>[0], init?: RequestInit & {dispatcher: Dispatcher}) => Promise<Response>;
  let closing: Promise<void> | undefined;

  return {
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      try {
        return await request(input, {...init, dispatcher});
      } catch (error: any) {
        // If connecting to local proxy failed with ECONNREFUSED, probe alternative local Clash ports
        const isConnRefused = error?.cause?.code === 'ECONNREFUSED';
        const isLocalProxy = httpProxy && (httpProxy.includes('127.0.0.1') || httpProxy.includes('localhost'));
        if (isConnRefused && isLocalProxy) {
          try {
            const currentPort = Number(new URL(httpProxy).port) || 0;
            const fallback = await findActiveLocalProxy(currentPort);
            if (fallback) {
              httpProxy = fallback;
              httpsProxy = fallback;
              dispatcher = buildDispatcher(fallback);
              return await request(input, {...init, dispatcher});
            }
          } catch {}
        }
        // Enhance error message with target URL and proxy context
        const targetUrl = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request)?.url || '');
        const method = init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
        const formatted = formatNetworkError(error, {url: targetUrl, method, proxy: httpProxy});
        const enhancedError = new Error(formatted);
        (enhancedError as any).cause = error;
        throw enhancedError;
      }
    }) as typeof fetch,
    close(): Promise<void> {
      return closing ??= dispatcher.destroy();
    },
    activeProxy(): string {
      return httpProxy;
    },
  };
}
