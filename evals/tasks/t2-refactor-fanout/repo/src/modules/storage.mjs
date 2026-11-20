import {log} from '../logger.mjs';

export function saveBlob(name, size) {
  if (size < 0) {
    log('error', 'Negative blob size for ' + name);
    return false;
  }
  log('info', 'Saved blob ' + name + ' (' + size + ' bytes)');
  return true;
}
