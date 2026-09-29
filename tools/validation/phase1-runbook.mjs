#!/usr/bin/env node
/**
 * P2-4 Production Validation Runbook（MSG-20260929-73 冻结验收标准）
 * ---------------------------------------------------------------
 * 纪律：
 *   CODE READY ≠ PRODUCTION VALIDATED（真实数据仍 WAITING_HOST_DATA）
 *   Stage A：input rows = normalized + quarantine + rejected（**禁止 silent drop**；禁止自动修正未知字段/猜测金额）
 *   Stage B：Candidate >= 10；**Candidate ≠ Claim**（只是潜在线索）
 *   Stage C：human verification >= 5，分类 TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_DATA
 *   禁止：自动提交 Claim/Appeal、自动扣佣、自动收费、自动金额承诺、自动平台操作
 *   输出：IMPORT-REPORT.md / DATA-QUALITY-REPORT.md / PHASE1-RESULT.md（8 节 + Decision Gate）
 *
 * 用法：
 *   node tools/validation/phase1-runbook.mjs plan
 *   node tools/validation/phase1-runbook.mjs audit-input <dataset.csv>
 *   node tools/validation/phase1-runbook.mjs gate <candidates> <verified> [true|false|needs...]
 */
import { readFileSync } from 'node:fs';

export const PHASE1_THRESHOLDS = {
  candidateMin: 10,
  humanVerificationMin: 5,
  requiredStageAColumns: ['order_id', 'occurred_at', 'amount', 'currency'],
  /** 阶段一禁止判断商业指标 */
  forbiddenMetrics: ['recoveryAmount', 'successRate', 'ARR', 'billingCapacity'],
};

export const DECISION_GATES = ['PASS_TO_MVP', 'CONTINUE_DATA_COLLECTION', 'STOP_REWORK'];

export const HUMAN_CLASSIFICATIONS = ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_DATA'];

export const FORBIDDEN_AUTOMATIONS = [
  'auto-submit-claim',
  'auto-appeal',
  'auto-commission',
  'auto-charge',
  'auto-amount-promise',
  'auto-platform-action',
];

export const PHASE1_RESULT_SECTIONS = [
  'Dataset Summary',
  'Import Result',
  'Data Quality',
  'Candidate Findings',
  'Human Verification',
  'False Positive Analysis',
  'Missing Data',
  'Decision Gate',
];

/** Stage A：导入完整性（禁止 silent drop） */
export function auditImportIntegrity(counts) {
  const input = Number(counts.inputRows ?? 0);
  const normalized = Number(counts.normalizedRows ?? 0);
  const quarantine = Number(counts.quarantineRows ?? 0);
  const rejected = Number(counts.rejectedRows ?? 0);
  const accounted = normalized + quarantine + rejected;
  const difference = input - accounted;
  return {
    ok: difference === 0 && input >= 0,
    inputRows: input,
    normalizedRows: normalized,
    quarantineRows: quarantine,
    rejectedRows: rejected,
    difference,
    /** true = 有行既没归一化也没被隔离/拒绝（silent drop） */
    silentDropDetected: difference > 0,
    note:
      difference === 0
        ? 'input = normalized + quarantine + rejected'
        : difference > 0
          ? `存在 ${difference} 行未记账（silent drop）→ 阶段一不通过`
          : `记账数超过输入 ${-difference} 行 → 数据异常，阶段一不通过`,
  };
}

/** Stage B/C + Decision Gate */
export function evaluateDecisionGate(input) {
  const candidateCount = Number(input.candidateCount ?? 0);
  const humanVerified = Number(input.humanVerifiedCount ?? 0);
  const classifications = Array.isArray(input.classifications) ? input.classifications : [];
  const unknown = classifications.filter((item) => !HUMAN_CLASSIFICATIONS.includes(item));
  const truePositives = classifications.filter((item) => item === 'TRUE_POSITIVE').length;

  const reasons = [];
  if (candidateCount < PHASE1_THRESHOLDS.candidateMin) {
    reasons.push(`Candidate ${candidateCount} < ${PHASE1_THRESHOLDS.candidateMin}`);
  }
  if (humanVerified < PHASE1_THRESHOLDS.humanVerificationMin) {
    reasons.push(`Human verification ${humanVerified} < ${PHASE1_THRESHOLDS.humanVerificationMin}`);
  }
  if (unknown.length > 0) {
    reasons.push(`未知人工分类: ${unknown.join(', ')}`);
  }

  let gate;
  if (unknown.length > 0) {
    gate = 'STOP_REWORK';
  } else if (candidateCount < PHASE1_THRESHOLDS.candidateMin) {
    gate = 'CONTINUE_DATA_COLLECTION';
  } else if (humanVerified < PHASE1_THRESHOLDS.humanVerificationMin) {
    gate = 'CONTINUE_DATA_COLLECTION';
  } else {
    gate = 'PASS_TO_MVP';
  }

  return {
    gate,
    reasons,
    candidateCount,
    humanVerifiedCount: humanVerified,
    truePositives,
    disclaimer: 'Candidate ≠ Claim：候选仅为潜在线索，不代表已确认可追回金额或已主张',
  };
}

/** 读取 CSV（最小结构检查；不猜金额、不自动修正字段） */
export function auditCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return auditImportIntegrity({ inputRows: 0 });
  const header = lines[0].split(',').map((cell) => cell.trim());
  const missing = PHASE1_THRESHOLDS.requiredStageAColumns.filter((column) => !header.includes(column));
  const dataRows = lines.slice(1);
  const rejected = dataRows.filter((row) => row.split(',').length !== header.length).length;
  const normalized = dataRows.length - rejected;
  return {
    header,
    missingColumns: missing,
    ...auditImportIntegrity({
      inputRows: dataRows.length,
      normalizedRows: missing.length === 0 ? normalized : 0,
      quarantineRows: 0,
      rejectedRows: missing.length === 0 ? rejected : dataRows.length,
    }),
  };
}

/** 渲染 PHASE1-RESULT.md（8 节 + Decision Gate） */
export function renderPhase1Result(payload) {
  const gate = evaluateDecisionGate(payload);
  const lines = ['# PHASE1-RESULT', ''];
  for (const section of PHASE1_RESULT_SECTIONS) {
    lines.push(`## ${section}`, '');
    const value = payload?.[section];
    if (section === 'Decision Gate') {
      lines.push(`- Gate: **${gate.gate}**（仅允许 ${DECISION_GATES.join(' / ')}）`);
      lines.push(`- Candidate: ${gate.candidateCount}（阈值 >= ${PHASE1_THRESHOLDS.candidateMin}）`);
      lines.push(`- Human verification: ${gate.humanVerifiedCount}（阈值 >= ${PHASE1_THRESHOLDS.humanVerificationMin}）`);
      if (gate.reasons.length > 0) lines.push(`- Reasons: ${gate.reasons.join('; ')}`);
      lines.push(`- 说明：${gate.disclaimer}`);
    } else if (value === undefined || value === null) {
      lines.push('_（待填充：真实数据 WAITING_HOST_DATA）_');
    } else if (typeof value === 'string') {
      lines.push(value);
    } else {
      lines.push('```json');
      lines.push(JSON.stringify(value, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('## 禁止事项（阶段一）', '');
  for (const item of FORBIDDEN_AUTOMATIONS) lines.push(`- ❌ ${item}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'plan') {
    console.log('P2-4 Production Validation Runbook（CODE READY ≠ PRODUCTION VALIDATED）');
    console.log(`Stage A：input = normalized + quarantine + rejected（阈值：禁止 silent drop）`);
    console.log(`Stage B：Candidate >= ${PHASE1_THRESHOLDS.candidateMin}（Candidate ≠ Claim）`);
    console.log(`Stage C：human verification >= ${PHASE1_THRESHOLDS.humanVerificationMin}（${HUMAN_CLASSIFICATIONS.join(' / ')}）`);
    console.log(`Decision Gate：${DECISION_GATES.join(' / ')}`);
    console.log(`输出：IMPORT-REPORT.md / DATA-QUALITY-REPORT.md / PHASE1-RESULT.md`);
    console.log(`禁止：${FORBIDDEN_AUTOMATIONS.join(', ')}`);
    console.log('真实数据：WAITING_HOST_DATA（不得使用真实客户数据做测试）');
    return;
  }
  if (command === 'audit-input') {
    const file = args[0];
    if (!file) {
      console.error('用法：audit-input <dataset.csv>');
      process.exit(2);
    }
    console.log(JSON.stringify(auditCsv(readFileSync(file, 'utf8')), null, 2));
    return;
  }
  if (command === 'gate') {
    const [candidates, verified, ...classifications] = args;
    console.log(
      JSON.stringify(
        evaluateDecisionGate({
          candidateCount: Number(candidates ?? 0),
          humanVerifiedCount: Number(verified ?? 0),
          classifications,
        }),
        null,
        2,
      ),
    );
    return;
  }
  console.error('未知命令（支持：plan / audit-input / gate）');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('phase1-runbook.mjs')) {
  main();
}
