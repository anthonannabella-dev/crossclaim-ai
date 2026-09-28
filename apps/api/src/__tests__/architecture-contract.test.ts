/**
 * 架构契约测试
 * ---------------------------------------------------------------
 * 把 ARCHITECTURE_CONTRACT.md 里的硬约束变成**可执行断言**。
 * 目的：以后任何人（或任何 Agent）改坏架构，CI 立刻红。
 *
 * 这些断言直接读 apps/api/prisma/schema.prisma，不依赖数据库。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCHEMA_PATH = join(__dirname, '..', '..', 'prisma', 'schema.prisma');
const schema = readFileSync(SCHEMA_PATH, 'utf8');

/** 去掉注释后的 schema —— 用于"不得出现某关键词"这类断言，避免注释误伤 */
const schemaNoComments = schema
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

/** 取某个模型的整段定义（从 `model X {` 到匹配的 `}`） */
function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  if (start < 0) return '';
  const end = schema.indexOf('\n}', start);
  return end < 0 ? '' : schema.slice(start, end);
}

function modelNames(): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

// ============================================================
// §六：25 个核心领域模型必须存在
// ============================================================
describe('领域模型清单（章程 §六）', () => {
  const REQUIRED = [
    'Organization',
    'User',
    'Membership',
    'SourceConnection',
    'FileAsset',
    'ImportBatch',
    'SourceTransaction',
    'RecoveryOpportunity',
    'RecoveryGraphNode',
    'RecoveryGraphEdge',
    'EvidenceArtifact',
    'EvidenceEdge',
    'Case',
    'CaseOpportunity',
    'RecoveryRoute',
    'Claim',
    'Appeal',
    'RuleSet',
    'RuleVersion',
    'RuleEvaluation',
    'Settlement',
    'RecoveryLedgerEntry',
    'BillingInvoice',
    'FeeCalculation',
    'AuditLog',
  ];

  it.each(REQUIRED)('模型 %s 存在', (name) => {
    expect(modelNames()).toContain(name);
  });

  it('没有遗漏或多出的核心模型（允许额外模型，但核心 25 个必须齐全）', () => {
    for (const name of REQUIRED) {
      expect(modelBlock(name)).not.toBe('');
    }
  });
});

// ============================================================
// §七.2 / §七.3：SourceTransaction 与 RecoveryLedger 严格分离
// ============================================================
describe('原始交易与账本分离（§七.2 / §七.3）', () => {
  it('SourceTransaction 不得有任何指向 RecoveryLedgerEntry 的关系字段', () => {
    const block = modelBlock('SourceTransaction');
    expect(block).not.toMatch(/RecoveryLedgerEntry/);
  });

  it('原始账单/订单/发票不允许直接变成账本 —— 账本必须经由 Settlement 或机会', () => {
    const ledger = modelBlock('RecoveryLedgerEntry');
    // 允许携带"来源引用"字段，但必须同时具备 Settlement/Opportunity 路径
    expect(ledger).toMatch(/settlementId\s+String\?/);
    expect(ledger).toMatch(/opportunityId\s+String\?/);
  });
});

// ============================================================
// §七.4 / §七.6：Settlement 与 Billing 分开
// ============================================================
describe('到账与收费分离（§七.4 / §七.5 / §七.6）', () => {
  it('Settlement 与 BillingInvoice 是两个独立模型', () => {
    expect(modelBlock('Settlement')).not.toBe('');
    expect(modelBlock('BillingInvoice')).not.toBe('');
  });

  it('BillingInvoice 不得持有指向 Settlement 的外键（两笔钱方向相反，禁止混表）', () => {
    expect(modelBlock('BillingInvoice')).not.toMatch(/settlementId/);
  });

  it('Settlement 不得持有指向 BillingInvoice 的外键', () => {
    expect(modelBlock('Settlement')).not.toMatch(/billingInvoiceId/);
  });

  it('Settlement 表达"实际到账"，必须有 receivedAt 与状态', () => {
    const s = modelBlock('Settlement');
    expect(s).toMatch(/receivedAt\s+DateTime\?/);
    expect(s).toMatch(/status\s+SettlementStatus/);
  });
});

// ============================================================
// §七.7 / §七.8：FileAsset ≠ Evidence，且证据可服务多个 Case
// ============================================================
describe('文件与证据分离（§七.7 / §七.8）', () => {
  it('FileAsset 与 EvidenceArtifact 是两个独立模型', () => {
    expect(modelBlock('FileAsset')).not.toBe('');
    expect(modelBlock('EvidenceArtifact')).not.toBe('');
  });

  it('EvidenceArtifact 不得直接挂 caseId（否则一份证据无法服务多个案件）', () => {
    expect(modelBlock('EvidenceArtifact')).not.toMatch(/caseId\s+String/);
  });

  it('证据与案件通过 CaseEvidence 联结表关联（多对多）', () => {
    const link = modelBlock('CaseEvidence');
    expect(link).toMatch(/caseId\s+String/);
    expect(link).toMatch(/evidenceId\s+String/);
    // 复合主键 = 多对多的标志
    expect(link).toMatch(/@@id\(\[caseId,\s*evidenceId\]\)/);
  });
});

// ============================================================
// §七.9 / §七.10：图用 PG Node+Edge，不引入 Neo4j
// ============================================================
describe('图结构（§七.9 / §七.10）', () => {
  it('存在 RecoveryGraphNode 与 RecoveryGraphEdge', () => {
    expect(modelBlock('RecoveryGraphNode')).not.toBe('');
    expect(modelBlock('RecoveryGraphEdge')).not.toBe('');
  });

  it('Edge 用 from/to 节点表达关系', () => {
    const edge = modelBlock('RecoveryGraphEdge');
    expect(edge).toMatch(/fromNodeId\s+String/);
    expect(edge).toMatch(/toNodeId\s+String/);
  });

  it('不引入 Neo4j（schema 中不得出现 neo4j）', () => {
    // 只看真实定义，忽略注释（注释里会解释为什么不用 Neo4j）
    expect(schemaNoComments.toLowerCase()).not.toContain('neo4j');
  });
});

// ============================================================
// §七.11 / §七.12：金额由确定性代码决定，不由 LLM
// ============================================================
describe('金额确定性（§七.11 / §七.12）', () => {
  it('机会金额字段使用 Decimal，不用 Float', () => {
    const o = modelBlock('RecoveryOpportunity');
    expect(o).toMatch(/recoverableAmount\s+Decimal\?/);
    expect(o).toMatch(/@db\.Decimal\(18,\s*4\)/);
  });

  it('账本与结算金额均为 Decimal', () => {
    expect(modelBlock('RecoveryLedgerEntry')).toMatch(/amount\s+Decimal/);
    expect(modelBlock('Settlement')).toMatch(/amount\s+Decimal/);
  });

  it('成功费必须可复算：FeeCalculation 必须存 computation', () => {
    const fee = modelBlock('FeeCalculation');
    expect(fee).toMatch(/computation\s+Json/);
    expect(fee).toMatch(/rate\s+Decimal\?/);
  });
});

// ============================================================
// §七.16 / §七.17：规则版本与优先级
// ============================================================
describe('规则治理（§七.16 / §七.17）', () => {
  it('RuleVersion 至少含 source/version/effectiveFrom/effectiveTo/lastVerified', () => {
    const rv = modelBlock('RuleVersion');
    for (const field of [
      /source\s+String/,
      /version\s+String/,
      /effectiveFrom\s+DateTime/,
      /effectiveTo\s+DateTime\?/,
      /lastVerified\s+DateTime\?/,
    ]) {
      expect(rv).toMatch(field);
    }
  });

  it('规则优先级枚举包含 5 档（合同 > Rate Card > Tariff > 政策 > 默认）', () => {
    const tier = schema.match(/enum RuleTier\s*\{([\s\S]*?)\n\}/);
    expect(tier).not.toBeNull();
    const body = tier![1];
    expect(body).toContain('CUSTOMER_CONTRACT');
    expect(body).toContain('CUSTOMER_RATE_CARD');
    expect(body).toContain('CARRIER_TARIFF');
    expect(body).toContain('DATED_POLICY');
    expect(body).toContain('DEFAULT');
  });

  it('规则评估有幂等键，避免重复产出机会', () => {
    expect(modelBlock('RuleEvaluation')).toMatch(/dedupeKey\s+String\?/);
  });
});

// ============================================================
// §七.1：RecoveryOpportunity 是核心实体
// ============================================================
describe('核心实体（§七.1）', () => {
  it('RecoveryOpportunity 存在且被 Case 关联', () => {
    expect(modelBlock('RecoveryOpportunity')).not.toBe('');
    expect(modelBlock('CaseOpportunity')).toMatch(/opportunityId\s+String/);
  });

  it('机会可被规则评估推导（RuleEvaluation → Opportunity）', () => {
    expect(modelBlock('RuleEvaluation')).toMatch(/opportunityId\s+String\?/);
  });
});

// ============================================================
// 多租户隔离（架构契约 §五）
// ============================================================
describe('多租户隔离', () => {
  const TENANT_SCOPED = [
    'SourceConnection',
    'FileAsset',
    'ImportBatch',
    'SourceTransaction',
    'RecoveryOpportunity',
    'RecoveryGraphNode',
    'RecoveryGraphEdge',
    'EvidenceArtifact',
    'Case',
    'RecoveryRoute',
    'RuleSet',
    'Settlement',
    'RecoveryLedgerEntry',
    'BillingInvoice',
  ];

  it.each(TENANT_SCOPED)('%s 带 organizationId', (name) => {
    expect(modelBlock(name)).toMatch(/organizationId\s+String/);
  });
});

// ============================================================
// 账本只增不改（架构契约 §三.2）
// ============================================================
describe('账本只增不改', () => {
  it('RecoveryLedgerEntry 提供反向分录与作废字段，而非可修改的金额', () => {
    const l = modelBlock('RecoveryLedgerEntry');
    expect(l).toMatch(/voidsEntryId\s+String\?/);
    expect(l).toMatch(/voidedAt\s+DateTime\?/);
    expect(l).toMatch(/voidReason\s+String\?/);
    // REVERSAL 定义在枚举里，不在 model 块内
    const enumBlock = schema.match(/enum LedgerEntryType\s*\{([\s\S]*?)\n\}/);
    expect(enumBlock).not.toBeNull();
    expect(enumBlock![1]).toContain('REVERSAL');
  });
});
