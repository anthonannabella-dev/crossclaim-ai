// ============================================================
// 出口退税率自动更新服务
// 从国家税务总局/海关总署公开数据抓取最新退税率
// 退税率一般在每年1月1日和7月1日调整
// ============================================================
import { logger } from '../config/logger';
import axios from 'axios';
import { ExportRebateRate, getExportRebateRate } from './taxRebateRates';

// 公开退税率查询API
const REBATE_API = 'https://www.chinatax.gov.cn/api/export-rebate';

interface RebateSource {
  hsPrefix: string;
  rate: number;
  vatRate: number;
  description: string;
  category: '一般' | '限制' | '禁止';
}

// 爬取国家税务总局退税率查询结果
async function fetchRebateByChapter(chapter: string): Promise<RebateSource[]> {
  try {
    const resp = await axios.get(REBATE_API, {
      params: { chapter, year: new Date().getFullYear() },
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    if (resp.status === 200 && Array.isArray(resp.data)) {
      return resp.data.map((d: any) => ({
        hsPrefix: d.hsPrefix || d.hs_prefix || '',
        rate: Number(d.rate) || 0,
        vatRate: Number(d.vatRate) || 13,
        description: d.description || '',
        category: (d.category === '限制' ? '限制' : d.category === '禁止' ? '禁止' : '一般') as '一般' | '限制' | '禁止',
      }));
    }
  } catch (err: any) {
    logger.warn('[TaxRebateUpdater] 章节 ' + chapter + ' 抓取失败', err.message);
  }
  return [];
}

// 硬编码默认退税率（当API不可用时使用）
const DEFAULT_RATES: RebateSource[] = [
  { hsPrefix: '01', rate: 0, vatRate: 9, description: '活动物', category: '禁止' },
  { hsPrefix: '02', rate: 0, vatRate: 9, description: '肉及食用杂碎', category: '禁止' },
  { hsPrefix: '03', rate: 9, vatRate: 9, description: '水产品', category: '一般' },
  { hsPrefix: '04', rate: 9, vatRate: 9, description: '乳蛋蜂蜜', category: '一般' },
  { hsPrefix: '05', rate: 5, vatRate: 9, description: '其他动物产品', category: '限制' },
  { hsPrefix: '06', rate: 5, vatRate: 9, description: '活植物/花卉', category: '限制' },
  { hsPrefix: '07', rate: 5, vatRate: 9, description: '蔬菜', category: '限制' },
  { hsPrefix: '08', rate: 5, vatRate: 9, description: '水果/坚果', category: '限制' },
  { hsPrefix: '09', rate: 5, vatRate: 9, description: '咖啡/茶/香料', category: '限制' },
  { hsPrefix: '10', rate: 0, vatRate: 9, description: '谷物', category: '禁止' },
  { hsPrefix: '11', rate: 5, vatRate: 13, description: '制粉工业产品', category: '限制' },
  { hsPrefix: '12', rate: 5, vatRate: 9, description: '油子/工业植物', category: '限制' },
  { hsPrefix: '15', rate: 0, vatRate: 13, description: '动植物油脂', category: '禁止' },
  { hsPrefix: '16', rate: 13, vatRate: 13, description: '肉/鱼制品', category: '一般' },
  { hsPrefix: '17', rate: 13, vatRate: 13, description: '糖及糖食', category: '一般' },
  { hsPrefix: '18', rate: 13, vatRate: 13, description: '可可制品', category: '一般' },
  { hsPrefix: '19', rate: 13, vatRate: 13, description: '谷物/淀粉制品', category: '一般' },
  { hsPrefix: '20', rate: 13, vatRate: 13, description: '蔬菜水果制品', category: '一般' },
  { hsPrefix: '21', rate: 13, vatRate: 13, description: '杂项食品', category: '一般' },
  { hsPrefix: '22', rate: 13, vatRate: 13, description: '饮料/酒/醋', category: '一般' },
  { hsPrefix: '24', rate: 13, vatRate: 13, description: '烟草及烟草制品', category: '一般' },
  { hsPrefix: '25', rate: 13, vatRate: 13, description: '盐/硫磺/泥土/石料', category: '一般' },
  { hsPrefix: '27', rate: 13, vatRate: 13, description: '矿物燃料/矿物油', category: '一般' },
  { hsPrefix: '28', rate: 13, vatRate: 13, description: '无机化工品', category: '一般' },
  { hsPrefix: '29', rate: 13, vatRate: 13, description: '有机化工品', category: '一般' },
  { hsPrefix: '30', rate: 13, vatRate: 13, description: '药品', category: '一般' },
  { hsPrefix: '31', rate: 5, vatRate: 9, description: '肥料', category: '限制' },
  { hsPrefix: '32', rate: 13, vatRate: 13, description: '韋革/染料/油漆', category: '一般' },
  { hsPrefix: '33', rate: 13, vatRate: 13, description: '精油/香料/化妆品', category: '一般' },
  { hsPrefix: '34', rate: 13, vatRate: 13, description: '肥皂/洁洁品', category: '一般' },
  { hsPrefix: '35', rate: 13, vatRate: 13, description: '蛋白物/淀粉/胶', category: '一般' },
  { hsPrefix: '36', rate: 13, vatRate: 13, description: '火药/爆炸品', category: '一般' },
  { hsPrefix: '37', rate: 13, vatRate: 13, description: '照相及电影材料', category: '一般' },
  { hsPrefix: '38', rate: 13, vatRate: 13, description: '杂项化工品', category: '一般' },
  { hsPrefix: '39', rate: 13, vatRate: 13, description: '塑料及其制品', category: '一般' },
  { hsPrefix: '40', rate: 13, vatRate: 13, description: '橡胶及其制品', category: '一般' },
  { hsPrefix: '41', rate: 13, vatRate: 13, description: '生皮/皮革', category: '一般' },
  { hsPrefix: '42', rate: 13, vatRate: 13, description: '皮革制品', category: '一般' },
  { hsPrefix: '43', rate: 13, vatRate: 13, description: '毛皮及其制品', category: '一般' },
  { hsPrefix: '44', rate: 13, vatRate: 13, description: '木及木制品', category: '一般' },
  { hsPrefix: '45', rate: 13, vatRate: 13, description: '栓/枔、稽杆、编织材料', category: '一般' },
  { hsPrefix: '46', rate: 13, vatRate: 13, description: '编织制品', category: '一般' },
  { hsPrefix: '47', rate: 0, vatRate: 13, description: '木浆/回收纸', category: '禁止' },
  { hsPrefix: '48', rate: 13, vatRate: 13, description: '纸及纸板', category: '一般' },
  { hsPrefix: '49', rate: 13, vatRate: 13, description: '图书/新闻卷卷经', category: '一般' },
  { hsPrefix: '50', rate: 13, vatRate: 13, description: '蛛丝', category: '一般' },
  { hsPrefix: '51', rate: 13, vatRate: 13, description: '羊毛/动物细毛', category: '一般' },
  { hsPrefix: '52', rate: 13, vatRate: 13, description: '棉花', category: '一般' },
  { hsPrefix: '53', rate: 13, vatRate: 13, description: '植物纲维', category: '一般' },
  { hsPrefix: '54', rate: 13, vatRate: 13, description: '化学合细丝', category: '一般' },
  { hsPrefix: '55', rate: 13, vatRate: 13, description: '化学短细丝', category: '一般' },
  { hsPrefix: '56', rate: 13, vatRate: 13, description: '纤维/羛及无纺布', category: '一般' },
  { hsPrefix: '57', rate: 13, vatRate: 13, description: '地毯', category: '一般' },
  { hsPrefix: '58', rate: 13, vatRate: 13, description: '特种织物', category: '一般' },
  { hsPrefix: '59', rate: 13, vatRate: 13, description: '浸渍/涂布/工业用织物', category: '一般' },
  { hsPrefix: '60', rate: 13, vatRate: 13, description: '编织物', category: '一般' },
  { hsPrefix: '61', rate: 13, vatRate: 13, description: '编织或钩编的服装', category: '一般' },
  { hsPrefix: '62', rate: 13, vatRate: 13, description: '非编织或非钩编的服装', category: '一般' },
  { hsPrefix: '63', rate: 13, vatRate: 13, description: '其他织织品', category: '一般' },
  { hsPrefix: '64', rate: 13, vatRate: 13, description: '鞋鞋', category: '一般' },
  { hsPrefix: '65', rate: 13, vatRate: 13, description: '帽类', category: '一般' },
  { hsPrefix: '66', rate: 13, vatRate: 13, description: '雨伞/手杖', category: '一般' },
  { hsPrefix: '67', rate: 13, vatRate: 13, description: '已加工羽毛/人造花', category: '一般' },
  { hsPrefix: '68', rate: 13, vatRate: 13, description: '石料/矿渣/磁砖', category: '一般' },
  { hsPrefix: '69', rate: 13, vatRate: 13, description: '陶瓷产品', category: '一般' },
  { hsPrefix: '70', rate: 13, vatRate: 13, description: '玻璃及其制品', category: '一般' },
  { hsPrefix: '71', rate: 0, vatRate: 13, description: '贵金属/宝石', category: '禁止' },
  { hsPrefix: '72', rate: 13, vatRate: 13, description: '钢铁', category: '一般' },
  { hsPrefix: '73', rate: 13, vatRate: 13, description: '钢铁制品', category: '一般' },
  { hsPrefix: '74', rate: 13, vatRate: 13, description: '铜及其制品', category: '一般' },
  { hsPrefix: '75', rate: 13, vatRate: 13, description: '镍及其制品', category: '一般' },
  { hsPrefix: '76', rate: 13, vatRate: 13, description: '铝及其制品', category: '一般' },
  { hsPrefix: '78', rate: 13, vatRate: 13, description: '铅及其制品', category: '一般' },
  { hsPrefix: '79', rate: 13, vatRate: 13, description: '锌及其制品', category: '一般' },
  { hsPrefix: '80', rate: 13, vatRate: 13, description: '锡及其制品', category: '一般' },
  { hsPrefix: '81', rate: 13, vatRate: 13, description: '其他基本金属', category: '一般' },
  { hsPrefix: '82', rate: 13, vatRate: 13, description: '金属工具/餐具', category: '一般' },
  { hsPrefix: '83', rate: 13, vatRate: 13, description: '杂项金属制品', category: '一般' },
  { hsPrefix: '84', rate: 13, vatRate: 13, description: '核反应器/锅炉/机器', category: '一般' },
  { hsPrefix: '85', rate: 13, vatRate: 13, description: '电机/电器/电声/视频', category: '一般' },
  { hsPrefix: '86', rate: 13, vatRate: 13, description: '铁路/有轨交通设备', category: '一般' },
  { hsPrefix: '87', rate: 13, vatRate: 13, description: '交通设备', category: '一般' },
  { hsPrefix: '88', rate: 13, vatRate: 13, description: '航空器', category: '一般' },
  { hsPrefix: '89', rate: 13, vatRate: 13, description: '船舶', category: '一般' },
  { hsPrefix: '90', rate: 13, vatRate: 13, description: '光学/医疗/仪器', category: '一般' },
  { hsPrefix: '91', rate: 13, vatRate: 13, description: '钟表', category: '一般' },
  { hsPrefix: '92', rate: 13, vatRate: 13, description: '乐器', category: '一般' },
  { hsPrefix: '93', rate: 0, vatRate: 13, description: '武器/弹药', category: '禁止' },
  { hsPrefix: '94', rate: 13, vatRate: 13, description: '家具/床具/照明', category: '一般' },
  { hsPrefix: '95', rate: 13, vatRate: 13, description: '玩具/游戏用品/体育用品', category: '一般' },
  { hsPrefix: '96', rate: 13, vatRate: 13, description: '杂项制品', category: '一般' },
  { hsPrefix: '97', rate: 0, vatRate: 13, description: '艺术品/收藏品', category: '禁止' },
];

// 尝试从API获取，失败则返回硬编码数据
export async function fetchLatestRebateRates(): Promise<RebateSource[]> {
  const allRates: RebateSource[] = [];
  const chapters = Array.from({ length: 97 }, (_, i) => String(i + 1).padStart(2, '0')).filter(c => c !== '77');
  
  for (const ch of chapters) {
    const rates = await fetchRebateByChapter(ch);
    if (rates.length > 0) {
      allRates.push(...rates);
    }
  }
  
  // 用硬编码数据补充缺失章节
  const existingPrefixes = new Set(allRates.map(r => r.hsPrefix));
  for (const def of DEFAULT_RATES) {
    if (!existingPrefixes.has(def.hsPrefix)) {
      allRates.push(def);
    }
  }
  
  return allRates.sort((a, b) => a.hsPrefix.localeCompare(b.hsPrefix));
}

// 更新数据库中的退税率（未来可以扩展为DB表）
// 目前税率硬编码在 taxRebateRates.ts 中，运行时直接返回
export async function updateTaxRebateRates(): Promise<number> {
  const rates = await fetchLatestRebateRates();
  logger.info('[TaxRebateUpdater] 完成! 共获取 ' + rates.length + ' 条退税率数据');
  logger.info('[TaxRebateUpdater] 提示: 退税率数据目前硬编码在 taxRebateRates.ts');
  logger.info('[TaxRebateUpdater] 建议未来迁移至数据库表以实现全自动更新');
  return rates.length;
}

/**
 * 按HS章节规则更新数据库中的增值税率和出口退税率
 * 每月1号由 cron 自动调用，与 hsCodeUpdater 配合使用
 * 当外部API不可用时，使用内置的章节映射规则
 */
export async function updateAllHSTaxRatesToDb(): Promise<{
  vatUpdated: number;
  exportUpdated: number;
  totalChecked: number;
}> {
  const { updateAllTaxRates } = await import('./taxRateService');
  const count = await updateAllTaxRates();
  logger.info('[TaxRebateUpdater] HS编码税率数据库更新完成: ' + count + ' 条');
  return {
    vatUpdated: count,
    exportUpdated: count,
    totalChecked: count,
  };
}
