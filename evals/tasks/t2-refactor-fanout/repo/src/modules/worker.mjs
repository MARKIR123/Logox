import {log} from '../logger.mjs';

export function processTask(taskId, succeeded) {
  if (!succeeded) {
    log('error', 'Task failed: ' + taskId);
    return false;
  }
  log('info', 'Task completed: ' + taskId);
  return true;
}
