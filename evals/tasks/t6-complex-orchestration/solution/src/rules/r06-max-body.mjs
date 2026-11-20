export const ruleMeta = {
  id: 'R06',
  severity: 'error',
  title: 'Max Body Limit',
};

const MAX_LIMIT = 50 * 1024 * 1024;

export function evaluate(config) {
  const bytes = config?.maxBodyBytes;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_LIMIT) {
    return {passed: false, details: `maxBodyBytes must be > 0 and <= ${MAX_LIMIT}, got ${bytes}`};
  }
  return {passed: true, details: `maxBodyBytes=${bytes} is within limit`};
}
