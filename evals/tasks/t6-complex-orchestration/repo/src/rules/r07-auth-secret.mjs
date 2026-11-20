export const meta = {
  id: 'R07',
  level: 'error',
  name: 'Auth Secret Indirection',
};

export function check(config) {
  if (typeof config?.auth?.secret === 'string' && config.auth.secret.length > 0) {
    return {valid: false, reason: 'auth.secret must not be hardcoded; use auth.secretEnv'};
  }
  if (typeof config?.auth?.secretEnv !== 'string' || !config.auth.secretEnv.trim()) {
    return {valid: false, reason: 'auth.secretEnv must be a non-empty environment variable name'};
  }
  return {valid: true, reason: `auth secret read from env ${config.auth.secretEnv}`};
}
