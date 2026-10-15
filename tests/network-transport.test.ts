import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {createHttpTransport} from '../src/providers/transport.js';

test('环境代理使用 CONNECT，NO_PROXY 绕过，连接复用且关闭后不再发送', async () => {
  let tunnels = 0, connections = 0;
  const origin = createServer((_req, res) => res.end('network-ready'));
  origin.on('connection', () => connections++);
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address(); assert.ok(address && typeof address === 'object');
  const proxy = createServer();
  proxy.on('connect', (_req, client, head) => {
    tunnels++;
    const upstream = connect(address.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object');
  const transport = createHttpTransport({http_proxy: `http://127.0.0.1:${proxyAddress.port}`, NO_PROXY: ''});
  const direct = createHttpTransport({HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`, no_proxy: '127.0.0.1'});
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    for (let i = 0; i < 3; i++) {
      assert.equal(await (await transport.fetch(url)).text(), 'network-ready');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(tunnels, 1); assert.equal(connections, 1);
    assert.equal(await (await direct.fetch(url)).text(), 'network-ready'); assert.equal(tunnels, 1);
    await transport.close(); await transport.close();
    await assert.rejects(transport.fetch(url)); assert.equal(tunnels, 1);
  } finally {
    await transport.close(); await direct.close();
    origin.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
  }
});

test('无代理环境不继承宿主代理，非法代理错误不回显凭据', () => {
  assert.throws(() => createHttpTransport({HTTPS_PROXY: 'socks5://private-user:private-key@127.0.0.1:9'}), error =>
    error instanceof Error && /代理/.test(error.message) && !error.message.includes('private-'));
});
