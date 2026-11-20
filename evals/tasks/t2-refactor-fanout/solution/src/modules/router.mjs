import {logger} from '../logger.mjs';

export function routeStatus(level, path) {
  logger[level]('Route ' + path + ' status');
  return {level, path};
}
