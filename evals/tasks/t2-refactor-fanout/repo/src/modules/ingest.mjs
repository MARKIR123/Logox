import {log} from '../logger.mjs';

// Legacy note: callers previously invoked log('info', ...) directly before batching.
export function ingestBatch(records) {
  log('info', 'Ingesting batch of ' + records.length + ' records');
  return records.length;
}
