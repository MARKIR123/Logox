import {logger} from '../logger.mjs';

// Legacy note: callers previously invoked log('info', ...) directly before batching.
export function ingestBatch(records) {
  logger.info('Ingesting batch of ' + records.length + ' records');
  return records.length;
}
