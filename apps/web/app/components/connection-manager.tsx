'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/** 与后端 Prisma enum 保持一致；Web 不导入 Prisma，这里只维护词表。 */
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

export default function ConnectionManager({ items }: { items: ConnectionItem[] }) {
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
        setError(`${
          body.error ?? '请求失败'
        }（${response.status}）`.trim());
        return false;
      }
      setNotice(okMessage);
      router.refresh();
      return true;
    } catch {
      setError('网络异常，请稍后重试');
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

    const created = await call(
      '/connections',
      { method: 'POST', body: JSON.stringify(payload) },
      '连接已创建',
    );
    if (created) {
      setLabel('');
      setCredentialRef('');
      setPlatform('');
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="space-y-3 rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">新建采集连接</h2>
        <p className="text-xs text-slate-500">
          credentialRef 只填写<b>引用名</b>（例如 vault:ups-2026），系统会拒绝真实密钥或令牌。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            名称
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder="UPS 月度账单"
            />
          </label>
          <label className="text-sm">
            类型
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
            领域
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
            渠道
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
              适配器 platform
              <input
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
                className="mt-1 w-full rounded border px-2 py-1"
                placeholder="仅限已注册适配器"
              />
            </label>
          ) : null}
          <label className="text-sm">
            凭据引用（可选）
            <input
              value={credentialRef}
              onChange={(event) => setCredentialRef(event.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder="vault:ups-2026"
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
          创建连接
        </button>
      </form>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-lg font-medium">连接列表</h2>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">暂无连接。</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">名称</th>
                <th>渠道</th>
                <th>类型</th>
                <th>状态</th>
                <th>凭据引用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t align-top">
                  <td className="py-2">
                    {item.label}
                    {item.platform ? (
                      <span className="ml-2 rounded bg-slate-100 px-1 text-xs text-slate-600">
                        {item.platform}
                      </span>
                    ) : null}
                  </td>
                  <td>{item.channel}</td>
                  <td>{item.kind}</td>
                  <td>
                    {item.status}
                    {item.lastError ? (
                      <div className="text-xs text-red-600">{item.lastError}</div>
                    ) : null}
                  </td>
                  <td>{item.hasCredentialRef ? '已配置' : '未配置'}</td>
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
                              `连接已切换为 ${to}`,
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
                          onChange={(event) =>
                            setRefDraft((prev) => ({ ...prev, [item.id]: event.target.value }))
                          }
                          className="w-40 rounded border px-2 py-1 text-xs"
                          placeholder="新凭据引用"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void call(
                              `/connections/${item.id}/credential-ref`,
                              {
                                method: 'POST',
                                body: JSON.stringify({
                                  credentialRef: (refDraft[item.id] ?? '').trim() || null,
                                }),
                              },
                              '凭据引用已更新',
                            )
                          }
                          className="rounded border px-2 py-1 text-xs disabled:opacity-60"
                        >
                          更新引用
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
