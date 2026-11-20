export function buildHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-service': 'edge-gateway',
    ...extra,
  };
}
