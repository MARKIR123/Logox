export const meta = {
  id: 'R10',
  level: 'warn',
  name: 'CORS Origin Restriction',
};

export function check(config) {
  const origins = config?.cors?.origins;
  if (!Array.isArray(origins) || origins.length === 0) {
    return {valid: false, reason: 'cors.origins must be a non-empty array'};
  }
  if (config?.env === 'production' && origins.includes('*')) {
    return {valid: false, reason: 'cors.origins should not include wildcard "*" in production'};
  }
  return {valid: true, reason: `cors.origins specifies ${origins.length} origin(s)`};
}
