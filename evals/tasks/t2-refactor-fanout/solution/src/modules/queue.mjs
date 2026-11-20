import {logger} from '../logger.mjs';

export function enqueueJob(jobId, depth) {
  if (depth > 100) {
    logger.warn('Queue depth high at ' + depth + ' for job ' + jobId);
  } else {
    logger.info('Enqueued job ' + jobId);
  }
  return jobId;
}
