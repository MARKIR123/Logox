export const ruleMeta = {
  id: 'R08',
  severity: 'warn',
  title: 'Rate Limit Ceiling',
};

export function evaluate(config) {
  const rpm = config?.rateLimit?.rpm;
  if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0 || rpm > 10000) {
    return {passed: false, details: `rateLimit.rpm should be between 1 and 10000, got ${rpm}`};
  }
  return {passed: true, details: `rateLimit.rpm=${rpm} is safe`};
}
