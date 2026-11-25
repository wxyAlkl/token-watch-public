const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { fetch } = require('undici');
const { createNetwork, systemProxyUrls } = require('../outbound-network');

test('Windows proxy settings support shared and per-protocol addresses', () => {
  assert.deepEqual(systemProxyUrls({ enabled: 0, server: '127.0.0.1:7897' }), {});
  assert.deepEqual(systemProxyUrls({ enabled: 1, server: '127.0.0.1:7897' }), {
    httpProxy: 'http://127.0.0.1:7897/', httpsProxy: 'http://127.0.0.1:7897/'
  });
  assert.deepEqual(systemProxyUrls({ enabled: 1, server: 'http=localhost:8000;https=localhost:8001' }), {
    httpProxy: 'http://localhost:8000/', httpsProxy: 'http://localhost:8001/'
  });
  assert.throws(() => systemProxyUrls({ enabled: 1, server: 'socks5://localhost:1080' }));
});

test('network resolver honors system proxy, caches it, and bypasses local API requests', async (t) => {
  let reads = 0;
  const network = createNetwork({ env: {}, platform: 'win32', readProxy: async () => {
    reads += 1;
    return { enabled: 1, server: '127.0.0.1:7897' };
  } });
  t.after(() => network.close());
  assert.equal(await network.dispatcher('http://127.0.0.1:4318/api/stations'), undefined);
  assert.equal(await network.dispatcher('http://localhost:4318/'), undefined);
  assert.equal(await network.dispatcher('http://[::1]:4318/'), undefined);
  assert.equal(reads, 0);
  const first = await network.dispatcher('https://example.com');
  assert.ok(first);
  assert.equal(await network.dispatcher('https://example.org'), first);
  assert.equal(reads, 1);
});

test('outbound requests really traverse the configured CONNECT proxy', async (t) => {
  let tunnels = 0;
  const target = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-proxy-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ balance: 42 }));
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels += 1;
    assert.equal(req.url, 'relay.example:80');
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const network = createNetwork({ env: {}, platform: 'win32', readProxy: async () => ({
    enabled: 1, server: `127.0.0.1:${proxy.address().port}`
  }) });
  t.after(async () => {
    await network.close();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => target.close(resolve));
  });
  const url = 'http://relay.example/balance';
  const response = await fetch(url, { dispatcher: await network.dispatcher(url), headers: { authorization: 'Bearer test-proxy-key' } });
  assert.deepEqual(await response.json(), { balance: 42 });
  assert.equal(tunnels, 1);
});

test('environment proxy overrides system proxy and failed discovery is explicit', async (t) => {
  const network = createNetwork({ env: { HTTPS_PROXY: 'http://127.0.0.1:9000' }, platform: 'win32',
    readProxy: async () => { throw new Error('should not be called'); } });
  t.after(() => network.close());
  assert.ok(await network.dispatcher('https://example.com'));
  const failing = createNetwork({ env: {}, platform: 'win32', readProxy: async () => { throw new Error('registry unavailable'); } });
  await assert.rejects(failing.dispatcher('https://example.com'), /无法读取 Windows 系统代理设置/);
  const direct = createNetwork({ env: {}, platform: 'linux' });
  assert.equal(await direct.dispatcher('https://example.com'), undefined);
});
