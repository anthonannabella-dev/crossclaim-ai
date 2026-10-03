'use client';

import { useState, type FormEvent } from 'react';

/**
 * PC-01A 自助注册表单。
 * - gate 关闭：只显示「暂不可用」（不渲染可用表单）。
 * - 成功后必须明确提示：账号已创建但**需要邮箱验证**（PC-01B），且当前未登录。
 */
export default function SignupForm({ enabled }: { enabled: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { organizationId: string }>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <h1 className="text-base font-semibold">自助注册暂不可用</h1>
        <p className="mt-2">
          Self-service signup is currently unavailable. 当前为邀请制：请联系组织管理员发送邀请。
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <h1 className="text-base font-semibold">账号已创建 / Account created</h1>
        <p className="mt-2">
          还需要完成邮箱验证才能登录（当前未自动登录）。Email verification is still required before sign-in.
        </p>
        <p className="mt-1 text-xs text-amber-800">organizationId: {done.organizationId}</p>
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
      };
      if (!response.ok) {
        setError(body.message ?? body.error ?? '注册失败 / Signup failed');
        return;
      }
      setDone({ organizationId: String(body.organizationId ?? '') });
    } catch {
      setError('网络错误 / Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold">创建账号 / Create account</h1>
      <p className="mt-2 text-sm text-slate-600">
        自助注册会创建你的组织与 OWNER 成员身份；完成后仍需邮箱验证（PC-01B）。
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-slate-700">邮箱 / Email</span>
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
          <span className="text-slate-700">密码 / Password</span>
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
          <span className="text-slate-700">组织名称 / Organization</span>
          <input
            type="text"
            required
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-700">显示名称 / Display name（可选）</span>
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
          {busy ? '提交中…' : '创建账号 / Sign up'}
        </button>
      </form>
    </div>
  );
}
