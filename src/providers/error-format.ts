import {z} from 'zod';

export interface NetworkContext {
  url?: string | URL;
  method?: string;
  proxy?: string;
}

const errorObjectSchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
  errno: z.union([z.number(), z.string()]).optional(),
  syscall: z.string().optional(),
  address: z.string().optional(),
  port: z.union([z.number(), z.string()]).optional(),
  hostname: z.string().optional(),
  cause: z.unknown().optional(),
}).passthrough();

export function formatNetworkError(error: unknown, context?: NetworkContext): string {
  if (!error) return 'Network request failed';
  if (typeof error === 'string') return error;

  const parts: string[] = [];
  const targetDesc = context?.url
    ? `${context.method ? context.method.toUpperCase() + ' ' : ''}${String(context.url)}`
    : '';

  let current: unknown = error;
  const seen = new Set<unknown>();
  let primaryReason = '';

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const parsed = errorObjectSchema.safeParse(current);
    if (!parsed.success) break;

    const {message = '', code = '', syscall = '', address = '', port = '', hostname = ''} = parsed.data;

    if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      const endpoint = address && port ? `${address}:${port}` : (hostname ? `${hostname}:${port}` : 'endpoint');
      primaryReason = `Connection refused by ${endpoint} (ECONNREFUSED). Check if the local proxy or server is running on this port.`;
      break;
    }

    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || message.includes('connect timeout')) {
      const endpoint = address && port ? `${address}:${port}` : (hostname || 'remote server');
      primaryReason = `Connection timed out (${code || 'TIMEOUT'}) connecting to ${endpoint}.`;
      break;
    }

    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
      primaryReason = `Response transfer timed out (${code}).`;
      break;
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      primaryReason = `DNS domain resolution failed for ${hostname || address || 'host'} (${code}).`;
      break;
    }

    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
      primaryReason = `Connection was abruptly closed or reset (${code}).`;
      break;
    }

    if (message && message !== 'fetch failed' && !message.includes('fetch failed')) {
      if (!primaryReason) primaryReason = message;
    }

    current = parsed.data.cause;
  }

  if (targetDesc) {
    parts.push(`Failed to fetch ${targetDesc}`);
  }
  if (primaryReason) {
    parts.push(primaryReason);
  } else if (error instanceof Error && error.message && error.message !== 'fetch failed') {
    parts.push(error.message);
  } else {
    parts.push('Underlying network connection failed');
  }

  if (context?.proxy) {
    parts.push(`(via proxy ${context.proxy})`);
  }

  return parts.join(': ');
}

export function formatDetailedError(error: unknown, fallback = 'Operation failed'): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error;

  if (error instanceof Error) {
    if (error.message === 'fetch failed' || error.name === 'TypeError') {
      return formatNetworkError(error);
    }
    // Unwrap nested fetch failed causes
    const causeMsg = error.cause ? formatNetworkError(error.cause) : '';
    if (causeMsg && causeMsg !== 'Network request failed') {
      return `${error.message}: ${causeMsg}`;
    }
    return error.message || fallback;
  }

  return String(error);
}
