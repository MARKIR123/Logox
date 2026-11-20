import {log} from '../logger.mjs';

export function sendAlert(attempt, target) {
  const level = attempt >= 3 ? 'error' : 'warn';
  log(level, 'Alert attempt ' + attempt + ' to ' + target);
  return {attempt, level};
}
