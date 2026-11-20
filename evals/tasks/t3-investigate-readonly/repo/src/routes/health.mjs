export function healthRoute(heartbeat) {
  return function handleHealth() {
    return {status: 'ok', heartbeatIntervalMs: heartbeat.intervalMs};
  };
}
