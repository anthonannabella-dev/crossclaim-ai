import { fetchLatestPolicies } from './policyFetcher';
import { callAI } from './ai/deepseek';
import { sendNotification } from './notificationHub';
import prisma from '../config/database';

// ============================================================
// AI 政策分析：摘要 + 影响级别 + 受影响HS编码
// ============================================================

export async function summarizePolicy(title: string, content: string): Promise<{
  summary: string;
  impactLevel: string;
  affectedHsCodes?: string[];
  actionRequired?: string;
}> {
  const prompt = `${title}\n\n${(content || '').slice(0, 3000)}`;

  const raw = await callAI(`你是一位海关政策分析专家。请分析以下政策法规，提取关键信息：

${prompt}

请返回JSON格式（不要加代码块标记）:
{
  "summary": "300字以内的政策摘要",
  "impactLevel": "HIGH/MEDIUM/LOW",
  "affectedHsCodes": ["受影响的HS编码章节，如72、84、85等"],
  "actionRequired": "企业应采取的合规行动建议"
}`, {
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 800,
  });

  try {
    if (!raw) return { summary: title, impactLevel: 'MEDIUM' };
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { summary: title, impactLevel: 'MEDIUM' };
  }
}

// ─── 判断一条政策是否与租户的业务相关 ───
function isRelevantToTenant(
  policy: { portCode?: string | null; affectedHsCodes?: string | null; category: string },
  tenant: { preferredPorts?: string | null; hsCodeRanges?: string | null },
): 'HIGH' | 'MEDIUM' | 'LOW' {
  let relevance: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';

  // 1. 按口岸匹配：如果政策是地方性的(LOCAL)，且用户配了这个口岸 → 高相关性
  if (tenant.preferredPorts && policy.portCode) {
    const ports: string[] = JSON.parse(tenant.preferredPorts);
    if (ports.includes(policy.portCode)) {
      relevance = 'HIGH';
    }
  }

  // 2. 按HS编码匹配：政策影响某章节，用户刚好做这个品类 → 高相关性
  if (tenant.hsCodeRanges && policy.affectedHsCodes) {
    const userHsCodes: string[] = JSON.parse(tenant.hsCodeRanges);
    const policyHsCodes: string[] = policy.affectedHsCodes.split(',').map(h => h.trim());
    const hasOverlap = userHsCodes.some(u => policyHsCodes.some(p => p === u || u.startsWith(p)));
    if (hasOverlap) {
      relevance = 'HIGH';
    }
  }

  // 3. 没有配置任何偏好 → 默认MEDIUM
  if (!tenant.preferredPorts && !tenant.hsCodeRanges) {
    relevance = 'MEDIUM';
  }

  return relevance;
}

// ─── 主策略：抓取 → AI分析 → 按用户过滤 → 精准推送 ───
export async function runPolicyMonitor(): Promise<{
  newPolicies: number;
  notificationsSent: number;
}> {
  const newCount = await fetchLatestPolicies();
  if (newCount === 0) return { newPolicies: 0, notificationsSent: 0 };

  // 获取新政策（尚未AI摘要）
  const unsummarized = await prisma.policyAlert.findMany({
    where: { impactLevel: null },
    orderBy: { createdAt: 'desc' },
    take: newCount,
  });

  let summarized = 0;
  for (const policy of unsummarized) {
    try {
      const aiResult = await summarizePolicy(policy.title, policy.content ?? '');
      await prisma.policyAlert.update({
        where: { id: policy.id },
        data: {
          summary: aiResult.summary,
          impactLevel: aiResult.impactLevel,
          affectedHsCodes: aiResult.affectedHsCodes?.join(',') ?? null,
          actionRequired: aiResult.actionRequired || null,
        },
      });
      summarized++;
    } catch {
      await prisma.policyAlert.update({
        where: { id: policy.id },
        data: { summary: policy.content?.slice(0, 200) || policy.title },
      });
    }
  }

  // ─── 精准推送：按每个用户的业务配置过滤 ───
  let notificationsSent = 0;
  const activeTenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      companyName: true,
      preferredPorts: true,
      hsCodeRanges: true,
    },
  });

  for (const policy of unsummarized) {
    if (!policy.impactLevel || policy.impactLevel === 'LOW') continue;

    for (const tenant of activeTenants) {
      // 全国性政策(HIGH)推给所有活跃用户
      // 地方性政策只推给关联口岸的用户
      const relevance = isRelevantToTenant(
        { portCode: policy.portCode, affectedHsCodes: policy.affectedHsCodes, category: policy.category },
        { preferredPorts: tenant.preferredPorts, hsCodeRanges: tenant.hsCodeRanges },
      );

      // 只有HIGH关联度的才推送
      if (relevance !== 'HIGH' && policy.impactLevel !== 'HIGH') continue;

      const portTag = policy.portCode
        ? `[${PORT_LABELS[policy.portCode] || policy.portCode}]`
        : '[全国]';

      await sendNotification({
        tenantId: tenant.id,
        event: 'policy_update',
        title: `${portTag} ${policy.impactLevel === 'HIGH' ? '⚠️' : '📢'} ${policy.title.slice(0, 60)}`,
        message: (policy.summary || '').slice(0, 300),
      }).catch(() => {});

      notificationsSent++;
    }
  }

  return { newPolicies: newCount, notificationsSent };
}

// ─── 端口标签映射 ───
const PORT_LABELS: Record<string, string> = {
  shanghai: '上海海关',
  shenzhen: '深圳海关',
  ningbo: '宁波海关',
  guangzhou: '广州海关',
  qingdao: '青岛海关',
  tianjin: '天津海关',
  huangpu: '黄埔海关',
  xiamen: '厦门海关',
  dalian: '大连海关',
  beijing: '北京海关',
};

// ─── 政策统计 ───
export async function getPolicyAnalytics() {
  const [total, highImpact, byCategory, bySourceType] = await Promise.all([
    prisma.policyAlert.count({ where: { isActive: true } }),
    prisma.policyAlert.count({ where: { isActive: true, impactLevel: 'HIGH' } }),
    prisma.policyAlert.groupBy({
      by: ['category'],
      where: { isActive: true },
      _count: true,
    }),
    prisma.policyAlert.groupBy({
      by: ['sourceType'],
      where: { isActive: true },
      _count: true,
    }),
  ]);

  return {
    totalPolicies: total,
    highImpactCount: highImpact,
    byCategory: byCategory.map((c: any) => ({ category: c.category, count: c._count })),
    bySourceType: bySourceType.map((s: any) => ({ sourceType: s.sourceType, count: s._count })),
  };
}
