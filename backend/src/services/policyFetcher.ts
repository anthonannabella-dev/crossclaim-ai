import axios from 'axios';
import prisma from '../config/database';

// ============================================================
// 政策源定义 — 3个全国性源 + 10个主要直属海关
// ============================================================

interface PolicySource {
  name: string;
  url: string;
  category: string;
  portCode: string | null;   // null表示全国性, 如"shanghai"表示上海海关
  sourceType: 'NATIONAL' | 'LOCAL';
}

const POLICY_SOURCES: PolicySource[] = [
  // ─── 全国性：海关总署、商务部、关税司 ───
  {
    name: '海关总署',
    url: 'http://www.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: null,
    sourceType: 'NATIONAL',
  },
  {
    name: '商务部',
    url: 'http://www.mofcom.gov.cn/article/zwgk/bnjg/',
    category: 'rcep',
    portCode: null,
    sourceType: 'NATIONAL',
  },
  {
    name: '国务院关税税则委员会',
    url: 'http://gss.mof.gov.cn/gzdt/zhengcefabu/',
    category: 'tariff',
    portCode: null,
    sourceType: 'NATIONAL',
  },

  // ─── 地方性：10个主要直属海关（覆盖80%以上业务量） ───
  {
    name: '上海海关',
    url: 'http://shanghai.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'shanghai',
    sourceType: 'LOCAL',
  },
  {
    name: '深圳海关',
    url: 'http://shenzhen.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'shenzhen',
    sourceType: 'LOCAL',
  },
  {
    name: '宁波海关',
    url: 'http://ningbo.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'ningbo',
    sourceType: 'LOCAL',
  },
  {
    name: '广州海关',
    url: 'http://guangzhou.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'guangzhou',
    sourceType: 'LOCAL',
  },
  {
    name: '青岛海关',
    url: 'http://qingdao.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'qingdao',
    sourceType: 'LOCAL',
  },
  {
    name: '天津海关',
    url: 'http://tianjin.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'tianjin',
    sourceType: 'LOCAL',
  },
  {
    name: '黄埔海关',
    url: 'http://huangpu.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'huangpu',
    sourceType: 'LOCAL',
  },
  {
    name: '厦门海关',
    url: 'http://xiamen.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'xiamen',
    sourceType: 'LOCAL',
  },
  {
    name: '大连海关',
    url: 'http://dalian.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'dalian',
    sourceType: 'LOCAL',
  },
  {
    name: '北京海关',
    url: 'http://beijing.customs.gov.cn/customs/302249/302266/302267/index.html',
    category: 'customs',
    portCode: 'beijing',
    sourceType: 'LOCAL',
  },
];

// 口岸名称映射（用于前端显示和用户配置匹配）
export const PORT_LABELS: Record<string, string> = {
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

interface FetchResult {
  title: string;
  content: string;
  source: string;
  publishDate: Date;
  category: string;
  url: string;
  portCode: string | null;
  sourceType: 'NATIONAL' | 'LOCAL';
}

// 从单个源抓取政策列表
async function fetchFromSource(source: PolicySource): Promise<FetchResult[]> {
  try {
    const response = await axios.get(source.url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    const html = response.data as string;
    const results: FetchResult[] = [];

    // 匹配政府网站常见列表格式: <a href="..." title="...">...</a>
    const linkPattern = /<a[^>]*href="([^"]*)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi;
    const datePattern = /(\d{4}[-/]\d{2}[-/]\d{2})/;

    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const href = match[1];
      const title = match[2].trim();
      if (!title || title.length < 6) continue;

      const absoluteUrl = href.startsWith('http') ? href
        : href.startsWith('/') ? new URL(href, source.url).href
        : `${source.url}${href}`;

      const dateMatch = datePattern.exec(title + href) || datePattern.exec(absoluteUrl);
      const publishDate = dateMatch ? new Date(dateMatch[1]) : new Date();

      results.push({
        title,
        content: '',
        source: source.name,
        publishDate,
        category: source.category,
        url: absoluteUrl,
        portCode: source.portCode,
        sourceType: source.sourceType,
      });
    }

    return results.slice(0, 10);
  } catch (err) {
    console.error(`[PolicyFetcher] 抓取失败 ${source.name}:`, (err as Error).message);
    return [];
  }
}

// 获取详情页正文
async function fetchArticleContent(articleUrl: string): Promise<string> {
  try {
    const response = await axios.get(articleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const html = response.data as string;
    const bodyMatch = /<div[^>]*(?:article|content|main|TRS_Editor)[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    const text = bodyMatch ? bodyMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
    return text.slice(0, 5000);
  } catch {
    return '';
  }
}

// ─── 主抓取函数：增量更新，按标题去重，标记全国/地方 ───
export async function fetchLatestPolicies(): Promise<number> {
  let newCount = 0;

  for (const source of POLICY_SOURCES) {
    try {
      const items = await fetchFromSource(source);

      for (const item of items) {
        const existing = await prisma.policyAlert.findFirst({
          where: { title: item.title, source: item.source },
        });

        if (!existing) {
          let content = item.content;
          if (!content) {
            content = await fetchArticleContent(item.url);
          }

          await prisma.policyAlert.create({
            data: {
              title: item.title,
              content: content || '',
              summary: content ? content.slice(0, 200) : '',
              source: item.source,
              publishDate: item.publishDate,
              category: source.category,
              portCode: item.portCode,
              sourceType: item.sourceType,
            },
          });
          newCount++;
        }
      }
    } catch (err) {
      console.error(`[PolicyFetcher] Error processing ${source.name}:`, (err as Error).message);
    }
  }

  return newCount;
}

// ─── 获取端口列表（供前端下拉框使用） ───
export function getAvailablePorts(): { value: string; label: string; type: string }[] {
  const ports = POLICY_SOURCES
    .filter(s => s.sourceType === 'LOCAL')
    .map(s => ({
      value: s.portCode!,
      label: s.name,
      type: 'LOCAL',
    }));
  return ports;
}

// ─── 搜索政策（支持按口岸、按类型、按关键词） ───
export async function searchPolicySource(params: {
  keyword?: string;
  category?: string;
  portCode?: string;
  sourceType?: string;
  limit?: number;
}) {
  const where: any = { isActive: true };
  const { keyword, category, portCode, sourceType, limit = 50 } = params;

  if (category) where.category = category;
  if (portCode) where.portCode = portCode;
  if (sourceType) where.sourceType = sourceType;
  if (keyword) {
    where.OR = [
      { title: { contains: keyword } },
      { content: { contains: keyword } },
    ];
  }

  return prisma.policyAlert.findMany({
    where,
    orderBy: { publishDate: 'desc' },
    take: limit,
  });
}
