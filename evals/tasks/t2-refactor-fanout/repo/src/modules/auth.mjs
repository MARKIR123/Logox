import {log} from '../logger.mjs';

export function authenticate(username, token) {
  if (!token) {
    log('warn', 'Missing token for user ' + username);
    return false;
  }
  log('info', 'Authenticated user ' + username);
  return true;
}
