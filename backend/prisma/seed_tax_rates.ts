// ============================================================
// 一次性填补 HS 编码的增值税率和出口退税率
// 运行: npx tsx prisma/seed_tax_rates.ts
// 之后可以通过 cron 定时：每月1号自动运行 updateAllTaxRates()
// ============================================================
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** HS章节 → 增值税率/出口退税率映射（与中国税法对齐） */
const CHAPTER_RULES: Record<string, { vat: number; export: number }> = {
  '01': { vat: 9, export: 5 }, '02': { vat: 9, export: 5 },
  '03': { vat: 9, export: 9 }, '04': { vat: 9, export: 5 },
  '05': { vat: 9, export: 0 }, '06': { vat: 9, export: 5 },
  '07': { vat: 9, export: 5 }, '08': { vat: 9, export: 5 },
  '09': { vat: 9, export: 5 }, '10': { vat: 9, export: 0 },
  '11': { vat: 9, export: 9 }, '12': { vat: 9, export: 0 },
  '13': { vat: 9, export: 5 }, '14': { vat: 9, export: 0 },
  '15': { vat: 9, export: 0 },
  '16': { vat: 13, export: 13 }, '17': { vat: 13, export: 13 },
  '18': { vat: 13, export: 13 }, '19': { vat: 13, export: 13 },
  '20': { vat: 13, export: 13 }, '21': { vat: 13, export: 13 },
  '22': { vat: 13, export: 13 }, '23': { vat: 9, export: 9 },
  '24': { vat: 13, export: 0 },
  '25': { vat: 13, export: 9 }, '26': { vat: 13, export: 0 },
  '27': { vat: 13, export: 0 },
  '28': { vat: 13, export: 13 }, '29': { vat: 13, export: 13 },
  '30': { vat: 13, export: 13 }, '31': { vat: 9, export: 5 },
  '32': { vat: 13, export: 13 }, '33': { vat: 13, export: 13 },
  '34': { vat: 13, export: 13 }, '35': { vat: 13, export: 13 },
  '36': { vat: 13, export: 13 }, '37': { vat: 13, export: 13 },
  '38': { vat: 13, export: 13 },
  '39': { vat: 13, export: 13 }, '40': { vat: 13, export: 13 },
  '41': { vat: 13, export: 13 }, '42': { vat: 13, export: 13 },
  '43': { vat: 13, export: 13 },
  '44': { vat: 13, export: 13 }, '45': { vat: 13, export: 13 },
  '46': { vat: 13, export: 13 },
  '47': { vat: 13, export: 0 }, '48': { vat: 13, export: 13 },
  '49': { vat: 9, export: 0 },
  '50': { vat: 13, export: 13 }, '51': { vat: 13, export: 13 },
  '52': { vat: 13, export: 13 }, '53': { vat: 13, export: 13 },
  '54': { vat: 13, export: 13 }, '55': { vat: 13, export: 13 },
  '56': { vat: 13, export: 13 }, '57': { vat: 13, export: 13 },
  '58': { vat: 13, export: 13 }, '59': { vat: 13, export: 13 },
  '60': { vat: 13, export: 13 },
  '61': { vat: 13, export: 13 }, '62': { vat: 13, export: 13 },
  '63': { vat: 13, export: 13 },
  '64': { vat: 13, export: 13 }, '65': { vat: 13, export: 13 },
  '66': { vat: 13, export: 13 }, '67': { vat: 13, export: 13 },
  '68': { vat: 13, export: 13 }, '69': { vat: 13, export: 13 },
  '70': { vat: 13, export: 13 },
  '71': { vat: 13, export: 0 },
  '72': { vat: 13, export: 0 }, '73': { vat: 13, export: 13 },
  '74': { vat: 13, export: 0 }, '75': { vat: 13, export: 0 },
  '76': { vat: 13, export: 0 }, '78': { vat: 13, export: 0 },
  '79': { vat: 13, export: 0 }, '80': { vat: 13, export: 0 },
  '81': { vat: 13, export: 13 }, '82': { vat: 13, export: 13 },
  '83': { vat: 13, export: 13 },
  '84': { vat: 13, export: 13 }, '85': { vat: 13, export: 13 },
  '86': { vat: 13, export: 13 }, '87': { vat: 13, export: 13 },
  '88': { vat: 13, export: 13 }, '89': { vat: 13, export: 13 },
  '90': { vat: 13, export: 13 }, '91': { vat: 13, export: 13 },
  '92': { vat: 13, export: 13 },
  '93': { vat: 13, export: 0 },
  '94': { vat: 13, export: 13 }, '95': { vat: 13, export: 13 },
  '96': { vat: 13, export: 13 },
  '97': { vat: 13, export: 0 },
};

function getChapterFromCode(code: string): string {
  return code.replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2);
}

async function main() {
  console.log('开始填补 HS 编码税率数据...');

  const total = await prisma.hSCode.count();
  console.log(`数据库中共 ${total} 条 HS 编码`);

  // 分批处理，每批 200 条
  const BATCH = 200;
  let updated = 0;
  let skipped = 0;
  let cursor: any = undefined;

  while (true) {
    const batch = await prisma.hSCode.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, code: true, vatRate: true, exportRate: true },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    const updates: Promise<any>[] = [];

    for (const item of batch) {
      const ch = getChapterFromCode(item.code);
      const rule = CHAPTER_RULES[ch];

      if (!rule) {
        // 未找到映射章节，填空默认值
        if (item.vatRate === 0 || item.vatRate === null || item.exportRate === 0 || item.exportRate === null) {
          updates.push(
            prisma.hSCode.update({
              where: { id: item.id },
              data: { vatRate: 13, exportRate: 13 },
            })
          );
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      // 只在当前是 0 或 null 时才更新
      const needsVat = item.vatRate === 0 || item.vatRate === null;
      const needsExport = item.exportRate === 0 || item.exportRate === null;

      if (needsVat || needsExport) {
        const data: any = {};
        if (needsVat) data.vatRate = rule.vat;
        if (needsExport) data.exportRate = rule.export;
        updates.push(
          prisma.hSCode.update({
            where: { id: item.id },
            data,
          })
        );
        updated++;
      } else {
        skipped++;
      }
    }

    await Promise.all(updates);

    if (updated % 2000 === 0 || updated + skipped === total) {
      console.log(`  进度: ${updated} 条已更新, ${skipped} 条跳过 (共 ${total})`);
    }
  }

  // 验证
  const vatCount = await prisma.hSCode.count({ where: { vatRate: { gt: 0 } } });
  const exportCount = await prisma.hSCode.count({ where: { exportRate: { gt: 0 } } });
  console.log(`\n完成！`);
  console.log(`  更新了 ${updated} 条`);
  console.log(`  跳过了 ${skipped} 条（已有值）`);
  console.log(`  有增值税率: ${vatCount}/${total}`);
  console.log(`  有出口退税率: ${exportCount}/${total}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
