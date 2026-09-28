// ============================================================
// 商品税率自动填充服务
// 按 HS 章节号推断增值税率和出口退税率
// 增值税规则（中国税法）：
//   - 13%：一般货物、有形动产（大部分章节）
//   - 9%：农产品、水产品、食用植物油、天然气、居民用煤炭制品、农机等
//   - 6%：现代服务业、无形资产
//   - 0%：出口货物
// 出口退税率规则（参考值，实际以税务总局更新为准）：
//   - 13%：机电产品、纺织品、化工品等（大部分制成品）
//   - 9%：部分农产品加工品、水产品
//   - 5%：部分初级加工品
//   - 0%：禁止出口类、资源类原材料
// ============================================================

import prisma from '../config/database';
import { logger } from '../config/logger';

interface ChapterTaxRule {
  /** HS chapter number as string, e.g. "01", "84", "97" */
  chapter: string;
  /** VAT rate (0, 6, 9, 13) */
  vatRate: number;
  /** Export rebate rate (0-13) */
  exportRate: number;
  /** Description for documentation */
  label: string;
}

/**
 * 中国增值税率+出口退税率按HS章节对照表
 * 数据来源：《中华人民共和国增值税暂行条例》及其实施细则
 * 出口退税率参考税务总局2024年出口退税文库
 */
const CHAPTER_TAX_RULES: ChapterTaxRule[] = [
  // 第1类：活动物、动物产品 — 增值税9%（初级农产品），出口退税率低
  { chapter: '01', vatRate: 9, exportRate: 5, label: '活动物（限制出口）' },
  { chapter: '02', vatRate: 9, exportRate: 5, label: '肉及食用杂碎' },
  { chapter: '03', vatRate: 9, exportRate: 9, label: '水产品' },
  { chapter: '04', vatRate: 9, exportRate: 5, label: '乳品、蛋品、蜂蜜' },
  { chapter: '05', vatRate: 9, exportRate: 0, label: '其他动物产品（限制出口）' },

  // 第2类：植物产品 — 增值税9%（初级农产品）
  { chapter: '06', vatRate: 9, exportRate: 5, label: '活植物、花卉' },
  { chapter: '07', vatRate: 9, exportRate: 5, label: '蔬菜' },
  { chapter: '08', vatRate: 9, exportRate: 5, label: '水果、坚果' },
  { chapter: '09', vatRate: 9, exportRate: 5, label: '咖啡、茶、香料' },
  { chapter: '10', vatRate: 9, exportRate: 0, label: '谷物（限制出口）' },
  { chapter: '11', vatRate: 9, exportRate: 9, label: '制粉工业产品' },
  { chapter: '12', vatRate: 9, exportRate: 0, label: '含油子仁、工业植物' },
  { chapter: '13', vatRate: 9, exportRate: 5, label: '虫胶、树胶、树脂' },
  { chapter: '14', vatRate: 9, exportRate: 0, label: '编结用植物材料' },

  // 第3类：动/植物油 — 增值税9%（食用农产品）
  { chapter: '15', vatRate: 9, exportRate: 0, label: '动植物油脂（限制出口）' },

  // 第4类：食品、饮料、烟草 — 增值税13%（加工食品）
  { chapter: '16', vatRate: 13, exportRate: 13, label: '肉、鱼制品' },
  { chapter: '17', vatRate: 13, exportRate: 13, label: '糖及糖食' },
  { chapter: '18', vatRate: 13, exportRate: 13, label: '可可及可可制品' },
  { chapter: '19', vatRate: 13, exportRate: 13, label: '谷物、粉、淀粉制品' },
  { chapter: '20', vatRate: 13, exportRate: 13, label: '蔬菜、水果制品' },
  { chapter: '21', vatRate: 13, exportRate: 13, label: '杂项食品' },
  { chapter: '22', vatRate: 13, exportRate: 13, label: '饮料、酒、醋' },
  { chapter: '23', vatRate: 9, exportRate: 9, label: '食品工业残渣、饲料' },
  { chapter: '24', vatRate: 13, exportRate: 0, label: '烟草（专营）' },

  // 第5类：矿产品 — 增值税13%
  { chapter: '25', vatRate: 13, exportRate: 9, label: '盐、硫磺、石料' },
  { chapter: '26', vatRate: 13, exportRate: 0, label: '矿砂、矿渣（限制出口）' },
  { chapter: '27', vatRate: 13, exportRate: 0, label: '矿物燃料（限制出口）' },

  // 第6类：化工品 — 增值税13%
  { chapter: '28', vatRate: 13, exportRate: 13, label: '无机化学品' },
  { chapter: '29', vatRate: 13, exportRate: 13, label: '有机化学品' },
  { chapter: '30', vatRate: 13, exportRate: 13, label: '药品' },
  { chapter: '31', vatRate: 9, exportRate: 5, label: '肥料' },
  { chapter: '32', vatRate: 13, exportRate: 13, label: '鞣料、染料、颜料' },
  { chapter: '33', vatRate: 13, exportRate: 13, label: '精油、化妆品' },
  { chapter: '34', vatRate: 13, exportRate: 13, label: '肥皂、洗涤剂' },
  { chapter: '35', vatRate: 13, exportRate: 13, label: '蛋白类物质、胶' },
  { chapter: '36', vatRate: 13, exportRate: 13, label: '炸药、烟火' },
  { chapter: '37', vatRate: 13, exportRate: 13, label: '照相及电影用品' },
  { chapter: '38', vatRate: 13, exportRate: 13, label: '杂项化工品' },

  // 第7类：塑料和橡胶 — 增值税13%
  { chapter: '39', vatRate: 13, exportRate: 13, label: '塑料及其制品' },
  { chapter: '40', vatRate: 13, exportRate: 13, label: '橡胶及其制品' },

  // 第8类：皮革 — 增值税13%
  { chapter: '41', vatRate: 13, exportRate: 13, label: '生皮、皮革' },
  { chapter: '42', vatRate: 13, exportRate: 13, label: '皮革制品' },
  { chapter: '43', vatRate: 13, exportRate: 13, label: '毛皮及其制品' },

  // 第9类：木及木制品 — 增值税13%
  { chapter: '44', vatRate: 13, exportRate: 13, label: '木及木制品' },
  { chapter: '45', vatRate: 13, exportRate: 13, label: '软木及制品' },
  { chapter: '46', vatRate: 13, exportRate: 13, label: '编织材料制品' },

  // 第10类：纸浆、纸 — 增值税13%
  { chapter: '47', vatRate: 13, exportRate: 0, label: '木浆、废纸（资源类）' },
  { chapter: '48', vatRate: 13, exportRate: 13, label: '纸及纸板' },
  { chapter: '49', vatRate: 9, exportRate: 0, label: '图书、报纸（文化产品免征）' },

  // 第11类：纺织品 — 增值税13%
  { chapter: '50', vatRate: 13, exportRate: 13, label: '蚕丝' },
  { chapter: '51', vatRate: 13, exportRate: 13, label: '羊毛、动物细毛' },
  { chapter: '52', vatRate: 13, exportRate: 13, label: '棉花' },
  { chapter: '53', vatRate: 13, exportRate: 13, label: '植物纺织纤维' },
  { chapter: '54', vatRate: 13, exportRate: 13, label: '化学长丝' },
  { chapter: '55', vatRate: 13, exportRate: 13, label: '化学短纤' },
  { chapter: '56', vatRate: 13, exportRate: 13, label: '絮胎、毡呢、无纺布' },
  { chapter: '57', vatRate: 13, exportRate: 13, label: '地毯' },
  { chapter: '58', vatRate: 13, exportRate: 13, label: '特种机织物' },
  { chapter: '59', vatRate: 13, exportRate: 13, label: '浸渍、涂布织物' },
  { chapter: '60', vatRate: 13, exportRate: 13, label: '针织物及钩编织物' },
  { chapter: '61', vatRate: 13, exportRate: 13, label: '针织服装' },
  { chapter: '62', vatRate: 13, exportRate: 13, label: '非针织服装' },
  { chapter: '63', vatRate: 13, exportRate: 13, label: '其他纺织制成品' },

  // 第12类：鞋帽 — 增值税13%
  { chapter: '64', vatRate: 13, exportRate: 13, label: '鞋靴' },
  { chapter: '65', vatRate: 13, exportRate: 13, label: '帽类' },
  { chapter: '66', vatRate: 13, exportRate: 13, label: '雨伞、手杖' },
  { chapter: '67', vatRate: 13, exportRate: 13, label: '已加工羽毛、人造花' },

  // 第13类：石料、陶瓷、玻璃 — 增值税13%
  { chapter: '68', vatRate: 13, exportRate: 13, label: '石料、石膏制品' },
  { chapter: '69', vatRate: 13, exportRate: 13, label: '陶瓷产品' },
  { chapter: '70', vatRate: 13, exportRate: 13, label: '玻璃及其制品' },

  // 第14类：珠宝、贵金属 — 增值税13%
  { chapter: '71', vatRate: 13, exportRate: 0, label: '天然或养殖珍珠、宝石、贵金属' },

  // 第15类：贱金属 — 增值税13%
  { chapter: '72', vatRate: 13, exportRate: 0, label: '钢铁（产能控制）' },
  { chapter: '73', vatRate: 13, exportRate: 13, label: '钢铁制品' },
  { chapter: '74', vatRate: 13, exportRate: 0, label: '铜及其制品' },
  { chapter: '75', vatRate: 13, exportRate: 0, label: '镍及其制品' },
  { chapter: '76', vatRate: 13, exportRate: 0, label: '铝及其制品' },
  { chapter: '78', vatRate: 13, exportRate: 0, label: '铅及其制品' },
  { chapter: '79', vatRate: 13, exportRate: 0, label: '锌及其制品' },
  { chapter: '80', vatRate: 13, exportRate: 0, label: '锡及其制品' },
  { chapter: '81', vatRate: 13, exportRate: 13, label: '其他贱金属' },
  { chapter: '82', vatRate: 13, exportRate: 13, label: '贱金属工具、餐具' },
  { chapter: '83', vatRate: 13, exportRate: 13, label: '贱金属杂项制品' },

  // 第16类：机电产品 — 增值税13%
  { chapter: '84', vatRate: 13, exportRate: 13, label: '核反应堆、锅炉、机械器具' },
  { chapter: '85', vatRate: 13, exportRate: 13, label: '电机、电气设备' },

  // 第17类：车辆、航空器、船舶 — 增值税13%
  { chapter: '86', vatRate: 13, exportRate: 13, label: '铁道车辆' },
  { chapter: '87', vatRate: 13, exportRate: 13, label: '车辆及其零件' },
  { chapter: '88', vatRate: 13, exportRate: 13, label: '航空器、航天器' },
  { chapter: '89', vatRate: 13, exportRate: 13, label: '船舶及浮动结构体' },

  // 第18类：光学、医疗 — 增值税13%
  { chapter: '90', vatRate: 13, exportRate: 13, label: '光学、医疗、精密仪器' },
  { chapter: '91', vatRate: 13, exportRate: 13, label: '钟表' },
  { chapter: '92', vatRate: 13, exportRate: 13, label: '乐器' },

  // 第19类：武器 — 增值税13%
  { chapter: '93', vatRate: 13, exportRate: 0, label: '武器、弹药（管制）' },

  // 第20类：杂项制品 — 增值税13%
  { chapter: '94', vatRate: 13, exportRate: 13, label: '家具、寝具、灯具' },
  { chapter: '95', vatRate: 13, exportRate: 13, label: '玩具、游戏品、体育用品' },
  { chapter: '96', vatRate: 13, exportRate: 13, label: '杂项制品' },

  // 第21类：艺术品 — 增值税13%
  { chapter: '97', vatRate: 13, exportRate: 0, label: '艺术品、收藏品' },
];

/** 获取某个 HS 编码对应的增值税率和出口退税率 */
export function getTaxRatesByHsCode(hsCode: string): { vatRate: number; exportRate: number } {
  const chapterStr = hsCode.replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2);
  const rule = CHAPTER_TAX_RULES.find(r => r.chapter === chapterStr);
  if (rule) {
    return { vatRate: rule.vatRate, exportRate: rule.exportRate };
  }
  // 默认：找不到映射章节则13%增值税 + 13%出口退税（保守）
  return { vatRate: 13, exportRate: 13 };
}

/** 批量更新数据库中的 HSCode 增值税率和出口退税率 */
export async function updateAllTaxRates(): Promise<number> {
  const codes = await prisma.hSCode.findMany({
    select: { id: true, code: true, vatRate: true, exportRate: true },
    // 只更新当前为0或null的数据
    where: {
      OR: [
        { vatRate: { equals: 0 } },
        { vatRate: null },
        { exportRate: { equals: 0 } },
        { exportRate: null },
      ],
    },
  });

  logger.info(`[TaxRateService] 需要更新 ${codes.length} 条 HS 编码的税率`);

  let updated = 0;
  const BATCH_SIZE = 100;

  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const updates = batch.map((item: any) => {
      const rates = getTaxRatesByHsCode(item.code);
      return prisma.hSCode.update({
        where: { id: item.id },
        data: {
          vatRate: rates.vatRate,
          exportRate: rates.exportRate,
        },
      });
    });

    await Promise.all(updates);
    updated += batch.length;
    if (updated % 1000 === 0) {
      logger.info(`[TaxRateService] 已更新 ${updated}/${codes.length} 条`);
    }
  }

  logger.info(`[TaxRateService] 完成！共更新 ${updated} 条 HS 编码的税率`);
  return updated;
}

/** 获取所有章节的税率规则（供管理/展示用） */
export function getAllChapterTaxRules(): ChapterTaxRule[] {
  return [...CHAPTER_TAX_RULES];
}
