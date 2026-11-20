export function ordersRoute(httpClient) {
  return async function handleOrders(req) {
    return httpClient.request(`/orders/${req.id ?? 'list'}`);
  };
}
