// ============================================================
// HS 编码数据自动更新服务
// 每月1号凌晨自动更新
// 数据源: 项目内置 JSON + 推算法则（不再依赖外部 API）
// 数据文件: /app/data/hs_codes.json (由 data_fetcher/ 生成)
// ============================================================
import prisma from '../config/database';
import { logger } from '../config/logger';
import * as fs from 'fs';
import * as path from 'path';

interface HsRecord {
  code: string;
  description: string;
  unit: string;
  tariffRate: number;
  exportRate: number | null;
  vatRate: number | null;
  exciseRate: number | null;
  supervision: string | null;
  category: string;
  chapter: string;
}

// ============================================================
// 税率推算规则（与 data_fetcher/fetch_and_seed.py 保持一致）
// ============================================================

function getVatRate(chapter: number): number {
  if (chapter >= 1 && chapter <= 24) return 9.0;
  return 13.0;
}

function getExportRebateRate(code: string, description: string, chapter: number): number {
  if (chapter === 27) return 0.0;
  if (chapter === 93 || chapter === 97 || chapter === 71) return 0.0;
  if (chapter >= 1 && chapter <= 15) return 5.0;
  if (chapter === 72) {
    if (/废|碎|粉/.test(description)) return 0.0;
    return 5.0;
  }
  if (chapter >= 50 && chapter <= 63) return 13.0;
  if (chapter >= 28 && chapter <= 38) return 9.0;
  if (chapter >= 84 && chapter <= 85) return 13.0;
  return 13.0;
}

function getExciseRate(code: string, description: string, chapter: number): number | null {
  if (chapter === 87) return 9.0;
  if (chapter === 27) return 15.0;
  return null;
}

function getSupervision(chapter: number): string {
  if (chapter >= 1 && chapter <= 15) return 'A,B';
  if (chapter === 28 || chapter === 29 || chapter === 27 || chapter === 87) return 'O';
  if (chapter === 30) return 'A,Q';
  if (chapter === 72) return 'B';
  if (chapter === 93) return 'G';
  return '一般监管';
}

export function inferCategory(chapterNum: number): string {
  if (chapterNum >= 1 && chapterNum <= 24) return '农产品';
  if (chapterNum >= 25 && chapterNum <= 27) return '矿产品';
  if (chapterNum >= 28 && chapterNum <= 38) return '化工品';
  if (chapterNum >= 39 && chapterNum <= 40) return '塑料橡胶';
  if (chapterNum >= 41 && chapterNum <= 43) return '皮革毛皮';
  if (chapterNum >= 44 && chapterNum <= 49) return '木及纸制品';
  if (chapterNum >= 50 && chapterNum <= 63) return '纺织品';
  if (chapterNum >= 64 && chapterNum <= 67) return '鞋帽';
  if (chapterNum >= 68 && chapterNum <= 70) return '石料陶瓷';
  if (chapterNum === 71) return '贵金属';
  if (chapterNum >= 72 && chapterNum <= 83) return '金属制品';
  if (chapterNum >= 84 && chapterNum <= 85) return '机电产品';
  if (chapterNum >= 86 && chapterNum <= 89) return '运输设备';
  if (chapterNum >= 90 && chapterNum <= 92) return '光学仪器';
  if (chapterNum === 93) return '武器';
  if (chapterNum >= 94 && chapterNum <= 96) return '杂项制品';
  if (chapterNum === 97) return '艺术品';
  return '工业品';
}

function parseChapter(code: string, chapterStr?: string): number {
  if (chapterStr) {
    const n = parseInt(chapterStr.substring(0, 2), 10);
    if (!isNaN(n) && n >= 1 && n <= 97) return n;
  }
  const match = code.match(/^(\d{2})/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (!isNaN(n) && n >= 1 && n <= 97) return n;
  }
  return 84;
}

function enrichRecord(rec: any): HsRecord {
  const code = String(rec.code || '');
  const description = rec.name || rec.description || '';
  const chapter = parseChapter(code, rec.chapter);
  const cat = inferCategory(chapter);

  return {
    code,
    description,
    unit: rec.unit || '个',
    tariffRate: typeof rec.mfn_rate === 'number' ? rec.mfn_rate : (rec.tariffRate || 0),
    exportRate: typeof rec.export_rate === 'number' ? rec.export_rate
               : (rec.exportRate || getExportRebateRate(code, description, chapter)),
    vatRate: typeof rec.vat_rate === 'number' && rec.vat_rate > 0 ? rec.vat_rate
            : (rec.vatRate || getVatRate(chapter)),
    exciseRate: typeof rec.excise_rate === 'number' && rec.excise_rate > 0 ? rec.excise_rate
               : (rec.exciseRate || getExciseRate(code, description, chapter)),
    supervision: (rec.supervision || '') || getSupervision(chapter),
    category: cat,
    chapter: String(chapter).padStart(2, '0'),
  };
}

function loadDataFromFile(): HsRecord[] {
  const searchPaths = [
    '/app/data/hs_codes.json',
    '/app/data_fetcher/output/hs_codes.json',
    '/app/dist/data/hs_codes.json',
    path.join(__dirname, '../../data/hs_codes.json'),
    path.join(__dirname, '../../data_fetcher/output/hs_codes.json'),
  ];

  for (const fp of searchPaths) {
    try {
      if (fs.existsSync(fp)) {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (Array.isArray(raw) && raw.length > 0) {
          logger.info('[HSUpdater] 从文件加载: ' + fp + ' (' + raw.length + ' 条)');
          return raw.map(enrichRecord);
        }
      }
    } catch (err: any) {
      logger.warn('[HSUpdater] 读取文件失败: ' + fp + ' - ' + err.message);
    }
  }
  return [];
}

function loadBuiltinData(): HsRecord[] {
  const records: HsRecord[] = [];
  const CHAPTERS = Array.from({ length: 97 }, (_, i) => i + 1).filter(c => c !== 77);

  for (const chapter of CHAPTERS) {
    const ch = String(chapter).padStart(2, '0');
    const cat = inferCategory(chapter);
    const supervision = getSupervision(chapter);
    const vat = getVatRate(chapter);
    const code = ch + '.00.00';
    const description = '第' + ch + '章 商品（自动补充）';
    const exportRate = getExportRebateRate(code, description, chapter);
    const exciseRate = getExciseRate(code, description, chapter);

    records.push({
      code,
      description,
      unit: '个',
      tariffRate: 8.0,
      exportRate: exportRate || 0,
      vatRate: vat,
      exciseRate: exciseRate || null,
      supervision,
      category: cat,
      chapter: ch,
    });
  }
  return records;
}

async function seedToDatabase(records: HsRecord[]): Promise<number> {
  let totalUpdated = 0;
  const batchSize = 200;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const operations = batch.map(rec =>
      prisma.hSCode.upsert({
        where: { code: rec.code },
        update: {
          description: rec.description,
          unit: rec.unit,
          tariffRate: rec.tariffRate,
          exportRate: rec.exportRate,
          vatRate: rec.vatRate,
          exciseRate: rec.exciseRate,
          supervision: rec.supervision || null,
          category: rec.category,
          updatedAt: new Date(),
        },
        create: {
          code: rec.code,
          description: rec.description,
          unit: rec.unit,
          tariffRate: rec.tariffRate,
          exportRate: rec.exportRate,
          vatRate: rec.vatRate,
          exciseRate: rec.exciseRate,
          supervision: rec.supervision || null,
          category: rec.category,
        },
      }).catch((err: any) => {
        if (err.code !== 'P2002') {
          logger.warn('[HSUpdater] upsert失败: ' + rec.code + ' - ' + err.message);
        }
        return null;
      })
    );

    const results = await Promise.all(operations);
    const updated = results.filter(r => r !== null).length;
    totalUpdated += updated;

    logger.info('[HSUpdater] 进度: ' + Math.min(i + batchSize, records.length) + '/' + records.length + ' (已更新: ' + totalUpdated + ')');
  }

  return totalUpdated;
}

export async function updateAllHSCodes(): Promise<number> {
  logger.info('[HSUpdater] ====== 开始 HS 编码数据更新 ======');

  let records = loadDataFromFile();

  if (records.length === 0) {
    logger.info('[HSUpdater] JSON数据文件不存在，使用内置基准数据');
    records = loadBuiltinData();
  }

  if (records.length === 0) {
    logger.warn('[HSUpdater] 无可用数据源，跳过更新');
    return 0;
  }

  logger.info('[HSUpdater] 共 ' + records.length + ' 条待写入');
  const count = await seedToDatabase(records);
  logger.info('[HSUpdater] 完成! 共更新/新增 ' + count + ' 条 HS 编码');
  return count;
}

export async function updateHSCodesIncremental(): Promise<number> {
  return updateAllHSCodes();
}
