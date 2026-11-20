export const meta = {
  id: 'R03',
  level: 'error',
  name: 'Production TLS Required',
};

export function check(config) {
  if (config?.env === 'production' && config?.tls?.enabled !== true) {
    return {valid: false, reason: 'tls.enabled must be true in production'};
  }
  return {valid: true, reason: 'TLS policy satisfied'};
}
