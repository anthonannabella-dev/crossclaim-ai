#!/usr/bin/env node
/**
 * P2-3 Secret Rotation — 计划工具（只读；**拒绝执行真实轮换**）
 * ---------------------------------------------------------------
 * 用途：为宿主生成某一项 Secret 的轮换计划（步骤 / 重叠窗口 / 停机窗口 / 回滚 / 审计要求）。
 *
 * 安全边界（MSG-20260929-72）：
 *   - 本工具**不读取、不生成、不写入**任何 Secret 取值
 *   - 传入 --execute 一律拒绝（真实轮换 = HOST APPROVAL REQUIRED）
 *   - 只输出清单（名称）与流程，不输出任何环境变量取值
 *
 * 用法：
 *   node tools/secrets/secret-rotation-plan.mjs                # 打印全部 Secret 的计划摘要
 *   node tools/secrets/secret-rotation-plan.mjs DATABASE_URL   # 打印单项计划
 *   node tools/secrets/secret-rotation-plan.mjs --execute      # 拒绝执行（退出码 2）
 */

/** 清单（仅名称与元数据；与 apps/api/src/services/operations/secret-rotation-audit.ts 保持一致） */
export const SECRET_INVENTORY = [
  { name: 'DATABASE_URL', rotationClass: 'stop-and-start', overlapWindowMinutes: 0, impact: '数据库连接（滚动重启期间短暂不可用）' },
  { name: 'SESSION_SECRET', rotationClass: 'overlap', overlapWindowMinutes: 60, impact: '会话令牌派生（既有会话失效，需公告）' },
  { name: 'AUDIT_IP_SALT', rotationClass: 'overlap', overlapWindowMinutes: 0, impact: '审计 IP 哈希（历史哈希不重算）' },
  { name: 'STORAGE_URL_SECRET', rotationClass: 'overlap', overlapWindowMinutes: 30, impact: '签名下载令牌（窗口内旧链接仍可验证）' },
  { name: 'STRIPE_WEBHOOK_SECRET', rotationClass: 'overlap', overlapWindowMinutes: 30, impact: 'Webhook 验签（窗口内双密钥）' },
  { name: 'SOURCE_CONNECTION_CREDENTIAL_REF', rotationClass: 'reference-only', overlapWindowMinutes: 0, impact: '连接凭据引用名（真实值在外部密钥管理）' },
  { name: 'OAUTH_CLIENT_CREDENTIAL_REF', rotationClass: 'reference-only', overlapWindowMinutes: 0, impact: '未来 OAuth 凭据引用（占位）' },
];

export const ROTATION_FLOW = [
  'prepare（登记变更单：谁 / 何时 / 哪一项 Secret 名称）',
  'generate（在密钥管理中生成新值；不入仓库、不入日志）',
  'overlap-window（双值可接受；窗口 = 相关 TTL + 余量）',
  'switch（应用读取新值；滚动重启以最小化停机）',
  'verify（登录 / 导入 / 下载 / webhook 冒烟各一次）',
  'revoke-old（验证通过后再撤销旧值）',
  'audit（secret.rotated：只记名称/操作者/时间/结果/变更单号）',
];

export const ROLLBACK_FLOW = [
  'detect-invalid-new-secret（验证失败 / 错误率上升）',
  'restore-old-secret（立即回退到旧值）',
  'verify（再次冒烟）',
  'audit-failure（secret.rotated, result=ROLLED_BACK/FAILED）',
];

export function buildPlan(name) {
  const entry = SECRET_INVENTORY.find((item) => item.name === name);
  if (!entry) throw new Error('未知 Secret 名称（清单只认名字，不接受取值）: ' + name);
  return {
    secretName: entry.name,
    rotationClass: entry.rotationClass,
    overlapWindowMinutes: entry.overlapWindowMinutes,
    impact: entry.impact,
    hostApprovalRequired: true,
    flow: ROTATION_FLOW,
    rollback: ROLLBACK_FLOW,
    audit: {
      action: 'secret.rotated',
      allowedFields: ['secretName', 'actorUserId', 'timestamp', 'result', 'changeRequestId'],
      forbidden: ['secret value', 'hash', 'prefix', 'suffix', 'length', 'oldSecret', 'newSecret'],
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--execute')) {
    console.error('HOST APPROVAL REQUIRED：本工具拒绝执行真实轮换（只生成计划）。');
    console.error('请由宿主在密钥管理中执行，并回填 secret.rotated 审计记录。');
    process.exit(2);
  }
  if (args.length > 0) {
    console.log(JSON.stringify(buildPlan(args[0]), null, 2));
    return;
  }
  console.log('Secret Rotation Plan（只读；不读取任何取值）');
  for (const entry of SECRET_INVENTORY) {
    console.log(
      `  - ${entry.name} :: ${entry.rotationClass} :: overlap=${entry.overlapWindowMinutes}min :: ${entry.impact}`,
    );
  }
  console.log('\n流程：');
  for (const step of ROTATION_FLOW) console.log('  ' + step);
  console.log('\n回滚：');
  for (const step of ROLLBACK_FLOW) console.log('  ' + step);
  console.log('\n审计：action=secret.rotated（只记名称/操作者/时间/结果/变更单号）');
}

if (process.argv[1] && process.argv[1].endsWith('secret-rotation-plan.mjs')) {
  main();
}
