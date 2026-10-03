#!/usr/bin/env node
/**
 * LAYER 2 — GOLDEN PATH MATRIX（CHANGE C · MSG-20261003-135）
 * ---------------------------------------------------------------
 * 为四个业务域（Platform / Logistics-Carrier / Customs / Independent-site）逐格核对
 * 协议 Layer 2 要求的 12 个能力轴，并输出**证据文件名**（不是自评）：
 *   http · persistence · db_invariant · frontend · happy · negative · replay ·
 *   concurrency · failure_recovery · cross_tenant · rbac · amount_ledger
 *
 * 判定规则：
 *   · COVERED —— 至少存在一个「同时命中域关键字与轴关键字」的**真实测试文件**（或前端文件）；
 *   · GAP     —— 不存在；由 `--materialize` 自动登记为 backlog（允许用专项测试数量替代矩阵）。
 *
 * 用法：
 *   node tools/autopilot/golden-path-matrix.mjs [--write] [--materialize]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_JSON = path.join(ROOT, 'docs', 'releases', 'LAYER2-GOLDEN-PATH-MATRIX.json');
const OUT_MD = path.join(ROOT, 'docs', 'releases', 'LAYER2-GOLDEN-PATH-MATRIX.md');
const BACKLOG = path.join(ROOT, 'tools', 'autopilot', 'backlog.json');

const DOMAINS = [
  { id: 'platform', name: 'Platform Recovery', keywords: ['platform', 'amazon'], webTokens: ['claim-package', '/recovery-money'], frontendRequiredTokens: ['qualification'] },
  { id: 'logistics_carrier', name: 'Logistics / Carrier Recovery', keywords: ['carrier'], webTokens: ['carrier-claim-packages', 'carrier'] },
  { id: 'customs', name: 'Customs / Trade Recovery', keywords: ['customs'], webTokens: ['customs-opportunities', 'customs-entry-facts'] },
  { id: 'independent_site', name: 'Independent-site / Chargeback', keywords: ['independent-site', 'chargeback', 'ps04', 'dispute'], webTokens: ['independent', 'chargeback', 'dispute'], frontendRequiredTokens: ['phase1'] },
];

const AXES = [
  { id: 'http', patterns: ['-http', 'route', 'e2e-db', '状态码', '401', '403'] },
  { id: 'persistence', patterns: ['-db.test', '-store', 'persist', '持久化', 'append-only'] },
  { id: 'db_invariant', patterns: ['constraint', 'trigger', 'append-only', 'immutab', '约束', '触发器'] },
  { id: 'frontend', patterns: ['__FRONTEND__'] },
  { id: 'happy', patterns: ['-db.test', '-http', 'chain', 'service', 'happy'] },
  { id: 'negative', patterns: ['negative', 'reject', 'fail-closed', 'invalid', '拒绝', '不得', '负路径'] },
  { id: 'replay', patterns: ['replay', 'idempot', '重放', '幂等', '重复'] },
  { id: 'concurrency', patterns: ['concurr', 'worker', 'exactly-one', 'exactly one', 'race', '并发', '竞争'] },
  { id: 'failure_recovery', patterns: ['timeout', 'ambiguous', 'unknown-provider', 'reconcil', 'retry', '超时', '恢复'] },
  { id: 'cross_tenant', patterns: ['tenant', '跨租户', '租户'] },
  { id: 'rbac', patterns: ['rbac', 'permission', 'role', '权限', '角色'] },
  { id: 'amount_ledger', patterns: ['ledger', 'fee', 'amount', 'billing', '账本', '费用', '金额'] },
];

function walk(dir, filter, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
}

const apiTests = walk(path.join(ROOT, 'apps', 'api', 'src', '__tests__'), (file) => file.endsWith('.test.ts'));
const webFiles = walk(path.join(ROOT, 'apps', 'web'), (file) => /\.(tsx|ts)$/.test(file));
const readSafe = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8').toLowerCase();
  } catch {
    return '';
  }
};
// 证据判据基于**文件内容**（断言发生在文件内部，不能只看文件名）。
const apiIndex = apiTests.map((file) => ({ file, hay: (file + '\n' + readSafe(file)).toLowerCase() }));
const webIndex = webFiles.map((file) => ({ file, hay: (file + '\n' + readSafe(file)).toLowerCase() }));

const matrix = { generated_at: new Date().toISOString(), rule: 'COVERED 需存在命名证据文件；否则 GAP', domains: [] };
const gaps = [];

for (const domain of DOMAINS) {
  // 域归属必须由**文件名**决定（避免「内容里提过 platform」就把无关测试算进该域）；
  // 能力轴则由**文件内容**判定（断言写在文件内部）。
  const domainTests = apiIndex.filter((entry) => domain.keywords.some((keyword) => entry.file.toLowerCase().includes(keyword)));
  const domainWeb = webIndex.filter((entry) => domain.keywords.some((keyword) => entry.hay.includes(keyword)));
  // frontend 证据必须真正调用该域的后端路径（避免「文件里出现域名」就算接通）。
  // CHANGE E 加严（MSG-20261003-141）：frontend cell 不仅要「存在调用」，还要**断言关键状态字段**存在，
  // 否则会出现「文件存在 = 状态完整」的假阳性。
  const domainWebWired = webIndex.filter(
    (entry) =>
      (entry.hay.includes('/api') || entry.hay.includes('apiget')) &&
      domain.webTokens.some((token) => entry.hay.includes(token)) &&
      (domain.frontendRequiredTokens ?? []).every((token) => entry.hay.includes(token)),
  );
  const cells = {};
  for (const axis of AXES) {
    let evidence = [];
    if (axis.id === 'frontend') {
      evidence = domainWebWired.map((entry) => entry.file);
    } else {
      evidence = domainTests.filter((entry) => axis.patterns.some((pattern) => entry.hay.includes(pattern))).map((entry) => entry.file);
    }
    const status = evidence.length > 0 ? 'COVERED' : 'GAP';
    cells[axis.id] = { status, evidence: evidence.slice(0, 4) };
    if (status === 'GAP') gaps.push(domain.id + ':' + axis.id);
  }
  matrix.domains.push({ id: domain.id, name: domain.name, domain_test_files: domainTests.length, domain_web_files: domainWeb.length, cells });
}
matrix.gaps = gaps;

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT_JSON, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
  const lines = [
    '# LAYER 2 — GOLDEN PATH MATRIX（自动生成，请勿手改）',
    '',
    '- 生成时间：' + matrix.generated_at,
    '- 机器可读：`docs/releases/LAYER2-GOLDEN-PATH-MATRIX.json`；生成器：`tools/autopilot/golden-path-matrix.mjs`',
    '- 判定规则：**COVERED 必须存在命名证据文件**（测试/前端）；否则 GAP，并自动登记为 backlog。',
    '- 依据：MSG-20261003-135 CHANGE C（禁止用「专项测试很多」替代完整矩阵）。',
    '',
  ];
  for (const domain of matrix.domains) {
    lines.push('## ' + domain.name + '（api 测试 ' + domain.domain_test_files + ' 个 / 前端 ' + domain.domain_web_files + ' 个）', '');
    lines.push('| 能力轴 | 状态 | 证据 |', '|---|---|---|');
    for (const axis of AXES) {
      const cell = domain.cells[axis.id];
      lines.push('| ' + axis.id + ' | ' + cell.status + ' | ' + (cell.evidence.length ? cell.evidence.join('<br>') : '—') + ' |');
    }
    lines.push('');
  }
  lines.push('## GAP 汇总（自动 materialize 为 backlog）', '');
  lines.push(...(matrix.gaps.length ? matrix.gaps.map((gap) => '- ' + gap) : ['- （无）']), '');
  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');
  console.log('WROTE=' + OUT_JSON);
  console.log('WROTE=' + OUT_MD);
}

if (process.argv.includes('--materialize')) {
  const backlog = JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  let added = 0;
  for (const gap of gaps) {
    const [domainId, axisId] = gap.split(':');
    const id = 'GP-' + domainId + '-' + axisId;
    if (backlog.items.some((item) => item.id === id)) continue;
    backlog.items.push({
      id,
      priority: 'P1',
      source_backlog_id: 'MSG-20261003-135 CHANGE C（Layer 2 Golden Path Matrix）',
      title: 'Layer 2 Golden Path 缺口：' + domainId + ' / ' + axisId + ' 无命名证据',
      scope: '为该能力轴补真实 E2E/测试证据（HTTP·persistence·DB invariant·frontend·happy·negative·replay·concurrency·failure-recovery·cross-tenant·RBAC·amount-ledger）',
      acceptance_criteria: '存在命名证据文件且断言真实；否则该域 Layer 2 不得判完整',
      dependencies: [],
      risk_class: 'MEDIUM',
      ARCH_REVIEW_REQUIRED: false,
      HOST_ACTION_REQUIRED: false,
      HOLD_EXTERNAL: true,
      allowed_files: ['apps/api/src/__tests__/**', 'apps/web/**'],
      boundary: 'NO_EXTERNAL_CALL',
      required_tests: [domainId],
      template: 'suite-evidence',
      filters: [domainId === 'independent_site' ? 'independent-site' : domainId === 'logistics_carrier' ? 'carrier' : domainId],
      materializable: false,
    });
    added += 1;
  }
  backlog.updatedAt = new Date().toISOString();
  fs.writeFileSync(BACKLOG, JSON.stringify(backlog, null, 2) + '\n', 'utf8');
  console.log('MATERIALIZED=' + added + ' TOTAL_ITEMS=' + backlog.items.length);
}

console.log(JSON.stringify({ gaps: gaps.length, gapIds: gaps }));
