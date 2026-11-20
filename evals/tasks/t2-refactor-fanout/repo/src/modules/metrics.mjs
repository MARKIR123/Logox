import {log} from '../logger.mjs';

export function flushMetrics(points) {
  log('info', 'Flushed ' + points.length + ' metric points');
  return points.length;
}
