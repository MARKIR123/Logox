export const ruleMeta = {
  id: 'R05',
  severity: 'error',
  title: 'Request Timeout Bounds',
};

export function evaluate(config) {
  const ms = config?.requestTimeoutMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 100 || ms > 120000) {
    return {passed: false, details: `requestTimeoutMs must be between 100 and 120000, got ${ms}`};
  }
  return {passed: true, details: `requestTimeoutMs=${ms}ms is within bounds`};
}
