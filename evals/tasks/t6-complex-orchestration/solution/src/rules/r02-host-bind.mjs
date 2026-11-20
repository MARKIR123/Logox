export const ruleMeta = {
  id: 'R02',
  severity: 'warn',
  title: 'Production Host Binding',
};

export function evaluate(config) {
  if (config?.env === 'production' && config?.host === '0.0.0.0') {
    return {passed: false, details: 'production service should avoid binding to 0.0.0.0 directly'};
  }
  return {passed: true, details: `host binding ${config?.host ?? 'default'} is acceptable`};
}
