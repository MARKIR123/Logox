export function usersRoute(httpClient) {
  return async function handleUsers(req) {
    return httpClient.request(`/users/${req.id ?? 'me'}`);
  };
}
