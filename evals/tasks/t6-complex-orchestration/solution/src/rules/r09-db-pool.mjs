export const ruleMeta = {
  id: 'R09',
  severity: 'error',
  title: 'Database Pool Bounds',
};

export function evaluate(config) {
  const min = config?.database?.poolMin;
  const max = config?.database?.poolMax;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) {
    return {passed: false, details: `invalid database pool bounds: min=${min}, max=${max}`};
  }
  return {passed: true, details: `database pool [${min}, ${max}] is valid`};
}
