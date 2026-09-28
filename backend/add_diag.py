# -*- coding: utf-8 -*-
f = 'D:/customs-saas/backend/src/services/groupPipelineService.ts'
s = open(f, encoding='utf-8').read()
old = """ // —— 用 AI 结构化提取补全真实商品明细(数量/单价/品名/原产国),替代写死的占位值 ——
let aiItems: any[] = [];
try {
const { extractWithAI } = await import('./ocrParser');
const aiDocs = await prisma.document.findMany({
where: { tenantId: group.tenantId, billOfLading: group.billOfLading, ocrResult: { not: null } },
});
const combinedText = aiDocs.map((d: any) => d.ocrResult || '').join('\n');
if (combinedText.trim()) {
const extracted = await extractWithAI(combinedText, 'declaration');
if (extracted && Array.isArray((extracted as any).items)) {
aiItems = (extracted as any).items.filter((it: any) => it && (it.hsCode || it.description));
}
}
} catch (e) { /* AI 提取失败则回退占位逻辑,不影响主流程 */ }"""

new = """ // —— 用 AI 结构化提取补全真实商品明细(数量/单价/品名/原产国),替代写死的占位值 ——
let aiItems: any[] = [];
try {
logger.warn('[AUTOFILL-DIAG] start group=' + groupId + ' bl=[' + String(group.billOfLading) + ']');
const { extractWithAI } = await import('./ocrParser');
const aiDocs = await prisma.document.findMany({
where: { tenantId: group.tenantId, billOfLading: group.billOfLading, ocrResult: { not: null } },
});
const combinedText = aiDocs.map((d: any) => d.ocrResult || '').join('\n');
logger.warn('[AUTOFILL-DIAG] aiDocs=' + aiDocs.length + ' combinedLen=' + combinedText.length);
if (combinedText.trim()) {
const extracted = await extractWithAI(combinedText, 'declaration');
logger.warn('[AUTOFILL-DIAG] extracted keys=' + JSON.stringify(Object.keys((extracted as any) || {})) + ' itemsIsArray=' + Array.isArray((extracted as any).items) + ' itemsLen=' + (((extracted as any).items || []).length));
if (extracted && Array.isArray((extracted as any).items)) {
aiItems = (extracted as any).items.filter((it: any) => it && (it.hsCode || it.description));
}
}
logger.warn('[AUTOFILL-DIAG] final aiItems=' + aiItems.length + ' sample=' + JSON.stringify(aiItems[0] || null));
} catch (e: any) { logger.warn('[AUTOFILL-DIAG] EXCEPTION ' + (e && e.message ? e.message : String(e))); }"""

assert s.count(old) == 1, '补丁段未唯一匹配'
s = s.replace(old, new)
open(f, 'w', encoding='utf-8').write(s)
print('OK: 诊断日志已加入')
