import { cookies } from 'next/headers';

import { getServerMessages } from '../../../../i18n/server';
import InlineNotice from '../../../components/ui/inline-notice';
import { buildAgentRunView, type AgentRunPayload } from '../../../lib/agent-run-view';
import AgentRunView from './agent-run-view';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: (await response.json()) as T };
}

export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getServerMessages();
  const result = await apiGet<AgentRunPayload>(`/agent-goals/${encodeURIComponent(id)}`);

  if (!result.ok || result.body === null) {
    return (
      <InlineNotice tone="info" title={t.agentRun.notFoundTitle}>
        {t.agentRun.notFound}
      </InlineNotice>
    );
  }

  return <AgentRunView view={buildAgentRunView(result.body, t)} t={t} />;
}
