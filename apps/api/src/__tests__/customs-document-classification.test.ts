// CUSTOMS / DUTY RECOVERY — slice B-S2 — Customs 文档分类回归
// ---------------------------------------------------------------------------
// 覆盖：19 类文档识别、互斥消歧（7501 vs ACE/Broker）、证据不足 fail-closed、
// OCR 降权与人工复核、歧义封顶、9801/9802 ≠ drawback 警示、制度边界不变量、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMS_AMBIGUOUS_CONFIDENCE_CAP_BP,
  CUSTOMS_CLASSIFICATION_BOUNDARY,
  CUSTOMS_CLASSIFICATION_CONFIDENCE_CAP_BP,
  CUSTOMS_CLASSIFICATION_RULES,
  CUSTOMS_DOCUMENT_KINDS,
  CUSTOMS_FLOOR_CONFIDENCE_BP,
  CUSTOMS_OCR_CONFIDENCE_CAP_BP,
  CUSTOMS_TEXT_SIGNALS,
  CustomsClassificationError,
  assertClassificationIsNotCustomsTruth,
  classifyCustomsDocument,
  detectCustomsSpecialHeadings,
  isCustomsDocumentKind,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T14:00:00.000Z');

function classify(text: string, overrides: Parameters<typeof classifyCustomsDocument>[0] = { text }) {
  return classifyCustomsDocument({ ...overrides, text, now: NOW });
}

describe('B-S2 Customs 文档分类 — 各类文档识别', () => {
  it('CBP 7501（Form 7501 + Entry Summary + 关键字段）→ CBP_7501', () => {
    const result = classify(
      [
        'CBP Form 7501 Entry Summary',
        'Entry Number: ABC-123456',
        'Entry Date: 2026-08-01',
        'Customs Value: 12,500.00',
        'Total Duty: 312.50',
      ].join('\n'),
    );
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.matchedSignals).toContain('FORM_7501');
    expect(result.confidenceBp).toBeGreaterThanOrEqual(7_000);
    expect(result.reasons).toContain('RULE_CBP_7501_FORM_MATCHED');
  });

  it('仅文件名含 7501 → CBP_7501（文件名也是证据）', () => {
    const result = classifyCustomsDocument({ filename: 'entry-summary-7501.pdf', text: '', now: NOW });
    expect(result.documentKind).toBe('CBP_7501');
  });

  it('CBP 28（CF 28 / Request for Information）→ CBP_28', () => {
    const result = classify('CF 28 — Request for Information regarding entry ABC-123456');
    expect(result.documentKind).toBe('CBP_28');
  });

  it('CBP 29（CBP Form 29 / Notice of Action）→ CBP_29', () => {
    const result = classify('CBP Form 29 Notice of Action');
    expect(result.documentKind).toBe('CBP_29');
  });

  it('ACE entry record → ACE_ENTRY_RECORD', () => {
    const result = classify('ACE Entry Record\nEntry Number: ABC-123456');
    expect(result.documentKind).toBe('ACE_ENTRY_RECORD');
    expect(result.matchedSignals).toContain('ENTRY_NUMBER');
  });

  it('Broker entry record → BROKER_ENTRY_RECORD', () => {
    const result = classify('Broker Entry Record\nBroker reference: BRK-9911');
    expect(result.documentKind).toBe('BROKER_ENTRY_RECORD');
  });

  it('Duty payment record（不误判为发票）→ DUTY_PAYMENT_RECORD', () => {
    const result = classify('Duty Statement — duties paid 312.50');
    expect(result.documentKind).toBe('DUTY_PAYMENT_RECORD');
    expect(result.documentKind).not.toBe('COMMERCIAL_INVOICE');
  });

  it('Commercial invoice → COMMERCIAL_INVOICE；Vendor invoice → PURCHASE_INVOICE', () => {
    expect(classify('Commercial Invoice\nInvoice No: INV-2026-0001').documentKind).toBe('COMMERCIAL_INVOICE');
    expect(classify('Vendor Invoice\nInvoice No: V-9911').documentKind).toBe('PURCHASE_INVOICE');
  });

  it('Packing list / Return record / Export record / Destruction record', () => {
    expect(classify('Packing List\nCarton 1 of 3').documentKind).toBe('PACKING_LIST');
    expect(classify('Return Authorization RMA-7712').documentKind).toBe('RETURN_RECORD');
    expect(classify('Export Declaration\nEntry Number: ABC-123456').documentKind).toBe('EXPORT_RECORD');
    expect(classify('Certificate of Destruction — goods destroyed 2026-07-30').documentKind).toBe(
      'DESTRUCTION_RECORD',
    );
  });

  it('POD / POA / Ruling / Exclusion / Refund evidence / Tracking confirmation', () => {
    expect(classify('Proof of Delivery 1Z999AA10123456784').documentKind).toBe('POD');
    expect(classify('Power of Attorney (Form 5291) for customs broker').documentKind).toBe('POA');
    expect(classify('Customs Ruling NY N123456 classification of widget').documentKind).toBe('RULING');
    expect(classify('Section 301 exclusion, HTS 9903.88.01').documentKind).toBe('EXCLUSION_REFERENCE');
    expect(classify('Duty refund claim under drawback').documentKind).toBe('REFUND_EVIDENCE');
    expect(classify('Delivery confirmation tracking number 1Z999AA10123456784').documentKind).toBe(
      'TRACKING_CONFIRMATION',
    );
  });

  it('19 类文档都有对应规则（无遗漏）', () => {
    const covered = new Set(CUSTOMS_CLASSIFICATION_RULES.map((rule) => rule.kind));
    for (const kind of CUSTOMS_DOCUMENT_KINDS) {
      if (kind === 'OTHER') continue;
      expect(covered.has(kind)).toBe(true);
    }
    expect(CUSTOMS_DOCUMENT_KINDS).toContain('OTHER');
    expect(isCustomsDocumentKind('CBP_7501')).toBe(true);
    expect(isCustomsDocumentKind('NOT_A_DOCUMENT_KIND')).toBe(false);
  });
});

describe('B-S2 — 互斥消歧（7501 优先于 ACE / Broker）', () => {
  it('7501 与 ACE entry 同时出现 → CBP_7501（ACE 被否决）', () => {
    const result = classify('CBP Form 7501 Entry Summary\nACE Entry Record\nEntry Number: ABC-123456');
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.alternatives.map((a) => a.documentKind)).not.toContain('ACE_ENTRY_RECORD');
  });

  it('7501 与 Broker entry 同时出现 → CBP_7501（Broker 被否决）', () => {
    const result = classify('Form 7501\nBroker Entry Record');
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.alternatives.map((a) => a.documentKind)).not.toContain('BROKER_ENTRY_RECORD');
  });

  it('ACE 与 Broker 同时出现 → ACE_ENTRY_RECORD', () => {
    const result = classify('ACE Entry Record\nBroker Entry Record');
    expect(result.documentKind).toBe('ACE_ENTRY_RECORD');
    expect(result.alternatives.map((a) => a.documentKind)).not.toContain('BROKER_ENTRY_RECORD');
  });

  it('CBP 28 / 29 各自独立，不互相误判', () => {
    expect(classify('CF 29 Notice of Action').documentKind).toBe('CBP_29');
    expect(classify('CF 28 Request for Information').documentKind).toBe('CBP_28');
  });
});

describe('B-S2 — fail-closed 与歧义处理', () => {
  it('证据不足（仅 entry number）→ OTHER + NO_RULE_MATCHED + 人工复核', () => {
    const result = classify('Entry Number: ABC-123456');
    expect(result.documentKind).toBe('OTHER');
    expect(result.confidenceBp).toBe(CUSTOMS_FLOOR_CONFIDENCE_BP);
    expect(result.reasons).toContain('NO_RULE_MATCHED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.matchedSignals).toEqual([]);
  });

  it('互相冲突（section 301 exclusion vs refund）→ 置信封顶 + AMBIGUOUS + 人工复核', () => {
    const result = classify('Section 301 exclusion product refund');
    expect(result.confidenceBp).toBeLessThanOrEqual(CUSTOMS_AMBIGUOUS_CONFIDENCE_CAP_BP);
    expect(result.reasons.some((r) => r.startsWith('AMBIGUOUS_BETWEEN_'))).toBe(true);
    expect(result.requiresManualReview).toBe(true);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(2);
  });

  it('OCR 文本一律降权（≤6000）并标记人工复核', () => {
    const result = classify('CBP Form 7501 Entry Summary', { text: 'CBP Form 7501 Entry Summary', textFromOcr: true, now: NOW });
    expect(result.documentKind).toBe('CBP_7501');
    expect(result.confidenceBp).toBeLessThanOrEqual(CUSTOMS_OCR_CONFIDENCE_CAP_BP);
    expect(result.reasons).toContain('TEXT_FROM_OCR_DOWNWEIGHTED');
    expect(result.requiresManualReview).toBe(true);
    expect(result.sourceTextFromOcr).toBe(true);
  });

  it('maxConfidenceBp 可显式压低上限（调用方收紧）', () => {
    const result = classify('CBP Form 7501 Entry Summary', {
      text: 'CBP Form 7501 Entry Summary',
      maxConfidenceBp: 3_000,
      now: NOW,
    });
    expect(result.confidenceBp).toBeLessThanOrEqual(3_000);
  });

  it('正常高置信分类不超过全局上限 9500', () => {
    const result = classify(
      'CBP Form 7501 Entry Summary\nEntry Date: 2026-08-01\nCustoms Value: 100\nTotal Duty: 5',
    );
    expect(result.confidenceBp).toBeLessThanOrEqual(CUSTOMS_CLASSIFICATION_CONFIDENCE_CAP_BP);
  });
});

describe('B-S2 — 9801 / 9802 ≠ drawback', () => {
  it('特别 heading 检测：9801 / 9802 被识别，drawback 出现时给出警示', () => {
    const deMinimis = detectCustomsSpecialHeadings('Section 321 de minimis under HTS 9801 drawback');
    expect(deMinimis.headings).toEqual(['9801']);
    expect(deMinimis.drawbackSignals).toContain('DRAWBACK');
    expect(deMinimis.nonDrawbackHeadsUp).toBe('HTS_9801_9802_ARE_NOT_DRAWBACK');

    const usGoods = detectCustomsSpecialHeadings('HTS 9802.00.80 US goods returned');
    expect(usGoods.headings).toEqual(['9802']);
    expect(usGoods.nonDrawbackHeadsUp).toBeNull();
  });

  it('分类结果携带警示，并要求人工复核', () => {
    const result = classify('HTS 9802.00.80 US goods returned — drawback candidate');
    expect(result.specialHeadings.headings).toEqual(['9802']);
    expect(result.specialHeadings.nonDrawbackHeadsUp).toBe('HTS_9801_9802_ARE_NOT_DRAWBACK');
    expect(result.reasons).toContain('HTS_9801_9802_ARE_NOT_DRAWBACK');
    expect(result.requiresManualReview).toBe(true);
  });

  it('纯 9801 文本不会仅凭 heading 被判为 REFUND_EVIDENCE', () => {
    const result = classify('Entry under HTS 9801 de minimis shipment');
    expect(result.documentKind).not.toBe('REFUND_EVIDENCE');
    expect(result.specialHeadings.drawbackSignals).toEqual([]);
  });
});

describe('B-S2 — 制度边界与确定性', () => {
  it('分类结果恒为「非 Customs Truth / 不能判定 eligibility」', () => {
    const result = classify('CBP Form 7501 Entry Summary');
    expect(result.customsTruthEligible).toBe(false);
    expect(result.canDecideEligibility).toBe(false);
    expect(result.kind).toBe('CUSTOMS_DOCUMENT_CLASSIFICATION');
    expect(() => assertClassificationIsNotCustomsTruth(result)).not.toThrow();
    expect(() =>
      assertClassificationIsNotCustomsTruth({ customsTruthEligible: true as never }),
    ).toThrowError(CustomsClassificationError);
    expect(() => assertClassificationIsNotCustomsTruth({ canDecideEligibility: true as never })).toThrowError(
      CustomsClassificationError,
    );
  });

  it('边界常量：只分类、不抽字段、不写 Canonical Truth、不判定金额与佣金', () => {
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.classificationOnly).toBe(true);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.ocrIsNotCustomsTruth).toBe(true);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.llmCannotDecideEligibility).toBe(true);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.extractsFields).toBe(false);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.writesCanonicalTruth).toBe(false);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.determinesSuccessFeeEligibility).toBe(false);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.failClosedOnInsufficientEvidence).toBe(true);
    expect(CUSTOMS_CLASSIFICATION_BOUNDARY.forbidden).toContain('treating HTS 9801 / 9802 as drawback');
  });

  it('确定性：同输入同 now → 同 classificationDigest；文本变 → 摘要变', () => {
    const a = classify('CBP Form 7501 Entry Summary');
    const b = classify('CBP Form 7501 Entry Summary');
    const c = classify('Commercial Invoice');
    expect(a.classificationDigest).toBe(b.classificationDigest);
    expect(a.classificationDigest).not.toBe(c.classificationDigest);
    expect(a.classificationDigest).toHaveLength(64);
    expect(a.classifiedAt).toBe(NOW.toISOString());
  });

  it('信号表与规则表结构完整（required 非空、id 唯一）', () => {
    const ids = new Set<string>();
    for (const rule of CUSTOMS_CLASSIFICATION_RULES) {
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(rule.required.length).toBeGreaterThan(0);
      for (const signal of [...rule.required, ...rule.optional, ...(rule.vetoIf ?? [])]) {
        expect(CUSTOMS_TEXT_SIGNALS[signal]).toBeInstanceOf(RegExp);
      }
    }
    expect(Object.keys(CUSTOMS_TEXT_SIGNALS).length).toBeGreaterThan(30);
  });

  it('模块不导出任何字段抽取 / 权利判定 / 写库入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(
        /extractCanonical|writeCustomsTruth|decideEligibility|computeRecoverable|persistClassification|mutateCustomsFact/i,
      );
    }
  });
});
