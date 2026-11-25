const { parse } = require('acorn');
const { getQuickJS, shouldInterruptAfterDeadline } = require('quickjs-emscripten');

function scriptSource(code) {
  if (typeof code !== 'string' || code.length > 65536) throw new Error('用量查询代码不能超过 64 KB');
  return `(${code.trim().replace(/;\s*$/, '')}\n)`;
}

function validateUsageScript(code) {
  try {
    parse(scriptSource(code), { ecmaVersion: 'latest' });
  } catch (error) {
    throw new Error(`用量查询代码语法错误：${error.message}`);
  }
}

// Substitute parsed string literals so credentials cannot change JavaScript syntax.
function substituteScript(code, variables) {
  const source = scriptSource(code);
  const ast = parse(source, { ecmaVersion: 'latest' });
  const replacements = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const value = node.value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.hasOwn(variables, key)) throw new Error(`未知用量查询变量：${match}`);
        return variables[key];
      });
      replacements.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  let result = source;
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, item.start) + item.text + result.slice(item.end);
  }
  return result;
}

async function evaluateUsageScript(code, variables, response, stage = 'request') {
  const source = substituteScript(code, variables);
  const QuickJS = await getQuickJS();
  const expression = stage === 'request'
    ? `const config = ${source}; JSON.stringify(config.request)`
    : `const config = ${source}; JSON.stringify(config.extractor(${JSON.stringify(response)}))`;
  try {
    const result = QuickJS.evalCode(expression, {
      memoryLimitBytes: 16 * 1024 * 1024,
      maxStackSizeBytes: 256 * 1024,
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 250)
    });
    if (typeof result !== 'string' || result.length > 1024 * 1024) throw new Error('查询代码没有返回有效结果或结果过大');
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`用量查询代码执行失败：${error.message || '执行超时或结果无效'}`);
  }
}

function usageVariables(station) {
  return {
    baseUrl: new URL(station.statsUrl || station.baseUrl).origin,
    apiBaseUrl: station.baseUrl,
    statsUrl: station.statsUrl || '',
    apiKey: station.apiKey || '',
    accessToken: station.statsToken || station.apiKey || '',
    userId: station.statsUserId || ''
  };
}

function usageTemplate(profile, statsUrl = '', unit = 'USD') {
  const pathname = profile === 'aixhan' ? '/api/public/usage/stats'
    : profile === 'ahe' ? '/api/usage/token/'
      : profile === 'deepseek' ? '/user/balance' : '/api/user/self';
  // A bare statistics origin selects the host; a full endpoint keeps its path.
  let endpoint = statsUrl || `{{baseUrl}}${pathname}`;
  if (statsUrl) {
    const url = new URL(statsUrl);
    if (url.pathname === '/') {
      url.pathname = pathname;
      endpoint = url.toString();
    }
  }
  const request = { url: endpoint, method: 'GET' };
  if (profile !== 'aixhan') request.headers = { Authorization: 'Bearer {{accessToken}}' };
  if (profile === 'ahe') request.headers = { Authorization: 'Bearer {{apiKey}}', 'User-Agent': 'cc-switch/1.0' };
  if (profile === 'deepseek') request.headers = { Authorization: 'Bearer {{apiKey}}' };
  if (profile === 'new-api') request.headers['New-Api-User'] = '{{userId}}';
  let extractor;
  if (profile === 'aixhan') {
    extractor = `const data = response?.data ?? response;
    if (data?.remaining == null) throw new Error(response?.message || "未返回余额");
    return { isValid: true, remaining: data.remaining, unit: ${JSON.stringify(unit)} };`;
  } else if (profile === 'ahe') {
    extractor = `if (!response?.code || !response?.data) throw new Error(response?.message || "查询失败");
    const data = response.data;
    const divisor = Number(data.quota_per_unit) || 500000;
    const amount = (value) => value == null || value === "" ? null : Number(value) / divisor;
    const result = [];
    if (data.user_total_available != null) result.push({
      planName: "钱包", isValid: true, remaining: amount(data.user_total_available),
      used: amount(data.user_total_used), total: amount(data.user_total_granted), unit: ${JSON.stringify(unit)}
    });
    for (const item of data.subscriptions || []) {
      const sub = item.subscription;
      if (!sub) continue;
      const total = amount(sub.amount_total), used = amount(sub.amount_used);
      result.push({ planName: item.plan?.title || "订阅", isValid: true,
        remaining: total == null ? null : Math.max(total - (used || 0), 0), used, total, unit: ${JSON.stringify(unit)} });
    }
    for (const item of data.quota_buckets?.active_buckets || []) {
      if (!item.bucket) continue;
      result.push({ planName: item.bucket.title || "额度包", isValid: true,
        remaining: amount(item.remaining_quota), used: amount(item.bucket.amount_used),
        total: amount(item.bucket.amount_total), unit: ${JSON.stringify(unit)} });
    }
    return result;`;
  } else if (profile === 'new-api') {
    extractor = `if (response?.success === false) throw new Error(response.message || "查询失败");
    const data = response?.data ?? response;
    if (data?.quota == null) throw new Error("未返回账户额度");
    const divisor = 500000;
    const remaining = Number(data.quota) / divisor;
    const used = data.used_quota == null ? null : Number(data.used_quota) / divisor;
    return { planName: "账户", isValid: true, remaining, used,
      total: used == null ? null : remaining + used, unit: ${JSON.stringify(unit)} };`;
  } else if (profile === 'deepseek') {
    extractor = `if (!Array.isArray(response?.balance_infos) || !response.balance_infos.length) throw new Error("未返回 DeepSeek 余额");
    const balances = response.balance_infos;
    const item = balances.find((entry) => String(entry?.currency || "").toUpperCase() === "CNY") || balances[0];
    const currency = String(item?.currency || "").toUpperCase();
    const remaining = Number(item?.total_balance);
    if (!currency || !Number.isFinite(remaining)) throw new Error("DeepSeek 余额格式无效");
    const granted = Number(item?.granted_balance);
    const toppedUp = Number(item?.topped_up_balance);
    const extra = [
      Number.isFinite(granted) ? "赠送余额: " + currency + " " + granted.toFixed(2) : "",
      Number.isFinite(toppedUp) ? "充值余额: " + currency + " " + toppedUp.toFixed(2) : "",
      response.is_available === false ? "当前不可用" : ""
    ].filter(Boolean).join(" | ");
    return { planName: "DeepSeek 账户余额", isValid: true,
      remaining, used: null, total: null, unit: currency, extra };`;
  } else {
    extractor = `if (response?.success === false) throw new Error(response.message || "查询失败");
    const data = response?.data ?? response;
    return { isValid: true, remaining: data.balance, used: data.totalSpend,
      total: data.balanceLimit, unit: ${JSON.stringify(unit)} };`;
  }
  let requestCode = JSON.stringify(request, null, 2).replace(/\n/g, '\n  ');
  if (profile === 'aixhan') {
    const url = new URL(endpoint.replace('{{baseUrl}}', 'https://placeholder.invalid'));
    url.searchParams.delete('key');
    const cleanEndpoint = endpoint.includes('{{baseUrl}}') ? `{{baseUrl}}${url.pathname}${url.search}` : url.toString();
    requestCode = requestCode.replace(JSON.stringify(endpoint), `${JSON.stringify(`${cleanEndpoint}${url.search ? '&' : '?'}key=`)} + encodeURIComponent("{{apiKey}}")`);
  }
  return `({\n  request: ${requestCode},\n  extractor: function(response) {\n    ${extractor}\n  }\n})`;
}

module.exports = { validateUsageScript, evaluateUsageScript, usageTemplate, usageVariables };
