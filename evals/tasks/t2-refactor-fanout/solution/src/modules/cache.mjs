import {logger} from '../logger.mjs';

export function putCache(key, ttlSeconds) {
  logger.info(`Stored key (${key}) with ttl=${ttlSeconds}s`);
  return {key, ttlSeconds};
}
