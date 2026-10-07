'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import type { Messages } from '../../i18n';

export default function LoginForm({ t }: { t: Messages }) {
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
        setError(body.message ?? t.login.failed);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError(t.uploadPage.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-xl font-semibold">{t.login.title}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.footerNote}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-slate-700">{t.login.email}</span>
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
          <span className="text-slate-700">{t.login.password}</span>
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
          {busy ? t.login.submitting : t.login.submit}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        {t.login.noAccount}{' '}
        <Link href="/signup" className="text-slate-900 underline">
          {t.common.createAccount}
        </Link>
      </p>
      <p className="mt-4 text-sm text-slate-600">
        {t.login.noAccount}{' '}
        <Link href="/signup" className="text-slate-900 underline">
          {t.common.createAccount}
        </Link>
      </p>
    </div>
  );
}
