import prisma from '../config/database';

export interface ExportRebateRate {
  hsPrefix: string;
  rate: number;
  vatRate: number;
  description: string;
  category: '一般' | '限制' | '禁止';
}

const RATES: ExportRebateRate[] = [
  // === 第一类: 活动物/动物产品 (01-05章) ===
  { hsPrefix: '01', rate: 0, vatRate: 9, description: '活动物', category: '禁止' },
  { hsPrefix: '02', rate: 0, vatRate: 9, description: '肉及食用杂碎', category: '禁止' },
  { hsPrefix: '03', rate: 9, vatRate: 9, description: '水产品', category: '一般' },
  { hsPrefix: '04', rate: 9, vatRate: 9, description: '乳蛋蜂蜜', category: '一般' },
  { hsPrefix: '05', rate: 5, vatRate: 9, description: '其他动物产品', category: '限制' },

  // === 第二类: 植物产品 (06-14章) ===
  { hsPrefix: '06', rate: 5, vatRate: 9, description: '活植物/花卉', category: '限制' },
  { hsPrefix: '07', rate: 5, vatRate: 9, description: '蔬菜', category: '限制' },
  { hsPrefix: '08', rate: 5, vatRate: 9, description: '水果/坚果', category: '限制' },
  { hsPrefix: '09', rate: 5, vatRate: 9, description: '咖啡/茶/香料', category: '限制' },
  { hsPrefix: '10', rate: 0, vatRate: 9, description: '谷物', category: '禁止' },
  { hsPrefix: '11', rate: 5, vatRate: 13, description: '制粉工业产品', category: '限制' },
  { hsPrefix: '12', rate: 5, vatRate: 9, description: '油籽/工业植物', category: '限制' },

  // === 第三类: 动植物油脂 (15章) ===
  { hsPrefix: '15', rate: 0, vatRate: 13, description: '动植物油脂', category: '禁止' },

  // === 第四类: 食品/饮料/烟草 (16-24章) ===
  { hsPrefix: '16', rate: 13, vatRate: 13, description: '肉/鱼制品', category: '一般' },
  { hsPrefix: '17', rate: 13, vatRate: 13, description: '糖及糖食', category: '一般' },
  { hsPrefix: '18', rate: 13, vatRate: 13, description: '可可制品', category: '一般' },
  { hsPrefix: '19', rate: 13, vatRate: 13, description: '谷物/淀粉制品', category: '一般' },
  { hsPrefix: '20', rate: 13, vatRate: 13, description: '蔬菜水果制品', category: '一般' },
  { hsPrefix: '21', rate: 13, vatRate: 13, description: '杂项食品', category: '一般' },
  { hsPrefix: '22', rate: 13, vatRate: 13, description: '饮料/酒/醋', category: '一般' },
  { hsPrefix: '23', rate: 5, vatRate: 13, description: '食品工业残渣', category: '限制' },
  { hsPrefix: '24', rate: 0, vatRate: 13, description: '烟草', category: '禁止' },

  // === 第五类: 矿产品 (25-27章) ===
  { hsPrefix: '25', rate: 0, vatRate: 13, description: '盐/硫磺/石料', category: '禁止' },
  { hsPrefix: '26', rate: 0, vatRate: 13, description: '矿砂', category: '禁止' },
  { hsPrefix: '27', rate: 0, vatRate: 13, description: '矿物燃料', category: '禁止' },

  // === 第六类: 化工品 (28-38章) ===
  { hsPrefix: '28', rate: 13, vatRate: 13, description: '无机化学品', category: '一般' },
  { hsPrefix: '29', rate: 13, vatRate: 13, description: '有机化学品', category: '一般' },
  { hsPrefix: '30', rate: 13, vatRate: 13, description: '药品', category: '一般' },
  { hsPrefix: '31', rate: 0, vatRate: 9, description: '肥料', category: '禁止' },
  { hsPrefix: '32', rate: 13, vatRate: 13, description: '染料/涂料', category: '一般' },
  { hsPrefix: '33', rate: 13, vatRate: 13, description: '精油/化妆品', category: '一般' },
  { hsPrefix: '34', rate: 13, vatRate: 13, description: '肥皂/洗涤剂', category: '一般' },
  { hsPrefix: '35', rate: 13, vatRate: 13, description: '蛋白类物质', category: '一般' },
  { hsPrefix: '36', rate: 13, vatRate: 13, description: '炸药/烟火', category: '一般' },
  { hsPrefix: '37', rate: 13, vatRate: 13, description: '照相/电影用品', category: '一般' },
  { hsPrefix: '38', rate: 13, vatRate: 13, description: '杂项化学产品', category: '一般' },

  // === 第七类: 塑料/橡胶 (39-40章) ===
  { hsPrefix: '39', rate: 13, vatRate: 13, description: '塑料及其制品', category: '一般' },
  { hsPrefix: '40', rate: 9, vatRate: 13, description: '橡胶及其制品', category: '一般' },

  // === 第八类: 皮革/毛皮 (41-43章) ===
  { hsPrefix: '41', rate: 0, vatRate: 13, description: '生皮及皮革', category: '禁止' },
  { hsPrefix: '42', rate: 13, vatRate: 13, description: '皮革制品/旅行用品', category: '一般' },
  { hsPrefix: '43', rate: 13, vatRate: 13, description: '毛皮/人造毛皮', category: '一般' },

  // === 第九类: 木及木制品 (44-46章) ===
  { hsPrefix: '44', rate: 9, vatRate: 13, description: '木及木制品', category: '限制' },
  { hsPrefix: '45', rate: 9, vatRate: 13, description: '软木制品', category: '一般' },
  { hsPrefix: '46', rate: 9, vatRate: 13, description: '编结材料制品', category: '一般' },

  // === 第十类: 纸浆/纸 (47-49章) ===
  { hsPrefix: '47', rate: 0, vatRate: 13, description: '纸浆', category: '禁止' },
  { hsPrefix: '48', rate: 13, vatRate: 13, description: '纸及纸制品', category: '一般' },
  { hsPrefix: '49', rate: 13, vatRate: 13, description: '印刷品/手稿', category: '一般' },

  // === 第十一类: 纺织原料及制品 (50-63章) ===
  { hsPrefix: '50', rate: 13, vatRate: 13, description: '蚕丝', category: '一般' },
  { hsPrefix: '51', rate: 13, vatRate: 13, description: '羊毛/动物毛', category: '一般' },
  { hsPrefix: '52', rate: 13, vatRate: 13, description: '棉花', category: '一般' },
  { hsPrefix: '53', rate: 13, vatRate: 13, description: '其他植物纤维', category: '一般' },
  { hsPrefix: '54', rate: 13, vatRate: 13, description: '化纤长丝', category: '一般' },
  { hsPrefix: '55', rate: 13, vatRate: 13, description: '化纤短纤', category: '一般' },
  { hsPrefix: '56', rate: 13, vatRate: 13, description: '絮胎/毡呢/无纺布', category: '一般' },
  { hsPrefix: '57', rate: 13, vatRate: 13, description: '地毯', category: '一般' },
  { hsPrefix: '58', rate: 13, vatRate: 13, description: '特种机织物/花边', category: '一般' },
  { hsPrefix: '59', rate: 13, vatRate: 13, description: '涂布/浸渍织物', category: '一般' },
  { hsPrefix: '60', rate: 13, vatRate: 13, description: '针织物', category: '一般' },
  { hsPrefix: '61', rate: 13, vatRate: 13, description: '针织服装', category: '一般' },
  { hsPrefix: '62', rate: 13, vatRate: 13, description: '梭织服装', category: '一般' },
  { hsPrefix: '63', rate: 13, vatRate: 13, description: '其他纺织制品', category: '一般' },

  // === 第十二类: 鞋帽/伞/杖 (64-67章) ===
  { hsPrefix: '64', rate: 13, vatRate: 13, description: '鞋靴', category: '一般' },
  { hsPrefix: '65', rate: 13, vatRate: 13, description: '帽类', category: '一般' },
  { hsPrefix: '66', rate: 13, vatRate: 13, description: '雨伞/手杖', category: '一般' },
  { hsPrefix: '67', rate: 13, vatRate: 13, description: '羽毛/人造花', category: '一般' },

  // === 第十三/十四类: 矿物材料/陶瓷/玻璃/珠宝 (68-71章) ===
  { hsPrefix: '68', rate: 13, vatRate: 13, description: '石料/石膏/水泥制品', category: '一般' },
  { hsPrefix: '69', rate: 13, vatRate: 13, description: '陶瓷产品', category: '一般' },
  { hsPrefix: '70', rate: 13, vatRate: 13, description: '玻璃及其制品', category: '一般' },
  { hsPrefix: '71', rate: 0, vatRate: 13, description: '珠宝/贵金属', category: '禁止' },

  // === 第十五类: 贱金属 (72-83章) ===
  { hsPrefix: '72', rate: 0, vatRate: 13, description: '钢铁(出口限制)', category: '禁止' },
  { hsPrefix: '73', rate: 9, vatRate: 13, description: '钢铁制品', category: '限制' },
  { hsPrefix: '74', rate: 9, vatRate: 13, description: '铜及其制品', category: '限制' },
  { hsPrefix: '75', rate: 9, vatRate: 13, description: '镍及其制品', category: '限制' },
  { hsPrefix: '76', rate: 0, vatRate: 13, description: '铝及其制品(出口限制)', category: '禁止' },
  { hsPrefix: '78', rate: 0, vatRate: 13, description: '铅及其制品', category: '禁止' },
  { hsPrefix: '79', rate: 5, vatRate: 13, description: '锌及其制品', category: '限制' },
  { hsPrefix: '80', rate: 5, vatRate: 13, description: '锡及其制品', category: '限制' },
  { hsPrefix: '81', rate: 5, vatRate: 13, description: '其他贱金属', category: '限制' },
  { hsPrefix: '82', rate: 13, vatRate: 13, description: '贱金属工具', category: '一般' },
  { hsPrefix: '83', rate: 13, vatRate: 13, description: '贱金属杂项制品', category: '一般' },

  // === 第十六类: 机电设备 (84-85章) ===
  { hsPrefix: '84', rate: 13, vatRate: 13, description: '核反应堆/锅炉/机械设备', category: '一般' },
  { hsPrefix: '85', rate: 13, vatRate: 13, description: '电气设备/电子产品', category: '一般' },

  // === 第十七类: 车辆/航空器/船舶 (86-89章) ===
  { hsPrefix: '86', rate: 13, vatRate: 13, description: '铁路车辆', category: '一般' },
  { hsPrefix: '87', rate: 13, vatRate: 13, description: '车辆及其零件', category: '一般' },
  { hsPrefix: '88', rate: 13, vatRate: 13, description: '航空器/航天器', category: '一般' },
  { hsPrefix: '89', rate: 13, vatRate: 13, description: '船舶及浮动结构体', category: '一般' },

  // === 第十八类: 光学/医疗/钟表/乐器 (90-92章) ===
  { hsPrefix: '90', rate: 13, vatRate: 13, description: '光学/医疗/精密仪器', category: '一般' },
  { hsPrefix: '91', rate: 13, vatRate: 13, description: '钟表', category: '一般' },
  { hsPrefix: '92', rate: 13, vatRate: 13, description: '乐器', category: '一般' },

  // === 第十九/二十类: 武器/杂项 (93-96章) ===
  { hsPrefix: '93', rate: 0, vatRate: 13, description: '武器/弹药', category: '禁止' },
  { hsPrefix: '94', rate: 13, vatRate: 13, description: '家具/灯具/寝具', category: '一般' },
  { hsPrefix: '95', rate: 13, vatRate: 13, description: '玩具/游戏/运动用品', category: '一般' },
  { hsPrefix: '96', rate: 13, vatRate: 13, description: '杂项制品', category: '一般' },

  // === 第二十一类: 艺术品/古物 (97章) ===
  { hsPrefix: '97', rate: 0, vatRate: 13, description: '艺术品/收藏品/古物', category: '禁止' },
];

function normalizeHS(hsCode: string): string {
  return hsCode.replace(/[^0-9]/g, '').trim();
}

function matchRate(hsCode: string): ExportRebateRate | null {
  const digits = normalizeHS(hsCode);
  if (digits.length < 2) return null;

  let best: ExportRebateRate | null = null;
  let bestLen = 0;

  for (const r of RATES) {
    if (digits.startsWith(r.hsPrefix) && r.hsPrefix.length > bestLen) {
      best = r;
      bestLen = r.hsPrefix.length;
    }
  }

  return best;
}

export async function getExportRebateRate(hsCode: string): Promise<ExportRebateRate> {
  const digits = normalizeHS(hsCode);

  // 1. 优先查数据库
  try {
    const record = await prisma.hSCode.findFirst({
      where: { code: { startsWith: digits.slice(0, 6) } },
      select: { exportRate: true, vatRate: true, description: true },
    });
    if (record && record.exportRate != null && record.exportRate > 0) {
      return {
        hsPrefix: digits.slice(0, 6),
        rate: record.exportRate,
        vatRate: record.vatRate ?? 13,
        description: record.description || `HS ${digits.slice(0, 6)}`,
        category: record.exportRate >= 13 ? '一般' : record.exportRate > 0 ? '限制' : '禁止',
      };
    }
  } catch { /* fall through */ }

  // 2. 内置映射表前缀匹配
  const matched = matchRate(hsCode);
  if (matched) return matched;

  // 3. 未匹配: 默认 0%
  return {
    hsPrefix: digits.slice(0, 2) || '00',
    rate: 0,
    vatRate: 13,
    description: `HS ${digits.slice(0, 2)}章 (待确认)`,
    category: '禁止',
  };
}

export function getExportRebateRateSync(hsCode: string): ExportRebateRate {
  const digits = normalizeHS(hsCode);
  const matched = matchRate(hsCode);
  if (matched) return matched;

  return {
    hsPrefix: digits.slice(0, 2) || '00',
    rate: 0,
    vatRate: 13,
    description: `HS ${digits.slice(0, 2)}章 (待确认)`,
    category: '禁止',
  };
}
