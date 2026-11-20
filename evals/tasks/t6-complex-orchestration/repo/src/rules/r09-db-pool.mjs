export const meta = {
  id: 'R09',
  level: 'error',
  name: 'Database Pool Bounds',
};

export function check(config) {
  const min = config?.database?.poolMin;
  const max = config?.database?.poolMax;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) {
    return {valid: false, reason: `invalid database pool bounds: min=${min}, max=${max}`};
  }
  return {valid: true, reason: `database pool [${min}, ${max}] is valid`};
}
