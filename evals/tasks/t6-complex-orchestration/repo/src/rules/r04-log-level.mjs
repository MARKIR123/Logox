export const meta = {
  id: 'R04',
  level: 'warn',
  name: 'Log Level Hygiene',
};

const ALLOWED_PROD_LEVELS = new Set(['info', 'warn', 'error']);

export function check(config) {
  const level = config?.logLevel;
  if (!ALLOWED_PROD_LEVELS.has(level)) {
    return {valid: false, reason: `logLevel "${level}" is too verbose or unrecognized`};
  }
  return {valid: true, reason: `logLevel "${level}" is appropriate`};
}
