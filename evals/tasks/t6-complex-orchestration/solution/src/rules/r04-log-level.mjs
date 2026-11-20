export const ruleMeta = {
  id: 'R04',
  severity: 'warn',
  title: 'Log Level Hygiene',
};

const ALLOWED_PROD_LEVELS = new Set(['info', 'warn', 'error']);

export function evaluate(config) {
  const level = config?.logLevel;
  if (!ALLOWED_PROD_LEVELS.has(level)) {
    return {passed: false, details: `logLevel "${level}" is too verbose or unrecognized`};
  }
  return {passed: true, details: `logLevel "${level}" is appropriate`};
}
