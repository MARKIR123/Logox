export const ruleMeta = {
  id: 'R03',
  severity: 'error',
  title: 'Production TLS Required',
};

export function evaluate(config) {
  if (config?.env === 'production' && config?.tls?.enabled !== true) {
    return {passed: false, details: 'tls.enabled must be true in production'};
  }
  return {passed: true, details: 'TLS policy satisfied'};
}
