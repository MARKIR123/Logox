import {log} from '../logger.mjs';

export function putCache(key, ttlSeconds) {
  log('info', `Stored key (${key}) with ttl=${ttlSeconds}s`);
  return {key, ttlSeconds};
}
