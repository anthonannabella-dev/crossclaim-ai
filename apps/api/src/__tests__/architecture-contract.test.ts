/**
 * 架构契约测试（schema 级）
 * ---------------------------------------------------------------
 * 把 ARCHITECTURE_CONTRACT.md 的硬约束变成**可执行断言**。
 * 只读 schema.prisma 与 migration SQL，不需要数据库。
 *
 * 数据库级行为（跨租户失败等）见 tenant-isolation.test.ts。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(API_ROOT, 'prisma', 'schema.prisma');
const MIGRATIONS_DIR = join(API_ROOT, 'prisma', 'migrations');
const TRIGGER_MIGRATION = join(
  API_ROOT,
  'prisma',
  'migrations',
  '20260928060000_tenant_integrity',
  'migration.sql',
);

/** 所有迁移 SQL 的拼接 —— 约束与触发器可能分布在多个迁移文件里 */
const ALL_MIGRATIONS_SQL = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(MIGRATIONS_DIR, entry.name, 'migration.sql'))
  .filter((file) => existsSync(file))
  .sort()
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

const schema = readFileSync(SCHEMA_PATH, 'utf8');

/** 去掉注释后的 schema —— 用于"不得出现某关键词"这类断言 */
const schemaNoComments = schema
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  if (start < 0) return '';
  const end = schema.indexOf('\n}', start);
  return end < 0 ? '' : schema.slice(start, end);
}

function modelNames(): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

function enumBlock(name: string): string {
  const m = schema.match(new RegExp(`enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : '';
}

// ============================================================
// CHANGE #1：模型数量必须与文档一致（25 core + 1 join = 26）
// ============================================================
describe('模型清单一致性（C-0002 CHANGE #1）', () => {
  const CORE = [
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
  const JOIN_MODELS = ['CaseEvidence'];

  it(`核心模型恰好 ${CORE.length} 个`, () => {
    expect(CORE).toHaveLength(25);
    for (const name of CORE) expect(modelBlock(name), `缺少核心模型 ${name}`).not.toBe('');
  });

  it(`联结模型 ${JOIN_MODELS.length} 个`, () => {
    for (const name of JOIN_MODELS) expect(modelBlock(name), `缺少联结模型 ${name}`).not.toBe('');
  });

  it('模型总数为 26（25 core + 1 join）—— 与 README/DOMAIN_MODEL 表述一致', () => {
    expect(modelNames()).toHaveLength(26);
  });
});

// ============================================================
// CHANGE #2：tenant-owned 模型必须显式带 organizationId
// ============================================================
describe('租户归属（C-0002 CHANGE #2）', () => {
  const TENANT_OWNED = [
    'SourceConnection',
    'FileAsset',
    'ImportBatch',
    'SourceTransaction',
    'RecoveryOpportunity',
    'RecoveryGraphNode',
    'RecoveryGraphEdge',
    'EvidenceArtifact',
    'EvidenceEdge', // 本次补强
    'CaseEvidence', // 本次补强
    'Case',
    'CaseOpportunity', // 本次补强
    'RecoveryRoute',
    'Claim', // 本次补强
    'Appeal', // 本次补强
    'RuleVersion', // 本次补强（可空：全局规则）
    'RuleEvaluation', // 本次补强
    'Settlement',
    'RecoveryLedgerEntry',
    'BillingInvoice',
    'FeeCalculation', // 本次补强
  ];

  it.each(TENANT_OWNED)('%s 带 organizationId', (name) => {
    expect(modelBlock(name)).toMatch(/organizationId\s+String/);
  });

  it.each(TENANT_OWNED)('%s 带 @@unique([organizationId, id])（复合键基础）', (name) => {
    const block = modelBlock(name);
    if (name === 'CaseEvidence' || name === 'CaseOpportunity') {
      // 联结表用复合主键，不另建唯一键
      expect(block).toMatch(/@@id\(\[/);
      return;
    }
    expect(block).toMatch(/@@unique\(\[organizationId,\s*id\]\)/);
  });

  it('RuleSet 支持全局规则（organizationId 可空 + ownerType/ownerKey）', () => {
    const rs = modelBlock('RuleSet');
    expect(rs).toMatch(/organizationId\s+String\?/);
    expect(rs).toMatch(/ownerType\s+RuleOwnerType/);
    expect(rs).toMatch(/ownerKey\s+String/);
    expect(enumBlock('RuleOwnerType')).toContain('SYSTEM');
    expect(enumBlock('RuleOwnerType')).toContain('TENANT');
  });

  it('全局规则唯一性不依赖 NULL（用 ownerKey 归一化）', () => {
    expect(modelBlock('RuleSet')).toMatch(/@@unique\(\[ownerKey,\s*channel,\s*scope,\s*name\]\)/);
  });
});

// ============================================================
// CHANGE #3：租户完整性的数据库级约束必须存在
// ============================================================
describe('租户完整性数据库约束（C-0002 CHANGE #3）', () => {
  const migration = existsSync(TRIGGER_MIGRATION) ? readFileSync(TRIGGER_MIGRATION, 'utf8') : '';

  it('触发器迁移文件存在', () => {
    expect(existsSync(TRIGGER_MIGRATION)).toBe(true);
  });

  it('定义了通用校验函数', () => {
    expect(migration).toContain('crossclaim_assert_tenant_integrity');
    expect(migration).toMatch(/RAISE EXCEPTION/);
  });

  // 每个"有跨表引用"的 tenant-owned 表都必须挂触发器
  const TRIGGERED = [
    'FileAsset',
    'ImportBatch',
    'SourceTransaction',
    'RecoveryGraphEdge',
    'EvidenceArtifact',
    'EvidenceEdge',
    'CaseEvidence',
    'CaseOpportunity',
    'RecoveryRoute',
    'Claim',
    'Appeal',
    'RuleVersion',
    'RuleEvaluation',
    'Settlement',
    'RecoveryLedgerEntry',
    'FeeCalculation',
    // C-0002 第二次复审 CHANGE #13
    'BillingInvoice',
  ];

  it.each(TRIGGERED)('%s 挂了租户校验触发器', (table) => {
    expect(ALL_MIGRATIONS_SQL).toContain(`ON "${table}"`);
  });

  it('触发器覆盖图、案件-证据、规则评估、费用计算这几条关键链路', () => {
    expect(ALL_MIGRATIONS_SQL).toMatch(/'fromNodeId', 'RecoveryGraphNode'/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/'evidenceId', 'EvidenceArtifact'/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/'opportunityId', 'RecoveryOpportunity'/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/'settlementId', 'Settlement'/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/'billingInvoiceId', 'BillingInvoice'/);
  });
});

// ============================================================
// C-0002 第二次复审 CHANGE #13 / #14：两处数据库级漏洞的修复必须存在
// ============================================================
describe('租户完整性修复（C-0002 第二次复审 CHANGE #13 / #14）', () => {
  it('CHANGE #13：BillingInvoice 挂上租户校验触发器（caseId → Case）', () => {
    expect(ALL_MIGRATIONS_SQL).toMatch(/CREATE TRIGGER cc_tenant_BillingInvoice/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/ON "BillingInvoice"[\s\S]{0,200}'caseId', 'Case'/);
  });

  it('CHANGE #14：RuleSet 的所有权组合受数据库约束', () => {
    expect(ALL_MIGRATIONS_SQL).toContain('cc_ruleset_ownership_check');
    expect(ALL_MIGRATIONS_SQL).toMatch(/"ownerType" = 'SYSTEM'[\s\S]{0,140}"organizationId" IS NULL/);
    expect(ALL_MIGRATIONS_SQL).toMatch(/"ownerType" = 'TENANT'[\s\S]{0,200}"organizationId"::text/);
  });

  it('CHANGE #14：RuleVersion 与所属 RuleSet 的租户归属必须一致', () => {
    expect(ALL_MIGRATIONS_SQL).toContain('crossclaim_assert_ruleversion_ownership');
    expect(ALL_MIGRATIONS_SQL).toMatch(
      /CREATE TRIGGER cc_ruleversion_ownership[\s\S]{0,160}ON "RuleVersion"/,
    );
  });
});

// ============================================================
// CHANGE #4/#5：费用与到账的关系必须完整、不得悬空
// ============================================================
describe('费用与到账关系（C-0002 CHANGE #4 / #5）', () => {
  it('FeeCalculation 有到 Settlement / Case / BillingInvoice 的真实关系', () => {
    const fc = modelBlock('FeeCalculation');
    expect(fc).toMatch(/billingInvoice\s+BillingInvoice\?\s+@relation/);
    expect(fc).toMatch(/settlement\s+Settlement\?\s+@relation/);
    expect(fc).toMatch(/case\s+Case\?\s+@relation/);
  });

  it('Settlement.evidenceId 有真实关系到 EvidenceArtifact（不悬空）', () => {
    const s = modelBlock('Settlement');
    expect(s).toMatch(/evidenceId\s+String\?/);
    expect(s).toMatch(/evidence\s+EvidenceArtifact\?\s+@relation/);
  });

  it('可追溯链 Settlement → FeeCalculation → BillingInvoice 在 schema 里成立', () => {
    expect(modelBlock('Settlement')).toMatch(/feeCalculations\s+FeeCalculation\[\]/);
    expect(modelBlock('BillingInvoice')).toMatch(/fees\s+FeeCalculation\[\]/);
  });
});

// ============================================================
// CHANGE #6：SourceTransaction 幂等
// ============================================================
describe('原始交易幂等（C-0002 CHANGE #6）', () => {
  it('SourceTransaction 有稳定 dedupeKey 且按租户唯一', () => {
    const st = modelBlock('SourceTransaction');
    expect(st).toMatch(/dedupeKey\s+String/);
    expect(st).toMatch(/@@unique\(\[organizationId,\s*dedupeKey\]\)/);
  });

  it('RuleEvaluation 也有幂等键', () => {
    expect(modelBlock('RuleEvaluation')).toMatch(/dedupeKey\s+String\?/);
  });
});

// ============================================================
// CHANGE #7：三大域从第一版就可表达
// ============================================================
describe('域可表达性（C-0002 CHANGE #7）', () => {
  it('Channel 含 INSURANCE', () => {
    expect(enumBlock('Channel')).toContain('INSURANCE');
  });

  it('RouteTarget 含 INSURER 与 CUSTOMS_AUTHORITY', () => {
    const rt = enumBlock('RouteTarget');
    expect(rt).toContain('INSURER');
    expect(rt).toContain('CUSTOMS_AUTHORITY');
  });

  it('SettlementSource 含 INSURER_PAYOUT', () => {
    expect(enumBlock('SettlementSource')).toContain('INSURER_PAYOUT');
  });
});

// ============================================================
// CHANGE #10：图节点多态引用有唯一约束
// ============================================================
describe('图节点约束（C-0002 CHANGE #10）', () => {
  it('RecoveryGraphNode 有 @@unique([organizationId, nodeType, refId])', () => {
    expect(modelBlock('RecoveryGraphNode')).toMatch(
      /@@unique\(\[organizationId,\s*nodeType,\s*refId\]\)/,
    );
  });
});

// ============================================================
// 原有硬约束（保留）
// ============================================================
describe('原始交易与账本分离（§七.2 / §七.3）', () => {
  it('SourceTransaction 不得有任何指向 RecoveryLedgerEntry 的关系字段', () => {
    expect(modelBlock('SourceTransaction')).not.toMatch(/RecoveryLedgerEntry/);
  });
});

describe('到账与收费分离（§七.4 / §七.6）', () => {
  it('BillingInvoice 不得持有指向 Settlement 的外键', () => {
    expect(modelBlock('BillingInvoice')).not.toMatch(/settlementId/);
  });

  it('Settlement 不得持有指向 BillingInvoice 的外键', () => {
    expect(modelBlock('Settlement')).not.toMatch(/billingInvoiceId/);
  });
});

describe('文件与证据分离（§七.7 / §七.8）', () => {
  it('EvidenceArtifact 不得直接挂 caseId（否则一证据无法服务多案）', () => {
    expect(modelBlock('EvidenceArtifact')).not.toMatch(/caseId\s+String/);
  });

  it('CaseEvidence 是多对多联结表（复合主键）', () => {
    expect(modelBlock('CaseEvidence')).toMatch(/@@id\(\[caseId,\s*evidenceId\]\)/);
  });
});

describe('图结构（§七.9 / §七.10）', () => {
  it('不引入 Neo4j（忽略注释）', () => {
    expect(schemaNoComments.toLowerCase()).not.toContain('neo4j');
  });
});

describe('金额确定性（§七.11 / §七.12）', () => {
  it('金额字段使用 Decimal(18,4)', () => {
    expect(modelBlock('RecoveryOpportunity')).toMatch(/@db\.Decimal\(18,\s*4\)/);
    expect(modelBlock('RecoveryLedgerEntry')).toMatch(/amount\s+Decimal/);
    expect(modelBlock('FeeCalculation')).toMatch(/computation\s+Json/);
  });
});

describe('规则治理（§七.16 / §七.17）', () => {
  it('RuleVersion 至少含 source/version/effectiveFrom/effectiveTo/lastVerified', () => {
    const rv = modelBlock('RuleVersion');
    for (const f of [
      /source\s+String/,
      /version\s+String/,
      /effectiveFrom\s+DateTime/,
      /effectiveTo\s+DateTime\?/,
      /lastVerified\s+DateTime\?/,
    ]) {
      expect(rv).toMatch(f);
    }
  });

  it('RuleTier 五档优先级', () => {
    const tier = enumBlock('RuleTier');
    for (const t of ['CUSTOMER_CONTRACT', 'CUSTOMER_RATE_CARD', 'CARRIER_TARIFF', 'DATED_POLICY', 'DEFAULT']) {
      expect(tier).toContain(t);
    }
  });
});

describe('账本只增不改', () => {
  it('提供反向分录与作废字段', () => {
    const l = modelBlock('RecoveryLedgerEntry');
    expect(l).toMatch(/voidsEntryId\s+String\?/);
    expect(l).toMatch(/voidedAt\s+DateTime\?/);
    expect(l).toMatch(/voidReason\s+String\?/);
    expect(enumBlock('LedgerEntryType')).toContain('REVERSAL');
  });
});
