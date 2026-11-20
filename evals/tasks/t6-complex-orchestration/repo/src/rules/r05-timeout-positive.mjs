export const meta = {
  id: 'R05',
  level: 'error',
  name: 'Request Timeout Bounds',
};

export function check(config) {
  const ms = config?.requestTimeoutMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 100 || ms > 120000) {
    return {valid: false, reason: `requestTimeoutMs must be between 100 and 120000, got ${ms}`};
  }
  return {valid: true, reason: `requestTimeoutMs=${ms}ms is within bounds`};
}
