/**
* originCompareService.ts —— 多协定原产地/优惠税率比对
* 按 HS 前缀匹配各 FTA 的原产地规则,结合目的国成员资格,给出 MFN 基准与最优协定路径。
* 返回结构与前端 OriginPage「协定比对」一致(routes 表 + bestRoute 卡片)。
*/
import prisma from '../config/database';
import { logger } from '../config/logger';
export interface CompareRoute {
ftaAgreement: { shortName: string };
ftaShortName: string;
hsCode: string;
ruleType: string;
ruleDetail: string | null;
rvcThreshold: number | null;
tariffReduction: number | null;
source: string | null;
effectiveDate: Date | null;
}
export interface CompareResult {
hsCode: string;
classification: string;
destinationName: string;
destinationCountry: string;
mfnRate: number | null;
bestRoute: { ftaShortName: string; tariffRate: number } | null;
applicableFtas: number;
routes: CompareRoute[];
}
function memberCovers(memberCountries: string, dest: string): boolean {
if (!memberCountries) return false;
const hay = memberCountries.toLowerCase();
const needle = dest.trim().toLowerCase();
if (!needle) return false;
// memberCountries 可能是逗号分隔或 JSON 数组字符串,统一做包含匹配
return hay.includes(needle);
}
export async function compareOrigins(tenantId: string, hsCode: string, destCountry: string): Promise<CompareResult> {
const code = String(hsCode || '').trim();
const dest = String(destCountry || '').trim();
const prefix4 = code.replace(/\D/g, '').slice(0, 4);
const hsRecord = prefix4
? await prisma.hSCode.findFirst({ where: { code: { startsWith: prefix4 } } }).catch(() => null)
: null;
const rules = prefix4
? await prisma.originRule.findMany({
where: { hsCode: { startsWith: prefix4 } },
include: { ftaAgreement: { select: { shortName: true, name: true, memberCountries: true, isActive: true } } },
take: 50,
}).catch(() => [] as any[])
: [];
// 仅保留目的国被该 FTA 覆盖的规则(成员国列表为空则视为不限定,一并保留)
const applicable = rules.filter((r: any) => {
const mc = r.ftaAgreement?.memberCountries || '';
return r.ftaAgreement?.isActive !== false && (!mc || !dest || memberCovers(mc, dest));
});
const routes: CompareRoute[] = applicable.map((r: any) => ({
ftaAgreement: { shortName: r.ftaAgreement?.shortName || '-' },
ftaShortName: r.ftaAgreement?.shortName || '-',
hsCode: r.hsCode,
ruleType: r.ruleType,
ruleDetail: r.ruleDetail ?? null,
rvcThreshold: r.rvcThreshold ?? null,
tariffReduction: r.tariffReduction ?? null,
source: r.source ?? null,
effectiveDate: r.effectiveDate ?? null,
}));
const withRate = routes.filter((r) => r.tariffReduction != null) as (CompareRoute & { tariffReduction: number })[];
const best = withRate.sort((a, b) => a.tariffReduction - b.tariffReduction)[0];
const bestRoute = best ? { ftaShortName: best.ftaShortName, tariffRate: best.tariffReduction } : null;
logger.info('[originCompare] tenant=%s hs=%s dest=%s rules=%d applicable=%d', tenantId, code, dest, rules.length, routes.length);
return {
hsCode: code,
classification: hsRecord?.description || '未匹配到商品归类',
destinationName: dest,
destinationCountry: dest,
mfnRate: hsRecord?.tariffRate ?? null,
bestRoute,
applicableFtas: routes.length,
routes,
};
}
export async function getBestFta(tenantId: string, hsCode: string, destCountry: string): Promise<{ ftaShortName: string; tariffRate: number } | null> {
const result = await compareOrigins(tenantId, hsCode, destCountry);
return result.bestRoute;
}
