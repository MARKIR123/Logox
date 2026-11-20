import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createService} from '../src/server.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('edge-gateway service', () => {
  it('initializes http client and routes with positive timeouts', async () => {
    const svc = createService(rootDir, {});
    assert.ok(svc.httpClient.timeoutMs > 0);
    assert.equal(svc.routes.health().status, 'ok');
    const res = await svc.routes.orders({id: '123'});
    assert.equal(res.url, '/orders/123');
  });
});
