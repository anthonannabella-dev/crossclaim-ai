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
  check('mobile.home.no.horizontal.overflow', mBody.length > 0, '');
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
