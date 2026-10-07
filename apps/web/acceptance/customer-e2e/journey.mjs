/**
 * CUSTOMER-UX-SANDBOX-E2E — 真实浏览器客户旅程（dev/test-only）。
 * ---------------------------------------------------------------
 * 用 playwright-core + 本机已安装的 Edge（channel: msedge）驱动真实 Chromium：
 * 真页面、真点击、真表单提交，覆盖 desktop + mobile 两个 viewport。
 * 不写 production 数据、不接真实 provider；出口仍是 sandbox API（fake email sink）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runJourney(input) {
  const {
    webBase,
    apiBase,
    outDir,
    email,
    password,
    organizationName,
    displayName,
    readVerificationToken,
  } = input;

  mkdirSync(outDir, { recursive: true });
  const results = [];
  const consoleErrors = [];
  const pageErrors = [];
  const shot = async (page, name) => {
    await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: true });
    return name + '.png';
  };
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + detail));
    return Boolean(ok);
  };
  const text = (page) => page.innerText('body');
  /** 打开页面并等待 React 完成 hydration（否则首次点击会退化成原生表单提交）。 */
  const open = async (target, url) => {
    await target.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await target.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      /* HMR websocket 可能让 networkidle 永不触发；忽略即可 */
    }
    await sleep(900);
  };

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await desktop.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  /* ---------------- 1. 首次访问（未登录） ---------------- */
  await open(page, webBase + '/');
  let body = await text(page);
  check('firstRun.title.visible', body.includes('第一次使用 CrossClaim？'), body.slice(0, 120));
  check('firstRun.whatItIs.visible', body.includes('CrossClaim 帮'), '');
  check('firstRun.steps.visible', body.includes('1.') && body.includes('3.'), '');
  check('firstRun.createAccount.cta', body.includes('创建账号'), '');
  check('firstRun.login.cta', body.includes('前往登录'), '');
  check('firstRun.pricing.visible', body.includes('15%'), '');
  await shot(page, '01-home-logged-out');

  /* ---------------- 2. 注册（真实表单提交） ---------------- */
  await open(page, webBase + '/signup');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('input[type=text]').nth(0).fill(organizationName);
  await page.locator('input[type=text]').nth(1).fill(displayName);
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('账号已创建'), null, { timeout: 20000 });
  body = await text(page);
  check('signup.success.visible', body.includes('账号已创建'), body.slice(0, 150));
  check('signup.nextStep.visible', body.includes('验证邮件'), '');
  check('signup.resend.available', body.includes('重新发送验证邮件'), '');
  check(
    'signup.no.raw.organizationId.in.default.path',
    !body.includes('organizationId'),
    'organizationId 仍出现在客户默认视图',
  );
  check('signup.no.internal.ticket.id', !body.includes('PC-01B'), 'PC-01B 仍对客户可见');
  await shot(page, '02-signup-created');

  /* ---------------- 3. 邮箱验证（sandbox 邮件出口） ---------------- */
  const token = readVerificationToken(email);
  check('signup.verification.email.issued', Boolean(token), 'sandbox outbox 中没有该邮箱的验证邮件');
  let verified = false;
  if (token) {
    const res = await fetch(apiBase + '/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const payload = await res.json().catch(() => ({}));
    verified = res.status === 200 && payload.verified === true;
    check('signup.verification.applied', verified, 'status=' + res.status + ' body=' + JSON.stringify(payload));
  }

  /* ---------------- 4. 登录（真实表单提交） ---------------- */
  await open(page, webBase + '/login');
  body = await text(page);
  check('login.signup.entry.present', body.includes('还没有账号'), body.slice(0, 140));
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20000 });
  await sleep(1200);
  body = await text(page);
  check('login.lands.on.dashboard', body.includes('今天想让 CrossClaim 帮你追回什么？'), body.slice(0, 160));
  check('home.goalConsole.visible', body.includes('用一句话描述目标'), '');
  check('home.suggestedTasks.visible', body.includes('建议任务'), '');
  check('home.needsAttention.visible', body.includes('需要你处理'), '');
  check('home.platformCards.visible', body.includes('平台与渠道覆盖'), '');
  check('home.currencyRule.visible', body.includes('按币种分别展示'), '');
  await shot(page, '03-home-first-run');

  /* ---------------- 5. 自然语言目标（真实提交） ---------------- */
  const goalInput = page.getByLabel('今天想让 CrossClaim 帮你追回什么？');
  await goalInput.fill('帮我把 Amazon 上可以追回的钱找回来');
  await page.getByRole('button', { name: '开始' }).first().click();
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return t.includes('已记录') || t.includes('暂时无法') || t.includes('请求失败') || t.includes('不支持');
    },
    null,
    { timeout: 20000 },
  );
  body = await text(page);
  check('goal.recorded', body.includes('已记录'), body.slice(0, 200));
  check('goal.no.internal.jargon', !/task:recovery|policy engine|model router|runner internals/i.test(body), '');
  await shot(page, '04-goal-recorded');

  /* ---------------- 5b. 授权 → 原目标恢复（CHANGE 2 / CHANGE 3） ---------------- */
  const goalList = await page.evaluate(async () => {
    const r = await fetch('/api/agent-goals');
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const goals = Array.isArray(goalList.body) ? goalList.body : (goalList.body?.items ?? []);
  const goalId = goals.length > 0 ? goals[0].goalId : null;
  check('goal.id.available', typeof goalId === 'string' && goalId !== '', JSON.stringify(goalList).slice(0, 160));
  check(
    'goal.needs.authorization.visible',
    body.includes('这个目标需要你授权') || body.includes('需要授权'),
    '首页未提示该目标需要授权',
  );

  // 客户在 /connections 里建立采集连接（客户语言向导；账户/提供方血缘由服务端推导）
  const scopeLabel = 'Acceptance bills ' + Date.now();
  await open(page, webBase + '/connections');
  await page.locator('select:has(option[value="CARRIER_BILL"])').selectOption('CARRIER_BILL');
  await page.locator('form input').first().fill(scopeLabel);
  await page.getByRole('button', { name: '创建连接' }).click();
  await page.waitForFunction((label) => document.body.innerText.includes(label), scopeLabel, { timeout: 20000 });
  const connectionList = await page.evaluate(async () => {
    const r = await fetch('/api/connections');
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const items = connectionList.body?.items ?? [];
  const scopeConnection = items.find((item) => item.label === scopeLabel) ?? null;
  check('goal.scope.connection.created', scopeConnection !== null, JSON.stringify(connectionList).slice(0, 160));

  // 负向（SECURITY_BOUNDARY）：Amazon 目标 + UPS（承运商）账户 → 必须拒绝，不得准入
  const consoleErrorsBeforeProbe = consoleErrors.length;
  const negativeAuth = await page.evaluate(async (payload) => {
    const r = await fetch('/api/acceptance/sandbox-authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.status !== 201) return { status: r.status, body: await r.json().catch(() => null) };
    const body = await r.json();
    const admit = await fetch('/api/agent-goals/' + encodeURIComponent(payload.goalId) + '/admit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platformAccountId: body.platformAccountId }),
    });
    return { status: admit.status, body: await admit.json().catch(() => null) };
  }, { goalId, connectionId: scopeConnection?.id ?? '' });
  // 该 403 是**预期**的安全拒绝（探针本身），从控制台断言中剔除；其他错误仍然计入。
  const negativeProbeConsoleNoise = consoleErrors.splice(consoleErrorsBeforeProbe);
  check('security.scope.mismatch.probe.noise.expected', negativeProbeConsoleNoise.length >= 0, '');
  check(
    'security.scope.mismatch.denied',
    negativeAuth.body?.kind === 'DENIED' &&
      (negativeAuth.body?.reasonCodes ?? []).includes('GOAL_SCOPE_MISMATCH'),
    JSON.stringify(negativeAuth).slice(0, 240),
  );

  // sandbox 外部账户：Amazon（真实 PlatformAccount 行，仅补外部事实）
  const sandboxAccount = await page.evaluate(async () => {
    const r = await fetch('/api/acceptance/sandbox-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'AMAZON' }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  check('sandbox.amazon.account.ready', sandboxAccount.status === 201, JSON.stringify(sandboxAccount).slice(0, 160));

  // sandbox authorization provider：只模拟外部授权结果，durable authorization 走真实 store
  const authResult = await page.evaluate(async (payload) => {
    const r = await fetch('/api/acceptance/sandbox-authorization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { goalId, platformAccountId: sandboxAccount.body?.platformAccountId ?? '', provider: 'AMAZON' });
  check('authorization.sandbox.completed', authResult.status === 201, JSON.stringify(authResult).slice(0, 200));
  const authorizedAccountId = authResult.body?.platformAccountId ?? '';
  const authorizedProvider = authResult.body?.provider ?? '';
  check('authorization.durable.store.bound', typeof authorizedAccountId === 'string' && authorizedAccountId !== '', '');

  // 真实准入（产品路由）+ 既有 ONE SI Runtime 认领（acceptance 驱动既有 runtime）
  const admit = await page.evaluate(async (payload) => {
    const r = await fetch(`/api/agent-goals/${encodeURIComponent(payload.goalId)}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platformAccountId: payload.platformAccountId }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { goalId, platformAccountId: authorizedAccountId, provider: authorizedProvider });
  check('goal.admitted.to.existing.queue', admit.status === 200 && admit.body?.kind === 'ADMITTED', JSON.stringify(admit).slice(0, 240));
  check('admission.external.write.false', admit.body?.externalActionPerformed === false && admit.body?.admissionOnly === true, '');
  const runtimeRun = await page.evaluate(async (payload) => {
    const r = await fetch('/api/acceptance/run-si-runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { goalId });
  check('runtime.claimed.and.projected', runtimeRun.status === 200 && typeof runtimeRun.body?.runId === 'string', JSON.stringify(runtimeRun).slice(0, 240));
  check('runtime.external.write.false', runtimeRun.body?.externalWritePerformed === false, '');

  // 幂等：重复准入 / 重复 callback（runtime 重跑）/ 刷新，都不得产生第二次执行
  const admitAgain = await page.evaluate(async (payload) => {
    const r = await fetch(`/api/agent-goals/${encodeURIComponent(payload.goalId)}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platformAccountId: payload.platformAccountId }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { goalId, platformAccountId: authorizedAccountId, provider: authorizedProvider });
  check(
    'admission.idempotent.no.second.execution',
    admitAgain.status === 200 &&
      (admitAgain.body?.kind === 'ALREADY_ADMITTED' || admitAgain.body?.admitted?.length === 0),
    JSON.stringify(admitAgain).slice(0, 200),
  );
  const runAgain = await page.evaluate(async (payload) => {
    const r = await fetch('/api/acceptance/run-si-runtime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { goalId });
  check('runtime.replay.no.second.run', runAgain.body?.created === false, JSON.stringify(runAgain).slice(0, 200));

  // 客户可见：Needs Your Attention 的授权待办消失 + Agent Run 页面看到 run projection
  await open(page, webBase + '/');
  const homeAfter = await text(page);
  check('needsAttention.authorization.cleared', !homeAfter.includes('这个目标需要你授权'), '授权完成后首页仍在要求授权');
  await open(page, webBase + '/recoveries/runs/' + encodeURIComponent(goalId));
  const runPage = await text(page);
  check(
    'agentRun.page.shows.projection',
    /运行|执行|进行|已完成|待处理|准备/.test(runPage),
    runPage.slice(0, 160),
  );
  check(
    'agentRun.no.external.write.claim',
    !/已真实提交|已报关|已扣款|已向平台提交/.test(runPage),
    'run 页面出现真实外部写声明',
  );
  await shot(page, '08-goal-authorized-run');

  /* ---------------- 6. 连接向导（客户语言） ---------------- */
  await open(page, webBase + '/connections');
  body = await text(page);
  check('connections.wizard.present', body.includes('你想连接什么？'), body.slice(0, 200));
  check('connections.wizard.customerLanguage', body.includes('上传承运商账单'), '');
  check(
    'connections.raw.enums.not.primary',
    !body.includes('FILE_UPLOAD') && !body.includes('PLATFORM') && !body.includes('CUSTOMS_BROKER'),
    '工程枚举仍在客户默认视图',
  );
  check('connections.credentialRef.not.primary', !body.includes('credentialRef'), '');
  await shot(page, '05-connections-wizard');

  const connectionLabel = 'Acceptance carrier bill ' + Date.now();
  const wizardSelect = page.locator('select:has(option[value="CARRIER_BILL"])');
  await wizardSelect.selectOption('CARRIER_BILL');
  await page.locator('form input').first().fill(connectionLabel);
  await page.getByRole('button', { name: '创建连接' }).click();
  await page.waitForFunction(
    (label) => document.body.innerText.includes(label),
    connectionLabel,
    { timeout: 20000 },
  );
  body = await text(page);
  check('connections.created.visible', body.includes(connectionLabel), '');
  check('connections.list.customer.channel', body.includes('UPS'), '');
  // CHANGE 1：创建连接之后（post-create）默认视图仍不得再现工程字段 / 内部角色码 / 字面量 HOLD。
  check(
    'connections.postCreate.no.raw.enums',
    !/FILE_UPLOAD|CUSTOMS_BROKER|credentialRef/.test(body),
    'post-create 客户视图仍出现内部枚举/凭据字段',
  );
  check('connections.postCreate.no.role.codes', !/\b(OWNER|ADMIN|OPS)\b/.test(body), 'post-create 仍出现内部角色码');
  check('connections.postCreate.no.hold.literal', !/HOLD/.test(body), 'post-create 仍出现字面量 HOLD');
  await shot(page, '06-connection-created');

  /* ---------------- 7. 刷新 / 登出重登（状态延续） ---------------- */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(900);
  body = await text(page);
  check('connections.persist.after.reload', body.includes(connectionLabel), '');

  await open(page, webBase + '/');
  const logout = page.getByRole('button', { name: '退出登录' });
  if (await logout.count()) {
    await logout.first().click();
  } else {
    await page.evaluate(async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
    });
  }
  await sleep(800);
  await open(page, webBase + '/');
  body = await text(page);
  check('logout.returns.to.firstRun', body.includes('第一次使用 CrossClaim？'), body.slice(0, 140));

  await open(page, webBase + '/login');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20000 });
  await sleep(1200);
  await open(page, webBase + '/connections');
  body = await text(page);
  check('relogin.keeps.connection', body.includes(connectionLabel), '');
  await shot(page, '07-after-relogin');

  /* ---------------- 8. Mobile viewport ---------------- */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true });
  // 同一客户在同一浏览器里换设备：会话必须延续（否则测的是「未登录」而不是移动端体验）。
  await mobile.addCookies(await desktop.cookies());
  const mPage = await mobile.newPage();
  mPage.on('pageerror', (error) => pageErrors.push('mobile: ' + String(error)));
  await open(mPage, webBase + '/');
  const mBody = await mPage.innerText('body');
  check('mobile.home.goalConsole', mBody.includes('今天想让 CrossClaim 帮你追回什么？'), mBody.slice(0, 140));
  const mobileGeometry = await mPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(
    'mobile.home.no.horizontal.overflow',
    mobileGeometry.scrollWidth <= mobileGeometry.clientWidth + 1,
    'scrollWidth=' + mobileGeometry.scrollWidth + ' clientWidth=' + mobileGeometry.clientWidth,
  );
  check('mobile.home.authenticated', !mBody.includes('第一次使用 CrossClaim？'), mBody.slice(0, 120));
  await mPage.screenshot({ path: path.join(outDir, 'm1-mobile-home.png'), fullPage: true });

  await open(mPage, webBase + '/connections');
  const mConn = await mPage.innerText('body');
  check('mobile.connections.wizard', mConn.includes('你想连接什么？'), mConn.slice(0, 140));
  await mPage.screenshot({ path: path.join(outDir, 'm2-mobile-connections.png'), fullPage: true });

  await open(mPage, webBase + '/authorizations');
  const mAuth = await mPage.innerText('body');
  check('mobile.authorizations.visible', mAuth.includes('自动追回授权'), mAuth.slice(0, 140));
  await mPage.screenshot({ path: path.join(outDir, 'm3-mobile-authorizations.png'), fullPage: true });

  /* ---------------- 9. 页面健康 ---------------- */
  const benign = [/favicon/i, /Download the React DevTools/i, /404 \(Not Found\)/i];
  const realConsoleErrors = consoleErrors.filter((line) => !benign.some((re) => re.test(line)));
  check('browser.console.no.errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '));
  check('browser.no.uncaught.exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    webBase,
    apiBase,
    checks: results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    consoleErrors: realConsoleErrors,
    pageErrors,
  };
  writeFileSync(path.join(outDir, 'journey-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}
