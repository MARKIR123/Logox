export const ruleMeta = {
  id: 'R10',
  severity: 'warn',
  title: 'CORS Origin Restriction',
};

export function evaluate(config) {
  const origins = config?.cors?.origins;
  if (!Array.isArray(origins) || origins.length === 0) {
    return {passed: false, details: 'cors.origins must be a non-empty array'};
  }
  if (config?.env === 'production' && origins.includes('*')) {
    return {passed: false, details: 'cors.origins should not include wildcard "*" in production'};
  }
  return {passed: true, details: `cors.origins specifies ${origins.length} origin(s)`};
}
