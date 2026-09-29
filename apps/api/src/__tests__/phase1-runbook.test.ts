// P2-4（MSG-20260929-73）— Production Validation Runbook：门槛冻结、Stage A 记账、Decision Gate、禁止自动动作

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const toolPath = path.join(__dirname, '..', '..', '..', '..', 'tools', 'validation', 'phase1-runbook.mjs');

/** 动态导入纯 ESM 工具（CommonJS 输出下不允许 top-level await） */
let tool: Record<string, unknown>;

beforeAll(async () => {
  tool = (await import(pathToFileURL(toolPath).href)) as Record<string, unknown>;
});

describe('P2-4 Validation Runbook — 冻结门槛', () => {
  it('01 门槛与枚举冻结（Candidate>=10 / human>=5 / 三个 Decision Gate / 六项禁止自动化）', () => {
    expect((tool.PHASE1_THRESHOLDS as Record<string, number>).candidateMin).toBe(10);
    expect((tool.PHASE1_THRESHOLDS as Record<string, number>).humanVerificationMin).toBe(5);
    expect((tool.DECISION_GATES as any)).toEqual(['PASS_TO_MVP', 'CONTINUE_DATA_COLLECTION', 'STOP_REWORK']);
    expect((tool.HUMAN_CLASSIFICATIONS as any)).toEqual(['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_DATA']);
    expect((tool.FORBIDDEN_AUTOMATIONS as any)).toContain('auto-submit-claim');
    expect((tool.FORBIDDEN_AUTOMATIONS as any)).toContain('auto-amount-promise');
    expect((tool.PHASE1_RESULT_SECTIONS as string[])).toHaveLength(8);
    expect((tool.PHASE1_RESULT_SECTIONS as string[]).at(-1)).toBe('Decision Gate');
  });
});

describe('P2-4 Validation Runbook — Stage A 记账（禁止 silent drop）', () => {
  it('02 input = normalized + quarantine + rejected → 通过', () => {
    const result = (tool.auditImportIntegrity as any)({
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
    const result = (tool.auditImportIntegrity as any)({
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
    const result = (tool.auditImportIntegrity as any)({ inputRows: 10, normalizedRows: 12 });
    expect(result.ok).toBe(false);
    expect(result.difference).toBe(-2);
  });

  it('05 CSV 缺必需列 → 全部行计入 rejected，不猜测、不自动修正', () => {
    const csv = 'order_id,occurred_at\nA,2026-01-01\nB,2026-01-02\n';
    const result = (tool.auditCsv as any)(csv);
    expect(result.missingColumns).toEqual(['amount', 'currency']);
    expect(result.normalizedRows).toBe(0);
    expect(result.rejectedRows).toBe(2);
    expect(result.ok).toBe(true); // 记账仍然自洽（没有 silent drop）
  });
});

describe('P2-4 Validation Runbook — Stage B/C 与 Decision Gate', () => {
  it('06 Candidate 不足 → CONTINUE_DATA_COLLECTION', () => {
    const gate = (tool.evaluateDecisionGate as any)({ candidateCount: 4, humanVerifiedCount: 0 });
    expect(gate.gate).toBe('CONTINUE_DATA_COLLECTION');
    expect(gate.reasons.join(' ')).toContain('Candidate');
  });

  it('07 Candidate 足够但人工验证不足 → CONTINUE_DATA_COLLECTION', () => {
    const gate = (tool.evaluateDecisionGate as any)({ candidateCount: 12, humanVerifiedCount: 3 });
    expect(gate.gate).toBe('CONTINUE_DATA_COLLECTION');
  });

  it('08 全部达标 → PASS_TO_MVP，且声明 Candidate ≠ Claim', () => {
    const gate = (tool.evaluateDecisionGate as any)({
      candidateCount: 12,
      humanVerifiedCount: 5,
      classifications: ['TRUE_POSITIVE', 'TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_DATA', 'TRUE_POSITIVE'],
    });
    expect(gate.gate).toBe('PASS_TO_MVP');
    expect(gate.truePositives).toBe(3);
    expect(gate.disclaimer).toContain('Candidate ≠ Claim');
  });

  it('09 未知人工分类 → STOP_REWORK（不允许臆造分类）', () => {
    const gate = (tool.evaluateDecisionGate as any)({
      candidateCount: 12,
      humanVerifiedCount: 5,
      classifications: ['MAYBE'],
    });
    expect(gate.gate).toBe('STOP_REWORK');
    expect(gate.reasons.join(' ')).toContain('MAYBE');
  });

  it('10 PHASE1-RESULT 渲染包含 8 节 + 禁止自动动作 + 真实数据待填充标记', () => {
    const markdown = (tool.renderPhase1Result as any)({
      'Candidate Findings': { candidates: 12 },
    });
    for (const section of (tool.PHASE1_RESULT_SECTIONS as string[])) {
      expect(markdown, section).toContain(`## ${section}`);
    }
    expect(markdown).toContain('WAITING_HOST_DATA');
    expect(markdown).toContain('auto-submit-claim');
    expect(markdown).toContain('PASS_TO_MVP');
    expect(markdown).not.toContain('recoveryAmount'); // 阶段一不判断商业指标
  });
});

describe('P2-4 Validation Runbook — Stage 0 入场前置检查（preflight，只读）', () => {
  const now = '2026-09-30T00:00:00.000Z';

  function csv(header: string[], rowCount: number, date = '2026-09-01T00:00:00Z') {
    const lines = [header.join(',')];
    for (let index = 1; index <= rowCount; index += 1) {
      lines.push(
        header
          .map((column) => {
            if (column === 'order_id') return `ORDER-${index}`;
            if (column === 'occurred_at') return date;
            if (column === 'amount') return '120.50';
            if (column === 'currency') return 'JPY';
            if (column === 'product_name') return 'Widget';
            if (column === 'buyer_name') return 'MASKED';
            return 'NaN';
          })
          .join(','),
      );
    }
    return lines.join('\n');
  }

  it('11 结构合规（必需列/行数/唯一 id/日期可解析）→ READY_FOR_STAGE_A', () => {
    const result = (tool.preflightDataset as any)({ text: csv(['order_id', 'occurred_at', 'amount', 'currency'], 500), now });
    expect(result.verdict).toBe('READY_FOR_STAGE_A');
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(500);
    expect(result.blockingChecks).toEqual([]);
    expect(result.nextStep).toContain('audit-input');
  });

  it('12 缺必需列 → NEEDS_FIX，缺口进 blockingChecks，且只给别名提示不做映射', () => {
    const result = (tool.preflightDataset as any)({ text: csv(['order_id', 'occurred_at'], 500), now });
    expect(result.verdict).toBe('NEEDS_FIX');
    expect(result.blockingChecks).toContain('required-columns');
    expect(
      result.checks.find((check: { name: string }) => check.name === 'required-columns').detail,
    ).toContain('amount+currency');
  });

  it('13 行数不足（< 500）→ NEEDS_FIX', () => {
    const result = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency'], 120),
      now,
    });
    expect(result.verdict).toBe('NEEDS_FIX');
    expect(result.blockingChecks).toContain('min-rows');
  });

  it('14 疑似 PII 列 → NEEDS_FIX；业务标识列（product_name）不算 PII', () => {
    const pii = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency', 'buyer_name'], 500),
      now,
    });
    expect(pii.verdict).toBe('NEEDS_FIX');
    expect(pii.blockingChecks).toContain('no-pii-columns');
    expect(pii.checks.find((check: { name: string }) => check.name === 'no-pii-columns').detail).toContain(
      'buyer_name',
    );

    const business = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency', 'product_name'], 500),
      now,
    });
    expect(business.blockingChecks).not.toContain('no-pii-columns');
  });

  it('15 重复 order_id / 日期不可解析 → NEEDS_FIX；日期窗口仅提示不阻断', () => {
    const duplicated = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency'], 500).replace('ORDER-2,', 'ORDER-1,'),
      now,
    });
    expect(duplicated.blockingChecks).toContain('unique-order-id');

    const badDates = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency'], 500, 'not-a-date'),
      now,
    });
    expect(badDates.blockingChecks).toContain('dates-parsable');

    const oldDates = (tool.preflightDataset as any)({
      text: csv(['order_id', 'occurred_at', 'amount', 'currency'], 500, '2020-01-01T00:00:00Z'),
      now,
    });
    expect(oldDates.ok).toBe(true); // 窗口偏好为非阻断项
    expect(
      oldDates.checks.find((check: { name: string }) => check.name === 'recent-window-preferred').ok,
    ).toBe(false);
  });

  it('16 空文件 → NEEDS_FIX（不抛异常）', () => {
    const result = (tool.preflightDataset as any)({ text: '\n\n', now });
    expect(result.verdict).toBe('NEEDS_FIX');
    expect(result.blockingChecks).toEqual(['non-empty']);
  });
});
describe('P2-4 Validation Runbook — Stage 0 边界用例（MSG-20260930-02 授权范围）', () => {
  const now = '2026-09-30T00:00:00.000Z';

  function build(rows: string[]) {
    return ['order_id,occurred_at,amount,currency', ...rows].join('\n');
  }

  it('17 超大 CSV（50,000 行）→ 只读检查在时限内完成且行数准确（性能边界）', () => {
    const rows: string[] = [];
    for (let index = 1; index <= 50_000; index += 1) {
      rows.push(`BULK-${index},2026-09-01T00:00:00Z,120.50,JPY`);
    }
    const startedAt = Date.now();
    const result = (tool.preflightDataset as any)({ text: build(rows), now });
    const elapsedMs = Date.now() - startedAt;
    expect(result.verdict).toBe('READY_FOR_STAGE_A');
    expect(result.rowCount).toBe(50_000);
    expect(result.blockingChecks).toEqual([]);
    expect(elapsedMs).toBeLessThan(15_000); // 只读结构检查：50k 行不应退化到分钟级
  });

  it('18 空字段（amount/currency 为空）→ 当前不阻断（Stage 0 只做结构/列名；数值语义留给 Stage A 数据质量）', () => {
    const result = (tool.preflightDataset as any)({
      text: build(['EMPTY-1,2026-09-01T00:00:00Z,,', 'EMPTY-2,2026-09-02T00:00:00Z,,']),
      now,
      minRows: 2,
    });
    // 记录当前边界：不猜测金额、不因空值自动判定为“数据可用”
    expect(result.blockingChecks).toEqual([]);
    expect(result.verdict).toBe('READY_FOR_STAGE_A');
    expect(result.checks.find((check: { name: string }) => check.name === 'required-columns').ok).toBe(true);
  });

  it('19 Decimal 精度：金额文本原样保留，Stage 0 不做任何四舍五入或运算', () => {
    const csv = build([
      'DEC-1,2026-09-01T00:00:00Z,12345678.123456,JPY',
      'DEC-2,2026-09-02T00:00:00Z,0.000001,JPY',
    ]);
    const result = (tool.preflightDataset as any)({ text: csv, now, minRows: 2 });
    expect(result.verdict).toBe('READY_FOR_STAGE_A');
    expect(csv).toContain('12345678.123456');
    expect(csv).toContain('0.000001');
    // 只读契约：preflight 不返回任何金额计算结果
    expect(Object.keys(result)).not.toContain('amount');
    expect(JSON.stringify(result)).not.toContain('12345678.123456');
  });

  it('20 多币种混排 → 结构检查不阻断（币种一致性属 Stage A/DATA-QUALITY，不由 Stage 0 猜测）', () => {
    const result = (tool.preflightDataset as any)({
      text: build([
        'CUR-1,2026-09-01T00:00:00Z,100.00,JPY',
        'CUR-2,2026-09-01T00:00:00Z,100.00,USD',
        'CUR-3,2026-09-01T00:00:00Z,100.00,EUR',
      ]),
      now,
      minRows: 3,
    });
    expect(result.verdict).toBe('READY_FOR_STAGE_A');
    expect(result.blockingChecks).toEqual([]);
  });
});


