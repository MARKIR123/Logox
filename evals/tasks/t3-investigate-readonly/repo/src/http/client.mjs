import {buildHeaders} from './headers.mjs';
import {withRetry} from './retry.mjs';

export function createHttpClient(config) {
  const timeoutMs = config.requestTimeoutMs;
  const connectTimeoutMs = config.connectTimeoutMs;

  return {
    timeoutMs,
    connectTimeoutMs,
    async request(url, options = {}) {
      return withRetry(config.retryCount, () => ({
        url,
        headers: buildHeaders(options.headers),
        timeoutMs,
        connectTimeoutMs,
      }));
    },
  };
}
