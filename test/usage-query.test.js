const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateUsageScript, validateUsageScript, usageTemplate, usageVariables } = require('../usage-query');

test('custom usage queries use the configured statistics host with or without trailing slash', async () => {
  const code = '({ request: { url: "{{baseUrl}}/api/public/usage/stats?key=" + encodeURIComponent("{{apiKey}}") } })';
  for (const statsUrl of ['https://cdk.aixhan.com', 'https://cdk.aixhan.com/', 'https://cdk.aixhan.com/api/public/usage/stats']) {
    const variables = usageVariables({baseUrl:'https://api.aixhan.com/v1', statsUrl, apiKey:'a+b='});
    const request = await evaluateUsageScript(code, variables);
    assert.equal(request.url, 'https://cdk.aixhan.com/api/public/usage/stats?key=a%2Bb%3D');
    assert.equal(variables.apiBaseUrl, 'https://api.aixhan.com/v1');
    assert.equal(variables.statsUrl, statsUrl);
  }
  assert.equal(usageVariables({baseUrl:'https://example.test/v1'}).baseUrl, 'https://example.test');
});

test('Aixhan templates append the usage path to bare statistics origins', async () => {
  for (const endpoint of ['https://cdk.aixhan.com', 'https://cdk.aixhan.com/', 'https://cdk.aixhan.com/api/public/usage/stats']) {
    const request = await evaluateUsageScript(usageTemplate('aixhan', endpoint), {apiKey:'a+b='});
    assert.equal(request.url, 'https://cdk.aixhan.com/api/public/usage/stats?key=a%2Bb%3D');
  }
});

test('usage scripts substitute credentials as data and parse CC Switch requests', async () => {
  const code = `({
    request: { url: "{{baseUrl}}/balance?key=" + encodeURIComponent("{{apiKey}}"), method: "GET" },
    extractor: function(response) { return { isValid: true, remaining: response.remaining, unit: "USD" }; }
  })`;
  const request = await evaluateUsageScript(code, { baseUrl: 'https://example.test', apiKey: 'a+b=c"\\' }, null, 'request');
  assert.equal(request.url, 'https://example.test/balance?key=a%2Bb%3Dc%22%5C');
  const result = await evaluateUsageScript(code, { baseUrl: 'https://example.test', apiKey: 'secret' }, { remaining: 0 }, 'extractor');
  assert.deepEqual(result, { isValid: true, remaining: 0, unit: 'USD' });
});

test('usage scripts are validated and cannot access the Node process', async () => {
  assert.throws(() => validateUsageScript('({ request: { url: } })'), /语法错误/);
  await assert.rejects(
    evaluateUsageScript('({ request: { url: "https://example.test" }, extractor: function() { return process.env; } })', {}, {}, 'extractor'),
    /执行失败/
  );
});

test('usage script execution is interrupted when it does not finish', async () => {
  await assert.rejects(
    evaluateUsageScript('({ request: { url: "https://example.test" }, extractor: function() { while (true) {} } })', {}, {}, 'extractor'),
    /执行失败/
  );
});

test('built-in templates keep the provider-specific usage request shape', () => {
  const aixhan = usageTemplate('aixhan', 'https://cdk.aixhan.com/api/public/usage/stats', 'USD');
  assert.match(aixhan, /encodeURIComponent\("\{\{apiKey\}\}"\)/);
  assert.match(usageTemplate('ahe', '', 'CNY'), /cc-switch\/1\.0/);
  const deepseek = usageTemplate('deepseek', '', 'CNY');
  assert.match(deepseek, /\{\{baseUrl\}\}\/user\/balance/);
  assert.match(deepseek, /Bearer \{\{apiKey\}\}/);
  assert.match(deepseek, /balance_infos/);
});
