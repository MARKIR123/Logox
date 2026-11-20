export const ruleMeta = {
  id: 'R01',
  severity: 'error',
  title: 'Port Range',
};

export function evaluate(config) {
  const port = config?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {passed: false, details: `port must be an integer between 1 and 65535, got ${port}`};
  }
  return {passed: true, details: `port ${port} is within valid range`};
}
