import {logger} from '../logger.mjs';

export function authenticate(username, token) {
  if (!token) {
    logger.warn('Missing token for user ' + username);
    return false;
  }
  logger.info('Authenticated user ' + username);
  return true;
}
