'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

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
}

export default function ConnectionManager({ items, t }: { items: ConnectionItem[]; t: Messages }) {
  const copy = t.connectionsPage;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('FILE_UPLOAD');
  const [domain, setDomain] = useState<(typeof DOMAINS)[number]>('LOGISTICS');
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('UPS');
  const [platform, setPlatform] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [refDraft, setRefDraft] = useState<Record<string, string>>({});

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
      <form onSubmit={create} className="space-y-3 rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{copy.formTitle}</h2>
        <p className="text-xs text-slate-500">{copy.formHint}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            {copy.name}
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder={copy.namePlaceholder}
            />
          </label>
          <label className="text-sm">
            {copy.kind}
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
              className="mt-1 w-full rounded border px-2 py-1"
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
              className="mt-1 w-full rounded border px-2 py-1"
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
              className="mt-1 w-full rounded border px-2 py-1"
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
                className="mt-1 w-full rounded border px-2 py-1"
                placeholder={copy.platformPlaceholder}
              />
            </label>
          ) : null}
          <label className="text-sm">
            {copy.credentialRef}
            <input
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder={copy.refPlaceholder}
            />
          </label>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}
        <button
          type="submit"
          disabled={busy || label.trim() === ''}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {copy.create}
        </button>
      </form>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">{copy.listTitle}</h2>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{copy.empty}</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">{copy.colName}</th>
                <th>{copy.colChannel}</th>
                <th>{copy.colKind}</th>
                <th>{copy.colStatus}</th>
                <th>{copy.colCredentialRef}</th>
                <th>{copy.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t align-top">
                  <td className="py-2">
                    {item.label}
                    {item.platform ? (
                      <span className="ml-2 rounded bg-slate-100 px-1 text-xs text-slate-600">{item.platform}</span>
                    ) : null}
                  </td>
                  <td>{item.channel}</td>
                  <td>{item.kind}</td>
                  <td>
                    {item.status}
                    {item.lastError ? <div className="text-xs text-red-600">{item.lastError}</div> : null}
                  </td>
                  <td>{item.hasCredentialRef ? copy.configured : copy.notConfigured}</td>
                  <td className="space-y-2">
                    <div className="flex flex-wrap gap-2">
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
                          className="rounded border px-2 py-1 text-xs disabled:opacity-60"
                        >
                          {to}
                        </button>
                      ))}
                    </div>
                    {item.status !== 'REVOKED' ? (
                      <div className="flex gap-2">
                        <input
                          value={refDraft[item.id] ?? ''}
                          onChange={(event) => setRefDraft((prev) => ({ ...prev, [item.id]: event.target.value }))}
                          className="w-40 rounded border px-2 py-1 text-xs"
                          placeholder={copy.newRefPlaceholder}
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void call(
                              `/connections/${item.id}/credential-ref`,
                              { method: 'POST', body: JSON.stringify({ credentialRef: (refDraft[item.id] ?? '').trim() || null }) },
                              copy.noticeRefUpdated,
                            )
                          }
                          className="rounded border px-2 py-1 text-xs disabled:opacity-60"
                        >
                          {copy.updateRef}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
