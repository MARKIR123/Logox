export const meta = {
  id: 'R06',
  level: 'error',
  name: 'Max Body Limit',
};

const MAX_LIMIT = 50 * 1024 * 1024;

export function check(config) {
  const bytes = config?.maxBodyBytes;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_LIMIT) {
    return {valid: false, reason: `maxBodyBytes must be > 0 and <= ${MAX_LIMIT}, got ${bytes}`};
  }
  return {valid: true, reason: `maxBodyBytes=${bytes} is within limit`};
}
