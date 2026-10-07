import InlineNotice from '../components/ui/inline-notice';
import StatusBadge from '../components/ui/status-badge';
import RevokeAuthorizationButton from './revoke-authorization-button';
import type { Messages } from '../../i18n/dictionaries/zh-CN';

export interface AuthorizationItem {
  authorizationId: string;
  provider: string;
  platformAccountId: string;
  allowedActionTypes: string[];
  monetaryLimitUsd: number;
  currency: string;
  domain: string;
  jurisdiction: string;
  effectiveAt: string;
  expiresAt: string;
  authorizationVersion: number;
  termsPolicyVersion: string;
  revocationState: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  scopeDigest: string;
  createdAt: string;
}

/** 动作名（既有 Action Guard 目录键）→ 客户语言键；未知动作只显示「其他动作」，原始 code 进高级区 */
const ACTION_LABEL_KEYS: Record<string, keyof Messages['authorizationPage']> = {
  'evidence.read': 'actionEvidenceRead',
  'claim.prepare': 'actionClaimPrepare',
  'recovery.manual_submit': 'actionRecoveryManualSubmit',
  'recovery.manual_submit_reference_recorded': 'actionRecoveryManualReference',
  'claim.submit': 'actionClaimSubmit',
  'appeal.submit': 'actionAppealSubmit',
  'platform.write': 'actionPlatformWrite',
  'billing.draft': 'actionBillingDraft',
  'carrier.manual_submission.record': 'actionCarrierManualSubmission',
  'carrier.claim_response.record': 'actionCarrierClaimResponse',
  'customs.recovery.start': 'actionCustomsRecoveryStart',
};

function actionLabel(action: string, labels: Messages['authorizationPage']): string {
  const key = ACTION_LABEL_KEYS[action];
  return key ? (labels[key] as string) : labels.actionOther;
}

/**
 * P7：授权管理列表（**只读展示 + 撤销**）。
 * 所有状态字段来自后端 Standing Authorization；前端不生成 scopeDigest、不改任何 scope、不做资格判定。
 */
export default function AuthorizationList({ items, t }: { items: AuthorizationItem[]; t: Messages }) {
  const labels = t.authorizationPage;
  if (items.length === 0) {
    return (
      <InlineNotice tone="info" title={labels.empty}>
        {labels.emptyHint}
      </InlineNotice>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((item) => {
          const active = item.revocationState === 'ACTIVE';
          const statusLabel =
            item.revocationState === 'REVOKED'
              ? labels.statusRevoked
              : item.revocationState === 'SUSPENDED'
                ? labels.statusSuspended
                : labels.statusActive;
          return (
            <article key={item.authorizationId} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{item.provider}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge tone={active ? 'ok' : 'neutral'}>{statusLabel}</StatusBadge>
                  <StatusBadge tone={active ? 'ok' : 'neutral'}>
                    {active ? labels.automationOn : labels.automationOff}
                  </StatusBadge>
                </div>
              </div>

              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-slate-500">{labels.limitLabel}</dt>
                  <dd className="text-slate-900">
                    {item.currency} {item.monetaryLimitUsd}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">{labels.validityLabel}</dt>
                  <dd className="text-slate-900">
                    {item.effectiveAt.slice(0, 10)} → {item.expiresAt.slice(0, 10)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">{labels.actionsLabel}</dt>
                  <dd className="text-slate-900">
                    {item.allowedActionTypes.map((action) => actionLabel(action, labels)).join(' · ')}
                  </dd>
                </div>

              </dl>

              {item.revocationState !== 'ACTIVE' ? (
                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  {labels.revokedNote
                    .replace('{reason}', item.revocationReason ?? labels.revokeReasonUnknown)
                    .replace('{at}', (item.revokedAt ?? '').slice(0, 10))}
                </p>
              ) : null}

              <details className="mt-3 text-xs text-slate-500">
                <summary className="cursor-pointer">{labels.advancedLabel}</summary>
                <p className="mt-1 break-all">
                  {labels.scopeRefLabel}: {item.scopeDigest}
                </p>
                <p className="mt-1 break-all">
                  {labels.rawActionsLabel}: {item.allowedActionTypes.join(', ')}
                </p>
                <p className="mt-1 break-all">
                  {labels.accountRefLabel}: {item.platformAccountId}
                </p>
                <p className="mt-1">
                  {labels.versionLabel}: v{item.authorizationVersion} · {item.termsPolicyVersion}
                </p>
                <p className="mt-1">{labels.modifyUnavailable}</p>
              </details>

              <div className="mt-3">
                <RevokeAuthorizationButton
                  authorizationId={item.authorizationId}
                  disabled={!active}
                  labels={{
                    revokeCta: labels.revokeCta,
                    revokeReasonLabel: labels.revokeReasonLabel,
                    revokeConfirm: labels.revokeConfirm,
                    revokeCancel: labels.revokeCancel,
                    revokeBusy: labels.revokeBusy,
                    revokeFailed: labels.revokeFailed,
                    networkError: t.common.networkError,
                  }}
                />
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">{labels.boundaryNote}</p>
      <p className="text-xs text-slate-500">{labels.holdNote}</p>
    </div>
  );
}
