'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';
import StatusBadge from './ui/status-badge';
import type { BadgeTone } from './ui/status-badge';

/** 与后端 Prisma enum 保持一致；Web 不导入 Prisma，这里只维护词表（技术字面量，不翻译）。 */
const KINDS = ['FILE_UPLOAD', 'API'] as const;
const DOMAINS = ['PLATFORM', 'LOGISTICS', 'CUSTOMS'] as const;
const CHANNELS = [
  'AMAZON_FBA',
  'AMAZON_OTHER',
  'UPS',
  'FEDEX',
  'DHL',
  'FREIGHT_FORWARDER',
  'INSURANCE',
  'CUSTOMS_BROKER',
  'OTHER',
] as const;

/** 允许的迁移，仅用于按钮可见性；权威状态机在服务端。 */
/** CUSTOMER-UX：客户语言向导 —— 内部字段由客户端推断，客户不需要先懂数据模型。 */
type WizardKey = 'PLATFORM_AMAZON' | 'CARRIER_BILL' | 'CUSTOMS_DOC' | 'ADVANCED';
const NEXT_STATUSES: Record<string, string[]> = {
  NEEDS_AUTH: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['PAUSED', 'REVOKED'],
  PAUSED: ['ACTIVE', 'REVOKED'],
  ERROR: ['ACTIVE', 'PAUSED'],
  REVOKED: [],
};

export interface ConnectionItem {
  id: string;
  label: string;
  kind: string;
  domain: string;
  channel: string;
  status: string;
  hasCredentialRef: boolean;
  platform: string | null;
  lastError: string | null;
  /** P9：后端已有的最近同步时间（缺失时以「暂无同步记录」如实展示） */
  lastSyncAt?: string | null;
}

/**
 * UI-4 —— 采集连接（客户视图）。
 * 客户默认看到：名称 / 渠道 / 状态（客户语言）/ 凭据是否已配置 / 可用操作；
 * 工程字段（kind / domain / platform / 原始 status code / credentialRef）收进「高级详情」与创建表单。
 */
export default function ConnectionManager({ items, t }: { items: ConnectionItem[]; t: Messages }) {
  const copy = t.connectionsPage;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [wizard, setWizard] = useState<WizardKey>('PLATFORM_AMAZON');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('API');
  const [domain, setDomain] = useState<(typeof DOMAINS)[number]>('PLATFORM');
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('AMAZON_FBA');
  const [platform, setPlatform] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [refDraft, setRefDraft] = useState<Record<string, string>>({});

  const statusLabel = (code: string): string => {
    const table = copy as unknown as Record<string, string>;
    switch (code) {
      case 'ACTIVE':
        return table.statusActive ?? t.status.UNKNOWN;
      case 'PAUSED':
        return table.statusPaused ?? t.status.UNKNOWN;
      case 'REVOKED':
        return table.statusRevoked ?? t.status.UNKNOWN;
      case 'ERROR':
        return table.statusError ?? t.status.UNKNOWN;
      case 'NEEDS_AUTH':
        return table.statusNeedsAuth ?? t.status.UNKNOWN;
      default:
        return t.status.UNKNOWN;
    }
  };

  /** P9：CrossClaim 能否继续工作（由既有连接状态派生，未知状态回落到「需要重新授权」）。 */
  const continueLabel = (code: string): string => {
    const table = copy as unknown as Record<string, string>;
    switch (code) {
      case 'ACTIVE':
        return table.summaryCanContinue ?? t.status.UNKNOWN;
      case 'PAUSED':
        return table.summaryPaused ?? t.status.UNKNOWN;
      case 'REVOKED':
        return table.summaryStopped ?? t.status.UNKNOWN;
      default:
        return table.summaryNeedsReauth ?? t.status.UNKNOWN;
    }
  };

  /** 客户语言：渠道码 → 客户可读名称（未知码原样显示，不做猜测）。 */
  const channelLabel = (code: string): string => {
    const table = copy as unknown as Record<string, string>;
    const suffix = code
      .split('_')
      .map((word) => (word === '' ? '' : word[0] + word.slice(1).toLowerCase()))
      .join('');
    return table['channel' + suffix] ?? table.channelOther ?? t.status.UNKNOWN;
  };

  /** 向导：选择「想连接什么」→ 自动推导内部 kind / domain / channel。 */
  function applyWizard(next: WizardKey) {
    setWizard(next);
    if (next === 'PLATFORM_AMAZON') {
      setKind('API');
      setDomain('PLATFORM');
      setChannel('AMAZON_FBA');
    } else if (next === 'CARRIER_BILL') {
      setKind('FILE_UPLOAD');
      setDomain('LOGISTICS');
      setChannel('UPS');
    } else if (next === 'CUSTOMS_DOC') {
      setKind('FILE_UPLOAD');
      setDomain('CUSTOMS');
      setChannel('CUSTOMS_BROKER');
    }
  }

  const wizardHint = (): string => {
    const table = copy as unknown as Record<string, string>;
    if (wizard === 'PLATFORM_AMAZON') return table.wizardHintPlatform ?? '';
    if (wizard === 'CARRIER_BILL') return table.wizardHintCarrier ?? '';
    if (wizard === 'CUSTOMS_DOC') return table.wizardHintCustoms ?? '';
    return table.wizardHintAdvanced ?? '';
  };

  const statusTone = (code: string): BadgeTone => {
    switch (code) {
      case 'ACTIVE':
        return 'ok';
      case 'NEEDS_AUTH':
      case 'ERROR':
        return 'warn';
      case 'REVOKED':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  const actionLabel = (to: string): string => {
    const table = copy as unknown as Record<string, string>;
    switch (to) {
      case 'ACTIVE':
        return table.actionActivate ?? to;
      case 'PAUSED':
        return table.actionPause ?? to;
      case 'REVOKED':
        return table.actionRevoke ?? to;
      default:
        return to;
    }
  };

  async function call(path: string, init: RequestInit, okMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api${path}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(`${body.error ?? copy.requestFailed}（${response.status}）`.trim());
        return false;
      }
      setNotice(okMessage);
      router.refresh();
      return true;
    } catch {
      setError(copy.networkError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, unknown> = { label, kind, domain, channel };
    if (kind === 'API') payload.platform = platform;
    if (credentialRef.trim() !== '') payload.credentialRef = credentialRef.trim();

    const created = await call('/connections', { method: 'POST', body: JSON.stringify(payload) }, copy.noticeCreated);
    if (created) {
      setLabel('');
      setCredentialRef('');
      setPlatform('');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">{copy.listTitle}</h2>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{copy.empty}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{channelLabel(item.channel)}</p>
                  </div>
                  <StatusBadge tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusBadge>
                </div>

                {item.lastError ? <p className="mt-2 text-xs text-amber-700">{copy.lastErrorNotice}</p> : null}

                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">{copy.summaryLabel}</dt>
                    <dd className="mt-0.5 font-medium text-slate-800">{continueLabel(item.status)}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{copy.lastSyncLabel}</dt>
                    <dd className="mt-0.5 text-slate-800">
                      {item.lastSyncAt ? String(item.lastSyncAt).slice(0, 10) : copy.lastSyncNever}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-2">
                  {(NEXT_STATUSES[item.status] ?? []).map((to) => (
                    <button
                      key={to}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void call(
                          `/connections/${item.id}/status`,
                          { method: 'POST', body: JSON.stringify({ to }) },
                          copy.noticeStatus,
                        )
                      }
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    >
                      {actionLabel(to)}
                    </button>
                  ))}
                </div>

                <details className="mt-3 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">{copy.advanced}</summary>
                  {item.status !== 'REVOKED' ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <input
                        value={refDraft[item.id] ?? ''}
                        onChange={(event) =>
                          setRefDraft((prev) => ({ ...prev, [item.id]: event.target.value }))
                        }
                        className="w-48 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        placeholder={copy.newRefPlaceholder}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void call(
                            `/connections/${item.id}/credential-ref`,
                            {
                              method: 'POST',
                              body: JSON.stringify({ credentialRef: (refDraft[item.id] ?? '').trim() || null }),
                            },
                            copy.noticeRefUpdated,
                          )
                        }
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {copy.updateRef}
                      </button>
                    </div>
                  ) : null}
                  <p className="mt-2">
                    {copy.colCredentialRef}: {item.hasCredentialRef ? copy.configured : copy.notConfigured}
                  </p>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    <li>kind={item.kind}</li>
                    <li>domain={item.domain}</li>
                    <li>channel={item.channel}</li>
                    <li>status={item.status}</li>
                    <li>platform={item.platform ?? '-'}</li>
                    <li>credentialRef={item.hasCredentialRef ? 'SET' : 'UNSET'}</li>
                    <li>lastSyncAt={item.lastSyncAt ?? '-'}</li>
                    <li>lastError={item.lastError ?? '-'}</li>
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">{copy.formTitle}</h2>
        {wizard === 'ADVANCED' ? (
          <p className="mt-1 text-xs text-slate-500">{copy.formHint}</p>
        ) : null}
        <form onSubmit={create} className="mt-4 space-y-3">
          <label className="block text-sm">
            {copy.wizardTitle}
            <select
              value={wizard}
              onChange={(event) => applyWizard(event.target.value as WizardKey)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
            >
              <option value="PLATFORM_AMAZON">{copy.wizardAmazon}</option>
              <option value="CARRIER_BILL">{copy.wizardCarrier}</option>
              <option value="CUSTOMS_DOC">{copy.wizardCustoms}</option>
              <option value="ADVANCED">{copy.wizardAdvanced}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">{wizardHint()}</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {copy.name}
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
                placeholder={copy.namePlaceholder}
              />
            </label>
            <div className={wizard === 'ADVANCED' ? 'text-sm' : 'hidden'}>
            <label className="text-sm">
              {copy.kind}
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
              >
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {copy.domain}
              <select
                value={domain}
                onChange={(event) => setDomain(event.target.value as (typeof DOMAINS)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
              >
                {DOMAINS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {copy.channel}
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as (typeof CHANNELS)[number])}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
              >
                {CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'API' ? (
              <label className="text-sm">
                {copy.platform}
                <input
                  value={platform}
                  onChange={(event) => setPlatform(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
                  placeholder={copy.platformPlaceholder}
                />
              </label>
            ) : null}
            <label className="text-sm">
              {copy.credentialRef}
              <input
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5"
                placeholder={copy.refPlaceholder}
              />
            </label>
            </div>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
          <button
            type="submit"
            disabled={busy || label.trim() === ''}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {copy.create}
          </button>
        </form>
      </section>
    </div>
  );
}
