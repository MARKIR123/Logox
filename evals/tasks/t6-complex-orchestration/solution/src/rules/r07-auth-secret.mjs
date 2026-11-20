export const ruleMeta = {
  id: 'R07',
  severity: 'error',
  title: 'Auth Secret Indirection',
};

export function evaluate(config) {
  if (typeof config?.auth?.secret === 'string' && config.auth.secret.length > 0) {
    return {passed: false, details: 'auth.secret must not be hardcoded; use auth.secretEnv'};
  }
  if (typeof config?.auth?.secretEnv !== 'string' || !config.auth.secretEnv.trim()) {
    return {passed: false, details: 'auth.secretEnv must be a non-empty environment variable name'};
  }
  return {passed: true, details: `auth secret read from env ${config.auth.secretEnv}`};
}
