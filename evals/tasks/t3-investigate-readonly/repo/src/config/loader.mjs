import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {FALLBACK_CONFIG} from './defaults.mjs';
import {loadEnvOverrides} from './env.mjs';

function readJsonOptional(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(rootDir, env = process.env) {
  const defaultLayer = readJsonOptional(join(rootDir, 'config', 'default.json'));
  const envOverrides = loadEnvOverrides(rootDir, env);
  const activeEnv = envOverrides.env ?? defaultLayer.env ?? FALLBACK_CONFIG.env;
  const envLayer = readJsonOptional(join(rootDir, 'config', `${activeEnv}.json`));

  return {...FALLBACK_CONFIG, ...defaultLayer, ...envLayer, ...envOverrides};
}
