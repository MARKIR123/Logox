export const meta = {
  id: 'R01',
  level: 'error',
  name: 'Port Range',
};

export function check(config) {
  const port = config?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {valid: false, reason: `port must be an integer between 1 and 65535, got ${port}`};
  }
  return {valid: true, reason: `port ${port} is within valid range`};
}
