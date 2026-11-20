export const meta = {
  id: 'R08',
  level: 'warn',
  name: 'Rate Limit Ceiling',
};

export function check(config) {
  const rpm = config?.rateLimit?.rpm;
  if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0 || rpm > 10000) {
    return {valid: false, reason: `rateLimit.rpm should be between 1 and 10000, got ${rpm}`};
  }
  return {valid: true, reason: `rateLimit.rpm=${rpm} is safe`};
}
