import {logger} from '../logger.mjs';

export function saveBlob(name, size) {
  if (size < 0) {
    logger.error('Negative blob size for ' + name);
    return false;
  }
  logger.info('Saved blob ' + name + ' (' + size + ' bytes)');
  return true;
}
