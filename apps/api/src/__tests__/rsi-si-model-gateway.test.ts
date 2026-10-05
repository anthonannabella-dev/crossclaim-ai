/**
 * PHASE 2 U1 验收 —— 唯一 Model Gateway capability port（复用 rsi-model-router；禁第二 Router）
 * 边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（只用 host 注入的 local simulation adapter）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SI_MODEL_GATEWAY_BOUNDARY,
  createSiModelGatewayPort,
} from '../runtime/rsi-si-model-gateway';
import { createRsiDomainPackRunner } from '../runtime/rsi-domain-pack';
import { RSI_RUNTIME_COMPOSITION_BOUNDARY } from '../runtime/rsi-run';
import { createRsiLocalSimAdapter } from '../services/autonomy/rsi-local-sim-adapter';
import type { RsiCostUsage, RsiModelCallRequest } from '../services/autonomy/rsi-cost-policy';

const repoRoot = path.resolve(process.cwd(), '..', '..');

const usage = (): RsiCostUsage => ({
  spentToday: 0,
  spentThisMonth: 0,
  incidentSpent: 0,
  incidentAttempts: 0,
  incidentCandidates: 0,
  incidentLlmCalls: 0,
  incidentTokens: 0,
  incidentElapsedMinutes: 0,
  strongCallsForTask: 0,
});

const request = (): RsiModelCallRequest => ({
  taskType: 'SEMANTIC',
  complexity: 'LOW',
  maxCost: 0.5,
  latencyRequirementMs: 5_000,
  requiredCapability: 'SEMANTIC_UNDERSTANDING',
  incidentId: 'inc-p2',
  taskId: 'task-p2',
  promptRef: 'prompt:task-p2',
  promptDigest: 'c'.repeat(64),
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  necessity: { outcome: 'AMBIGUOUS', ruleVersion: 'rule/v1', schemaVersion: 'schema/v1', inputDigest: 'a'.repeat(64) },
} as RsiModelCallRequest);

describe('PHASE 2 U1 · SI Model Gateway capability port', () => {
  it('P2U1_1 port 委托共享 Gateway（local sim）：invoke 返回 Gateway 判定与可审计 usage', async () => {
    const records: { provider: string; estimatedCost: number }[] = [];
    const port = createSiModelGatewayPort({
      lowCost: createRsiLocalSimAdapter({ tier: 'LOW_COST', providerName: 'rsi-local-sim-low-cost' }),
      usage,
      onCall: (record) => records.push({ provider: record.provider, estimatedCost: record.estimatedCost }),
    });
    const result = await port.invoke(request());
    expect(port.gatewayOwner).toBe('rsi-model-router');
    expect(typeof result.called).toBe('boolean');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(Array.isArray(records)).toBe(true);
    expect(SI_MODEL_GATEWAY_BOUNDARY.secondRouter).toBe('FORBIDDEN');
    expect(SI_MODEL_GATEWAY_BOUNDARY.realProviderNetwork).toBe('HOLD');
    expect(SI_MODEL_GATEWAY_BOUNDARY.paidModelCalls).toBe('HOLD');
  });

  it('P2U1_2 domain pack context 可拿到 gateway port；缺省时 deterministic-first（不触达模型）', async () => {
    const seen: (string | undefined)[] = [];
    const pack = {
      packId: 'probe-pack',
      domain: 'probe',
      matches: () => true,
      run: async (context: { modelGateway?: { gatewayOwner: string } }) => {
        seen.push(context.modelGateway?.gatewayOwner);
        return {
          status: 'PASS' as const,
          evidenceRef: 'probe:1',
          reasonCodes: [],
          modelCallCount: context.modelGateway === undefined ? 0 : 1,
          guardActions: [],
          externalWritePerformed: false,
        };
      },
    };
    const withGateway = createRsiDomainPackRunner({
      packs: [pack],
      modelGateway: createSiModelGatewayPort({
        lowCost: createRsiLocalSimAdapter({ tier: 'LOW_COST', providerName: 'rsi-local-sim-low-cost' }),
        usage,
      }),
    });
    await withGateway.run({ id: 't1', dedupeKey: 'task:probe:1', priority: 'P2' });
    const withoutGateway = createRsiDomainPackRunner({ packs: [pack] });
    await withoutGateway.run({ id: 't2', dedupeKey: 'task:probe:2', priority: 'P2' });
    expect(seen).toEqual(['rsi-model-router', undefined]);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.siModelGatewayWiring).toContain('SECOND_MODEL_ROUTER = FORBIDDEN');
  });

  it('P2U1_3 P2U1_3_ALLOWLIST：产品代码 Router 创建点严格 allowlist（无第二 Router）', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const srcRoot = path.join(repoRoot, 'apps', 'api', 'src');
    const creators = walk(srcRoot)
      .filter((file) => !file.includes(path.sep + '__tests__' + path.sep))
      .filter((file) => /createRsiModelRouter\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .sort();
    expect(creators).toEqual([
      'apps/api/src/runtime/rsi-si-model-gateway.ts',
      'apps/api/src/services/autonomy/rsi-model-provider-composition.ts',
      'apps/api/src/services/autonomy/rsi-model-router.ts',
    ]);
  });
});
