import prisma from '../config/database';
import { eventEmitter } from './webhook/eventEmitter';
import { DeclarationData, runPreCheck, CustomsMode, PreCheckResult, CUSTOMS_MODE_INFO } from './declarationBuilder';
import * as XLSX from 'xlsx';

// ============================================================
// 报关单持久化服务（草稿箱 + 历史 + 退单重报）
// ============================================================

export type DeclarationStatus = 'draft' | 'submitted' | 'rejected' | 'resubmitted' | 'completed';

/** 保存草稿 */
export async function saveDraft(tenantId: string, data: DeclarationData, preCheck?: PreCheckResult): Promise<any> {
  // 从预检结果中提取退单代码和原因
  let rejectionCode: string | null = null;
  let rejectionReason: string | null = null;
  if (preCheck) {
    const firstError = preCheck.issues.find(i => i.severity === 'error');
    if (firstError) {
      rejectionCode = firstError.code;
      rejectionReason = firstError.message;
    }
  }

  const payload = {
    tenantId,
    declarationNo: data.declarationNo || null,
    status: 'draft' as const,
    customsMode: data.customsMode || 'normal',
    supervisionCode: data.supervisionCode || null,
    taxMethod: data.taxMethod || null,
    declarationJson: JSON.stringify(data),
    itemsJson: JSON.stringify(data.items || []),
    totalValue: data.totalValue || 0,
    currency: data.currency || 'USD',
    billOfLading: (data.billOfLading || (data as any).transport?.billOfLading || null),
    score: preCheck?.score ?? null,
    preCheckPassed: preCheck?.passed ?? null,
    rejectionCode,
    rejectionReason,
  };
  return prisma.declaration.create({ data: payload });
}

/** 提交（draft -> submitted） */
export async function submitDeclaration(tenantId: string, id: string): Promise<any> {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) throw new Error('\u62a5\u5173\u5355\u4e0d\u5b58\u5728');
  if (doc.status !== 'draft') throw new Error(`\u5f53\u524d\u72b6\u6001(${doc.status})\u4e0d\u53ef\u63d0\u4ea4`);

  await prisma.auditLog.create({ data: { tenantId, action: 'declaration_submit', entityType: doc.billOfLading ? 'bill_of_lading' : 'declaration', entityId: doc.billOfLading || doc.id, detail: `\u63d0\u4ea4: ${doc.declarationNo || doc.id}` } }).catch(() => {});
  return prisma.declaration.update({ where: { id }, data: { status: 'submitted' } });
}

/** 退单（submitted -> rejected） */
export async function rejectDeclaration(tenantId: string, id: string, code: string, reason: string) {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) throw new Error('\u4e0d\u5b58\u5728');
  if (doc.status !== 'submitted') throw new Error(`\u72b6\u6001(${doc.status})\u4e0d\u53ef\u9000\u5355`);
  return prisma.declaration.update({ where: { id }, data: { status: 'rejected', rejectionCode: code, rejectionReason: reason, rejectedAt: new Date() } });
}

/** 重报（rejected -> resubmitted，可改单） */
export async function resubmitDeclaration(tenantId: string, id: string, updatedData?: DeclarationData, preCheck?: PreCheckResult) {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) throw new Error('\u4e0d\u5b58\u5728');
  if (doc.status !== 'rejected') throw new Error(`\u72b6\u6001(${doc.status})\u4e0d\u53ef\u91cd\u62a5`);

  const update: any = { status: 'resubmitted', resubmittedAt: new Date(), rejectionCode: null, rejectionReason: null };
  if (updatedData) {
    update.declarationJson = JSON.stringify(updatedData);
    update.itemsJson = JSON.stringify(updatedData.items || []);
    update.totalValue = updatedData.totalValue || 0;
    if (preCheck) { update.score = preCheck.score; update.preCheckPassed = preCheck.passed; }
  }

  await prisma.auditLog.create({ data: { tenantId, action: 'declaration_resubmit', entityType: doc.billOfLading ? 'bill_of_lading' : 'declaration', entityId: doc.billOfLading || doc.id, detail: `\u91cd\u62a5: ${doc.declarationNo || doc.id}` } }).catch(() => {});
  return prisma.declaration.update({ where: { id }, data: update });
}

/** 完成报关 */
export async function completeDeclaration(tenantId: string, id: string) {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) throw new Error('\u4e0d\u5b58\u5728');
  if (!['submitted', 'resubmitted'].includes(doc.status)) throw new Error(`\u72b6\u6001\u4e0d\u53ef\u5b8c\u6210`);
  return prisma.declaration.update({ where: { id }, data: { status: 'completed' } });
}

/** 列表查询 */
export async function listDeclarations(tenantId: string, opts?: { status?: string; customsMode?: string; page?: number; pageSize?: number }) {
  const where: any = { tenantId };
  if (opts?.status) where.status = opts.status;
  if (opts?.customsMode) where.customsMode = opts.customsMode;

  const p = opts?.page || 1;
  const ps = opts?.pageSize || 20;

  const [total, items] = await Promise.all([
    prisma.declaration.count({ where }),
    prisma.declaration.findMany({
      where, orderBy: { updatedAt: 'desc' }, skip: (p - 1) * ps, take: ps,
      select: { id: true, declarationNo: true, status: true, customsMode: true, totalValue: true, currency: true, score: true, preCheckPassed: true, rejectionCode: true, rejectionReason: true, rejectedAt: true, resubmittedAt: true, createdAt: true, updatedAt: true },
    }),
  ]);
  return { total, page: p, pageSize: ps, items };
}

/** 单条详情 */
export async function getDeclarationDetail(tenantId: string, id: string) {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) return null;
  const safe = (s: string | null, fallback: any) => {
    try { return JSON.parse(s || JSON.stringify(fallback)); } catch { return fallback; }
  };
  return { ...doc, declaration: safe(doc.declarationJson, {}), items: safe(doc.itemsJson, []) };
}

/** 删除草稿 */
export async function deleteDeclaration(tenantId: string, id: string) {
  const doc = await prisma.declaration.findFirst({ where: { id, tenantId } });
  if (!doc) throw new Error('\u4e0d\u5b58\u5728');
  if (doc.status !== 'draft') throw new Error('\u53ea\u80fd\u5220\u9664\u8349\u7a3f');
  return prisma.declaration.delete({ where: { id } });
}

// ============================================================
// Excel 导入/导出
// ============================================================

/**
 * 导出报关单列表为 Excel Buffer
 */
export function exportDeclarationsToExcel(items: any[]): Buffer {
  const workbook = XLSX.utils.book_new();

  // Sheet 1: 列表
  const rows = items.map((item: any) => ({
    '\u62a5\u5173\u5355\u53f7': item.declarationNo || '',
    '\u72b6\u6001': statusLabel(item.status),
    '\u6a21\u5f0f': item.customsMode === 'normal' ? '\u4e00\u822c\u8d38\u6613' : item.customsMode || '',
    '\u91d1\u989d': item.totalValue || 0,
    '\u5e01\u79cd': item.currency || 'USD',
    '\u5408\u89c4\u5f97\u5206': item.score ?? '',
    '\u9000\u5355\u4ee3\u7801': item.rejectionCode || '',
    '\u9000\u5355\u539f\u56e0': item.rejectionReason || '',
    '\u521b\u5efa\u65f6\u95f4': item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '',
  }));

  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, '\u62a5\u5173\u5355\u5217\u8868');

  // Sheet 2: 每个报关单的商品明细
  // flatted later if needed

  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * 从 Excel Buffer 解析为 DeclarationData[]
 */
// 导入模板支持的列名(中文为准, 同时兼容英文 key)
export const IMPORT_TEMPLATE_COLUMNS: { key: string; aliases: string[]; example: string; note: string }[] = [
  { key: '监管方式', aliases: ['报关模式', 'mode', 'customsMode'], example: 'normal', note: 'normal/9610/9710/9810/1210/1239' },
  { key: '境内收发货人', aliases: ['consignee'], example: '深圳市某进出口贸易有限公司', note: '海关必填' },
  { key: '消费使用或生产销售单位', aliases: ['生产销售单位', '消费使用单位', 'consignor'], example: '深圳市某电子科技制造有限公司', note: '出口填生产销售单位' },
  { key: '合同协议号', aliases: ['合同号', 'contractNo'], example: 'PO-2024-0617', note: '' },
  { key: '运输方式', aliases: ['transportMode'], example: '海运', note: '海运/空运/陆运/铁路' },
  { key: '进出境口岸', aliases: ['入境口岸', '出境口岸', 'portOfEntry'], example: '深圳蛇口', note: '' },
  { key: '成交方式', aliases: ['贸易条款', 'tradeTerms'], example: 'CIF', note: 'CIF/CFR/FOB; CIF·CFR 需填运费' },
  { key: '币制', aliases: ['币种', 'currency'], example: 'USD', note: '' },
  { key: '运抵国', aliases: ['目的国', 'destinationCountry'], example: '美国', note: '' },
  { key: '毛重(千克)', aliases: ['毛重', 'grossWeight'], example: '3200.5', note: '' },
  { key: '净重(千克)', aliases: ['净重', 'netWeight'], example: '2950.25', note: '' },
  { key: '件数', aliases: ['packageCount', 'numberOfPackages'], example: '200', note: '' },
  { key: '包装种类', aliases: ['packageType'], example: '纸箱', note: '' },
  { key: '运费', aliases: ['freightRate'], example: '1200', note: 'CIF/CFR 必填(总额)' },
  { key: '保费', aliases: ['insuranceRate'], example: '80', note: '' },
  { key: '杂费', aliases: ['otherRate'], example: '0', note: '' },
  { key: 'HS编码', aliases: ['商品编号', 'hsCode', 'hscode'], example: '8517120000', note: '10位连写; 多项用逗号分隔' },
  { key: '商品名称', aliases: ['品名', 'description'], example: '移动电话(智能手机)', note: '' },
  { key: '规格型号', aliases: ['model', 'spec'], example: '品牌:XX 型号:A100 6.1英寸', note: '海关必填' },
  { key: '数量', aliases: ['quantity'], example: '500', note: '' },
  { key: '成交单位', aliases: ['单位', 'unit'], example: '台', note: '' },
  { key: '单价', aliases: ['unitPrice'], example: '85.3', note: '' },
  { key: '原产国', aliases: ['originCountry'], example: '中国', note: '' },
  { key: '法定第一数量', aliases: ['legalQty'], example: '500', note: '' },
  { key: '法定第一单位', aliases: ['legalUnit'], example: '台', note: '' },
  { key: '法定第二数量', aliases: ['legalQty2'], example: '150', note: '无则留空' },
  { key: '法定第二单位', aliases: ['legalUnit2'], example: '千克', note: '无则留空' },
  { key: '订单号', aliases: ['orderNo'], example: '', note: '9610 三单对碰' },
  { key: '支付单号', aliases: ['paymentNo'], example: '', note: '9610 三单对碰' },
  { key: '物流单号', aliases: ['logisticsNo'], example: '', note: '9610 三单对碰' },
  { key: '电商平台', aliases: ['ecommercePlatform'], example: '', note: '9610' },
  { key: 'B2B订单号', aliases: ['b2bOrderNo'], example: '', note: '9710' },
  { key: 'B2B平台', aliases: ['b2bPlatform'], example: '', note: '9710' },
  { key: '海外仓地址', aliases: ['warehouseAddress'], example: '', note: '9810' },
  { key: 'FNSKU', aliases: ['fnSku'], example: '', note: '9810' },
];

/** 生成带表头+示例+填表说明的导入模板(xlsx Buffer) */
export function generateImportTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  // Sheet1: 模板(表头 + 一行示例)
  const exampleRow: Record<string, any> = {};
  for (const c of IMPORT_TEMPLATE_COLUMNS) exampleRow[c.key] = c.example;
  const sheet = XLSX.utils.json_to_sheet([exampleRow], { header: IMPORT_TEMPLATE_COLUMNS.map(c => c.key) });
  XLSX.utils.book_append_sheet(wb, sheet, '批量申报模板');
  // Sheet2: 填表说明
  const noteRows = IMPORT_TEMPLATE_COLUMNS.map(c => ({ '列名': c.key, '说明': c.note, '示例': c.example, '兼容别名': c.aliases.join(' / ') }));
  const noteSheet = XLSX.utils.json_to_sheet(noteRows);
  XLSX.utils.book_append_sheet(wb, noteSheet, '填表说明');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/**
 * 从 Excel Buffer 解析为 DeclarationData[]
 */
export function importDeclarationsFromExcel(buffer: Buffer): Partial<DeclarationData>[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  const results: Partial<DeclarationData>[] = [];

  // 取列值: 按模板列的中文 key + 别名匹配, 返回首个非空
  const colMap = new Map<string, string[]>();
  for (const c of IMPORT_TEMPLATE_COLUMNS) colMap.set(c.key, [c.key, ...c.aliases]);
  const get = (row: any, key: string): string => {
    for (const k of (colMap.get(key) || [key])) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== '') return String(v).trim();
    }
    return '';
  };
  const splitList = (s: string): string[] => s.split(/[,;，；\n]+/).map(x => x.trim()).filter(Boolean);

  for (const row of rows) {
    const hsCodes = splitList(get(row, 'HS编码'));
    if (hsCodes.length === 0) continue; // 无 HS 的行跳过

    const descs = splitList(get(row, '商品名称'));
    const models = splitList(get(row, '规格型号'));
    const qtys = splitList(get(row, '数量')).map(Number);
    const prices = splitList(get(row, '单价')).map(Number);
    const units = splitList(get(row, '成交单位'));
    const origins = splitList(get(row, '原产国'));
    const lq1 = splitList(get(row, '法定第一数量')).map(Number);
    const lu1 = splitList(get(row, '法定第一单位'));
    const lq2 = splitList(get(row, '法定第二数量')).map(Number);
    const lu2 = splitList(get(row, '法定第二单位'));

    const rowCurrency = get(row, '币制') || 'USD';

    const items = hsCodes.map((hs, i) => {
      const qty = !isNaN(qtys[i]) ? qtys[i] : 1;
      const price = !isNaN(prices[i]) ? prices[i] : 0;
      return {
        lineNo: i + 1,
        hsCode: hs,
        description: descs[i] || descs[0] || '',
        model: models[i] || models[0] || '',          // 不再写死, 缺失留空(预检会提示)
        quantity: qty,
        unit: units[i] || units[0] || '件',            // 有则用 Excel 值
        unitPrice: price,
        totalPrice: price * qty,
        currency: rowCurrency,                          // 不再写死 USD
        originCountry: origins[i] || origins[0] || '',  // 不再写死 CN, 缺失留空(预检会提示)
        legalQty: !isNaN(lq1[i]) ? lq1[i] : undefined,
        legalUnit: lu1[i] || lu1[0] || '',
        legalQty2: !isNaN(lq2[i]) ? lq2[i] : undefined,
        legalUnit2: lu2[i] || lu2[0] || '',
      };
    });

    const mode = (get(row, '监管方式') || 'normal');
    const validModes = ['normal', '9610', '9710', '9810', '1210', '1239'];
    const num = (s: string): number | undefined => { const n = Number(s); return s !== '' && !isNaN(n) ? n : undefined; };

    results.push({
      customsMode: validModes.includes(mode) ? mode as any : 'normal',
      consignee: get(row, '境内收发货人'),
      consignor: get(row, '消费使用或生产销售单位'),
      importerExporter: get(row, '境内收发货人'),
      contractNo: get(row, '合同协议号'),
      transportMode: get(row, '运输方式'),
      portOfEntry: get(row, '进出境口岸'),
      tradeTerms: get(row, '成交方式') || 'FOB',
      currency: rowCurrency,
      destinationCountry: get(row, '运抵国'),
      grossWeight: num(get(row, '毛重(千克)')),
      netWeight: num(get(row, '净重(千克)')),
      numberOfPackages: num(get(row, '件数')),
      packageType: get(row, '包装种类'),
      freightRate: num(get(row, '运费')), freightMark: get(row, '运费') ? '3' : undefined, freightCurrency: rowCurrency,
      insuranceRate: num(get(row, '保费')), insuranceMark: get(row, '保费') ? '3' : undefined, insuranceCurrency: rowCurrency,
      otherRate: num(get(row, '杂费')), otherMark: get(row, '杂费') ? '3' : undefined, otherCurrency: rowCurrency,
      orderNo: get(row, '订单号'), paymentNo: get(row, '支付单号'), logisticsNo: get(row, '物流单号'),
      ecommercePlatform: get(row, '电商平台'),
      b2bOrderNo: get(row, 'B2B订单号'), b2bPlatform: get(row, 'B2B平台'),
      warehouseAddress: get(row, '海外仓地址'), fnSku: get(row, 'FNSKU'),
      totalValue: items.reduce((s: number, it: any) => s + it.totalPrice, 0),
      items: items as any,
    } as any);
  }

  return results;
}

function statusLabel(s: string): string {
  const map: Record<string, string> = { draft: '\u8349\u7a3f', submitted: '\u5df2\u63d0\u4ea4', rejected: '\u5df2\u9000\u5355', resubmitted: '\u5df2\u91cd\u62a5', completed: '\u5df2\u5b8c\u6210' };
  return map[s] || s;
}

// ============================================================
// 提运单归集
// ============================================================

export interface BlGroupSummary {
  billOfLading: string;
  declarationCount: number;
  totalValue: number;
  currency: string;
  statuses: string[];
  customsModes: string[];
  firstCreated: string;
  lastUpdated: string;
  declarations: Array<{
    id: string;
    declarationNo: string | null;
    status: string;
    customsMode: string;
    totalValue: number;
    currency: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

/** 获取当前租户所有提运单列表（按提单号归集） */
// 从一组报关单行构建提单汇总(list 与 byBL 共用)
type DeclRow = {
  id: string; declarationNo: string | null; status: string; customsMode: string;
  totalValue: number; currency: string | null; createdAt: Date; updatedAt: Date;
};
function buildBlSummary(bl: string, rows: DeclRow[]): BlGroupSummary {
  const currencies = new Set(rows.map((r) => r.currency || 'USD'));
  const g: BlGroupSummary = {
    billOfLading: bl,
    declarationCount: 0,
    totalValue: 0,
    // 同一提单出现多币种时不静默相加成误导值, 标记为 MIXED 由前端分币种展示
    currency: currencies.size === 1 ? [...currencies][0] : 'MIXED',
    statuses: [],
    customsModes: [],
    firstCreated: rows[0].createdAt.toISOString(),
    lastUpdated: rows[0].updatedAt.toISOString(),
    declarations: [],
  };
  for (const d of rows) {
    g.declarationCount++;
    g.totalValue += d.totalValue || 0;
    if (!g.statuses.includes(d.status)) g.statuses.push(d.status);
    if (!g.customsModes.includes(d.customsMode)) g.customsModes.push(d.customsMode);
    const ci = d.createdAt.toISOString(), ui = d.updatedAt.toISOString();
    if (ci < g.firstCreated) g.firstCreated = ci;
    if (ui > g.lastUpdated) g.lastUpdated = ui;
    g.declarations.push({
      id: d.id, declarationNo: d.declarationNo,
      status: d.status, customsMode: d.customsMode,
      totalValue: d.totalValue, currency: d.currency || 'USD',
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    });
  }
  return g;
}

/** 获取当前租户所有提运单列表(按提单号归集) */
export async function listBillOfLading(tenantId: string): Promise<BlGroupSummary[]> {
  // 走 billOfLading 列(已落列+索引), 不再扫全表 + 逐行 JSON.parse
  const all = await prisma.declaration.findMany({
    where: { tenantId, billOfLading: { not: null } },
    select: {
      id: true, declarationNo: true, status: true, customsMode: true,
      totalValue: true, currency: true, billOfLading: true,
      createdAt: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  const byBl = new Map<string, DeclRow[]>();
  for (const d of all) {
    const bl = (d.billOfLading || '').trim();
    if (!bl) continue;
    (byBl.get(bl) || byBl.set(bl, []).get(bl)!).push(d);
  }

  return [...byBl.entries()]
    .map(([bl, rows]) => buildBlSummary(bl, rows))
    .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
}

/** 按提运单号查询该提单下所有报关单(直接按列查询, 不再加载全部再过滤) */
export async function getDeclarationsByBL(tenantId: string, blNo: string): Promise<BlGroupSummary | null> {
  const rows = await prisma.declaration.findMany({
    where: { tenantId, billOfLading: blNo },
    select: {
      id: true, declarationNo: true, status: true, customsMode: true,
      totalValue: true, currency: true, createdAt: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (rows.length === 0) return null;
  return buildBlSummary(blNo, rows);
}

