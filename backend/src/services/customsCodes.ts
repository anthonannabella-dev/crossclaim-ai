/**
* customsCodes.ts —— 海关关务代码表 + 名称⇄代码映射
*
* 设计:内置常用子集(币制/运输方式/成交方式/计量单位/包装/监管方式/征免性质/关区),
* 启动时再合并外部全量表(单一窗口/海关下载整理后):
* 1) data/customsCodes.generated.json —— 含 COUNTRY_CODES(710)、TRADE_MODE_CODES(190)
* 2) CUSTOMS_CODE_TABLE_PATH 指向的 JSON —— 可覆盖/补全任意子表(外部优先)
*
* 所有 key 同时支持「中文名 / 英文或ISO缩写 / 代码本身」三种写法,value 统一为海关代码字符串。
* toCustomsCode() 永不抛错:命中则返回代码,未命中原样返回(配合 isStrictCodeMode 决定是否拦截)。
*/
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';
export const SUPERVISION_MODE_CODES: Record<string, string> = {
'一般贸易': '0110', '进料对口': '0615', '来料加工': '0214', '进料非对口': '0715',
'跨境贸易电子商务': '9610', '保税电商': '1210', '保税电商A': '1239',
'一般贸易电商B2B': '9710', '跨境电商B2B出口': '9710', '出口海外仓': '9810',
'市场采购': '1039', '边境小额': '4019', '免费': '3010',
};
export const REGULATORY_CERT_CODES: Record<string, string> = {
'入境货物通关单': 'A', '出境货物通关单': 'B', '原产地证': 'Y', '出口许可证': '4',
'进口许可证': '1', '濒危物种允许出口证明书': 'E',
};
export const DISTRICT_CODES: Record<string, string> = {
'深圳': '4403', '广州': '4401', '上海': '3100', '宁波': '3302',
'青岛': '3702', '天津': '1200', '黄埔': '5165', '杭州': '3301',
};
export const WRAP_TYPE_CODES: Record<string, string> = {
'纸箱': '22', '木箱': '21', '托盘': '92', '散装': '23', '裸装': '24',
'其他': '99', '桶': '12', '袋': '11', '托': '92',
};
export const EXEMPTION_CODES: Record<string, string> = {
'照章征税': '1', '折半征税': '2', '全免': '3', '特案': '4', '征免性质': '5', '保函征税': '7',
};
export const UNIT_CODES: Record<string, string> = {
'千克': '035', 'kg': '035', '台': '018', '个': '007', '件': '011', '套': '108',
'只': '010', '双': '009', '米': '015', '吨': '036', '升': '037', '台/套': '018',
};
export const COUNTRY_CODES: Record<string, string> = {
// 内置最小集,启动时由 generated.json(710 国)合并补全
'中国': '142', 'CN': '142', 'CHN': '142', '美国': '502', 'US': '502', 'USA': '502',
'日本': '116', 'JP': '116', '德国': '304', 'DE': '304', '韩国': '133', 'KR': '133',
};
export const CURRENCY_CODES: Record<string, string> = {
'USD': '502', '美元': '502', 'CNY': '142', 'RMB': '142', '人民币': '142',
'EUR': '300', '欧元': '300', 'HKD': '110', '港币': '110', 'JPY': '116', '日元': '116',
'GBP': '303', '英镑': '303', 'AUD': '601', 'CAD': '116',
};
export const TRANSPORT_MODE_CODES: Record<string, string> = {
// 运输方式(TrafMode)
'海运': '2', '水路': '2', 'sea': '2', '铁路': '3', 'rail': '3',
'陆运': '4', '公路': '4', 'road': '4', 'truck': '4', '空运': '5', '航空': '5', 'air': '5',
'邮政': '6', '邮件': '6', 'post': '6',
};
/** 成交方式(TransMode):1=CIF 2=C&F/CFR 3=FOB */
export const DELIVERY_TERM_CODES: Record<string, string> = {
'CIF': '1', 'C&F': '2', 'CFR': '2', 'CNF': '2', 'FOB': '3',
};
/** 监管方式(贸易方式)名称→代码,启动时由 generated.json(190 项)合并补全 */
export const TRADE_MODE_CODES: Record<string, string> = { ...SUPERVISION_MODE_CODES };
const TABLE_BY_SECTION: Record<string, Record<string, string>> = {
transport: TRANSPORT_MODE_CODES, currency: CURRENCY_CODES, country: COUNTRY_CODES,
unit: UNIT_CODES, wrapType: WRAP_TYPE_CODES, district: DISTRICT_CODES,
exemption: EXEMPTION_CODES, supervision: SUPERVISION_MODE_CODES,
tradeMode: TRADE_MODE_CODES, delivery: DELIVERY_TERM_CODES, regulatoryCert: REGULATORY_CERT_CODES,
// 兼容 generated.json 的全名 key
COUNTRY_CODES: COUNTRY_CODES, TRADE_MODE_CODES: TRADE_MODE_CODES,
CURRENCY_CODES: CURRENCY_CODES, TRANSPORT_MODE_CODES: TRANSPORT_MODE_CODES, UNIT_CODES: UNIT_CODES,
};
function mergeInto(target: Record<string, string>, src: Record<string, unknown>): number {
let n = 0;
for (const [k, v] of Object.entries(src)) {
if (typeof v === 'string' && v.length > 0) { target[k] = v; n++; }
}
return n;
}
/** 合并外部代码表(外部优先)。无参数时读取默认 generated 表 + CUSTOMS_CODE_TABLE_PATH。 */
export function loadExternalCodeTables(filePath?: string): void {
const candidates: string[] = [];
if (filePath) candidates.push(filePath);
else {
candidates.push(path.resolve(process.cwd(), 'data/customsCodes.generated.json'));
if (process.env.CUSTOMS_CODE_TABLE_PATH) candidates.push(process.env.CUSTOMS_CODE_TABLE_PATH);
}
for (const p of candidates) {
try {
if (!fs.existsSync(p)) continue;
const json = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
let merged = 0;
for (const [section, table] of Object.entries(json)) {
if (section.startsWith('_')) continue;
const target = TABLE_BY_SECTION[section];
if (target && table && typeof table === 'object') {
merged += mergeInto(target, table as Record<string, unknown>);
}
}
logger.info('[customsCodes] 已合并外部代码表 %s (+%d 条)', p, merged);
} catch (e: any) {
logger.warn('[customsCodes] 加载代码表失败 %s: %s', p, e?.message);
}
}
}
// 模块加载时尽力自动合并(失败不影响启动)
try { loadExternalCodeTables(); } catch { /* noop */ }
const CODE_RE = /^[0-9A-Za-z]{1,10}$/;
const valueSetCache = new WeakMap<Record<string, string>, Set<string>>();
function valueSet(t: Record<string, string>): Set<string> {
let s = valueSetCache.get(t);
if (!s) { s = new Set(Object.values(t)); valueSetCache.set(t, s); }
return s;
}
export function isCustomsCode(v: string): boolean {
return typeof v === 'string' && /^[0-9]{1,4}$|^[A-Z]$/.test(v.trim());
}
/** 名称/缩写/代码 → 海关代码;命中返回代码,未命中原样返回(不抛错)。 */
export function toCustomsCode(t: Record<string, string>, v: string): string {
if (v == null) return '';
const raw = String(v).trim();
if (!raw) return '';
if (t[raw]) return t[raw]; // 直接命中名称/缩写
if (valueSet(t).has(raw)) return raw; // 传入的本就是代码
const upper = raw.toUpperCase();
if (t[upper]) return t[upper]; // 大写缩写命中
return raw; // 未命中:原样返回供人工复核
}
/** 给定值是否能解析为代码(用于严格模式拦截)。 */
export function resolvesToCode(t: Record<string, string>, v: string): boolean {
if (v == null) return false;
const raw = String(v).trim();
if (!raw) return false;
return !!t[raw] || valueSet(t).has(raw) || !!t[raw.toUpperCase()];
}
/** 严格代码模式:开启后,未能解析为代码的字段会在预检中报错。默认关闭。 */
export function isStrictCodeMode(): boolean {
return String(process.env.CUSTOMS_STRICT_CODES || '').toLowerCase() === 'true';
}
/** 解析监管方式输入(支持「一般贸易/0110」「0110」「一般贸易」)→ 代码数组 */
export function parseSupervisionCodes(input: string): string[] {
if (!input) return [];
return String(input)
.split(/[,，;；/\s]+/)
.map((s) => s.trim())
.filter(Boolean)
.map((s) => toCustomsCode(SUPERVISION_MODE_CODES, s))
.filter((c, i, a) => a.indexOf(c) === i);
}
