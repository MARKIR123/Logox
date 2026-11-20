import {logger} from '../logger.mjs';

export function processTask(taskId, succeeded) {
  if (!succeeded) {
    logger.error('Task failed: ' + taskId);
    return false;
  }
  logger.info('Task completed: ' + taskId);
  return true;
}
