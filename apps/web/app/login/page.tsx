'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? '登录失败');
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-xl font-semibold">登录</h1>
      <p className="mt-2 text-sm text-slate-600">
        CrossClaim 目前采用邀请制，未开放自助注册。请使用收到的邀请链接设置密码。
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-slate-700">邮箱</span>
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
          <span className="text-slate-700">密码</span>
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
