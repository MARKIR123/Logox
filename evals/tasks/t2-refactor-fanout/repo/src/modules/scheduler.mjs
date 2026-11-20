import {log} from '../logger.mjs';

export function runTick(tickNumber) {
  log('info', 'Scheduler tick ' + tickNumber);
  return tickNumber + 1;
}
