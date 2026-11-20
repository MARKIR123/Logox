import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function parseEnvFile(filePath) {
  const vars = {};
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // Missing runtime env file is optional.
  }
  return vars;
}

export function loadEnvOverrides(rootDir, env = process.env) {
  const fileVars = parseEnvFile(join(rootDir, 'config', 'runtime.env'));
  const merged = {...fileVars, ...env};
  const overrides = {};

  if (merged.SVC_ENV) {
    overrides.env = merged.SVC_ENV;
  }
  if (merged.SVC_REQUEST_TIMEOUT_MS !== undefined) {
    overrides.requestTimeoutMs = Number(merged.SVC_REQUEST_TIMEOUT_MS) * 1000;
  }
  if (merged.SVC_CONNECT_TIMEOUT_MS !== undefined) {
    overrides.connectTimeoutMs = Number(merged.SVC_CONNECT_TIMEOUT_MS);
  }
  return overrides;
}
