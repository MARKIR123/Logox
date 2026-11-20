import {logger} from '../logger.mjs';

export function loadSettings(envName) {
  if (!envName) {
    logger.warn('Environment not specified, using development');
    return {env: 'development'};
  }
  logger.info('Loaded settings for ' + envName);
  return {env: envName};
}
