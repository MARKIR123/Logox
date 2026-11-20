import {logger} from '../logger.mjs';

export function sendAlert(attempt, target) {
  const level = attempt >= 3 ? 'error' : 'warn';
  logger[level]('Alert attempt ' + attempt + ' to ' + target);
  return {attempt, level};
}
