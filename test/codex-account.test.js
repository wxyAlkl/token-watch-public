const test = require('node:test');
const assert = require('node:assert/strict');
const { readAccount, createAccountMonitor } = require('../codex-account');

function client(responses) {
  return {
    calls: [], closed: false,
    async read(method) {
      this.calls.push(method);
      if (method === 'initialize') return {};
      assert.ok(Object.hasOwn(responses, method), method);
      if (responses[method] instanceof Error) throw responses[method];
      return responses[method];
    },
    send() {}, close() { this.closed = true; }
  };
}
const loggedIn = { account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com' } };

test('official account reports only supplied windows and dated usage, independent of station accounting', async () => {
  const rpc = client({
    'account/read': loggedIn,
    'account/rateLimits/read': { rateLimits: {}, rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { windowDurationMins: 10080, usedPercent: 100, resetsAt: 123 } },
      other: { limitName: 'Other', secondary: { windowDurationMins: 300, usedPercent: 0 } }
    } },
    'account/usage/read': { summary: { lifetimeTokens: 42 }, dailyUsageBuckets: [
      { startDate: '2026-10-28', tokens: 0 }, { startDate: '2026-10-29', tokens: 42 }
    ] }
  });
  const snapshot = await readAccount(rpc);
  assert.deepEqual(snapshot, {
    status: 'connected', plan: 'pro', windows: [
      { bucket: 'codex', kind: 'primary', minutes: 10080, remaining: 0, resetsAt: 123 },
      { bucket: 'Other', kind: 'secondary', minutes: 300, remaining: 100, resetsAt: null }
    ], usage: { total: 42, days: [{ date: '2026-10-29', tokens: 42 }, { date: '2026-10-28', tokens: 0 }] }
  });
  assert.ok(rpc.closed);
});

test('partial responses preserve the working endpoint and unknown fields', async () => {
  const rpc = client({
    'account/read': loggedIn,
    'account/rateLimits/read': { rateLimits: { primary: { usedPercent: null } } },
    'account/usage/read': new Error('unsupported on older client')
  });
  const partial = await readAccount(rpc);
  assert.equal(partial.windows.length, 1);
  assert.equal(partial.windows[0].remaining, null);
  assert.equal(partial.usage, null);
  const usageOnly = await readAccount(client({
    'account/read': loggedIn, 'account/rateLimits/read': new Error('offline'),
    'account/usage/read': { summary: { lifetimeTokens: 0 }, dailyUsageBuckets: null }
  }));
  assert.equal(usageOnly.windows, null);
  assert.deepEqual(usageOnly.usage, {total: 0, days: []});
});

test('signed-out and API-key accounts skip authenticated queries', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const rpc = client({ 'account/read': { account } });
    assert.deepEqual(await readAccount(rpc), { status: 'login-required' });
    assert.deepEqual(rpc.calls, ['initialize', 'account/read']);
    assert.ok(rpc.closed);
  }
});

test('concurrent dashboard reads share one probe and manual refresh sees account changes', async () => {
  let calls = 0;
  const monitor = createAccountMonitor(async () => ({ status: ++calls === 1 ? 'connected' : 'login-required' }));
  const [first, second] = await Promise.all([monitor(), monitor(true)]);
  assert.equal(first, second);
  assert.equal(first, await monitor());
  assert.equal((await monitor(true)).status, 'login-required');
  assert.equal(calls, 2);
});
