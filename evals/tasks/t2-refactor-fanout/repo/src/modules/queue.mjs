import {log} from '../logger.mjs';

export function enqueueJob(jobId, depth) {
  if (depth > 100) {
    log('warn', 'Queue depth high at ' + depth + ' for job ' + jobId);
  } else {
    log('info', 'Enqueued job ' + jobId);
  }
  return jobId;
}
