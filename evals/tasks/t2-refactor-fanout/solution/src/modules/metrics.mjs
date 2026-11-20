import {logger} from '../logger.mjs';

export function flushMetrics(points) {
  logger.info('Flushed ' + points.length + ' metric points');
  return points.length;
}
