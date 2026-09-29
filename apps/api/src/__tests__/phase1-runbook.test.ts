// P2-4（MSG-20260929-73）— Production Validation Runbook：门槛冻结、Stage A 记账、Decision Gate、禁止自动动作

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const toolPath = path.join(__dirname, '..', '..', '..', '..', 'tools', 'validation', 'phase1-runbook.mjs');
const tool = await import(pathToFileURL(toolPath).href);

describe('P2-4 Validation Runbook — 冻结门槛', () => {
  it('01 门槛与枚举冻结（Candidate>=10 / human>=5 / 三个 Decision Gate / 六项禁止自动化）', () => {
    expect(tool.PHASE1_THRESHOLDS.candidateMin).toBe(10);
    expect(tool.PHASE1_THRESHOLDS.humanVerificationMin).toBe(5);
    expect(tool.DECISION_GATES).toEqual(['PASS_TO_MVP', 'CONTINUE_DATA_COLLECTION', 'STOP_REWORK']);
    expect(tool.HUMAN_CLASSIFICATIONS).toEqual(['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_DATA']);
    expect(tool.FORBIDDEN_AUTOMATIONS).toContain('auto-submit-claim');
    expect(tool.FORBIDDEN_AUTOMATIONS).toContain('auto-amount-promise');
    expect(tool.PHASE1_RESULT_SECTIONS).toHaveLength(8);
    expect(tool.PHASE1_RESULT_SECTIONS.at(-1)).toBe('Decision Gate');
  });
});

describe('P2-4 Validation Runbook — Stage A 记账（禁止 silent drop）', () => {
  it('02 input = normalized + quarantine + rejected → 通过', () => {
    const result = tool.auditImportIntegrity({
      inputRows: 500,
      normalizedRows: 480,
      quarantineRows: 15,
      rejectedRows: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.silentDropDetected).toBe(false);
    expect(result.difference).toBe(0);
  });

  it('03 少记 7 行 → silentDropDetected=true 且不通过', () => {
    const result = tool.auditImportIntegrity({
      inputRows: 500,
      normalizedRows: 480,
      quarantineRows: 10,
      rejectedRows: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.silentDropDetected).toBe(true);
    expect(result.difference).toBe(7);
    expect(result.note).toContain('silent drop');
  });

  it('04 记账数超过输入 → 判为异常（不通过）', () => {
    const result = tool.auditImportIntegrity({ inputRows: 10, normalizedRows: 12 });
    expect(result.ok).toBe(false);
    expect(result.difference).toBe(-2);
  });

  it('05 CSV 缺必需列 → 全部行计入 rejected，不猜测、不自动修正', () => {
    const csv = 'order_id,occurred_at\nA,2026-01-01\nB,2026-01-02\n';
    const result = tool.auditCsv(csv);
    expect(result.missingColumns).toEqual(['amount', 'currency']);
    expect(result.normalizedRows).toBe(0);
    expect(result.rejectedRows).toBe(2);
    expect(result.ok).toBe(true); // 记账仍然自洽（没有 silent drop）
  });
});

describe('P2-4 Validation Runbook — Stage B/C 与 Decision Gate', () => {
  it('06 Candidate 不足 → CONTINUE_DATA_COLLECTION', () => {
    const gate = tool.evaluateDecisionGate({ candidateCount: 4, humanVerifiedCount: 0 });
    expect(gate.gate).toBe('CONTINUE_DATA_COLLECTION');
    expect(gate.reasons.join(' ')).toContain('Candidate');
  });

  it('07 Candidate 足够但人工验证不足 → CONTINUE_DATA_COLLECTION', () => {
    const gate = tool.evaluateDecisionGate({ candidateCount: 12, humanVerifiedCount: 3 });
    expect(gate.gate).toBe('CONTINUE_DATA_COLLECTION');
  });

  it('08 全部达标 → PASS_TO_MVP，且声明 Candidate ≠ Claim', () => {
    const gate = tool.evaluateDecisionGate({
      candidateCount: 12,
      humanVerifiedCount: 5,
      classifications: ['TRUE_POSITIVE', 'TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_DATA', 'TRUE_POSITIVE'],
    });
    expect(gate.gate).toBe('PASS_TO_MVP');
    expect(gate.truePositives).toBe(3);
    expect(gate.disclaimer).toContain('Candidate ≠ Claim');
  });

  it('09 未知人工分类 → STOP_REWORK（不允许臆造分类）', () => {
    const gate = tool.evaluateDecisionGate({
      candidateCount: 12,
      humanVerifiedCount: 5,
      classifications: ['MAYBE'],
    });
    expect(gate.gate).toBe('STOP_REWORK');
    expect(gate.reasons.join(' ')).toContain('MAYBE');
  });

  it('10 PHASE1-RESULT 渲染包含 8 节 + 禁止自动动作 + 真实数据待填充标记', () => {
    const markdown = tool.renderPhase1Result({
      'Candidate Findings': { candidates: 12 },
    });
    for (const section of tool.PHASE1_RESULT_SECTIONS) {
      expect(markdown, section).toContain(`## ${section}`);
    }
    expect(markdown).toContain('WAITING_HOST_DATA');
    expect(markdown).toContain('auto-submit-claim');
    expect(markdown).toContain('PASS_TO_MVP');
    expect(markdown).not.toContain('recoveryAmount'); // 阶段一不判断商业指标
  });
});
