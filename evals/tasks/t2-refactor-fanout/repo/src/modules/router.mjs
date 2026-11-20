import {log} from '../logger.mjs';

export function routeStatus(level, path) {
  log(level, 'Route ' + path + ' status');
  return {level, path};
}
