import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export function readHeartbeatSettings(rootDir) {
  const raw = readFileSync(join(rootDir, 'config', 'heartbeat.json'), 'utf8');
  return JSON.parse(raw);
}
