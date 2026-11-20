export function requireAuth(req) {
  return Boolean(req?.headers?.authorization);
}
