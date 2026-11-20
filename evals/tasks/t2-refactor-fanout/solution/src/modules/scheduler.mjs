import {logger} from '../logger.mjs';

export function runTick(tickNumber) {
  logger.info('Scheduler tick ' + tickNumber);
  return tickNumber + 1;
}
