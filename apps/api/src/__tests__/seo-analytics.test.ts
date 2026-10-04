/** SEO-7 单元验收：provider-neutral SEO 漏斗事件契约（无 PII / 无租户数据 / estimate 必须带标签）。 */

import { describe, expect, it } from 'vitest';

import {
  buildSeoFunnelEventRecord,
  emitSeoFunnelEvent,
  SEO_ANALYTICS_BOUNDARY,
  SEO_EVENT_FORBIDDEN_FIELDS,
  SEO_FUNNEL_EVENTS,
  type SeoFunnelEventRecord,
} from '../services/seo/seo-analytics';

const HASH = 'a'.repeat(64);

describe('SEO-7 — provider-neutral funnel events', () => {
  it('事件词表与需求一致（11 个漏斗事件）', () => {
    expect(SEO_FUNNEL_EVENTS).toEqual([
      'seo_page_view',
      'checker_started',
      'checker_completed',
      'calculator_started',
      'calculator_completed',
      'estimated_recovery_shown',
      'connect_clicked',
      'upload_clicked',
      'signup_started',
      'signup_completed',
      'recovery_started',
    ]);
  });

  it('合法事件：规范化 + 边界自证（无 PII / 无租户数据 / 无提交 / 无扣费）', () => {
    const built = buildSeoFunnelEventRecord({
      event: 'estimated_recovery_shown',
      slug: 'us-customs-drawback',
      locale: 'en',
      sessionHash: HASH,
      estimate: { min: 1000, max: 2500, currency: 'USD', label: 'ESTIMATE_ONLY' },
      properties: { platform: 'customs', source: 'organic' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.record.event).toBe('estimated_recovery_shown');
    expect(built.record.piiIncluded).toBe(false);
    expect(built.record.tenantDataIncluded).toBe(false);
    expect(built.record.submissionCreated).toBe(false);
    expect(built.record.chargingPerformed).toBe(false);
  });

  it('未知事件 / 非法 slug / 非法 locale / 非法 sessionHash 一律拒绝', () => {
    expect(buildSeoFunnelEventRecord({ event: 'nope' })).toMatchObject({ ok: false, code: 'UNKNOWN_EVENT' });
    expect(buildSeoFunnelEventRecord({ event: 'seo_page_view', slug: 'BAD SLUG' })).toMatchObject({
      ok: false,
      code: 'INVALID_SLUG',
    });
    expect(buildSeoFunnelEventRecord({ event: 'seo_page_view', locale: 'english' })).toMatchObject({
      ok: false,
      code: 'INVALID_LOCALE',
    });
    expect(buildSeoFunnelEventRecord({ event: 'seo_page_view', sessionHash: 'not-a-hash' })).toMatchObject({
      ok: false,
      code: 'INVALID_PROPERTY',
    });
  });

  it('禁止字段（租户/身份/凭据）直接拒绝', () => {
    for (const field of ['organizationId', 'tenantRef', 'email', 'clientSecret']) {
      const built = buildSeoFunnelEventRecord({
        event: 'seo_page_view',
        properties: { [field]: 'x' } as never,
      });
      expect(built).toMatchObject({ ok: false, code: 'FORBIDDEN_FIELD' });
    }
    expect(SEO_EVENT_FORBIDDEN_FIELDS).toContain('organizationId');
    expect(SEO_EVENT_FORBIDDEN_FIELDS).toContain('credentialReference');
  });

  it('属性值中的 PII（邮箱 / 电话 / 税号 / 长数字 / 裸 URL）拒绝', () => {
    for (const value of ['buyer@example.com', '+1 415 555 0132', '12-3456789', 'https://x/y']) {
      expect(
        buildSeoFunnelEventRecord({ event: 'checker_completed', properties: { note: value } }),
      ).toMatchObject({ ok: false, code: 'PII_DETECTED' });
    }
  });

  it('estimate 必须是非负递增区间 + 三位货币 + ESTIMATE_ONLY 标签', () => {
    expect(
      buildSeoFunnelEventRecord({
        event: 'estimated_recovery_shown',
        estimate: { min: 100, max: 50, currency: 'USD', label: 'ESTIMATE_ONLY' },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_ESTIMATE' });
    expect(
      buildSeoFunnelEventRecord({
        event: 'estimated_recovery_shown',
        estimate: { min: 100, max: 200, currency: 'US', label: 'ESTIMATE_ONLY' },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_ESTIMATE' });
    expect(
      buildSeoFunnelEventRecord({
        event: 'estimated_recovery_shown',
        estimate: { min: 100, max: 200, currency: 'USD', label: 'GUARANTEED' as never },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_ESTIMATE' });
  });

  it('sink 只在合法事件时被调用（非法事件不发送）', async () => {
    const sent: SeoFunnelEventRecord[] = [];
    const sink = { emit: async (record: SeoFunnelEventRecord) => void sent.push(record) };

    const bad = await emitSeoFunnelEvent(
      { event: 'checker_completed', properties: { email: 'a@b.com' } },
      sink,
    );
    expect(bad.ok).toBe(false);
    expect(sent).toHaveLength(0);

    const good = await emitSeoFunnelEvent({ event: 'checker_started', slug: 'us-customs-drawback' }, sink);
    expect(good.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe('checker_started');
    expect(sent[0]?.tenantDataIncluded).toBe(false);
    expect(sent[0]?.chargingPerformed).toBe(false);
  });

  it('边界自证：provider-neutral、不收 PII/租户数据、estimate 必须带标签、无外写/提交/扣费', () => {
    expect(SEO_ANALYTICS_BOUNDARY).toEqual({
      providerNeutral: true,
      piiAccepted: false,
      tenantDataAccepted: false,
      requiresEstimateLabel: true,
      externalWritePerformed: false,
      submissionCreated: false,
      chargingPerformed: false,
      productionCredentials: 'ABSENT',
    });
  });
});
