const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, present } = require('../public/quota-policy');

const station = (quotaPolicy, extra = {}) => ({ balance: 15, balanceKnown: true, balanceUnit: 'USD', usageStatus: 'online', quotaPolicy, ...extra });

test('quota policy defaults to prepaid and rejects invalid settings', () => {
  assert.deepEqual(normalize(), { mode: 'prepaid', limit: null, lowBalanceThreshold: null, source: 'account' });
  for (const value of [null, [], { mode: 'other' }, { mode: 'daily' }, { mode: 'weekly', limit: 0 },
    { mode: 'daily', limit: -1 }, { mode: 'daily', limit: true }, { mode: 'daily', limit: 'Infinity' },
    { lowBalanceThreshold: -1 }, { lowBalanceThreshold: false }, { source: '' }, { source: 'plan:' }]) {
    assert.throws(() => normalize(value));
  }
  assert.equal(normalize({ mode: 'weekly', limit: '100.25' }).limit, 100.25);
});

test('daily and weekly bars show remaining fraction with safe boundary values', () => {
  for (const mode of ['daily', 'weekly']) {
    assert.equal(present(station({ mode, limit: 20 })).percent, 75);
    for (const [balance, percent] of [[20, 100], [0, 0], [-5, 0], [30, 100]]) {
      const result = present(station({ mode, limit: 20 }, { balance }));
      assert.equal(result.percent, percent);
      assert.equal(result.overLimit, balance > 20);
      assert.equal(result.remaining, balance);
    }
    for (const balance of [null, undefined, '', ' ', NaN]) {
      const result = present(station({ mode, limit: 20 }, { balance }));
      assert.equal(result.percent, null);
      assert.equal(result.state, 'unknown');
    }
    assert.equal(present(station({ mode, limit: 20 }, { balanceKnown: false })).percent, null);
  }
});

test('prepaid has no percentage and distinguishes low, depleted and unknown balances', () => {
  assert.equal(present(station()).percent, null);
  assert.equal(present(station()).state, 'normal');
  assert.equal(present(station({ lowBalanceThreshold: 15 })).state, 'low');
  assert.equal(present(station({ lowBalanceThreshold: 10 })).state, 'normal');
  assert.equal(present(station({ lowBalanceThreshold: 0 }, { balance: 0 })).state, 'depleted');
  assert.equal(present(station({}, { balance: null })).state, 'unknown');
});

test('quota source uses matching unique plan, never falls back to account balance', () => {
  const policy = { mode: 'daily', limit: 20, source: 'plan:Daily' };
  const plans = [{ planName: 'Daily', remaining: 5, unit: 'USD' }, { name: 'Wallet', remaining: 90, unit: 'USD' }];
  const input = station(policy, { balance: 100, usagePlans: plans });
  assert.equal(present(input).percent, 25);
  assert.equal(present(input).sourceLabel, 'Daily');
  assert.equal(present({ ...input, usagePlans: [{ name: 'Daily', remaining: 0, unit: 'USD' }] }).percent, 0);
  for (const usagePlans of [[], [...plans, plans[0]], [{ ...plans[0], unit: 'CNY' }], [{ ...plans[0], remaining: null }]]) {
    assert.equal(present({ ...input, usagePlans }).percent, null);
    assert.equal(present({ ...input, usagePlans }).state, 'unknown');
  }
  assert.equal(input.balance, 100);
  assert.equal(plans[0].remaining, 5);
});

test('query failures preserve cached amount and expose staleness without replenishing it', () => {
  const input = station({ mode: 'weekly', limit: 100 }, { usageStatus: 'error', balance: 35, balanceUpdatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(present(input).stale, true);
  assert.equal(present(input).percent, 35);
  assert.equal(present({ ...input, balance: null }).stale, false);
  assert.equal(present({ ...input, usageStatus: 'online' }).stale, false);
});
