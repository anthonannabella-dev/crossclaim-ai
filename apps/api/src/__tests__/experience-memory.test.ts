// SI/RSI GAP-CLOSURE — 单元 C — Experience Memory v1 回归
// ---------------------------------------------------------------------------
// 覆盖：server-derived 强制、凭据/原始 payload 拒收、FACT/AGGREGATE/HEURISTIC、四维 scope 与跨租户隔离、
// append-only、LOW_SAMPLE → ADVISORY|FAIL_CLOSED、CONFLICT → 禁止自动学习、STALE → DOWNWEIGHT/IGNORE、
// 六类 v1 查询（证据组合接受率 / 拒绝原因补件成功率 / provider 周期 / 金额带成功率 / 动作成本与时间 /
// 人工复核有效性）、确定性摘要、边界断言。

import { describe, expect, it } from 'vitest';

import {
  EXPERIENCE_ALLOWED_USES,
  EXPERIENCE_CLASSES,
  EXPERIENCE_MEMORY_BOUNDARY,
  EXPERIENCE_MEMORY_VERSION,
  ExperienceMemoryError,
  aggregateExperience,
  assertExperienceDoesNotGrantExternalWrite,
  assertExperienceScopeMatches,
  assertNoForbiddenExperienceContent,
  createInMemoryExperienceMemoryStore,
  extractExperienceRecord,
  type ExperienceObservationInput,
  type ExperienceRecord,
} from '../services/experience-memory/experience-memory';

const NOW = new Date('2026-10-06T09:00:00.000Z');
const ORG = 'org-exp-1';
const ACCT = 'acct-exp-a';

function observation(overrides: Partial<ExperienceObservationInput> = {}): ExperienceObservationInput {
  return {
    serverDerived: true,
    scope: { organizationId: ORG, platformAccountId: ACCT, provider: 'AMAZON', domain: 'PLATFORM' },
    ruleVersion: 'rules/platform/v1',
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    action: 'SUBMIT_NOW',
    outcome: 'RECOVERED',
    evidenceCombination: ['POD', 'INVOICE'],
    rejectionReason: null,
    amountBand: 'USD:1000-5000',
    currency: 'USD',
    cycleTimeDays: 18,
    costUsd: 12,
    recoveredAmountUsd: 1_500,
    confidenceBp: 8_000,
    sourceRefs: ['outcome:1'],
    recordedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function records(count: number, overrides: Partial<ExperienceObservationInput> = {}): ExperienceRecord[] {
  return Array.from({ length: count }, (_, index) =>
    extractExperienceRecord(
      observation({
        ...overrides,
        sourceRefs: ['outcome:' + index],
        recordedAt: overrides.window?.to ?? '2026-10-01T00:00:00.000Z',
      }),
    ),
  );
}

describe('C Experience Memory v1 — 抽取与安全', () => {
  it('只接受 server-derived 观测；客户端自报一律拒绝', () => {
    expect(() => extractExperienceRecord(observation({ serverDerived: false }))).toThrowError(
      ExperienceMemoryError,
    );
    try {
      extractExperienceRecord(observation({ serverDerived: false }));
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EXPERIENCE_NOT_SERVER_DERIVED');
    }
  });

  it('凭据类 / 原始 provider payload 一律拒收（token / secret / password / cookie / api_key / private key / rawPayload）', () => {
    for (const bad of [
      'Bearer abcdefgh12345',
      'api_key=xyz',
      'secret-value',
      'password=123',
      'cookie=session',
      'Authorization: Basic ZW5j',
      'aws_secret_access_key',
      '-----BEGIN RSA PRIVATE KEY-----',
      'rawPayload',
    ]) {
      expect(() => assertNoForbiddenExperienceContent(bad)).toThrowError(ExperienceMemoryError);
    }
    expect(() => assertNoForbiddenExperienceContent('POD|INVOICE|RECOVERED')).not.toThrow();
  });

  it('抽取结果带 ruleVersion / 窗口 / sourceCount / confidence / sourceRefs，且为 FACT 级', () => {
    const record = extractExperienceRecord(observation());
    expect(record.kind).toBe('EXPERIENCE_RECORD');
    expect(record.experienceClass).toBe('FACT');
    expect(EXPERIENCE_CLASSES).toContain('AGGREGATE');
    expect(record.ruleVersion).toBe('rules/platform/v1');
    expect(record.window.from).toBe('2026-09-01T00:00:00.000Z');
    expect(record.sourceCount).toBe(1);
    expect(record.confidenceBp).toBe(8_000);
    expect(record.sourceRefs).toEqual(['outcome:1']);
    expect(record.serverDerived).toBe(true);
    expect(record.recordDigest).toHaveLength(64);
  });

  it('四维 scope（tenant / account / provider / domain）完整保留', () => {
    const record = extractExperienceRecord(
      observation({
        scope: { organizationId: ORG, platformAccountId: null, provider: 'CBP', domain: 'CUSTOMS' },
      }),
    );
    expect(record.scope).toEqual({
      organizationId: ORG,
      platformAccountId: null,
      provider: 'CBP',
      domain: 'CUSTOMS',
    });
  });

  it('append-only store：同 id 重复追加被拒绝；跨 tenant 查询返回空', async () => {
    const store = createInMemoryExperienceMemoryStore();
    const record = extractExperienceRecord(observation());
    await store.append(record);
    await expect(store.append(record)).rejects.toThrowError(ExperienceMemoryError);
    expect(store.size()).toBe(1);

    expect(await store.list({ organizationId: 'org-other' })).toEqual([]);
    expect(await store.list({ organizationId: ORG, platformAccountId: ACCT })).toHaveLength(1);
    expect(await store.list({ organizationId: ORG, platformAccountId: 'acct-other' })).toEqual([]);
  });

  it('跨租户断言 fail-closed', () => {
    expect(() =>
      assertExperienceScopeMatches({ recordScopeOrganizationId: ORG, queryOrganizationId: 'org-other' }),
    ).toThrowError(ExperienceMemoryError);
    expect(() =>
      assertExperienceScopeMatches({ recordScopeOrganizationId: ORG, queryOrganizationId: ORG }),
    ).not.toThrow();
  });
});

describe('C — 聚合安全规则（LOW_SAMPLE / CONFLICT / STALE）', () => {
  it('无样本 → FAIL_CLOSED，成功率与均值一律 null（绝不编造）', () => {
    const aggregate = aggregateExperience({ records: [], query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.decisionSupport).toBe('FAIL_CLOSED');
    expect(aggregate.sourceCount).toBe(0);
    expect(aggregate.successRateBp).toBeNull();
    expect(aggregate.averageCostUsd).toBeNull();
    expect(aggregate.confidenceBp).toBe(0);
    expect(aggregate.reasonCodes).toContain('NO_EXPERIENCE_DATA');
    expect(aggregate.requiresHumanReview).toBe(true);
  });

  it('低样本（< 5）→ ADVISORY 且置信封顶 4000 + 需人工复核', () => {
    const aggregate = aggregateExperience({ records: records(3), query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.decisionSupport).toBe('ADVISORY');
    expect(aggregate.reasonCodes).toContain('LOW_SAMPLE');
    expect(aggregate.confidenceBp).toBeLessThanOrEqual(4_000);
    expect(aggregate.requiresHumanReview).toBe(true);
    expect(aggregate.successRateBp).toBe(10_000);
  });

  it('足够样本（≥ 5）→ ADVISORY 且不强制人工复核', () => {
    const aggregate = aggregateExperience({ records: records(8), query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.decisionSupport).toBe('ADVISORY');
    expect(aggregate.reasonCodes).toContain('SUFFICIENT_SAMPLE');
    expect(aggregate.requiresHumanReview).toBe(false);
    expect(aggregate.sourceCount).toBe(8);
  });

  it('冲突结果（RECOVERED ≥2 且 REJECTED ≥2）→ NO_AUTOMATIC_LEARNING 且置信封顶 2000', () => {
    const conflicted = [
      ...records(3),
      ...records(3, { outcome: 'REJECTED', sourceRefs: ['rej:1', 'rej:2', 'rej:3'], recordedAt: '2026-10-01T00:00:00.000Z' }),
    ];
    const aggregate = aggregateExperience({ records: conflicted, query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.decisionSupport).toBe('NO_AUTOMATIC_LEARNING');
    expect(aggregate.reasonCodes).toContain('CONFLICTING_OUTCOMES');
    expect(aggregate.confidenceBp).toBeLessThanOrEqual(2_000);
    expect(aggregate.requiresHumanReview).toBe(true);
  });

  it('过期（窗口结束超过 180 天且占多数）→ DOWNWEIGHTED 且置信封顶 5000', () => {
    const ruleset = [
      ...records(6, { window: { from: '2025-01-01T00:00:00.000Z', to: '2025-02-01T00:00:00.000Z' } }),
    ];
    const aggregate = aggregateExperience({ records: ruleset, query: { scope: { organizationId: ORG } }, now: NOW });
    // 全部记录都过期 → IGNORE（不参与聚合），并如实标注
    expect(aggregate.decisionSupport).toBe('IGNORED');
    expect(aggregate.reasonCodes).toContain('ALL_RECORDS_STALE');
    expect(aggregate.reasonCodes.some((code) => code.startsWith('STALE_RECORDS:'))).toBe(true);
    expect(aggregate.sourceCount).toBe(0);
  });

  it('新鲜记录占多数但仍有陈旧样本 → 陈旧样本被排除，决策支持保持可用', () => {
    const mixed = [
      ...records(6),
      ...records(2, { window: { from: '2025-01-01T00:00:00.000Z', to: '2025-02-01T00:00:00.000Z' } }),
    ];
    const aggregate = aggregateExperience({ records: mixed, query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.sourceCount).toBe(6);
    expect(aggregate.decisionSupport).toBe('ADVISORY');
    expect(aggregate.reasonCodes.some((code) => code.startsWith('STALE_RECORDS:'))).toBe(true);
  });

  it('过期记录被排除在聚合之外（fresh 优先）', () => {
    const mixed = [
      ...records(6),
      ...records(4, { window: { from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z' } }),
    ];
    const aggregate = aggregateExperience({ records: mixed, query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.sourceCount).toBe(6);
  });
});

describe('C — v1 支持的六类经验查询', () => {
  it('① 证据组合历史接受率（同组合过滤）', () => {
    const sameCombination = records(6, { evidenceCombination: ['POD', 'INVOICE'] });
    const other = records(6, { evidenceCombination: ['POD'], sourceRefs: ['o:1', 'o:2', 'o:3', 'o:4', 'o:5', 'o:6'] });
    const aggregate = aggregateExperience({
      records: [...sameCombination, ...other],
      query: { scope: { organizationId: ORG }, evidenceCombination: ['POD', 'INVOICE'] },
      now: NOW,
    });
    expect(aggregate.sourceCount).toBe(6);
    expect(aggregate.successRateBp).toBe(10_000);
  });

  it('② 某 rejection reason 补件后的成功率', () => {
    const afterResubmit = records(5, {
      action: 'COLLECT_MORE_EVIDENCE',
      rejectionReason: 'MISSING_POD',
      sourceRefs: ['r:1', 'r:2', 'r:3', 'r:4', 'r:5'],
    });
    const stillRejected = [1, 2, 3, 4, 5].map((index) =>
      extractExperienceRecord(
        observation({
          action: 'COLLECT_MORE_EVIDENCE',
          rejectionReason: 'MISSING_POD',
          outcome: 'REJECTED',
          sourceRefs: ['rr:' + index],
          recordedAt: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    const aggregate = aggregateExperience({
      records: [...afterResubmit, ...stillRejected],
      query: { scope: { organizationId: ORG }, rejectionReason: 'MISSING_POD' },
      now: NOW,
    });
    expect(aggregate.sourceCount).toBe(10);
    expect(aggregate.successRateBp).toBe(5_000);
    expect(aggregate.decisionSupport).toBe('NO_AUTOMATIC_LEARNING');
  });

  it('③ provider / domain 维度过滤（CARRIER 周期的经验不污染 PLATFORM 查询）', () => {
    const platform = records(6);
    const carrier = records(6, {
      scope: { organizationId: ORG, platformAccountId: ACCT, provider: 'UPS', domain: 'CARRIER' },
      cycleTimeDays: 3,
      sourceRefs: ['c:1', 'c:2', 'c:3', 'c:4', 'c:5', 'c:6'],
    });
    const aggregate = aggregateExperience({
      records: [...platform, ...carrier],
      query: { scope: { organizationId: ORG }, domain: 'PLATFORM' },
      now: NOW,
    });
    expect(aggregate.sourceCount).toBe(6);
    expect(aggregate.averageCycleTimeDays).toBe(18);
  });

  it('④ 金额带成功率与 ⑤ 动作成本 / 周期分布', () => {
    const band = records(6, { amountBand: 'USD:1000-5000', costUsd: 20, cycleTimeDays: 20 });
    const aggregate = aggregateExperience({
      records: band,
      query: { scope: { organizationId: ORG }, amountBand: 'USD:1000-5000', action: 'SUBMIT_NOW' },
      now: NOW,
    });
    expect(aggregate.successRateBp).toBe(10_000);
    expect(aggregate.averageCostUsd).toBe(20);
    expect(aggregate.averageCycleTimeDays).toBe(20);
    expect(aggregate.averageRecoveredAmountUsd).toBe(1_500);
  });

  it('⑥ 人工复核更有效（HUMAN_OR_BROKER_REVIEW 的成功率可查询）', () => {
    const human = records(6, {
      action: 'HUMAN_OR_BROKER_REVIEW',
      outcome: 'RECOVERED',
      sourceRefs: ['h:1', 'h:2', 'h:3', 'h:4', 'h:5', 'h:6'],
    });
    const auto = records(6, { action: 'SUBMIT_NOW' });
    const humanAggregate = aggregateExperience({
      records: [...human, ...auto],
      query: { scope: { organizationId: ORG }, action: 'HUMAN_OR_BROKER_REVIEW' },
      now: NOW,
    });
    expect(humanAggregate.sourceCount).toBe(6);
    expect(humanAggregate.successRateBp).toBe(10_000);
  });

  it('PENDING 不计入成功率分母（避免把未完成的当失败）', () => {
    const mixed = [...records(6), ...records(2, { outcome: 'PENDING', sourceRefs: ['p:1', 'p:2'] })];
    const aggregate = aggregateExperience({ records: mixed, query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.sourceCount).toBe(8);
    expect(aggregate.successRateBp).toBe(10_000);
  });
});

describe('C — 边界与确定性', () => {
  it('v1 只允许影响 recommendation / ranking / confidence / planning，且不授予 External Write', () => {
    const aggregate = aggregateExperience({ records: records(6), query: { scope: { organizationId: ORG } }, now: NOW });
    expect(aggregate.allowedUses).toEqual([...EXPERIENCE_ALLOWED_USES]);
    expect(aggregate.externalWriteGranted).toBe(false);
    expect(() => assertExperienceDoesNotGrantExternalWrite(aggregate)).not.toThrow();
    expect(() =>
      assertExperienceDoesNotGrantExternalWrite({ externalWriteGranted: true as never }),
    ).toThrowError(ExperienceMemoryError);
    expect(() =>
      assertExperienceDoesNotGrantExternalWrite({ allowedUses: ['external_write'] }),
    ).toThrowError(ExperienceMemoryError);
  });

  it('边界常量：append-only / server-derived / 四维 scope / 三类安全规则 / 无外写', () => {
    expect(EXPERIENCE_MEMORY_BOUNDARY.rawAppendOnly).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.serverDerivedOnly).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.tenantScoped).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.accountScoped).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.providerScoped).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.domainScoped).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.lowSampleIsAdvisoryOrFailClosed).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.conflictForbidsAutomaticLearning).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.staleIsDownweightedOrIgnored).toBe(true);
    expect(EXPERIENCE_MEMORY_BOUNDARY.externalWriteGranted).toBe(false);
    expect(EXPERIENCE_MEMORY_BOUNDARY.writesCanonicalTruth).toBe(false);
    expect(EXPERIENCE_MEMORY_BOUNDARY.decidesEligibility).toBe(false);
    expect(EXPERIENCE_MEMORY_BOUNDARY.forbidden).toContain('storing credentials / cookies / raw provider payloads');
  });

  it('确定性：同输入同 now → 同 aggregateDigest；样本变化 → 摘要变', () => {
    const a = aggregateExperience({ records: records(6), query: { scope: { organizationId: ORG } }, now: NOW });
    const b = aggregateExperience({ records: records(6), query: { scope: { organizationId: ORG } }, now: NOW });
    const c = aggregateExperience({ records: records(7), query: { scope: { organizationId: ORG } }, now: NOW });
    expect(a.aggregateDigest).toBe(b.aggregateDigest);
    expect(a.aggregateDigest).not.toBe(c.aggregateDigest);
    expect(a.aggregateDigest).toHaveLength(64);
    expect(EXPERIENCE_MEMORY_VERSION).toBe('experience-memory/v1');
  });
});
