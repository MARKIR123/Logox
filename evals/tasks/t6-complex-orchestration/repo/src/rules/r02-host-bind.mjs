export const meta = {
  id: 'R02',
  level: 'warn',
  name: 'Production Host Binding',
};

export function check(config) {
  if (config?.env === 'production' && config?.host === '0.0.0.0') {
    return {valid: false, reason: 'production service should avoid binding to 0.0.0.0 directly'};
  }
  return {valid: true, reason: `host binding ${config?.host ?? 'default'} is acceptable`};
}
