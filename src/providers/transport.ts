import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Client, Pool, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher} from 'undici';
import {ProviderError} from './http.js';

const ignoreDispatcherError = () => {};
function guarded<T extends Dispatcher>(dispatcher: T): T {
  // 流读取仍会抛出原故障；拦住 Undici 内部的未订阅 error，避免进程退出。
  if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, 'error', ignoreDispatcherError);
  return dispatcher;
}
const client = (origin: string | URL, options: object) => guarded(new Client(origin, options));

function loadConfiguredProxy(env: NodeJS.ProcessEnv): string {
  const envProxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || env.all_proxy || env.ALL_PROXY;
  if (envProxy) return envProxy;
  const settingsPaths = [
    join(homedir(), '.logox-ts', 'settings.json'),
    join(homedir(), '.logox', 'settings.json'),
    join(homedir(), '.pi', 'agent', 'settings.json'),
  ];
  for (const p of settingsPaths) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (typeof data?.httpProxy === 'string' && data.httpProxy.trim()) {
        return data.httpProxy.trim();
      }
    } catch {}
  }
  return '';
}

/** 应用拥有连接，模型候选与会话共享；不修改全局 fetch、dispatcher 或环境。 */
export function createHttpTransport(env: NodeJS.ProcessEnv = process.env) {
  let dispatcher: EnvHttpProxyAgent;
  try {
    const configured = loadConfiguredProxy(env);
    const httpProxy = env.http_proxy || env.HTTP_PROXY || configured || '';
    const httpsProxy = env.https_proxy || env.HTTPS_PROXY || httpProxy;
    for (const proxy of [httpProxy, httpsProxy]) if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error('unsupported proxy');
    dispatcher = guarded(new EnvHttpProxyAgent({
      httpProxy, httpsProxy,
      noProxy: env.no_proxy || env.NO_PROXY || 'localhost,127.0.0.1,::1',
      allowH2: false, proxyTunnel: true,
      // 禁用 Undici 内部固定的 300s 超时；流式长连接的有效性由应用层的无进展 deadline 监控。
      headersTimeout: 0, bodyTimeout: 0,
      connect: {
        autoSelectFamilyAttemptTimeout: 2000,
        keepAlive: true,
        // 每 10 秒发送一次 TCP keep-alive 探测，防止 Clash Verge 等本地代理及中间 NAT 在 300 秒掐断隧道
        keepAliveInitialDelay: 10_000,
      }, clientFactory: client,
      factory: (origin, options) => Reflect.get(options, 'connections') === 1 ? client(origin, options)
        : guarded(new Pool(origin, {...options, factory: client})),
    }));
  } catch {throw new ProviderError('网络代理配置无效；请检查 HTTP_PROXY / HTTPS_PROXY，仅支持 HTTP(S) 代理。');}
  // Undici 与 Node 的 Web API 类型来自不同声明，运行时均使用标准 Request/Response。
  const request = undiciFetch as unknown as (input: Parameters<typeof fetch>[0], init?: RequestInit & {dispatcher: Dispatcher}) => Promise<Response>;
  let closing: Promise<void> | undefined;
  return {
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => request(input, {...init, dispatcher})) satisfies typeof fetch,
    close(): Promise<void> {return closing ??= dispatcher.destroy();},
  };
}
