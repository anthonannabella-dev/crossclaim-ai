/**
 * SEO-4 —— RuleVersion 行 → 导出规则（纯函数，apps/api 侧；web 永不接触）。
 * 只做三件事：解析（已验收 codec）、生效窗口过滤、SEO-6 gate 判定。不发明任何规则内容。
 */

import {
  isRecoveryRuleEffective,
  parseRecoveryRuleDefinition,
  seoIndexabilityGate,
  type RecoveryRuleVersionRow,
  type SeoRenderMetrics,
} from '../recovery-rules/recovery-rule-definition';
import type { SeoRecoverExportRule } from './seo-recover-static-export';

export interface SeoRecoverRuleSourceInput {
  rows: readonly RecoveryRuleVersionRow[];
  now: Date;
  /** 已注册的 checker basis key（来自 SEO-3 注册表）。为空 → gate 必然 fail-closed → 页面保持 noindex。 */
  registeredBasisKeys: readonly string[];
  renderMetrics?: SeoRenderMetrics;
  /** canonical selector 判定为「同一 slug 有 >1 生效版本」的 slug 集合。 */
  conflictingSlugs?: readonly string[];
}

export interface SeoRecoverRuleSourceResult {
  rules: readonly SeoRecoverExportRule[];
  rejected: readonly { ref: string; reason: string }[];
}

export function toExportRules(input: SeoRecoverRuleSourceInput): SeoRecoverRuleSourceResult {
  const rules: SeoRecoverExportRule[] = [];
  const rejected: { ref: string; reason: string }[] = [];

  for (const row of input.rows ?? []) {
    const parsed = parseRecoveryRuleDefinition(row);
    if (!parsed.ok) {
      rejected.push({ ref: String(row?.version ?? 'UNKNOWN'), reason: parsed.errors.join('|') });
      continue;
    }
    const rule = parsed.rule;
    if (!isRecoveryRuleEffective(rule, input.now)) {
      rejected.push({ ref: `${rule.slug}@${rule.ruleVersion}`, reason: 'NOT_EFFECTIVE' });
      continue;
    }

    const gate = seoIndexabilityGate({
      rule,
      now: input.now,
      registeredBasisKeys: input.registeredBasisKeys,
      renderMetrics: input.renderMetrics,
      conflictingVersions: (input.conflictingSlugs ?? []).includes(rule.slug),
      canonicalExplicit: true,
    });

    rules.push({
      slug: rule.slug,
      ruleVersion: rule.ruleVersion,
      platform: rule.platform,
      recoveryType: rule.recoveryType,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      indexable: gate.indexable,
      noindexReasons: [...gate.reasons],
      title: rule.title,
      problemDescription: rule.problemDescription,
      requiredEvidence: [...rule.requiredEvidence],
      sourceReferences: rule.sourceReferences.map((source) => source.id),
      relatedRuleRefs: [...rule.relatedRuleRefs],
    });
  }

  return { rules, rejected };
}
