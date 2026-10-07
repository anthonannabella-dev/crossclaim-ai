'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * PC-01A 自助注册表单。
 * - gate 关闭：只显示「暂不可用」（不渲染可用表单）。
 * - 成功后必须明确提示：账号已创建但**需要邮箱验证**（PC-01B），且当前未登录。
 */
export default function SignupForm({ enabled, t }: { enabled: boolean; t: Messages }) {
  const copy = t.signupPage;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { organizationId: string; emailDelivered: boolean | null }>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <h1 className="text-base font-semibold">{copy.disabledTitle}</h1>
        <p className="mt-2">{copy.disabledNote}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <h1 className="text-base font-semibold">{copy.createdTitle}</h1>
        <p className="mt-2">{copy.createdNote}</p>
        <p className="mt-2">{copy.verifyNextStep}</p>
        {done.emailDelivered === false ? <p className="mt-2">{copy.verifyChannelUnavailable}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={resend}
            className="rounded bg-amber-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {copy.resendVerification}
          </button>
          <Link href="/login" className="text-xs underline">
            {t.common.goToLogin}
          </Link>
        </div>
        {notice ? <p className="mt-2 text-xs">{notice}</p> : null}
        <details className="mt-3 text-xs">
          <summary>{copy.advancedInfo}</summary>
          <p className="mt-1 break-all">organizationId: {done.organizationId}</p>
        </details>
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, organizationName, displayName }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        organizationId?: string;
        verificationEmail?: { requested?: boolean; delivered?: boolean };
      };
      if (!response.ok) {
        setError(body.message ?? body.error ?? copy.failed);
        return;
      }
      setDone({
        organizationId: String(body.organizationId ?? ''),
        emailDelivered:
          body.verificationEmail === undefined ? null : body.verificationEmail.delivered === true,
      });
    } catch {
      setError(t.common.networkError);
    } finally {
      setBusy(false);
    }
  }

  /** 重发验证邮件：无论邮件通道是否已接入，都给客户一个明确、诚实的下一步。 */
  async function resend() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        setError(t.common.requestFailed.replace('{status}', String(response.status)));
        return;
      }
      setNotice(copy.resendAccepted);
    } catch {
      setError(t.common.networkError);
    } finally {
      setBusy(false);
    }
  }


  return (
    <div>
      <h1 className="text-xl font-semibold">{copy.title}</h1>
      <p className="mt-2 text-sm text-slate-600">{copy.description}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-slate-700">{copy.email}</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            autoComplete="username"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700">{copy.password}</span>
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            autoComplete="new-password"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700">{copy.organization}</span>
          <input
            type="text"
            required
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700">{copy.displayName}</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? copy.submitting : copy.submit}
        </button>
      </form>
    </div>
  );
}
