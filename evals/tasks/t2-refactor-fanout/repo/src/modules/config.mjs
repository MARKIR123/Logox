import {log} from '../logger.mjs';

export function loadSettings(envName) {
  if (!envName) {
    log('warn', 'Environment not specified, using development');
    return {env: 'development'};
  }
  log('info', 'Loaded settings for ' + envName);
  return {env: envName};
}
