/**
 * Wave 2 · C-0004 Checkpoint 1（Detection Spine）单元测试
 * ---------------------------------------------------------------
 * 覆盖：FREIGHT_RATE_V1 公式确定性、金额十进制（无浮点污染）、规则优先级、
 *       定义解析失败路径、定义哈希可追溯，以及与 fixture 预期结果的逐行一致性。
 * 数据库级链路见 detection-db.test.ts。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RuleDataError,
  RuleDefinitionError,
  definitionHash,
  evaluateFreightRate,
  parseFreightRateDefinition,
  selectRuleVersion,
  type FreightRateDefinition,
  type RuleCandidate,
} from '../services/rules';

const fixturesDir = path.join(__dirname, '..', '..', 'fixtures', 'logistics');
const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as Record<string, never>;

interface RuleSeedVersion {
  tier: string;
  version: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  definition: unknown;
}
interface RuleSeedSet {
  versions: RuleSeedVersion[];
}

const rules = readJson('rules.json') as unknown as { ruleSets: RuleSeedSet[] };
const expected = readJson('expected-results.json') as unknown as {
  rows: Array<{
    invoiceExternalId: string;
    trackingExternalId: string;
    lane: string;
    service: string;
    weightKg: string;
    expectedCharge: string;
    actualCharge: string;
    recoverableAmount: string;
    ruleTier: string;
    result: string;
  }>;
};

const seedVersion = (tier: string, lane: string, service: string): RuleSeedVersion => {
  for (const set of rules.ruleSets) {
    for (const version of set.versions) {
      const def = version.definition as FreightRateDefinition;
      if (version.tier === tier && def.match.lane === lane && def.match.service === service) {
        return version;
      }
    }
  }
  throw new Error(`fixture 里找不到规则: ${tier} ${lane} ${service}`);
};

describe('FREIGHT_RATE_V1 公式确定性', () => {
  it('按 fixture 预期逐行计算：expected / recoverable / result 全部一致', () => {
    for (const row of expected.rows) {
      const seed = seedVersion(row.ruleTier, row.lane, row.service);
      const definition = parseFreightRateDefinition(seed.definition);
      const result = evaluateFreightRate({
        definition,
        weightKg: row.weightKg,
        actualCharge: row.actualCharge,
      });

      expect(result.expected).toBe(row.expectedCharge);
      expect(result.recoverable).toBe(row.recoverableAmount);
      expect(result.recoverable === '0.0000' ? 'PASS' : 'OPPORTUNITY').toBe(row.result);
      // 中间值全部保留 4 位小数，便于独立复算
      expect(result.intermediate.expectedAmount).toBe(row.expectedCharge);
      expect(result.rounding).toEqual({ scale: 4, mode: 'HALF_UP' });
    }
  });

  it('金额不出现浮点污染：12.5kg × 3.2/kg + 80 base + 12.5% fuel = 135.0000', () => {
    const definition = parseFreightRateDefinition(
      seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-LAX', 'Ground').definition,
    );
    const result = evaluateFreightRate({
      definition,
      weightKg: '12.5',
      actualCharge: '135.0000',
    });
    expect(result.expected).toBe('135.0000');
    expect(result.intermediate.weightCharge).toBe('40.0000');
    expect(result.intermediate.preFuel).toBe('120.0000');
    expect(result.intermediate.fuelAmount).toBe('15.0000');
    expect(result.recoverable).toBe('0.0000');
  });

  it('实际收费低于应收时不产生可追回金额（不为负）', () => {
    const definition = parseFreightRateDefinition(
      seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-ORD', 'Ground').definition,
    );
    const result = evaluateFreightRate({ definition, weightKg: '8', actualCharge: '54.20' });
    expect(result.expected).toBe('130.1760');
    expect(result.recoverable).toBe('0.0000');
  });
});

describe('规则优先级（ARCHITECTURE_CONTRACT 不变量）', () => {
  const toCandidate = (seed: RuleSeedVersion, id: string): RuleCandidate => ({
    ruleVersionId: id,
    tier: seed.tier as RuleCandidate['tier'],
    version: seed.version,
    effectiveFrom: new Date(seed.effectiveFrom),
    effectiveTo: seed.effectiveTo ? new Date(seed.effectiveTo) : null,
    isActive: true,
    definition: parseFreightRateDefinition(seed.definition),
  });

  it('CUSTOMER_RATE_CARD 胜过 CARRIER_TARIFF（同 lane/service）', () => {
    const customer = toCandidate(seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-LAX', 'Ground'), 'v-customer');
    const carrier = toCandidate(seedVersion('CARRIER_TARIFF', 'CN-SHA>US-LAX', 'Ground'), 'v-carrier');
    const at = new Date('2026-09-01T00:00:00Z');

    const picked = selectRuleVersion([carrier, customer], at);
    expect(picked?.ruleVersionId).toBe('v-customer');
    expect(picked?.tier).toBe('CUSTOMER_RATE_CARD');

    // 若错误地选中承运商费率，INV-1001 会被误判为 PASS —— 这就是优先级必须生效的原因
    const inv1001 = expected.rows.find((row) => row.invoiceExternalId === 'INV-1001')!;
    const withTariff = evaluateFreightRate({
      definition: carrier.definition,
      weightKg: inv1001.weightKg,
      actualCharge: inv1001.actualCharge,
    });
    expect(withTariff.expected).toBe('158.2000');
    expect(withTariff.recoverable).toBe('0.0000');
  });

  it('生效日期与停用状态被正确遵守', () => {
    const base = toCandidate(seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-LAX', 'Ground'), 'v1');
    const future: RuleCandidate = { ...base, ruleVersionId: 'v-future', effectiveFrom: new Date('2027-01-01T00:00:00Z') };
    const inactive: RuleCandidate = { ...base, ruleVersionId: 'v-inactive', isActive: false };
    const expired: RuleCandidate = { ...base, ruleVersionId: 'v-expired', effectiveTo: new Date('2026-02-01T00:00:00Z') };

    const picked = selectRuleVersion([future, inactive, expired, base], new Date('2026-09-01T00:00:00Z'));
    expect(picked?.ruleVersionId).toBe('v1');
    expect(selectRuleVersion([inactive], new Date('2026-09-01T00:00:00Z'))).toBeNull();
  });
});

describe('规则定义解析（不猜、错误即抛）', () => {
  it('非对象 / 错误 kind / 缺少 pricing / scale 越界 一律抛 RuleDefinitionError', () => {
    expect(() => parseFreightRateDefinition(null)).toThrow(RuleDefinitionError);
    expect(() => parseFreightRateDefinition({ schemaVersion: 1, kind: 'SLA_V1' })).toThrow(/不支持的规则类型/);
    expect(() =>
      parseFreightRateDefinition({
        schemaVersion: 1,
        kind: 'FREIGHT_RATE_V1',
        match: { lane: 'A', service: 'Ground' },
        pricing: { baseRate: '1' },
      }),
    ).toThrow(/缺少 baseRate/);
    expect(() =>
      parseFreightRateDefinition({
        schemaVersion: 1,
        kind: 'FREIGHT_RATE_V1',
        match: { lane: 'A', service: 'Ground' },
        pricing: { baseRate: '1', perKg: '1', fuelPct: '1' },
        rounding: { scale: 9 },
      }),
    ).toThrow(/rounding.scale/);
  });

  it('非法重量 / 非法金额抛 RuleDataError', () => {
    const definition = parseFreightRateDefinition(
      seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-LAX', 'Ground').definition,
    );
    expect(() => evaluateFreightRate({ definition, weightKg: 'abc', actualCharge: '1' })).toThrow(RuleDataError);
    expect(() => evaluateFreightRate({ definition, weightKg: '-1', actualCharge: '1' })).toThrow(/不能为负/);
  });
});

describe('定义哈希（可追溯）', () => {
  it('同一定义哈希稳定，改价格即变', () => {
    const definition = parseFreightRateDefinition(
      seedVersion('CUSTOMER_RATE_CARD', 'CN-SHA>US-LAX', 'Ground').definition,
    );
    const same = parseFreightRateDefinition(JSON.parse(JSON.stringify(definition)));
    const changed: FreightRateDefinition = {
      ...definition,
      pricing: { ...definition.pricing, baseRate: '81.0000' },
    };

    expect(definitionHash(definition)).toBe(definitionHash(same));
    expect(definitionHash(definition)).not.toBe(definitionHash(changed));
    expect(definitionHash(definition)).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });
});
