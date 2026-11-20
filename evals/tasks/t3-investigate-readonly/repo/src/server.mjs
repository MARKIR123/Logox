import {loadConfig} from './config/loader.mjs';
import {createHttpClient} from './http/client.mjs';
import {readHeartbeatSettings} from './health/heartbeat.mjs';
import {ordersRoute} from './routes/orders.mjs';
import {usersRoute} from './routes/users.mjs';
import {healthRoute} from './routes/health.mjs';
import {requireAuth} from './middleware/auth.mjs';
import {logRequest} from './middleware/logging.mjs';

export function createService(rootDir, env = process.env) {
  const config = loadConfig(rootDir, env);
  const httpClient = createHttpClient(config);
  const heartbeat = readHeartbeatSettings(rootDir);
  return {
    config,
    httpClient,
    routes: {
      orders: ordersRoute(httpClient),
      users: usersRoute(httpClient),
      health: healthRoute(heartbeat),
    },
    requireAuth,
    logRequest,
  };
}
